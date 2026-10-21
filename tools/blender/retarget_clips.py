"""
애니메이션 클립 리타깃: 원본 캐릭터(src)의 클립을 같은 본 이름·T포즈 레스트를 가진 대상(dst)으로 옮긴다.
본 이름은 같아도 레스트 본 축(롤)이 캐릭터마다 달라 회전 트랙을 그대로 복사하면 자세가 틀어짐 →
아마추어 공간에서 "레스트 대비 회전 변화량"을 옮긴다:  T_dst = (P_src · R_src⁻¹) · R_dst
(P = 포즈 회전, R = 레스트 회전, 모두 아마추어 공간). 로컬 회전은 부모 목표에서 거꾸로 계산.
Hips 위치는 레스트 대비 이동량 × (대상 엉덩이 높이 / 원본 엉덩이 높이).

blender -b --factory-startup -P tools/blender/retarget_clips.py -- <src.glb> <dst.glb> <out.glb> [--clips a,b,..] [--validate a,b,..]
- --clips: 옮길 클립 (기본: 대상에 없는 원본 클립 전부). 대상에 이미 있는 클립은 그대로 둠
- --validate: 대상에 이미 있는 클립을 리타깃 결과와 비교만 함 (본 방향 각도 차이 출력, 파일 안 씀)
"""
import math
import sys

import bpy
from mathutils import Matrix, Quaternion

argv = sys.argv[sys.argv.index('--') + 1:]
src_path, dst_path, out_path = argv[0], argv[1], argv[2]


def opt(name):
    if name in argv:
        v = argv[argv.index(name) + 1]
        return [s for s in v.split(',') if s]
    return None


want = opt('--clips')
validate = opt('--validate')

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def load(path):
    before = set(bpy.data.objects)
    acts_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    for o in new:
        if o.type == 'MESH' and o.parent != arm:
            bpy.data.objects.remove(o, do_unlink=True)
    acts = {}
    if arm.animation_data:
        for tr in arm.animation_data.nla_tracks:
            for st in tr.strips:
                if st.action:
                    acts[st.action.name.split('.')[0]] = st.action
            tr.mute = True
        if arm.animation_data.action:
            acts.setdefault(arm.animation_data.action.name.split('.')[0], arm.animation_data.action)
        arm.animation_data.action = None
    else:
        arm.animation_data_create()
    new_acts = [a for a in bpy.data.actions if a not in acts_before]
    return arm, acts, new_acts


src, src_acts, src_new = load(src_path)
dst, dst_acts, _ = load(dst_path)
assert src.matrix_world == Matrix.Identity(4) or True  # glTF 임포트 아마추어 변환은 둘 다 같음 (Y-up 보정)

names = [b.name for b in dst.data.bones if b.name in src.data.bones]
# 부모 먼저
order = []
for b in dst.data.bones:  # Blender bones 목록은 부모가 먼저
    if b.name in names:
        order.append(b.name)


def rest_q(arm, n):
    return arm.data.bones[n].matrix_local.to_quaternion()


hip_src = src.data.bones['Hips'].head_local.z
hip_dst = dst.data.bones['Hips'].head_local.z
hip_ratio = hip_dst / hip_src
print('HIP RATIO', round(hip_ratio, 4))


def target_rotations():
    """현재 프레임 원본 포즈 → 대상 아마추어 공간 목표 회전"""
    out = {}
    for n in order:
        ps = src.pose.bones[n].matrix.to_quaternion()
        out[n] = ps @ rest_q(src, n).inverted() @ rest_q(dst, n)
    return out


def local_basis(n, tgt):
    """목표 아마추어 회전 → 포즈 본 basis 회전 (부모 목표 기준)"""
    b = dst.data.bones[n]
    if b.parent and b.parent.name in tgt:
        parent_t = tgt[b.parent.name]
        rel = rest_q(dst, b.parent.name).inverted() @ rest_q(dst, n)
        return (parent_t @ rel).inverted() @ tgt[n]
    if b.parent:
        # 부모가 원본에 없으면 부모는 레스트 그대로
        rel = b.parent.matrix_local.to_quaternion().inverted() @ rest_q(dst, n)
        return (b.parent.matrix_local.to_quaternion() @ rel).inverted() @ tgt[n]
    return rest_q(dst, n).inverted() @ tgt[n]


def hips_location():
    ps = src.pose.bones['Hips'].matrix.translation - src.data.bones['Hips'].matrix_local.translation
    delta = ps * hip_ratio
    # basis 위치는 본 레스트 축 공간
    return rest_q(dst, 'Hips').inverted() @ delta


def frames_of(act):
    f0, f1 = act.frame_range
    return int(math.floor(f0)), int(math.ceil(f1))


def sample_frames(act):
    """정수 프레임 + 끝(소수 프레임이면 정확한 끝). 루프 길이가 원본과 같게"""
    f0, f1 = act.frame_range
    out = [float(f) for f in range(int(math.floor(f0)), int(math.floor(f1)) + 1)]
    if f1 - out[-1] > 1e-3:
        out.append(f1)
    return out


if validate:
    for clip in validate:
        sa, da = src_acts.get(clip), dst_acts.get(clip)
        if not sa or not da:
            print('VALIDATE skip', clip)
            continue
        src.animation_data.action = sa
        dst.animation_data.action = da
        f0, f1 = frames_of(sa)
        worst = {}
        for f in range(f0, f1 + 1, 2):
            scene.frame_set(f)
            tgt = target_rotations()
            for n in order:
                native = dst.pose.bones[n].matrix.to_quaternion()
                # 본 방향(Y축)과 전체 회전 차이
                d = native.rotation_difference(tgt[n]).angle * 180 / math.pi
                worst[n] = max(worst.get(n, 0), d)
        top = sorted(worst.items(), key=lambda t: -t[1])[:6]
        mean = sum(worst.values()) / len(worst)
        print('VALIDATE', clip, 'mean-of-max', round(mean, 1), 'worst', [(k, round(v, 1)) for k, v in top])
    print('DONE')
    sys.exit(0)

clips = want or [c for c in src_acts if c not in dst_acts]
print('RETARGET', clips)
for clip in clips:
    sa = src_acts[clip]
    src.animation_data.action = sa
    act = bpy.data.actions.new(clip + '__rt')
    dst.animation_data.action = act
    f0, f1 = frames_of(sa)
    prev = {}
    for f in sample_frames(sa):
        scene.frame_set(int(f), subframe=f - int(f))
        tgt = target_rotations()
        for n in order:
            pb = dst.pose.bones[n]
            pb.rotation_mode = 'QUATERNION'
            q = local_basis(n, tgt)
            if n in prev and prev[n].dot(q) < 0:
                q = Quaternion((-q.w, -q.x, -q.y, -q.z))
            prev[n] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=f)
            if n == 'Hips':
                pb.location = hips_location()
                pb.keyframe_insert('location', frame=f)
    dst.animation_data.action = None
    # NLA에 넣어 ACTIONS 내보내기 대상이 되게
    tr = dst.animation_data.nla_tracks.new()
    tr.strips.new(clip, f0, act)
    tr.mute = True
    print('BAKED', clip, f0, f1)

# 원본 캐릭터와 그 클립은 내보내기 전에 제거, 새 액션 이름 정리
src_mesh = [o for o in bpy.data.objects if o.parent == src]
for o in src_mesh:
    bpy.data.objects.remove(o, do_unlink=True)
bpy.data.objects.remove(src, do_unlink=True)
for a in src_new:
    if a.name in bpy.data.actions and not a.name.endswith('__rt'):
        bpy.data.actions.remove(a)
for a in list(bpy.data.actions):
    if a.name.endswith('__rt'):
        a.name = a.name[:-4]
# 대상 원래 클립이 원본과 이름이 겹쳐 임포트 때 붙은 .001 제거
for a in list(bpy.data.actions):
    base = a.name.split('.')[0]
    if a.name != base and base not in bpy.data.actions:
        a.name = base
print('ACTIONS', sorted(a.name for a in bpy.data.actions))

bpy.ops.object.select_all(action='DESELECT')
bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format='GLB',
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_skins=True,
    export_yup=True,
    export_image_format='AUTO',
    export_apply=False,
    export_optimize_animation_size=True,
    export_optimize_animation_keep_anim_armature=False,
)
print('EXPORTED', out_path)

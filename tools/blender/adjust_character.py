"""
캐릭터 비율 조정: 메시 정점과 Armature 레스트 본을 "같은 공간 변형"으로 함께 옮긴다 (본 스케일 변경 없음).
스킨 가중치·본 계층·애니메이션 클립은 그대로이고, 레스트 포즈만 새 비율이 된다.

blender -b --factory-startup -P tools/blender/adjust_character.py -- <config.json> <in.glb> <out.glb> [<out.blend>]

config (Blender Z-up, 원본 높이 1.0 단위):
{
  "z_from": [0, 0.06, 0.2117, 0.391, 0.495, 0.892],   # 원본 기준 높이 (바닥, 신발 위, 엉덩이 관절, 어깨, 머리 시작, 머리 꼭대기(방울 제외))
  "z_to":   [0, 0.06, 0.2422, 0.4133, 0.495, 0.927],  # 블루 기준 높이
  "head_scale_xy": 1.117,   # 머리 가로·깊이 배율 (머리 시작 근처에서 부드럽게 시작)
  "head_blend": [0.465, 0.525],
  "arm_scale": 1.097,       # 팔 길이 배율 (위팔 시작 x 바깥쪽만)
  "upperarm_x": 0.1477
}
- 세로: 기준점 사이를 단조 3차 보간 (꺾임 없이 부드럽게). 마지막 기준점 위(방울 장식)는 그 구간 기울기로 이어짐
- 팔: 정점의 팔 본 가중치 합만큼 늘림 (어깨 쪽에서 부드럽게 이어짐). 팔 본(UpperArm·LowerArm·Hand·손가락)은 1
"""
import json
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
cfg = json.load(open(argv[0], encoding='utf-8'))
in_path, out_path = argv[1], argv[2]
blend_path = argv[3] if len(argv) > 3 else None

zf, zt = cfg['z_from'], cfg['z_to']
n = len(zf)
# Fritsch–Carlson 단조 3차 보간 기울기
d = [(zt[i + 1] - zt[i]) / (zf[i + 1] - zf[i]) for i in range(n - 1)]
m = [d[0]] + [0.0] * (n - 2) + [d[-1]]
for i in range(1, n - 1):
    if d[i - 1] * d[i] <= 0:
        m[i] = 0.0
    else:
        w1 = 2 * (zf[i + 1] - zf[i]) + (zf[i] - zf[i - 1])
        w2 = (zf[i + 1] - zf[i]) + 2 * (zf[i] - zf[i - 1])
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])


def fz(z):
    if z <= zf[0]:
        return zt[0] + (z - zf[0]) * m[0]
    if z >= zf[-1]:
        return zt[-1] + (z - zf[-1]) * m[-1]
    for i in range(n - 1):
        if z <= zf[i + 1]:
            h = zf[i + 1] - zf[i]
            t = (z - zf[i]) / h
            h00 = 2 * t**3 - 3 * t**2 + 1
            h10 = t**3 - 2 * t**2 + t
            h01 = -2 * t**3 + 3 * t**2
            h11 = t**3 - t**2
            return h00 * zt[i] + h10 * h * m[i] + h01 * zt[i + 1] + h11 * h * m[i + 1]
    return z


def smooth(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


hs = cfg.get('head_scale_xy', 1.0)
hb0, hb1 = cfg.get('head_blend', [0.47, 0.52])
arm_s = cfg.get('arm_scale', 1.0)
ux = cfg.get('upperarm_x', 0.14)
ARM = ('UpperArm', 'LowerArm', 'Hand', 'Thumb', 'Index', 'Middle', 'Ring', 'Little')

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=in_path)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm)
# 임포터 보조 오브젝트(본에 연결 안 된 Icosphere 등)는 내보내지 않도록 삭제
for o in list(bpy.data.objects):
    if o.type == 'MESH' and o is not mesh:
        bpy.data.objects.remove(o, do_unlink=True)

# 머리 중심 y (깊이 배율 기준): 머리 영역 정점의 경계 중심
mw = mesh.matrix_world
head_ys = [(mw @ v.co).y for v in mesh.data.vertices if (mw @ v.co).z > hb1]
cy = (min(head_ys) + max(head_ys)) / 2 if head_ys else 0.0


def transform(p, w_arm):
    x, y, z = p
    if w_arm > 0 and abs(x) > ux:
        ax = (ux + (abs(x) - ux) * arm_s) * (1 if x > 0 else -1)
        x = x + w_arm * (ax - x)
    h = smooth(hb0, hb1, z)
    s = 1 + (hs - 1) * h
    return Vector((x * s, cy + (y - cy) * s, fz(z)))


# 메시 정점 (월드 공간에서 변형 후 로컬로)
inv = mw.inverted()
names = [g.name for g in mesh.vertex_groups]
for v in mesh.data.vertices:
    w_arm = sum(ge.weight for ge in v.groups if names[ge.group].startswith(ARM))
    v.co = inv @ transform(mw @ v.co, min(1.0, w_arm))
mesh.data.update()

# 레스트 본: 같은 변형 (본 방향·롤은 Blender가 head/tail로 다시 정함, 스케일은 건드리지 않음)
aw = arm.matrix_world
ainv = aw.inverted()
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
for eb in arm.data.edit_bones:
    w = 1.0 if eb.name.startswith(ARM) else 0.0
    roll = eb.roll
    eb.head = ainv @ transform(aw @ eb.head, w)
    eb.tail = ainv @ transform(aw @ eb.tail, w)
    eb.roll = roll
bpy.ops.object.mode_set(mode='OBJECT')

# 모든 클립을 내보내기 위해 액션 목록 확인 (임포터가 NLA에 넣어 둠)
acts = sorted(a.name for a in bpy.data.actions)
print('ACTIONS', acts)
bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format='GLB',
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_skins=True,
    export_yup=True,
    export_image_format='AUTO',
    export_apply=False,
    # 원본처럼 회전 트랙(+ Hips 위치)만: 변하지 않는 위치·스케일 트랙은 빼야 게임의 팔 IK(본 위치 트랙 금지)와 충돌 안 함
    export_optimize_animation_size=True,
    export_optimize_animation_keep_anim_armature=False,
)
if blend_path:
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
print('EXPORTED', out_path)

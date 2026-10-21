"""
두 캐릭터 GLB 비교 렌더 (읽기 전용, 원본 수정 없음).

blender -b --factory-startup -P tools/blender/render_character_compare.py -- <out_dir> <ref.glb> <target.glb> [label_ref] [label_target]

모든 이미지는 같은 직교 카메라(같은 거리·높이·ortho 크기), 모델 원래 스케일 그대로.
- 01_ref_front, 02_target_front: 각각 단독 정면
- 03_lineup_front / 04_lineup_side / 05_lineup_back: 나란히 (기준 왼쪽, 대상 오른쪽)
- 06_head_front: 머리 확대 정면 나란히 (눈·얼굴 비교)
- 07_anim_<clip>: 대상 캐릭터 애니메이션 프레임 (기준과 나란히, 3/4 앞)
glTF 정면(+Z) = Blender -Y. 이미지 오른쪽 위에 기준선(높이 0.25 간격) 표시.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
out_dir, ref_path, tgt_path = os.path.abspath(argv[0]), argv[1], argv[2]
os.makedirs(out_dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def import_char(path, tag):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    mesh = next(o for o in new if o.type == 'MESH' and o.parent == arm)
    # 생성기가 남긴 보조 메시(Icosphere 등, 본에 연결 안 됨)는 렌더에서 숨김
    for o in new:
        if o.type == 'MESH' and o is not mesh:
            o.hide_render = True
            o.hide_viewport = True
    arm.name = f'{tag}_armature'
    mesh.name = f'{tag}_mesh'
    return arm, mesh


ref_arm, ref_mesh = import_char(ref_path, 'ref')
tgt_arm, tgt_mesh = import_char(tgt_path, 'tgt')
ref_actions = {a.name: a for a in bpy.data.actions if a.users and ref_arm.animation_data and False}

# 액션: 가져오기 직후 각 Armature에 첫 액션이 붙음. 이름으로 다시 찾는다 (같은 이름은 .001 접미사)
all_actions = list(bpy.data.actions)


def actions_for(arm):
    # glTF 임포터는 NLA 트랙에 모든 클립을 넣는다
    acts = {}
    if arm.animation_data:
        for tr in arm.animation_data.nla_tracks:
            for st in tr.strips:
                if st.action:
                    acts[st.action.name.split('.')[0].split('_target')[0]] = st.action
        if arm.animation_data.action:
            a = arm.animation_data.action
            acts.setdefault(a.name.split('.')[0], a)
    return acts


ref_acts = actions_for(ref_arm)
tgt_acts = actions_for(tgt_arm)
for arm in (ref_arm, tgt_arm):
    if arm.animation_data:
        for tr in arm.animation_data.nla_tracks:
            tr.mute = True
        arm.animation_data.action = None


def set_pose_rest(rest):
    for arm in (ref_arm, tgt_arm):
        arm.data.pose_position = 'REST' if rest else 'POSE'


# 렌더 설정: Workbench, 텍스처 색, 스튜디오 조명, 흰 배경
scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'
sh.color_type = 'TEXTURE'
sh.show_object_outline = True
sh.object_outline_color = (0.15, 0.15, 0.2)
sh.show_cavity = False
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new('w') if not scene.world else scene.world
sh.background_type = 'VIEWPORT'
sh.background_color = (0.93, 0.93, 0.95)
scene.render.resolution_x = 1200
scene.render.resolution_y = 1000
scene.render.image_settings.file_format = 'PNG'

# 높이 기준선 (0.25 간격, 얇은 막대) — 같은 축척 비교용
grid_objs = []
mat = bpy.data.materials.new('grid')
mat.diffuse_color = (0.85, 0.3, 0.4, 1)
for i in range(5):
    z = i * 0.25
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.6, z))
    c = bpy.context.object
    c.scale = (2.4, 0.002, 0.002)
    c.data.materials.append(mat)
    grid_objs.append(c)
sh.color_type = 'TEXTURE'

cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam


def place(obj, x, y):
    obj.location = (x, y, 0)


def shoot(name, cam_loc, look_at, ortho, hide=()):
    cam.location = Vector(cam_loc)
    d = Vector(look_at) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam_data.ortho_scale = ortho
    hidden = []
    for o in hide:
        if not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    scene.render.filepath = os.path.join(out_dir, name + '.png')
    bpy.ops.render.render(write_still=True)
    for o in hidden:
        o.hide_render = False
    print('RENDERED', name)


FRONT = (0, -10, 0.5)  # 정면: -Y에서 +Y를 봄
SIDE = (10, 0, 0.5)    # 측면: +X(캐릭터 왼쪽)에서
BACK = (0, 10, 0.5)
CENTER = (0, 0, 0.5)
ORTHO = 2.4

set_pose_rest(True)
for g in grid_objs:
    g.location.y = 0.6
# 단독 정면
place(ref_arm, 0, 0)
place(tgt_arm, 0, 0)
shoot('01_ref_front', FRONT, CENTER, ORTHO, hide=[tgt_mesh])
shoot('02_target_front', FRONT, CENTER, ORTHO, hide=[ref_mesh])
# 나란히 정면·후면 (기준 왼쪽 = 화면 왼쪽)
place(ref_arm, -0.55, 0)
place(tgt_arm, 0.55, 0)
shoot('03_lineup_front', FRONT, CENTER, ORTHO)
place(ref_arm, 0.55, 0)
place(tgt_arm, -0.55, 0)
shoot('05_lineup_back', BACK, CENTER, ORTHO)
# 측면: 화면 가로축이 Y → Y로 벌림 (기준 왼쪽). 기준선은 X 뒤쪽으로
for g in grid_objs:
    g.location = (-0.8, 0, g.location.z)
    g.scale = (0.002, 2.4, 0.002)
place(ref_arm, 0, 0.55)
place(tgt_arm, 0, -0.55)
shoot('04_lineup_side', SIDE, CENTER, ORTHO)
# 머리 확대 정면
for g in grid_objs:
    g.location = (0, 0.6, g.location.z)
    g.scale = (2.4, 0.002, 0.002)
place(ref_arm, -0.35, 0)
place(tgt_arm, 0.35, 0)
shoot('06_head_front', FRONT, (0, 0, 0.74), 1.3)

# 애니메이션 프레임 (포즈 모드): 3/4 앞에서
set_pose_rest(False)
for g in grid_objs:
    g.hide_render = True
place(ref_arm, -0.55, 0)
place(tgt_arm, 0.55, 0)
clips = [('Idle_Loop_Rig', 0.5), ('Walk_Loop_Rig', 0.25), ('Jog_Fwd_Loop_Rig', 0.25), ('Jump_Start_Rig', 0.7),
         ('Jump_Loop_Rig', 0.5), ('Jump_Land_Rig', 0.3), ('Death01_Rig', 1.0)]
three_q = (6.5, -7.5, 1.6)
for clip, t in clips:
    ra = ref_acts.get(clip)
    ta = tgt_acts.get(clip)
    if not ra or not ta:
        print('MISSING CLIP', clip, bool(ra), bool(ta))
        continue
    ref_arm.animation_data.action = ra
    tgt_arm.animation_data.action = ta
    f0, f1 = ta.frame_range
    frame = f0 + (f1 - f0) * t
    scene.frame_set(int(frame), subframe=frame - int(frame))
    shoot(f'07_anim_{clip}', three_q, (0, 0, 0.45), ORTHO)
print('DONE')

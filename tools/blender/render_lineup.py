"""
캐릭터 여러 명 나란히 비교 렌더 (읽기 전용, 원본 수정 없음).

blender -b --factory-startup -P tools/blender/render_lineup.py -- <out_dir> [--anim] <a.glb> <b.glb> ...

- 모든 이미지: 같은 직교 카메라(거리·높이·ortho 크기 고정), 모델 원래 스케일, 레스트 포즈
- lineup_front / lineup_side / lineup_back: 왼쪽부터 인자 순서대로 (후면은 화면상 좌우가 뒤집히지 않게 순서 유지)
- head_front / head_side: 머리 확대
- --anim: 클립별 프레임 (3/4 앞) anim_<clip>.png
- 가로 기준선 0.25 간격 (높이 비교용). glTF 정면(+Z) = Blender -Y.
"""
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
out_dir = os.path.abspath(argv[0])
rest = argv[1:]
do_anim = '--anim' in rest
paths = [p for p in rest if p != '--anim']
os.makedirs(out_dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

chars = []
for i, path in enumerate(paths):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    mesh = next(o for o in new if o.type == 'MESH' and o.parent == arm)
    for o in new:
        if o.type == 'MESH' and o is not mesh:
            o.hide_render = True
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
    chars.append({'arm': arm, 'mesh': mesh, 'acts': acts, 'name': os.path.basename(path)})

scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'
sh.color_type = 'TEXTURE'
sh.show_object_outline = True
sh.object_outline_color = (0.15, 0.15, 0.2)
sh.background_type = 'VIEWPORT'
sh.background_color = (0.93, 0.93, 0.95)
scene.render.resolution_x = 1600
scene.render.resolution_y = 900
scene.render.image_settings.file_format = 'PNG'

n = len(chars)
SPACING = 0.95
width = SPACING * n + 0.4

grid = []
mat = bpy.data.materials.new('grid')
mat.diffuse_color = (0.85, 0.3, 0.4, 1)
for i in range(5):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.7, i * 0.25))
    c = bpy.context.object
    c.scale = (width, 0.002, 0.002)
    c.data.materials.append(mat)
    grid.append(c)

cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam


def shoot(name, loc, look, ortho):
    cam.location = Vector(loc)
    cam.rotation_euler = (Vector(look) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.ortho_scale = ortho
    scene.render.filepath = os.path.join(out_dir, name + '.png')
    bpy.ops.render.render(write_still=True)
    print('RENDERED', name)


def layout(axis, sign=1, spacing=SPACING):
    for i, c in enumerate(chars):
        off = (i - (n - 1) / 2) * spacing * sign
        c['arm'].location = (off, 0, 0) if axis == 'x' else (0, off, 0)


for c in chars:
    c['arm'].data.pose_position = 'REST'

ORTHO = max(2.2, width)
layout('x')
shoot('lineup_front', (0, -10, 0.5), (0, 0, 0.5), ORTHO)
# 머리 확대: 머리만 보이게 간격을 좁힘 (T포즈 팔은 옆 캐릭터와 겹칠 수 있음)
HEAD_SP = 0.68
layout('x', 1, HEAD_SP)
shoot('head_front', (0, -10, 0.72), (0, 0, 0.72), HEAD_SP * n + 0.1)
# 후면: 카메라가 +Y에서 보면 화면 좌우가 뒤집힘 → 배치를 반대로 해서 인자 순서가 왼쪽부터 유지되게
layout('x', -1)
shoot('lineup_back', (0, 10, 0.5), (0, 0, 0.5), ORTHO)
# 측면 (+X에서 -X를 봄): 화면 오른쪽 = +Y → y를 인자 순서대로 늘려 왼쪽부터
for g in grid:
    g.location = (-0.8, 0, g.location.z)
    g.scale = (0.002, width, 0.002)
layout('y', 1)
shoot('lineup_side', (10, 0, 0.5), (0, 0, 0.5), ORTHO)
layout('y', 1, HEAD_SP)
shoot('head_side', (10, 0, 0.72), (0, 0, 0.72), HEAD_SP * n + 0.1)

if do_anim:
    for g in grid:
        g.hide_render = True
    layout('x')
    for c in chars:
        c['arm'].data.pose_position = 'POSE'
    clips = [('Idle_Loop_Rig', 0.5), ('Walk_Loop_Rig', 0.25), ('Jog_Fwd_Loop_Rig', 0.25), ('Jump_Start_Rig', 0.7),
             ('Jump_Loop_Rig', 0.5), ('Jump_Land_Rig', 0.3), ('Death01_Rig', 1.0)]
    for clip, t in clips:
        frame = None
        for c in chars:
            a = c['acts'].get(clip)
            c['arm'].animation_data.action = a
            if a:
                f0, f1 = a.frame_range
                frame = f0 + (f1 - f0) * t
        if frame is None:
            continue
        scene.frame_set(int(frame), subframe=frame - int(frame))
        shoot(f'anim_{clip}', (6.5, -7.5, 1.6), (0, 0, 0.45), ORTHO)
print('DONE')

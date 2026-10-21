"""
머리·얼굴 스킨 가중치 정리: 머리 영역 정점에서 팔·어깨 본(Shoulder/UpperArm/LowerArm/Hand/손가락) 가중치를 빼고 Spine으로 옮긴다.
생성기 리깅이 얼굴 아래쪽 정점을 어깨·위팔 본에도 묶어 둬서, 무기마다 팔 IK·쇄골 자세가 바뀌면 얼굴이 늘어나 보이는 문제.
목 근처(fade 구간)는 비율을 서서히 줄여 목·후드가 끊기지 않게 한다. 메시 형상·본·클립은 그대로.

blender -b --factory-startup -P tools/blender/clean_head_weights.py -- <in.glb> <out.glb> [--fade 0.46 0.50]
높이는 Blender Z-up, 원본 높이 1.0 단위 (블루 기준 어깨 0.413, 목 0.433, 머리 시작 약 0.495)
"""
import sys

import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
in_path, out_path = argv[0], argv[1]
z0, z1 = 0.46, 0.50
if '--fade' in argv:
    i = argv.index('--fade')
    z0, z1 = float(argv[i + 1]), float(argv[i + 2])

ARM = ('Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'Thumb', 'Index', 'Middle', 'Ring', 'Little')

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=in_path)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and o is not mesh:
        bpy.data.objects.remove(o, do_unlink=True)

groups = mesh.vertex_groups
spine = groups.get('Spine')
assert spine, 'Spine 그룹 없음'
arm_idx = {g.index for g in groups if g.name.startswith(ARM)}


def smooth(x):
    t = min(1.0, max(0.0, (x - z0) / (z1 - z0)))
    return t * t * (3 - 2 * t)


mw = mesh.matrix_world
changed = 0
moved_total = 0.0
for v in mesh.data.vertices:
    k = smooth((mw @ v.co).z)
    if k <= 0:
        continue
    moved = 0.0
    for ge in v.groups:
        if ge.group in arm_idx and ge.weight > 0:
            d = ge.weight * k
            ge.weight -= d
            moved += d
    if moved > 1e-6:
        cur = next((ge.weight for ge in v.groups if ge.group == spine.index), 0.0)
        spine.add([v.index], cur + moved, 'REPLACE')
        changed += 1
        moved_total += moved
# 0이 된 팔 가중치는 정점에서 제거 (정점당 4개 영향 제한에 걸리지 않게)
for g in groups:
    if g.index in arm_idx:
        zero = [v.index for v in mesh.data.vertices for ge in v.groups if ge.group == g.index and ge.weight <= 1e-5]
        if zero:
            g.remove(zero)
print('CLEANED verts', changed, 'moved weight', round(moved_total, 2))

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

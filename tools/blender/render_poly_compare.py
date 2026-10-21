"""
원본 vs 최적화본 폴리곤 비교 렌더 (읽기 전용, GLB 수정 없음).

blender -b --factory-startup -P tools/blender/render_poly_compare.py -- <out.png> <a.glb> <b.glb> [...]

- 인자 순서대로 왼쪽부터, 같은 크기로 맞춰 나란히 (각 모델 경계 상자 최대 길이 = 1)
- 위 줄: 텍스처, 아래 줄: 와이어프레임 (삼각형 밀도 비교)
- 제목줄에 파일 이름·삼각형 수 출력 (콘솔 TRIS 줄)
"""
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
out_path = os.path.abspath(argv[0])
paths = argv[1:]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

SP = 1.25
items = []
for i, path in enumerate(paths):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    # 임포터가 만드는 본 표시용 구체(Icosphere, 부모 없음)는 게임 메시가 아니라 제외
    shapes = [o for o in new if o.type == 'MESH' and o.name.startswith('Icosphere')]
    new = [o for o in new if o not in shapes]
    for o in shapes:
        bpy.data.objects.remove(o)
    meshes = [o for o in new if o.type == 'MESH']
    tris = 0
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    dg = bpy.context.evaluated_depsgraph_get()
    for m in meshes:
        me = m.evaluated_get(dg).to_mesh()
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        for v in me.vertices:
            w = m.matrix_world @ v.co
            lo = Vector((min(lo[k], w[k]) for k in range(3)))
            hi = Vector((max(hi[k], w[k]) for k in range(3)))
        m.evaluated_get(dg).to_mesh_clear()
    ext = hi - lo
    size = max(ext)
    center = (lo + hi) / 2
    root = bpy.data.objects.new(f'root{i}', None)
    scene.collection.objects.link(root)
    for o in new:
        if o.parent is None:
            o.parent = root
            o.location -= center
    # 긴 축이 Y(glTF 앞뒤)면 Z축 90° 돌려 X(화면 가로)로 → -Y 카메라에서 옆면이 보임
    if ext.y > ext.x:
        root.rotation_euler = (0, 0, 1.5708)
    root.scale = (1 / size,) * 3
    root.location = Vector((i * SP, 0, 0))
    # 와이어 패스용 복제 (Wireframe 모디파이어, 원본 GLB는 그대로)
    wires = []
    for m in meshes:
        w = m.copy()
        w.data = m.data
        scene.collection.objects.link(w)
        w.parent = m.parent
        w.matrix_parent_inverse = m.matrix_parent_inverse.copy()
        mod = w.modifiers.new('wire', 'WIREFRAME')
        mod.thickness = 0.0025 * size
        mod.use_replace = True
        mod.use_even_offset = False
        w.color = (0.1, 0.15, 0.45, 1)
        w.hide_render = True
        wires.append(w)
    for m in meshes:
        m.color = (0.92, 0.92, 0.95, 1)
    items.append({'name': os.path.basename(path), 'tris': tris, 'meshes': meshes, 'wires': wires, 'root': root})
    print(f'TRIS {os.path.basename(path)} {tris}')

scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'
sh.background_type = 'VIEWPORT'
sh.background_color = (0.93, 0.93, 0.95)
scene.render.resolution_x = 1600
scene.render.resolution_y = 700
scene.render.image_settings.file_format = 'PNG'

cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = SP * len(items) + 0.2
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
mid = (len(items) - 1) * SP / 2
# 무기 측면 (glTF +X 길이 방향 가정 없이 -Y에서 바라봄)
cam.location = (mid, -6, 0.15)
cam.rotation_euler = (1.5708 - 0.03, 0, 0)

base, ext = os.path.splitext(out_path)
for mode, suffix in (('TEXTURE', '_texture'), ('WIRE', '_wire')):
    if mode == 'TEXTURE':
        sh.type = 'SOLID'
        sh.color_type = 'TEXTURE'
        sh.show_object_outline = False
    else:
        sh.type = 'SOLID'
        sh.color_type = 'OBJECT'
        sh.light = 'FLAT'
        for it in items:
            for w in it['wires']:
                w.hide_render = False
    scene.render.filepath = base + suffix + ext
    bpy.ops.render.render(write_still=True)
    print('RENDERED', scene.render.filepath)
print('DONE')

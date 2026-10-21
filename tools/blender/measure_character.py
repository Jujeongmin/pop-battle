"""
캐릭터 비율 기준점 측정 (읽기 전용).

blender -b --factory-startup -P tools/blender/measure_character.py -- <out_dir> <a.glb> [<b.glb> ...]

각 GLB 레스트 포즈 기준 (Blender Z-up, glTF 정면 +Z = Blender -Y):
- hip: UpperLeg_L/R 머리 높이 평균 (다리 시작)
- shoulder: UpperArm_L/R 머리 높이 평균
- neck: 팔 가중치 정점을 뺀 몸 단면 폭이 가장 좁은 높이 (0.42~0.6)
- crown: 목 위에서 단면 폭이 머리 최대 폭의 50% 아래로 떨어지는 높이 (방울 장식 시작, 없으면 모자 꼭대기 근처)
- head_w / head_d: 목~crown 사이 최대 폭·깊이, arm_span: 전체 x 폭
- 얼굴 정면 렌더(<이름>_face.png): 직교 1.0 × 1.0 범위, 1000px (1px = 0.001), 중심 (x 0, z 0.75)
결과: <out_dir>/landmarks.json
"""
import json
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
out_dir = os.path.abspath(argv[0])
paths = argv[1:]
os.makedirs(out_dir, exist_ok=True)

ARM_BONES = ('Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'Thumb', 'Index', 'Middle', 'Ring', 'Little')
results = {}

for path in paths:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    mesh = next(o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm)
    for o in bpy.data.objects:
        if o.type == 'MESH' and o is not mesh:
            o.hide_render = True
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    bones = arm.data.bones

    def bz(name):
        b = bones.get(name)
        return (arm.matrix_world @ b.head_local).z if b else None

    hip = (bz('UpperLeg_L') + bz('UpperLeg_R')) / 2
    shoulder = (bz('UpperArm_L') + bz('UpperArm_R')) / 2
    me = mesh.data
    names = [g.name for g in mesh.vertex_groups]
    pts_body = []
    pts_all = []
    for v in me.vertices:
        co = mesh.matrix_world @ v.co
        pts_all.append(co)
        best, bw = None, -1
        for ge in v.groups:
            if ge.weight > bw:
                bw, best = ge.weight, names[ge.group]
        if best and not best.startswith(ARM_BONES):
            pts_body.append(co)

    def width_at(z, pts, h=0.006):
        xs = [p.x for p in pts if abs(p.z - z) < h]
        ys = [p.y for p in pts if abs(p.z - z) < h]
        return (max(xs) - min(xs) if xs else 0.0, max(ys) - min(ys) if ys else 0.0)

    # 목: 어깨 위 ~ 0.62에서 팔 정점 제외 몸 폭이 가장 좁은 곳
    zs = [shoulder + 0.02 + i * 0.003 for i in range(int((0.62 - shoulder - 0.02) / 0.003))]
    profile_body = [(z, width_at(z, pts_body)[0]) for z in zs]
    neck = min(profile_body, key=lambda t: t[1] or 9)[0]
    head_pts = [p for p in pts_body if p.z > neck]
    top = max(p.z for p in pts_all)
    prof = [(neck + i * 0.004, *width_at(neck + i * 0.004, head_pts)) for i in range(int((top - neck) / 0.004) + 1)]
    head_w = max(w for _, w, _ in prof)
    head_d = max(d for _, _, d in prof)
    crown = top
    zmax_w = max(prof, key=lambda t: t[1])[0]
    for z, w, _ in prof:
        if z > zmax_w and w < 0.5 * head_w:
            crown = z
            break
    xs = [p.x for p in pts_all]
    r = {
        'hip': round(hip, 4), 'shoulder': round(shoulder, 4), 'neck': round(neck, 4), 'crown': round(crown, 4),
        'top': round(top, 4), 'head_w': round(head_w, 4), 'head_d': round(head_d, 4),
        'head_wz': round(zmax_w, 4), 'arm_span': round(max(xs) - min(xs), 4),
        'hand_L_x': round((arm.matrix_world @ bones['Hand_L'].head_local).x, 4),
        'upperarm_L_x': round((arm.matrix_world @ bones['UpperArm_L'].head_local).x, 4),
        'body_w_at_chest': round(width_at((neck + shoulder) / 2 - 0.05, pts_body)[0], 4),
        'neck_profile': [[round(z, 3), round(w, 3)] for z, w in profile_body[::3]],
    }
    name = os.path.splitext(os.path.basename(path))[0]
    results[name] = r
    print('LANDMARKS', name, r)

    # 얼굴 정면 렌더: 평면 텍스처 색 (조명 영향 최소)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    sh.light = 'FLAT'
    sh.color_type = 'TEXTURE'
    sh.background_type = 'VIEWPORT'
    sh.background_color = (1, 1, 1)
    scene.view_settings.view_transform = 'Standard'
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 1000
    cam_data = bpy.data.cameras.new('cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 1.0
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.location = (0, -10, 0.75)
    cam.rotation_euler = (Vector((0, 0, 0.75)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(out_dir, name + '_face.png')
    bpy.ops.render.render(write_still=True)

with open(os.path.join(out_dir, 'landmarks.json'), 'w', encoding='utf-8') as f:
    json.dump(results, f, indent=1)
print('DONE')

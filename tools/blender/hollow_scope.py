"""라이플 스코프 수정본: 렌즈를 별도 머티리얼로 분리하고 스코프 관 내벽을 추가해 비어 있는 관으로 만든다.
- 뒤 렌즈(접안부) → ScopeLensRear: 렌즈 평면 기준 원형 UV (u=오른쪽, v=위, 뒤에서 볼 때). 게임에서 확대 화면(RenderTexture) 표시
- 앞 렌즈(대물렌즈) → ScopeLensFront: 유리
- 내벽 → ScopeInner
원본은 읽기만 하고 새 파일로 내보낸다.

사용:
  blender -b --factory-startup -P tools/blender/hollow_scope.py -- <input.glb> <output.glb>

좌표 (Blender, glTF 가져오기 후): 스코프 축은 x=0, z=AXIS_Z, y축 방향 (뒤 렌즈 y<0, 앞 렌즈 y>0).
값은 tools/blender 분석(렌즈 원판 반지름·깊이, 관 벽 반지름)으로 정했다. 다른 모델에는 그대로 쓰지 말 것.
"""
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

AXIS_Z = 0.165
REAR = {"y": -0.163, "depth_tol": 0.006, "radius": 0.028, "normal_sign": -1}
FRONT = {"y": 0.152, "depth_tol": 0.008, "radius": 0.022, "normal_sign": 1}
# 내벽 원통 반지름: 렌즈로 고른 면의 꼭짓점 최대 반지름보다 조금 크게 (투명 렌즈 가장자리로 껍데기 안이 비치지 않게)
INNER_MARGIN = 0.0015
INNER_SEGMENTS = 40


def make_material(name, color, roughness, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "BLENDED"
        if hasattr(mat, "blend_method"):
            mat.blend_method = "BLEND"
    return mat


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    src, dst = argv[0], argv[1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src, merge_vertices=True)
    obj = [o for o in bpy.context.scene.objects if o.type == "MESH"][0]
    mesh = obj.data

    rear_mat = make_material("ScopeLensRear", (0.75, 0.9, 1.0), 0.05, alpha=0.2)
    front_mat = make_material("ScopeLensFront", (0.75, 0.9, 1.0), 0.05, alpha=0.2)
    inner_mat = make_material("ScopeInner", (0.06, 0.08, 0.18), 0.7)
    mesh.materials.append(rear_mat)
    mesh.materials.append(front_mat)
    mesh.materials.append(inner_mat)
    lens_idx = {"rear": len(mesh.materials) - 3, "front": len(mesh.materials) - 2}
    inner_idx = len(mesh.materials) - 1

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()

    # 1) 렌즈 원판 면 → ScopeLensRear / ScopeLensFront
    counts = {}
    max_r = {}
    lens_faces = {}
    for label, cap in (("rear", REAR), ("front", FRONT)):
        faces = []
        rmax = 0.0
        for f in bm.faces:
            c = f.calc_center_median()
            r = math.hypot(c.x, c.z - AXIS_Z)
            if r < cap["radius"] and abs(c.y - cap["y"]) < cap["depth_tol"] and f.normal.y * cap["normal_sign"] > 0.6:
                f.material_index = lens_idx[label]
                faces.append(f)
                for v in f.verts:
                    rmax = max(rmax, math.hypot(v.co.x, v.co.z - AXIS_Z))
        counts[label] = len(faces)
        max_r[label] = rmax
        lens_faces[label] = faces

    # 뒤 렌즈 원형 UV: 뒤에서 볼 때 오른쪽 = +x, 위 = +z (게임에서 렌더 타깃을 그대로 붙임)
    uv_layer = bm.loops.layers.uv.active or bm.loops.layers.uv.new()
    radius = max_r["rear"]
    for f in lens_faces["rear"]:
        for loop in f.loops:
            co = loop.vert.co
            loop[uv_layer].uv = (0.5 + co.x / (2 * radius), 0.5 + (co.z - AXIS_Z) / (2 * radius))
    print(f"[hollow_scope] rear lens UV radius {radius:.4f}")
    inner_rear = max_r["rear"] + INNER_MARGIN
    inner_front = max_r["front"] + INNER_MARGIN
    print(f"[hollow_scope] lens vertex max radius rear={max_r['rear']:.4f} front={max_r['front']:.4f}")

    # 2) 내벽 원통 (양끝 열림, 법선 안쪽) → ScopeInner
    length = FRONT["y"] - REAR["y"]
    geom = bmesh.ops.create_cone(
        bm,
        cap_ends=False,
        cap_tris=False,
        segments=INNER_SEGMENTS,
        radius1=inner_rear,
        radius2=inner_front,
        depth=length,
        calc_uvs=True,
    )
    verts = geom["verts"]
    # 원통은 -Z(radius1) → +Z(radius2) 방향. y축으로 눕히고 축 위치로 이동
    rot = Matrix.Rotation(-math.pi / 2, 4, "X")  # +Z → +Y
    center = Vector((0.0, (REAR["y"] + FRONT["y"]) / 2, AXIS_Z))
    bmesh.ops.transform(bm, matrix=Matrix.Translation(center) @ rot, verts=verts)
    inner_faces = list({f for v in verts for f in v.link_faces})
    for f in inner_faces:
        f.material_index = inner_idx
    bmesh.ops.reverse_faces(bm, faces=inner_faces)

    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    print(f"[hollow_scope] lens faces rear={counts['rear']} front={counts['front']}, inner wall faces={len(inner_faces)}")

    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_image_format="AUTO",
        export_jpeg_quality=88,
        export_animations=False,
        export_skins=False,
    )
    print(f"[hollow_scope] wrote {dst}")


main()

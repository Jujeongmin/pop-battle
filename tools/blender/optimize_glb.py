"""정적 GLB 최적화 (리깅 없는 무기·소품용). 원본은 읽기만 하고 새 파일로 내보낸다.

사용:
  blender -b --factory-startup -P tools/blender/optimize_glb.py -- \
      <input.glb> <output.glb> --tris 7000 --tex 1024 [--tex-orm 512] [--tex-normal 1024]

- Decimate(Collapse)로 목표 삼각형 수까지 줄인다. UV는 유지.
- 텍스처는 역할(Color / ORM / Normal)별 크기로 축소.
- 축·크기·원점은 바꾸지 않는다 (게임 장착값이 원본 좌표계를 가정).
"""
import argparse
import sys

import bpy


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--tris", type=int, default=7000)
    p.add_argument("--tex", type=int, default=1024, help="base color 텍스처 크기")
    p.add_argument("--tex-orm", type=int, default=None)
    p.add_argument("--tex-normal", type=int, default=None)
    return p.parse_args(argv)


def tri_count(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # UV 이음새에서 정점이 갈라져 있으면 Decimate가 틈을 만들기 쉬우므로 병합해서 가져온다
    bpy.ops.import_scene.gltf(filepath=args.input, merge_vertices=True)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("메시 없음")
    for obj in meshes:
        if obj.parent is None and obj.data.users > 1:
            raise SystemExit("공유 메시 데이터는 지원하지 않음")
        before = tri_count(obj)
        ratio = min(1.0, args.tris / max(1, before))
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        if ratio < 1.0:
            mod = obj.modifiers.new("Decimate", "DECIMATE")
            mod.decimate_type = "COLLAPSE"
            mod.ratio = ratio
            mod.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=mod.name)
        # 가져온 사용자 지정 노멀은 정점이 바뀌면 의미가 없으므로 지우고 부드럽게 다시 계산
        if obj.data.has_custom_normals:
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
        for poly in obj.data.polygons:
            poly.use_smooth = True
        print(f"[optimize] {obj.name}: tris {before} -> {tri_count(obj)} (ratio {ratio:.3f})")

    for img in bpy.data.images:
        if img.size[0] == 0:
            continue
        name = img.name.lower()
        if "normal" in name:
            target = args.tex_normal or args.tex
        elif "orm" in name or "metal" in name or "rough" in name:
            target = args.tex_orm or args.tex
        else:
            target = args.tex
        w, h = img.size
        if max(w, h) > target:
            s = target / max(w, h)
            img.scale(max(1, round(w * s)), max(1, round(h * s)))
            print(f"[optimize] image {img.name}: {w}x{h} -> {img.size[0]}x{img.size[1]}")

    bpy.ops.export_scene.gltf(
        filepath=args.output,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_image_format="AUTO",
        export_jpeg_quality=88,
        export_animations=False,
        export_skins=False,
    )
    print(f"[optimize] wrote {args.output}")


main()

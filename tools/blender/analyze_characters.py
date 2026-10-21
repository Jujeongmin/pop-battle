"""
캐릭터 GLB 구조·비율 분석 (읽기 전용, 원본 수정 없음).

blender -b --factory-startup -P tools/blender/analyze_characters.py -- <out.json> <a.glb> <b.glb> ...

각 GLB를 빈 씬에 불러와 레스트 포즈 기준으로 다음을 기록한다.
- 메시·머티리얼·텍스처·UV·셰이프 키, Armature 본 계층·레스트 위치, 버텍스 그룹, 애니메이션(액션)
- 전체 경계, 높이 구간별 폭/깊이 단면
- 정점별 주 본(가장 큰 가중치) 그룹의 경계 (팔·다리·손 등)
- 연결된 메시 조각(섬)별 경계·주 본·머티리얼 (장식·백팩 등 분리 부품 식별용)
좌표: Blender Z-up 미터. glTF 정면(+Z)은 Blender -Y.
"""
import json
import sys
from collections import Counter, defaultdict

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
out_path, glbs = argv[0], argv[1:]


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def bbox(points):
    if not points:
        return None
    xs, ys, zs = zip(*points)
    mn = (min(xs), min(ys), min(zs))
    mx = (max(xs), max(ys), max(zs))
    return {'min': [round(v, 4) for v in mn], 'max': [round(v, 4) for v in mx],
            'size': [round(mx[i] - mn[i], 4) for i in range(3)]}


def analyze(path):
    clear()
    bpy.ops.import_scene.gltf(filepath=path)
    res = {'file': path, 'objects': [], 'armatures': [], 'actions': [], 'meshes': []}
    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    for a in arms:
        a.data.pose_position = 'REST'
    bpy.context.view_layer.update()

    for o in bpy.data.objects:
        res['objects'].append({'name': o.name, 'type': o.type, 'parent': o.parent.name if o.parent else None,
                               'location': [round(v, 4) for v in o.matrix_world.translation],
                               'scale': [round(v, 4) for v in o.matrix_world.to_scale()]})

    for a in arms:
        bones = []
        for b in a.data.bones:
            hw = a.matrix_world @ b.head_local
            tw = a.matrix_world @ b.tail_local
            bones.append({'name': b.name, 'parent': b.parent.name if b.parent else None,
                          'head': [round(v, 4) for v in hw], 'tail': [round(v, 4) for v in tw],
                          'length': round((tw - hw).length, 4)})
        res['armatures'].append({'name': a.name, 'bone_count': len(bones), 'bones': bones})

    for act in bpy.data.actions:
        fr = act.frame_range
        n_curves = 0
        try:
            for layer in act.layers:
                for strip in layer.strips:
                    for bag in strip.channelbags:
                        n_curves += len(bag.fcurves)
        except AttributeError:
            n_curves = len(getattr(act, 'fcurves', []))
        res['actions'].append({'name': act.name, 'frames': [round(fr[0], 2), round(fr[1], 2)], 'fcurves': n_curves})

    images = []
    for img in bpy.data.images:
        images.append({'name': img.name, 'size': list(img.size)})
    res['images'] = images

    for o in [o for o in bpy.data.objects if o.type == 'MESH']:
        me = o.data
        mw = o.matrix_world
        info = {'name': o.name, 'verts': len(me.vertices), 'faces': len(me.polygons),
                'materials': [m.name if m else None for m in me.materials],
                'uv_layers': [uv.name for uv in me.uv_layers],
                'shape_keys': [k.name for k in me.shape_keys.key_blocks] if me.shape_keys else [],
                'vertex_groups': [g.name for g in o.vertex_groups],
                'modifiers': [(m.type, getattr(m, 'object', None) and m.object.name) for m in o.modifiers]}
        co = [tuple(mw @ v.co) for v in me.vertices]
        info['bbox'] = bbox(co)
        zmin = info['bbox']['min'][2]
        height = info['bbox']['size'][2]

        # 높이 구간 단면 (전체 높이 40등분)
        slices = defaultdict(list)
        for p in co:
            k = min(39, int((p[2] - zmin) / height * 40))
            slices[k].append(p)
        info['slices'] = [{'z': round(zmin + (k + 0.5) * height / 40, 4), 'n': len(v),
                           'width_x': round(max(q[0] for q in v) - min(q[0] for q in v), 4),
                           'depth_y': round(max(q[1] for q in v) - min(q[1] for q in v), 4),
                           'center_y': round((max(q[1] for q in v) + min(q[1] for q in v)) / 2, 4)}
                          for k, v in sorted(slices.items())]

        # 주 본 그룹
        names = {g.index: g.name for g in o.vertex_groups}
        dom = []
        groups = defaultdict(list)
        for v in me.vertices:
            best = max(v.groups, key=lambda g: g.weight, default=None)
            n = names.get(best.group) if best else None
            dom.append(n)
            groups[n].append(tuple(mw @ v.co))
        info['dominant_bone_groups'] = {str(k): {'count': len(v), 'bbox': bbox(v)} for k, v in groups.items()}

        # 머티리얼별 경계
        mat_pts = defaultdict(set)
        for poly in me.polygons:
            for vi in poly.vertices:
                mat_pts[poly.material_index].add(vi)
        info['material_bboxes'] = {str(me.materials[k].name if k < len(me.materials) and me.materials[k] else k):
                                   {'verts': len(v), 'bbox': bbox([co[i] for i in v])} for k, v in mat_pts.items()}

        # 연결된 조각(섬)
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        seen = set()
        islands = []
        for start in bm.verts:
            if start.index in seen:
                continue
            stack = [start]
            comp = []
            seen.add(start.index)
            while stack:
                v = stack.pop()
                comp.append(v.index)
                for e in v.link_edges:
                    w = e.other_vert(v)
                    if w.index not in seen:
                        seen.add(w.index)
                        stack.append(w)
            islands.append(comp)
        bm.free()
        islands.sort(key=len, reverse=True)
        info['island_count'] = len(islands)
        info['islands'] = []
        for comp in islands[:40]:
            bones = Counter(dom[i] for i in comp).most_common(3)
            info['islands'].append({'verts': len(comp), 'bbox': bbox([co[i] for i in comp]),
                                    'bones': [[b, c] for b, c in bones]})
        res['meshes'].append(info)
    return res


results = [analyze(p) for p in glbs]
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=1)
print('WROTE', out_path)

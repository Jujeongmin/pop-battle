"""
캐릭터 체형 변형 (실루엣 차별화): 메시 정점과 레스트 본을 같은 공간 변형으로 함께 옮긴다.
UV·텍스처·스킨 가중치·본 계층·애니메이션 클립은 그대로 (adjust_character.py와 같은 원칙, 연산만 체형용).

blender -b --factory-startup -P tools/blender/shape_character.py -- <config.json> <in.glb> <out.glb> [--measure-only]

입력은 높이 1.0으로 정규화된 게임용 캐릭터 GLB (Blender Z-up, 정면 -Y). config 키 (모두 생략 가능 = 변화 없음):
  hip_z, chest_z, neck_z      기준 높이 (엉덩이 관절·가슴·목). 생략하면 본 위치로 추정
  chest_width, waist_width    몸통 가로 배율 (가슴 높이 / 허리 높이, 사이는 보간). 몸통 = Hips·Spine·Chest 가중치, 목 위(머리) 제외
  torso_depth                 몸통 앞뒤 배율
  belly                       배 돌출 (정규화 단위, 앞쪽 위주·옆은 일부). 음수 = 허리 조임
  belly_z, belly_sigma        배 중심 높이·폭 (생략: 엉덩이~가슴 40% 지점, 0.06)
  shoulder_extra              어깨 바깥 이동 (몸통 가로 배율로 생긴 이동에 더함)
  arm_thickness, leg_thickness  팔(위·아래팔)·다리(허벅지·종아리) 굵기: 본 축 기준 방사 배율 (손·신발 제외)
  arm_length                  팔 길이 배율 (위팔 시작 x 바깥, adjust_character와 같은 방식)
  head_scale                  머리 균일 배율 (목 위, 목 기준점)
  hand_scale, foot_scale      손(손 본 기준)·신발(바닥 고정) 배율
  shoe_top                    신발 윗선 높이 (기본 0.075)
  z_from, z_to                세로 기준점 재배치 (다리 길이 등, 단조 3차 보간)
"""
import json
import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
cfg = json.load(open(argv[0], encoding='utf-8'))
in_path, out_path = argv[1], argv[2]
measure_only = '--measure-only' in argv

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=in_path)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and o is not mesh:
        bpy.data.objects.remove(o, do_unlink=True)

mw = mesh.matrix_world
aw = arm.matrix_world
inv, ainv = mw.inverted(), aw.inverted()
names = [g.name for g in mesh.vertex_groups]

# 레스트 본 위치 (월드)
bones = {b.name: (aw @ b.head_local, aw @ b.tail_local) for b in arm.data.bones}
def bz(n, d):
    return bones[n][0].z if n in bones else d
hip_z = cfg.get('hip_z', (bz('UpperLeg_L', 0.24) + bz('UpperLeg_R', 0.24)) / 2)
chest_z = cfg.get('chest_z', bz('Chest', 0.33))
neck_z = cfg.get('neck_z', max(bz('Shoulder_L', 0.4), bz('Shoulder_R', 0.4)) + 0.05)
shoe_top = cfg.get('shoe_top', 0.075)
upper_x = cfg.get('upperarm_x', abs(bones['UpperArm_L'][0].x) if 'UpperArm_L' in bones else 0.14)

def smooth(a, b, x):
    if b == a:
        return 1.0 if x >= b else 0.0
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)

# ---- 세로 재배치 (선택) ----
zf, zt = cfg.get('z_from'), cfg.get('z_to')
def make_fz():
    if not zf:
        return lambda z: z
    n = len(zf)
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
                return ((2 * t**3 - 3 * t**2 + 1) * zt[i] + (t**3 - 2 * t**2 + t) * h * m[i]
                        + (-2 * t**3 + 3 * t**2) * zt[i + 1] + (t**3 - t**2) * h * m[i + 1])
        return z
    return fz
fz = make_fz()

# ---- 정점별 가중치 묶음 ----
def group_weights(v):
    w = {}
    for ge in v.groups:
        w[names[ge.group]] = w.get(names[ge.group], 0.0) + ge.weight
    return w
def wsum(w, pred):
    return sum(val for k, val in w.items() if pred(k))
is_torso = lambda n: n in ('Hips', 'Spine', 'Chest')
is_shoulder = lambda n: n.startswith('Shoulder')
is_uarm = lambda n: n.startswith('UpperArm') or n.startswith('LowerArm')
is_hand = lambda n: n.startswith('Hand') or any(n.startswith(p) for p in ('Thumb', 'Index', 'Middle', 'Ring', 'Little'))
is_leg = lambda n: n.startswith('UpperLeg') or n.startswith('LowerLeg')

verts = [mw @ v.co for v in mesh.data.vertices]
W = [group_weights(v) for v in mesh.data.vertices]

# 몸통 중심 y (높이별): 몸통 정점의 y 평균을 높이 구간별로
bins = {}
for p, w in zip(verts, W):
    if wsum(w, is_torso) > 0.6 and hip_z - 0.04 < p.z < neck_z:
        bins.setdefault(int(p.z * 50), []).append(p.y)
def torso_cy(z):
    k = int(z * 50)
    for dk in (0, 1, -1, 2, -2, 3, -3):
        if k + dk in bins:
            ys = bins[k + dk]
            return (min(ys) + max(ys)) / 2
    return 0.0

def closest_on_segment(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return a + ab * t

def measure(points, weights):
    """몸통 최대 가로폭·앞뒤 두께(배 높이), 팔·다리 평균 반지름, 높이"""
    tx = [abs(p.x) for p, w in zip(points, weights) if wsum(w, is_torso) > 0.5 and hip_z < p.z < neck_z - 0.02]
    by = [p.y for p, w in zip(points, weights) if wsum(w, is_torso) > 0.5 and abs(p.z - (hip_z + 0.4 * (chest_z - hip_z))) < 0.02]
    def limb_r(pred, names_):
        rs = []
        for p, w in zip(points, weights):
            best = max(((w.get(n, 0.0), n) for n in names_), default=(0, None))
            if best[0] > 0.7 and best[1] in bones:
                a, b = bones[best[1]]
                rs.append((p - closest_on_segment(p, a, b)).length)
        return sum(rs) / len(rs) if rs else 0.0
    zs = [p.z for p in points]
    xs = [abs(p.x) for p in points]
    return {
        'height': round(max(zs) - min(zs), 4),
        'torso_width': round(2 * max(tx), 4) if tx else 0,
        'belly_depth': round(max(by) - min(by), 4) if by else 0,
        'arm_radius': round(limb_r(is_uarm, ['UpperArm_L', 'LowerArm_L', 'UpperArm_R', 'LowerArm_R']), 4),
        'leg_radius': round(limb_r(is_leg, ['UpperLeg_L', 'LowerLeg_L', 'UpperLeg_R', 'LowerLeg_R']), 4),
        'span': round(2 * max(xs), 4),
    }

before = measure(verts, W)
print('MEASURE_BEFORE', json.dumps(before))
if measure_only:
    print('DONE')
    sys.exit(0)

cw, ww = cfg.get('chest_width', 1.0), cfg.get('waist_width', 1.0)
td = cfg.get('torso_depth', 1.0)
belly = cfg.get('belly', 0.0)
belly_z = cfg.get('belly_z', hip_z + 0.4 * (chest_z - hip_z))
belly_s = cfg.get('belly_sigma', 0.06)
ta, tl = cfg.get('arm_thickness', 1.0), cfg.get('leg_thickness', 1.0)
al = cfg.get('arm_length', 1.0)
hsc = cfg.get('head_scale', 1.0)
hands, feet = cfg.get('hand_scale', 1.0), cfg.get('foot_scale', 1.0)

def width_at(z):
    t = smooth(hip_z, chest_z, z)
    return ww + (cw - ww) * t
# 어깨 이동: 가슴 가로 배율로 위팔 시작점이 밀려나는 만큼 + 추가
shoulder_dx = (cw - 1.0) * upper_x + cfg.get('shoulder_extra', 0.0)

def torso_band(z):
    """몸통 연산 적용 정도: 엉덩이 아래로 서서히, 목 위(머리)는 0"""
    return smooth(hip_z - 0.06, hip_z, z) * (1 - smooth(neck_z - 0.02, neck_z + 0.03, z))

# 신발 중심 (발별): 신발 높이 아래 다리 정점의 x·y 중심
shoe = {}
for side in (1, -1):
    pts = [p for p, w in zip(verts, W) if p.z < shoe_top and p.x * side > 0 and wsum(w, is_leg) > 0.5]
    if pts:
        shoe[side] = Vector((sum(p.x for p in pts) / len(pts), sum(p.y for p in pts) / len(pts), 0))

neck_pivot = Vector((0.0, torso_cy(neck_z - 0.02), neck_z))

def _tp(p, side, chain=None):
    """본 위치용: 위치 연산만 (어깨 이동·팔 길이). 굵기·배는 본 축을 움직이지 않음. 세로 재배치는 호출한 쪽에서"""
    q = p.copy()
    if chain in ('arm', 'hand'):
        q.x += side * shoulder_dx
        if al != 1.0 and abs(q.x) > upper_x + shoulder_dx:
            q.x += side * (abs(q.x) - (upper_x + shoulder_dx)) * (al - 1.0)
    return q

_hand_raw = {1: bones['Hand_L'][0] if 'Hand_L' in bones else None, -1: bones['Hand_R'][0] if 'Hand_R' in bones else None}

def deform_vertex(p, w):
    x, y, z = p.x, p.y, p.z
    out = p.copy()
    wt = wsum(w, is_torso) * torso_band(z)
    ws = wsum(w, is_shoulder)
    wa = wsum(w, is_uarm)
    wh = wsum(w, is_hand)
    wl = wsum(w, is_leg)
    side = 1 if x >= 0 else -1
    # 1) 팔·다리 굵기 (원래 본 축 기준 방사)
    if wa > 0 and ta != 1.0:
        best = max(((w.get(n, 0.0), n) for n in ('UpperArm_L', 'LowerArm_L', 'UpperArm_R', 'LowerArm_R') if n in bones), default=(0, None))
        if best[1]:
            c = closest_on_segment(p, *bones[best[1]])
            out += (p - c) * ((ta - 1.0) * min(1.0, wa))
    if wl > 0 and tl != 1.0:
        best = max(((w.get(n, 0.0), n) for n in ('UpperLeg_L', 'LowerLeg_L', 'UpperLeg_R', 'LowerLeg_R') if n in bones), default=(0, None))
        if best[1]:
            c = closest_on_segment(p, *bones[best[1]])
            k = smooth(shoe_top - 0.01, shoe_top + 0.03, z)  # 신발은 그대로
            out += (p - c) * ((tl - 1.0) * min(1.0, wl) * k)
    # 2) 몸통 가로·앞뒤·배
    if wt > 0:
        cy = torso_cy(z)
        sx = width_at(z)
        out.x += x * (sx - 1.0) * wt
        out.y += (y - cy) * (td - 1.0) * wt
        if belly != 0.0:
            r = Vector((x, y - cy, 0.0))
            if r.length > 1e-6:
                front = max(0.0, -(y - cy) / r.length)
                g = math.exp(-((z - belly_z) / belly_s) ** 2)
                out += r.normalized() * (belly * g * wt * (0.3 + 0.7 * front))
    # 3) 어깨·팔 바깥 이동 + 팔 길이
    wsa = min(1.0, wa + wh + ws)
    if wsa > 0 and shoulder_dx != 0.0:
        out.x += side * shoulder_dx * wsa
    if al != 1.0 and (wa + wh) > 0:
        ax = abs(out.x)
        if ax > upper_x + shoulder_dx:
            base = upper_x + shoulder_dx
            out.x += side * (ax - base) * (al - 1.0) * min(1.0, wa + wh)
    # 4) 손 크기 (손 본 기준, 1~3 이후 위치에 맞춰 이동한 손 중심)
    if wh > 0.3 and hands != 1.0 and _hand_raw.get(side) is not None:
        hc = _tp(_hand_raw[side], side, 'hand')
        out = hc + (out - hc) * (1 + (hands - 1.0) * min(1.0, wh))
    # 5) 머리 크기 (목 기준점)
    if hsc != 1.0:
        k = smooth(neck_z, neck_z + 0.04, z)
        if k > 0:
            out = neck_pivot + (out - neck_pivot) * (1 + (hsc - 1.0) * k)
    # 6) 신발 크기 (바닥 고정)
    if feet != 1.0 and wl > 0.5 and z < shoe_top + 0.02 and side in shoe:
        k = 1 - smooth(shoe_top - 0.01, shoe_top + 0.02, z)
        c = shoe[side]
        f = 1 + (feet - 1.0) * k
        out.x = c.x + (out.x - c.x) * f
        out.y = c.y + (out.y - c.y) * f
        out.z = out.z * f
    # 7) 세로 재배치
    out.z = fz(out.z)
    return out

new_verts = [deform_vertex(p, w) for p, w in zip(verts, W)]
for v, p in zip(mesh.data.vertices, new_verts):
    v.co = inv @ p
mesh.data.update()

# ---- 레스트 본 ----
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
for eb in arm.data.edit_bones:
    n = eb.name
    side = 1 if (aw @ eb.head).x >= 0 else -1
    chain = 'hand' if is_hand(n) else 'arm' if is_uarm(n) else None
    roll = eb.roll
    h, t = aw @ eb.head, aw @ eb.tail
    h2, t2 = _tp(h, side, chain), _tp(t, side, chain)
    if is_shoulder(n):
        # 어깨 본: 몸쪽 끝은 그대로, 바깥 끝은 위팔과 함께 이동
        t2 = _tp(t, side, 'arm')
    if is_hand(n) and hands != 1.0 and n != 'Hand_L' and n != 'Hand_R':
        hc = _tp(_hand_raw[side], side, 'hand')
        h2 = hc + (h2 - hc) * hands
        t2 = hc + (t2 - hc) * hands
    if n in ('Hand_L', 'Hand_R') and hands != 1.0:
        hc = h2
        t2 = hc + (t2 - hc) * hands
    h2.z, t2.z = fz(h2.z), fz(t2.z)
    eb.head = ainv @ h2
    eb.tail = ainv @ t2
    eb.roll = roll
bpy.ops.object.mode_set(mode='OBJECT')

after = measure(new_verts, W)
print('MEASURE_AFTER', json.dumps(after))

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

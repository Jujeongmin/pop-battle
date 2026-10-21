"""
팀 컬러 마스크 만들기 (캐릭터 GLB는 수정하지 않음, 읽기만).

  blender -b --factory-startup -P tools/blender/team_mask.py -- analyze <in.glb> <config.json> <out_dir>
  blender -b --factory-startup -P tools/blender/team_mask.py -- build   <in.glb> <config.json> <out_dir>

캐릭터는 스킨 메시 1개 + 베이크 텍스처 1장이라(눈·머리카락·장식도 텍스처) 머티리얼 색을 통째로 바꾸면 안 된다.
1) 영역: 정점 위치(레스트)·본 가중치로 면마다 비니 / 상의 / 그 외를 나눔
   - 비니: 머리 둘레 방향별 챙 높이(앞·옆·뒤 보간) 위
   - 상의: 밑단 높이 ~ 목 높이 사이 + 팔(어깨·위팔·아래팔), 손(Hand·손가락 가중치)·다리 가중치 큰 면 제외
2) 색: 영역 안 텍셀 중 설정의 기준색(Lab)과 가까운 것만 (피부·눈·머리카락·별·지퍼·흰 장식 제외)
3) UV 삼각형을 마스크 해상도로 래스터화 → R = 비니, G = 상의 (0/255). 섬 바깥 1~2px 번짐 (밉맵 경계 줄 방지)
4) JSON: 영역별 기준 밝기(선형 휘도 중앙값) → 게임 셰이더가 명암 비율을 유지하며 팀 색으로 바꿈

analyze: 영역별 텍셀 색 군집(k-means) 표 + 영역 미리보기 PNG → 설정의 기준색 고를 때 사용
build:   mask PNG + info JSON + 팀 색 미리보기 GLB (렌더 확인용, 게임에는 안 씀)
"""
import bpy, sys, os, json, math
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
mode, in_path, cfg_path, out_dir = argv[0], argv[1], argv[2], os.path.abspath(argv[3])
cfg = json.load(open(cfg_path, encoding='utf-8'))
os.makedirs(out_dir, exist_ok=True)
RES = cfg.get('res', 1024)
name = cfg['name']

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=in_path)
mesh_obj = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
me = mesh_obj.data
mw = mesh_obj.matrix_world
mat = me.materials[0]
img_node = next(n for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE')
img = img_node.image
W, H = img.size
tex_raw = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)[:, :, :3]  # 아래→위 행 (Blender UV v와 같은 방향)
# 8비트 sRGB 이미지의 pixels는 sRGB 부호화 값 → 선형으로 (게임 셰이더도 선형에서 계산)
SRGB = img.colorspace_settings.name.lower().startswith('srgb')
srgb2lin = lambda c: np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)
lin2srgb = lambda c: np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.clip(c, 0, None), 1 / 2.4) - 0.055).astype(np.float32)
tex = srgb2lin(tex_raw) if SRGB else tex_raw
# 작업 해상도로 축소 (평균)
f = W // RES
tex_s = tex.reshape(RES, f, RES, f, 3).mean(axis=(1, 3)) if f > 1 else tex.copy()

# ---- 정점 속성 ----
nv = len(me.vertices)
co = np.array([tuple(mw @ v.co) for v in me.vertices], dtype=np.float32)
groups = {g.index: g.name for g in mesh_obj.vertex_groups}
def wsum(pred):
    out = np.zeros(nv, dtype=np.float32)
    for v in me.vertices:
        s = 0.0
        for g in v.groups:
            if pred(groups.get(g.group, '')):
                s += g.weight
        out[v.index] = s
    return out
is_hand = lambda n: n.startswith('Hand') or any(n.startswith(p) for p in ('Thumb', 'Index', 'Middle', 'Ring', 'Little'))
is_leg = lambda n: n.startswith('UpperLeg') or n.startswith('LowerLeg') or n.startswith('Foot') or n.startswith('Toe')
is_arm = lambda n: n.startswith('Shoulder') or n.startswith('UpperArm') or n.startswith('LowerArm')
w_hand, w_leg, w_arm = wsum(is_hand), wsum(is_leg), wsum(is_arm)

# 머리 중심 (앞 = -Y: glTF +Z 정면이 Blender -Y)
head_sel = co[:, 2] > cfg['beanie']['back']
hc = co[head_sel].mean(axis=0) if head_sel.any() else np.zeros(3)

def brim_z(x, y):
    """챙 높이: 머리 중심 기준 방향각 θ (0 = 정면, π = 뒤). 앞→옆→뒤를 코사인으로 보간"""
    b = cfg['beanie']
    th = np.arctan2(x - hc[0], -(y - hc[1]))  # 정면 0
    c = np.cos(th)
    side = b['side']
    front_part = np.clip(c, 0, 1)
    back_part = np.clip(-c, 0, 1)
    return side + (b['front'] - side) * front_part ** b.get('power', 1.0) + (b['back'] - side) * back_part ** b.get('power', 1.0)

# ---- 면 분류 ----
uv_layer = me.uv_layers.active.data
tris = []  # (uv(3,2), region)
cov_tris = []
t = cfg['top']
for poly in me.polygons:
    vids = list(poly.vertices)
    loops = list(poly.loop_indices)
    P = co[vids]
    cz = P[:, 2].mean()
    cx, cy = P[:, 0].mean(), P[:, 1].mean()
    hand = w_hand[vids].max()
    leg = w_leg[vids].mean()
    arm = w_arm[vids].mean()
    region = 0
    face_z = t.get('face_z', t['max_z'])
    # 머리 중심 기준 방향 (1 = 정면, -1 = 뒤): 목 위에서는 뒤쪽(후드)만 상의로 (얼굴·앞머리 제외)
    facing = float(np.cos(np.arctan2(cx - hc[0], -(cy - hc[1]))))
    if hand < t.get('hand_max', 0.35):
        if cz > brim_z(cx, cy) and cz > face_z:
            region = 1
        elif leg < t.get('leg_max', 0.5) and (
            (t['hem_z'] <= cz <= face_z)
            or (face_z < cz <= t['max_z'] and facing < t.get('hood_facing_max', -0.2))
            or (arm > t.get('arm_min', 0.5) and cz > t['hem_z'] - 0.05)
        ):
            region = 2
    uvs = np.array([tuple(uv_layer[li].uv) for li in loops], dtype=np.float32)
    # 삼각형 부채꼴
    for k in range(1, len(loops) - 1):
        tri = uvs[[0, k, k + 1]]
        cov_tris.append(tri)
        if region:
            tris.append((tri, region))

def raster(tri_list, res):
    """UV 삼각형 → 정수 영역 이미지 (행 = v 아래→위)"""
    img_r = np.zeros((res, res), dtype=np.uint8)
    for tri, val in tri_list:
        p = tri * res
        x0, y0 = np.floor(p.min(axis=0)).astype(int)
        x1, y1 = np.ceil(p.max(axis=0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, res - 1), min(y1, res - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        a, b, c = p
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / d
        l2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / d
        l3 = 1 - l1 - l2
        inside = (l1 >= -1e-4) & (l2 >= -1e-4) & (l3 >= -1e-4)
        sub = img_r[y0:y1 + 1, x0:x1 + 1]
        sub[inside] = val
    return img_r

region_img = raster(tris, RES)
covered = raster([(tr, 1) for tr in cov_tris], RES)

# ---- 색 공간 ----
def to_lab(rgb_lin):
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]], dtype=np.float32)
    xyz = rgb_lin @ M.T
    xyz /= np.array([0.95047, 1.0, 1.08883], dtype=np.float32)
    e = 216 / 24389
    k = 24389 / 27
    fxyz = np.where(xyz > e, np.cbrt(xyz), (k * xyz + 16) / 116)
    L = 116 * fxyz[..., 1] - 16
    A = 500 * (fxyz[..., 0] - fxyz[..., 1])
    B = 200 * (fxyz[..., 1] - fxyz[..., 2])
    return np.stack([L, A, B], axis=-1)

lab = to_lab(tex_s)  # Blender 이미지 픽셀은 선형
lum = tex_s @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

def kmeans(X, k, it=20, seed=1):
    rng = np.random.default_rng(seed)
    C = X[rng.choice(len(X), k, replace=False)]
    for _ in range(it):
        d = ((X[:, None, :] - C[None]) ** 2).sum(-1)
        lab_ = d.argmin(1)
        for j in range(k):
            if (lab_ == j).any():
                C[j] = X[lab_ == j].mean(0)
    return C, lab_

if mode == 'analyze':
    rep = {}
    for reg, rname in ((1, 'beanie'), (2, 'top')):
        X = lab[region_img == reg]
        if len(X) == 0:
            continue
        sub = X[np.random.default_rng(0).choice(len(X), min(len(X), 30000), replace=False)]
        C, lbl = kmeans(sub, cfg.get('k', 7))
        share = np.bincount(lbl, minlength=len(C)) / len(lbl)
        order = np.argsort(-share)
        rows = [{'lab': [round(float(v), 1) for v in C[j]], 'share': round(float(share[j]), 3)} for j in order]
        rep[rname] = rows
        print('CLUSTERS', name, rname, json.dumps(rows, ensure_ascii=False))
    json.dump(rep, open(os.path.join(out_dir, f'{name}_clusters.json'), 'w'), indent=1, ensure_ascii=False)

def match(reg, refs):
    m = np.zeros(region_img.shape, dtype=bool)
    sel = region_img == reg
    for r in refs:
        ref = np.array(r['lab'], dtype=np.float32)
        d = lab - ref
        # 명암(L)은 덜 엄격하게: 주름·그늘도 같은 천
        dist = np.sqrt((d[..., 0] * r.get('l_weight', 0.45)) ** 2 + d[..., 1] ** 2 + d[..., 2] ** 2)
        m |= sel & (dist < r.get('tol', 16))
    return m

def morph(m, region_sel, n_close=1):
    """작은 구멍 메우기(영역 안에서만) + 섬 바깥 번짐 2px"""
    def dil(x):
        y = x.copy()
        y[1:] |= x[:-1]; y[:-1] |= x[1:]; y[:, 1:] |= x[:, :-1]; y[:, :-1] |= x[:, 1:]
        return y
    def ero(x):
        y = x.copy()
        y[1:] &= x[:-1]; y[:-1] &= x[1:]; y[:, 1:] &= x[:, :-1]; y[:, :-1] &= x[:, 1:]
        return y
    out = m.copy()
    for _ in range(n_close):
        out = dil(out)
    for _ in range(n_close):
        out = ero(out)
    out &= region_sel
    # 영역 밖이지만 어떤 면도 덮지 않은 빈 텍셀로 2px 번짐 (UV 섬 가장자리 필터링 대비)
    empty = covered == 0
    grow = out.copy()
    for _ in range(2):
        grow = dil(grow) & (empty | grow)
    return grow

def save_png(arr_rgb_u8, path):
    h, w, _ = arr_rgb_u8.shape
    im = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    # 마스크는 색 데이터가 아님: 비색(Non-Color)으로 두어 감마 변환 없이 0/255 그대로 저장 (픽셀을 넣기 전에 설정해야 버퍼가 유지됨)
    im.colorspace_settings.name = 'Non-Color'
    px = np.concatenate([arr_rgb_u8.astype(np.float32) / 255.0, np.ones((h, w, 1), np.float32)], axis=-1)
    im.pixels.foreach_set(px.ravel())
    im.update()
    im.filepath_raw = path
    im.file_format = 'PNG'
    im.save()

# 영역 미리보기 (analyze·build 공통): 빨강 = 비니 영역, 초록 = 상의 영역, 위에 원본 텍스처 흐리게
prev = (np.clip(tex_s, 0, 1) ** (1 / 2.2) * 255 * 0.55).astype(np.uint8)
prev[region_img == 1] = (prev[region_img == 1] * 0.4 + np.array([255, 40, 40]) * 0.6).astype(np.uint8)
prev[region_img == 2] = (prev[region_img == 2] * 0.4 + np.array([40, 255, 40]) * 0.6).astype(np.uint8)
save_png(prev, os.path.join(out_dir, f'{name}_regions.png'))

if mode == 'build':
    info = {'name': name, 'res': RES, 'regions': {}}
    masks = {}
    for reg, rname in ((1, 'beanie'), (2, 'top')):
        refs = cfg['refs'].get(rname, [])
        m = morph(match(reg, refs), region_img == reg) if refs else np.zeros(region_img.shape, bool)
        masks[rname] = m
        core = m & (region_img == reg)
        ref_lum = float(np.median(lum[core])) if core.any() else 0.0
        info['regions'][rname] = {'refLuminance': round(ref_lum, 5), 'coverage': round(float(core.mean()), 4)}
        print('MASK', name, rname, 'texels', int(core.sum()), 'refLum', round(ref_lum, 4))
    out = np.zeros((RES, RES, 3), np.uint8)
    out[masks['beanie'], 0] = 255
    out[masks['top'], 1] = 255
    # Blender 픽셀 배열은 아래→위. 저장하면 일반 이미지(위→아래)가 되어 glTF 텍스처와 같은 방향
    save_png(out, os.path.join(out_dir, f'{name}_team_mask.png'))
    json.dump(info, open(os.path.join(out_dir, f'{name}_team_mask.json'), 'w'), indent=1)

    # 팀 색 미리보기: 게임 셰이더와 같은 공식으로 텍스처 색을 바꿔 GLB로 내보냄 (렌더 확인용)
    def srgb_to_lin(c):
        c = np.array(c, np.float32) / 255
        return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    tc = cfg.get('team_colors', {'blue': [0x28, 0x78, 0xFF], 'red': [0xFF, 0x45, 0x45]})
    up = lambda m: np.repeat(np.repeat(m, f, axis=0), f, axis=1) if f > 1 else m
    lum_full = tex @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    sh = cfg.get('shade', {'min': 0.55, 'max': 1.5, 'strength': 0.85})
    for team, rgb in tc.items():
        team_lin = srgb_to_lin(rgb)
        new = tex.copy()
        for rname in ('beanie', 'top'):
            m = up(masks[rname])
            ref = max(info['regions'][rname]['refLuminance'], 1e-4)
            ratio = np.clip(lum_full / ref, sh['min'], sh['max'])
            ratio = 1 + (ratio - 1) * sh['strength']
            new[m] = team_lin[None, :] * ratio[m][:, None]
        enc = lin2srgb(np.clip(new, 0, 1)) if SRGB else new
        px = np.concatenate([enc, np.ones((H, W, 1), np.float32)], axis=-1)
        img.pixels.foreach_set(px.ravel())
        img.update()
        p = os.path.join(out_dir, f'{name}_preview_{team}.glb')
        bpy.ops.export_scene.gltf(filepath=p, export_format='GLB', export_animations=False)
        print('PREVIEW', p)
print('DONE')

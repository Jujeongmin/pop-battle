"""
사망 표정(X X 눈) 텍스처 만들기. 캐릭터 GLB는 읽기만 함.

  blender -b --factory-startup -P tools/blender/dead_eyes.py -- <in.glb> <name> <out_dir> [config.json]

캐릭터는 스킨 메시 1개 + 베이크 텍스처 1장 (눈·입·눈썹이 모두 텍스처에 그려져 있음, 눈 메시·모프 타깃 없음).
→ 눈 영역만 덮는 작은 RGBA 텍스처를 만든다 (게임은 사망 때 그 영역만 교체):
1) 얼굴 정면 투영 격자 (1px = 0.001 GLB 단위): 앞을 보는 머리 삼각형을 래스터화해 가장 앞 표면의 텍스처 색·깊이·UV를 저장
2) 눈 찾기: 피부색(눈 아래 볼 영역 중앙값)과 색이 다른 덩어리 중, 가장 어두운 점(눈동자)에서 시작해 이어진 영역 (좌우 각각).
   설정 eyes가 있으면 그 타원 사용 (자동 검출 대신)
3) 눈 타원 + 여유(margin) 영역을 주변 피부색으로 메움 (경계에서 안쪽으로 확산, 명암 그라데이션 유지)
4) 각 눈 중심에 X (둥근 끝, 짙은 회색) — 투영 평면에 그려서 UV 경계와 무관하게 이어짐
5) 텍스처 공간으로 되돌림: 앞 표면 텍셀만 (깊이 비교), 바뀐 영역을 감싼 사각형만 원본 해상도로 저장
출력: <name>_dead_eyes.png (RGBA, sRGB, 사각형 영역), <name>_dead_eyes.json (UV 사각형 = glTF UV 기준 x, y, w, h),
     분석용 <name>_face.png (투영 원본), <name>_face_dead.png (결과 미리보기), <name>_face_mask.png (눈 영역)
"""
import json
import math
import os
import sys

import bpy
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
in_path, name, out_dir = argv[0], argv[1], os.path.abspath(argv[2])
cfg = json.load(open(argv[3], encoding='utf-8')) if len(argv) > 3 and os.path.exists(argv[3]) else {}
# --shape-key <out.glb>: 눈 부위를 얼굴 곡면으로 평탄화한 'Dead' 셰이프 키를 추가해 내보냄 (기본 형태는 그대로)
shape_out = argv[argv.index('--shape-key') + 1] if '--shape-key' in argv else None
os.makedirs(out_dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=in_path)
mesh_obj = next(o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.name.startswith('Icosphere'))
me = mesh_obj.data
mw = mesh_obj.matrix_world
mat = me.materials[0]
img = next(n for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE').image
W, H = img.size
tex = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)[:, :, :3]  # 아래→위 행, sRGB 부호화 값

# ---- 정점 (레스트 = 바인드 포즈), 삼각형, UV ----
co = np.array([mw @ v.co for v in me.vertices], dtype=np.float64)  # Blender: x 옆, -y 앞, z 위
me.calc_loop_triangles()
uv_layer = me.uv_layers.active.data
tris = np.array([t.vertices[:] for t in me.loop_triangles], dtype=np.int64)
tri_uv = np.array([[uv_layer[l].uv[:] for l in t.loops] for t in me.loop_triangles], dtype=np.float64)
height = co[:, 2].max()

PX = 0.001
X0, X1 = -0.34, 0.34
Z0, Z1 = 0.36 * height, 0.92 * height
GW = int(round((X1 - X0) / PX))
GH = int(round((Z1 - Z0) / PX))
depth = np.full((GH, GW), np.inf)
color = np.zeros((GH, GW, 3), np.float32)
covered = np.zeros((GH, GW), bool)

p = co[tris]  # (T, 3, 3)
n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
front = n[:, 1] < 0  # 앞(-y)을 보는 면
cz = p[:, :, 2].mean(axis=1)
cx = p[:, :, 0].mean(axis=1)
cand = np.nonzero(front & (cz > Z0 - 0.02) & (cz < Z1 + 0.02) & (np.abs(cx) < X1 + 0.02))[0]


def bary(px, py, a, b, c):
    """2D 무게중심 좌표 (px, py 배열)"""
    v0 = b - a
    v1 = c - a
    d = v0[0] * v1[1] - v1[0] * v0[1]
    if abs(d) < 1e-14:
        return None
    w1 = ((px - a[0]) * v1[1] - v1[0] * (py - a[1])) / d
    w2 = (v0[0] * (py - a[1]) - (px - a[0]) * v0[1]) / d
    return 1 - w1 - w2, w1, w2


def sample_tex(u, v):
    x = np.clip((u * W).astype(np.int64), 0, W - 1)
    y = np.clip((v * H).astype(np.int64), 0, H - 1)
    return tex[y, x]


# 1) 정면 투영 래스터화 (가장 앞 = y 최소)
for t in cand:
    a, b, c = p[t]
    gx = (np.array([a[0], b[0], c[0]]) - X0) / PX
    gz = (np.array([a[2], b[2], c[2]]) - Z0) / PX
    i0, i1 = max(0, int(math.floor(gx.min()))), min(GW - 1, int(math.ceil(gx.max())))
    j0, j1 = max(0, int(math.floor(gz.min()))), min(GH - 1, int(math.ceil(gz.max())))
    if i1 < i0 or j1 < j0:
        continue
    ii, jj = np.meshgrid(np.arange(i0, i1 + 1) + 0.5, np.arange(j0, j1 + 1) + 0.5)
    w = bary(ii, jj, np.array([gx[0], gz[0]]), np.array([gx[1], gz[1]]), np.array([gx[2], gz[2]]))
    if w is None:
        continue
    w0, w1, w2 = w
    inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
    if not inside.any():
        continue
    y = w0 * a[1] + w1 * b[1] + w2 * c[1]
    jj_i = (jj - 0.5).astype(np.int64)
    ii_i = (ii - 0.5).astype(np.int64)
    sel = inside & (y < depth[jj_i, ii_i])
    if not sel.any():
        continue
    uv = tri_uv[t]
    u = w0 * uv[0, 0] + w1 * uv[1, 0] + w2 * uv[2, 0]
    v = w0 * uv[0, 1] + w1 * uv[1, 1] + w2 * uv[2, 1]
    depth[jj_i[sel], ii_i[sel]] = y[sel]
    color[jj_i[sel], ii_i[sel]] = sample_tex(u[sel], v[sel])
    covered[jj_i[sel], ii_i[sel]] = True


def save_png(path, rgb, alpha=None):
    h, w = rgb.shape[:2]
    out = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    rgba = np.ones((h, w, 4), np.float32)
    rgba[:, :, :3] = rgb
    if alpha is not None:
        rgba[:, :, 3] = alpha
    out.pixels.foreach_set(rgba.ravel())
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)


save_png(os.path.join(out_dir, f'{name}_face.png'), color)

# 2) 눈 찾기
gx_m = X0 + (np.arange(GW) + 0.5) * PX  # 열 → x
gz_m = Z0 + (np.arange(GH) + 0.5) * PX  # 행 → z
XX, ZZ = np.meshgrid(gx_m, gz_m)
lum = color @ np.array([0.299, 0.587, 0.114], np.float32)

eye_band = covered & (ZZ > Z0 + 0.15 * (Z1 - Z0)) & (ZZ < Z0 + 0.75 * (Z1 - Z0)) & (np.abs(XX) < 0.26)
# 눈동자: 좌우 각각 가장 어두운 1.5% 픽셀의 중심
pupils = {}
for side in (-1, 1):
    roi = eye_band & (np.sign(XX) == side) & (np.abs(XX) > 0.02)
    if roi.any():
        thr = np.percentile(lum[roi], 1.5)
        pupils[side] = np.argwhere(roi & (lum <= thr)).mean(axis=0).astype(int)
# 피부색: 두 눈동자 사이(콧등)와 눈 아래 볼 — 눈동자 기준 상대 위치라 캐릭터마다 맞음
pj = int(np.mean([v[0] for v in pupils.values()]))
skin_px = covered & (np.abs(ZZ - gz_m[pj] + 0.1) < 0.02) & (np.abs(XX) < 0.14)
skin_px |= covered & (np.abs(ZZ - gz_m[pj]) < 0.015) & (np.abs(XX) < 0.012)
skin = np.median(color[skin_px], axis=0)
print('SKIN', skin.round(3).tolist(), int(skin_px.sum()))
diff = np.linalg.norm(color - skin, axis=2)
# 피부 판정: 색 거리 + 피부 색조(붉은기 r-b). 눈동자 가장자리의 회색 중간색은 피부로 보지 않음
warm = (color[:, :, 0] - color[:, :, 2]) > 0.5 * (skin[0] - skin[2])
eyes = cfg.get('eyes')
if not eyes:
    eyes = []
    for side in (-1, 1):
        if side not in pupils:
            continue
        sj, si = pupils[side]
        # 눈동자 중심에서 광선: 처음으로 피부색이 3px 이어지는 곳 = 눈 경계 (위쪽은 비니·눈썹에 붙어 있어도 피부 틈에서 멈춤)
        tol = cfg.get('skin_tol', 0.2)
        maxr = cfg.get('max_eye_radius', 0.12) / PX
        pts = []
        for k in range(36):
            ang = 2 * math.pi * k / 36
            dx, dz = math.cos(ang), math.sin(ang)
            run = 0
            hit = None
            for step in range(3, int(maxr)):
                i = int(round(si + dx * step))
                j = int(round(sj + dz * step))
                if i < 0 or i >= GW or j < 0 or j >= GH or not covered[j, i]:
                    break
                run = run + 1 if (diff[j, i] < tol and warm[j, i]) else 0
                if run >= 4:
                    hit = step - 3
                    break
            if hit is not None:
                pts.append((gx_m[si] + dx * hit * PX, gz_m[sj] + dz * hit * PX, hit))
        if len(pts) < 8:
            continue
        dist = np.array([q[2] for q in pts])
        med = np.median(dist)
        pts = [q for q in pts if q[2] < med * 1.45]
        P = np.array([[q[0], q[1]] for q in pts])
        # 축 정렬 타원 최소제곱: A x² + B z² + C x + D z = 1
        M = np.stack([P[:, 0] ** 2, P[:, 1] ** 2, P[:, 0], P[:, 1]], axis=1)
        A, Bq, C, D = np.linalg.lstsq(M, np.ones(len(P)), rcond=None)[0]
        ecx, ecz = -C / (2 * A), -D / (2 * Bq)
        G = 1 + A * ecx * ecx + Bq * ecz * ecz
        rx, rz = math.sqrt(G / A), math.sqrt(G / Bq)
        eyes.append({'cx': round(ecx, 4), 'cz': round(ecz, 4), 'rx': round(rx, 4), 'rz': round(rz, 4), 'rays': len(pts)})
if len(eyes) == 2 and cfg.get('symmetric', True):
    # 얼굴은 좌우 대칭: 앞머리·비니에 가린 쪽은 작게 잡히므로 크기는 큰 쪽, 높이는 덜 가린(큰) 눈, 가로는 중심선 기준 대칭
    l, r = sorted(eyes, key=lambda e: e['cx'])
    big = max(eyes, key=lambda e: e['rx'] * e['rz'])
    mid = (l['cx'] + r['cx']) / 2
    half = (r['cx'] - l['cx']) / 2
    cz_ = big['cz']
    rx_ = max(l['rx'], r['rx'])
    rz_ = max(l['rz'], r['rz'])
    eyes = [{'cx': round(mid - half, 4), 'cz': round(cz_, 4), 'rx': round(rx_, 4), 'rz': round(rz_, 4)},
            {'cx': round(mid + half, 4), 'cz': round(cz_, 4), 'rx': round(rx_, 4), 'rz': round(rz_, 4)}]
for e in eyes:
    for k, v in cfg.get('eye_adjust', {}).items():
        e[k] = round(e[k] + v, 4)
print('EYES', json.dumps(eyes))

# 가림 물체(비니 챙·앞머리) 제외: 눈 중심에서 깊이가 이어지는 표면만 따라감.
# 눈알은 얼굴에서 볼록 솟아 있지만 매끈하게 이어지고, 앞머리·챙은 별도 형상이라 경계에서 깊이가 끊김
step_thr = cfg.get('depth_step', 0.0035)
domain = np.zeros((GH, GW), bool)
for e in eyes:
    area = covered & (((XX - e['cx']) / (e['rx'] + 0.02)) ** 2 + ((ZZ - e['cz']) / (e['rz'] + 0.02)) ** 2 <= 1)
    j0 = int((e['cz'] - Z0) / PX)
    i0 = int((e['cx'] - X0) / PX)
    # 시작점: 중심 근처에서 가장 뒤쪽(얼굴 표면) 픽셀 (중심이 앞머리에 가려 있어도 눈 위에서 시작)
    best = None
    for dj in range(-8, 9, 2):
        for di in range(-8, 9, 2):
            j, i = j0 + dj, i0 + di
            if 0 <= j < GH and 0 <= i < GW and area[j, i] and (best is None or depth[j, i] > depth[best]):
                best = (j, i)
    if best is None:
        continue
    st = [best]
    domain[best] = True
    while st:
        j, i = st.pop()
        dj0 = depth[j, i]
        for nj, ni in ((j + 1, i), (j - 1, i), (j, i + 1), (j, i - 1)):
            if 0 <= nj < GH and 0 <= ni < GW and not domain[nj, ni] and area[nj, ni] and abs(depth[nj, ni] - dj0) < step_thr:
                domain[nj, ni] = True
                st.append((nj, ni))
occluder = covered & ~domain
save_png(os.path.join(out_dir, f'{name}_face_domain.png'), np.where(domain[:, :, None], color, color * 0.25))

# 3) 검은 눈동자 찾기 (흰자는 그대로 둠): 눈동자 중심에서 광선 → 마지막 어두운 픽셀 = 눈동자 경계
#    (눈동자 안 흰 반사광은 뒤에 어두운 픽셀이 다시 나오므로 건너뜀, 흰자가 연속 6px 나오면 멈춤)
sat = color.max(axis=2) - color.min(axis=2)
pupil_list = []
white_dbg = np.zeros((GH, GW), bool)
eye_inner = np.zeros((GH, GW), bool)
for e in eyes:
    side = 1 if e['cx'] > (eyes[0]['cx'] + eyes[-1]['cx']) / 2 else -1
    if side not in pupils:
        continue
    inside_eye = covered & (((XX - e['cx']) / e['rx']) ** 2 + ((ZZ - e['cz']) / e['rz']) ** 2 <= 1)
    # 시작점: 눈 타원 안 + 깊이 연속 영역(앞머리·챙 제외)에서 가장 어두운 3% 픽셀 중심 (앞머리 그늘을 눈동자로 잡지 않게)
    search = inside_eye & domain
    if search.sum() > 50:
        thr_s = np.percentile(lum[search], 3)
        sj, si = np.argwhere(search & (lum <= thr_s)).mean(axis=0).astype(int)
    else:
        sj, si = pupils[side]
    sclera = inside_eye & (lum > 0.7) & (sat < 0.15)
    l_s = np.median(lum[sclera]) if sclera.any() else 0.9
    l_p = np.percentile(lum[inside_eye], 2)
    dark_thr = l_p + cfg.get('pupil_threshold', 0.5) * (l_s - l_p)
    maxr = max(e['rx'], e['rz']) * 1.05 / PX
    pts = []
    for k in range(48):
        ang = 2 * math.pi * k / 48
        dx, dz = math.cos(ang), math.sin(ang)
        last_dark = None
        run = 0
        for step in range(1, int(maxr)):
            i = int(round(si + dx * step))
            j = int(round(sj + dz * step))
            if i < 0 or i >= GW or j < 0 or j >= GH or not covered[j, i]:
                break
            if lum[j, i] < dark_thr:
                last_dark = step
                run = 0
            elif lum[j, i] > 0.7 * l_s and sat[j, i] < 0.2:
                run += 1
                if run >= 6:
                    break
            else:
                run = 0
        if last_dark:
            pts.append((gx_m[si] + dx * (last_dark + 0.5) * PX, gz_m[sj] + dz * (last_dark + 0.5) * PX, last_dark))
    dist = np.array([q[2] for q in pts])
    med = np.median(dist)
    pts = [q for q in pts if 0.7 * med < q[2] < 1.4 * med]
    P_ = np.array([[q[0], q[1]] for q in pts])
    M_ = np.stack([P_[:, 0] ** 2, P_[:, 1] ** 2, P_[:, 0], P_[:, 1]], axis=1)
    A_, B_, C_, D_ = np.linalg.lstsq(M_, np.ones(len(P_)), rcond=None)[0]
    pcx, pcz = -C_ / (2 * A_), -D_ / (2 * B_)
    G_ = 1 + A_ * pcx * pcx + B_ * pcz * pcz
    # ex, ez = 흰자 중심: X는 원래 눈동자 위치가 아니라 흰자 가운데에 그림 (원래 눈동자는 위쪽을 보는 등 치우쳐 있음).
    # 눈동자에서 시작해 피부가 아닌 픽셀(흰자·눈동자·테두리)을 따라간 영역의 범위 중심. 비니 챙·앞머리는 깊이 연속 영역(domain) 밖이라 제외
    eye_px = np.zeros((GH, GW), bool)
    lim = 1.6 * max(e['rx'], e['rz']) / PX
    st = [(sj, si)]
    # 눈 픽셀 = 채도 낮음(흰자·회색 테두리·반사광) 또는 어두움(눈동자). 그늘진 피부는 채도가 있어 제외
    # 어두운 픽셀은 눈동자 타원(1.25배) 안만 (앞머리·머리카락 그늘이 흰자 영역에 섞이지 않게)
    near_pupil = ((XX - pcx) / (math.sqrt(G_ / A_) * 1.25)) ** 2 + ((ZZ - pcz) / (math.sqrt(G_ / B_) * 1.25)) ** 2 <= 1
    # 흰자 = 채도 낮고 밝음 (채도 낮은 갈색 앞머리는 어두워서 제외)
    notskin = domain & (((sat < cfg.get('white_sat', 0.16)) & (lum > 0.55 * l_s)) | ((lum < dark_thr) & near_pupil))
    while st:
        j, i = st.pop()
        if j < 0 or j >= GH or i < 0 or i >= GW or eye_px[j, i] or not notskin[j, i] or (j - sj) ** 2 + (i - si) ** 2 > lim * lim:
            continue
        eye_px[j, i] = True
        st.extend(((j + 1, i), (j - 1, i), (j, i + 1), (j, i - 1)))
    # 얇은 띠(비니 챙·앞머리 가장자리를 따라 이어진 부분) 제거: 침식 k px 후 눈동자에 이어진 덩어리만 다시 팽창
    k_open = cfg.get('white_open_px', 4)
    er = eye_px.copy()
    for _ in range(k_open):
        er = er & np.roll(er, 1, 0) & np.roll(er, -1, 0) & np.roll(er, 1, 1) & np.roll(er, -1, 1)
    core = np.zeros_like(er)
    st = [(sj, si)]
    while st:
        j, i = st.pop()
        if j < 0 or j >= GH or i < 0 or i >= GW or core[j, i] or not er[j, i]:
            continue
        core[j, i] = True
        st.extend(((j + 1, i), (j - 1, i), (j, i + 1), (j, i - 1)))
    for _ in range(k_open):
        core = core | np.roll(core, 1, 0) | np.roll(core, -1, 0) | np.roll(core, 1, 1) | np.roll(core, -1, 1)
    eye_px = core & eye_px
    white_dbg[eye_px] = True
    # 흰자 타원: 밝은 흰자가 눈 테두리(눈꺼풀선)·피부와 만나는 경계점에 타원을 맞춤. 눈동자에 닿은 경계는 빼서
    # (눈동자가 눈꺼풀선에 붙은 캐릭터는 그 부분을 나머지 호로 추정) → 메우기·X 기준. 눈꺼풀선은 타원 밖이라 보존
    rp_ = math.sqrt(G_ / A_)
    rq_ = math.sqrt(G_ / B_)
    pup_zone = ((XX - pcx) / (rp_ * 1.15 + 0.003)) ** 2 + ((ZZ - pcz) / (rq_ * 1.15 + 0.003)) ** 2 <= 1
    bright = eye_px & (sat < cfg.get('white_sat', 0.16)) & (lum > 0.55 * l_s)
    eyeish = bright | pup_zone
    edge = bright & ~pup_zone & ~(np.roll(eyeish, 1, 0) & np.roll(eyeish, -1, 0) & np.roll(eyeish, 1, 1) & np.roll(eyeish, -1, 1))
    ej, ei = np.nonzero(edge)
    fit_ok = False
    if len(ej) > 40:
        # 축 정렬 타원: (x-cx)² + k (z-cz)² = r² → x² + k z² + C x + D z + E = 0 을 상대 좌표(눈동자 기준)에서 최소제곱
        Pw = np.stack([gx_m[ei] - pcx, gz_m[ej] - pcz], axis=1)
        Mw = np.stack([Pw[:, 1] ** 2, Pw[:, 0], Pw[:, 1], np.ones(len(Pw))], axis=1)
        kw, Cw, Dw, Ew = np.linalg.lstsq(Mw, -(Pw[:, 0] ** 2), rcond=None)[0]
        if kw > 0:
            ex_r, ez_r = -Cw / 2, -Dw / (2 * kw)
            Gw = ex_r * ex_r + kw * ez_r * ez_r - Ew
            ex_, ez_ = ex_r + pcx, ez_r + pcz
            Aw, Bw = 1.0, kw
            if Gw > 0:
                wx_, wz_ = math.sqrt(Gw / Aw), math.sqrt(Gw / Bw)
                # 검출된 흰자 범위와 크게 다르지 않으면 채택 (위쪽이 비니에 잘린 흰자도 나머지 호로 추정)
                bj0, bi0 = np.nonzero(eye_px)
                bx_ = (gx_m[bi0.max()] - gx_m[bi0.min()]) / 2
                bz_ = (gz_m[bj0.max()] - gz_m[bj0.min()]) / 2
                fit_ok = 0.6 * bx_ < wx_ < 1.5 * bx_ and 0.6 * bz_ < wz_ < 1.6 * bz_ and abs(ex_ - pcx) < bx_ and abs(ez_ - pcz) < bz_
    print('WHITE_FIT', len(ej), fit_ok, round(float(ex_), 4) if fit_ok else None, round(float(ez_), 4) if fit_ok else None, round(float(wx_), 4) if fit_ok else None, round(float(wz_), 4) if fit_ok else None)
    if not fit_ok:
        bj, bi = np.nonzero(eye_px)
        ex_, ez_ = (gx_m[bi.min()] + gx_m[bi.max()]) / 2, (gz_m[bj.min()] + gz_m[bj.max()]) / 2
        wx_, wz_ = (gx_m[bi.max()] - gx_m[bi.min()]) / 2, (gz_m[bj.max()] - gz_m[bj.min()]) / 2
    shrink = cfg.get('white_shrink', 0.0015)
    inner = covered & (((XX - ex_) / max(wx_ - shrink, 1e-3)) ** 2 + ((ZZ - ez_) / max(wz_ - shrink, 1e-3)) ** 2 <= 1)
    white_dbg[edge] = True
    eye_inner |= inner
    pupil_list.append({'cx': round(pcx, 4), 'cz': round(pcz, 4), 'rx': round(math.sqrt(G_ / A_), 4), 'rz': round(math.sqrt(G_ / B_), 4), 'rays': len(pts),
                       'ex': round(ex_, 4), 'ez': round(ez_, 4), 'white_rx': round(wx_, 4), 'white_rz': round(wz_, 4)})
for pp in pupil_list:
    for k, v in cfg.get('pupil_adjust', {}).items():
        pp[k] = round(pp[k] + v, 4)
    # X 중심 보정 (흰자 검출이 앞머리 등에 가려 치우친 캐릭터만, 설정 x_offset = [x, z])
    off = cfg.get('x_offset', [0, 0])
    pp['ex'] = round(pp['ex'] + off[0], 4)
    pp['ez'] = round(pp['ez'] + off[1], 4)
# 좌우 눈 X 크기 통일: 눈동자 반지름은 두 눈 평균 (같은 디자인의 눈 — 검출 오차로 좌우 X 크기가 달라지지 않게)
if pupil_list and cfg.get('pupil_symmetric', True):
    r_mean = float(np.mean([(pp['rx'] + pp['rz']) / 2 for pp in pupil_list]))
    for pp in pupil_list:
        pp['r'] = round(r_mean, 4)
else:
    for pp in pupil_list:
        pp['r'] = round((pp['rx'] + pp['rz']) / 2, 4)
mid_x = float(np.mean([pp['cx'] for pp in pupil_list])) if pupil_list else 0.0
# 흰자도 좌우 대칭: 앞머리에 가린 쪽은 작게 잡히므로 크기는 큰 쪽, 높이는 평균, 가로는 중심선 기준 대칭 → 좌우 X 위치·크기 일관
if len(pupil_list) == 2 and cfg.get('white_symmetric', True):
    L, R = sorted(pupil_list, key=lambda q: q['ex'])
    wrx = max(L['white_rx'], R['white_rx'])
    wrz = max(L['white_rz'], R['white_rz'])
    ezm = (L['ez'] + R['ez']) / 2
    midw = (L['ex'] + R['ex']) / 2
    halfw = (R['ex'] - L['ex']) / 2
    for q, sx in ((L, -1), (R, 1)):
        q['ex'], q['ez'], q['white_rx'], q['white_rz'] = round(midw + sx * halfw, 4), round(ezm, 4), wrx, wrz
    # 메우기 허용 범위도 대칭 타원으로 다시 (가린 쪽 흰자 안쪽도 메워지게, 앞머리 자체는 텍셀 단계에서 제외)
    shrink = cfg.get('white_shrink', 0.0015)
    eye_inner = np.zeros((GH, GW), bool)
    for q in pupil_list:
        eye_inner |= covered & (((XX - q['ex']) / (q['white_rx'] - shrink)) ** 2 + ((ZZ - q['ez']) / (q['white_rz'] - shrink)) ** 2 <= 1)
print('PUPILS', json.dumps(pupil_list))
save_png(os.path.join(out_dir, f'{name}_face_white.png'), np.where(white_dbg[:, :, None], color, color * 0.3))

# 눈동자 영역(+ 테두리 여유)만 주변 흰자색으로 메움. 흰자·입·피부는 그대로
# 흰자 타원 안에서 가림 물체 다시 판정: 앞머리·챙은 흰자 표면보다 확실히 앞(가장 앞 표면이 흰자색이 아님)인 곳만.
#   볼록한 눈알 아래쪽은 깊이가 급히 바뀌어 연속 영역 밖으로 나가지만 가림 물체가 아님
if eye_inner.any():
    hair_like = covered & ~((sat < 0.2) & (lum > 0.4)) & ~(warm & (diff < 0.25))
    for q in pupil_list:
        inside_w = covered & (((XX - q['ex']) / q['white_rx']) ** 2 + ((ZZ - q['ez']) / q['white_rz']) ** 2 <= 1)
        occluder[inside_w & ~hair_like] = False
        domain[inside_w & ~hair_like] = True
# 메울 곳 = 눈동자(+여유) + 그 주변 흰자에 남은 눈동자 색 기운 (분홍빛 반사·회색 가장자리 중간색: 채도 있거나 어두운 픽셀)
#   → 흰자 안쪽(윤곽선 제외)으로 한정. 경계값은 깨끗한 흰자(채도 낮고 밝음)만 → 회색·분홍·살구색이 번지지 않음
pmargin = cfg.get('pupil_margin', 0.004)
white_area = eye_inner if eye_inner.any() else covered
# 깨끗한 흰자 밝기: 흰자 안 무채색 픽셀 중 밝은 쪽 (눈동자도 무채색이라 단순 중앙값은 검은색이 됨 → 상위 25% 백분위)
_wa = white_area & (sat < 0.08)
l_sg = float(np.percentile(lum[_wa], 75)) if _wa.any() else 0.9
fill = np.zeros((GH, GW), bool)
for pp in pupil_list:
    fill |= ((XX - pp['cx']) / (pp['rx'] + pmargin)) ** 2 + ((ZZ - pp['cz']) / (pp['rz'] + pmargin)) ** 2 <= 1
    # 색 기운(채도)은 1.6배까지, 어두운 중간색은 눈동자 바로 옆(1.25배)만 — 비니 챙·눈꺼풀 그늘(흰자 원래 명암)은 건드리지 않음
    halo = ((XX - pp['cx']) / (pp['rx'] * 1.4)) ** 2 + ((ZZ - pp['cz']) / (pp['rz'] * 1.4)) ** 2 <= 1
    rim = ((XX - pp['cx']) / (pp['rx'] * 1.25)) ** 2 + ((ZZ - pp['cz']) / (pp['rz'] * 1.25)) ** 2 <= 1
    fill |= (halo & (sat > cfg.get('tint_sat', 0.09))) | (rim & (lum < 0.75 * l_sg))
# 흰자 윗부분의 회색 그림자 띠(원래 눈동자 위 비니 그늘): 흰자 안쪽, 눈동자 높이 이상이고 회색(밝기 낮고 채도 낮음)인 곳 → 흰자 위쪽 명암을 회색 대신 밝게
if cfg.get('clean_top_shadow', True):
    for pp in pupil_list:
        top = ((XX - pp['ex']) / pp['white_rx']) ** 2 + ((ZZ - pp['ez']) / pp['white_rz']) ** 2 <= 1
        fill |= top & (ZZ > pp['cz']) & (lum < 0.85 * l_sg) & (sat < 0.12)
    # 흰자 안의 어두운 얼룩·회색 띠(원래 눈동자의 그림자, 반사 반대편 회색 등): 흰자 타원 안쪽(윤곽선 띠 white_keep_rim 제외)에서
    # 깨끗한 흰자보다 어두우면 메움. 흰자 바깥 윤곽(눈꺼풀선)은 그대로
    keep = cfg.get('white_keep_rim', 0.8)
    for pp in pupil_list:
        deep = ((XX - pp['ex']) / (pp['white_rx'] * keep)) ** 2 + ((ZZ - pp['ez']) / (pp['white_rz'] * keep)) ** 2 <= 1
        fill |= deep & (lum < cfg.get('white_dark', 0.88) * l_sg)
fill &= covered & white_area
print('FILL', int(fill.sum()), 'of white', int(white_area.sum()), 'white_lum', round(l_sg, 3))
save_png(os.path.join(out_dir, f'{name}_fill.png'), np.repeat(fill[:, :, None].astype(np.float32), 3, axis=2))
work = color.copy()
known = covered & ~fill
work[~known] = 0
clean = white_area & known & (sat < cfg.get('tint_sat', 0.09)) & (lum > 0.7 * l_sg)
work[fill] = np.median(color[clean], axis=0) if clean.any() else 1.0
valid = fill | clean
for it in range(cfg.get('fill_iterations', 600)):
    acc = np.zeros_like(work)
    cnt = np.zeros((GH, GW, 1), np.float32)
    for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        sh = np.roll(np.roll(work, dj, axis=0), di, axis=1)
        ok = np.roll(np.roll(valid, dj, axis=0), di, axis=1)[:, :, None].astype(np.float32)
        acc += sh * ok
        cnt += ok
    upd = acc / np.maximum(cnt, 1)
    work[fill] = upd[fill]
# 메운 곳 ↔ 원본 경계를 부드럽게 (색 조건이 픽셀마다 갈려 들쭉날쭉한 테두리가 생기지 않게). 눈동자(+여유) 안은 완전히 메움
core = np.zeros((GH, GW), bool)
for pp in pupil_list:
    core |= ((XX - pp['cx']) / (pp['rx'] + pmargin)) ** 2 + ((ZZ - pp['cz']) / (pp['rz'] + pmargin)) ** 2 <= 1
wgt = fill.astype(np.float32)
for _ in range(cfg.get('fill_soften', 4)):
    wgt = (wgt + np.roll(wgt, 1, 0) + np.roll(wgt, -1, 0) + np.roll(wgt, 1, 1) + np.roll(wgt, -1, 1)) / 5
wgt = np.where(core & white_area, 1.0, np.clip(wgt * 1.6, 0, 1) * fill)
filled = color * (1 - wgt[:, :, None]) + work * wgt[:, :, None]

# 4) X 그리기: 눈동자 중심, 전체 크기 = 눈동자 지름 × x_size (기본 85%), 둥근 끝
pupil_px = np.zeros((GH, GW), bool)
for pp in pupil_list:
    pupil_px |= (((XX - pp['cx']) / pp['rx']) ** 2 + ((ZZ - pp['cz']) / pp['rz']) ** 2 <= 0.5) & covered & (lum < 0.4)
pupil_col = np.median(color[pupil_px], axis=0) if pupil_px.any() else np.array([0.1, 0.1, 0.12])
# 색: 원래 눈동자 색 (아주 검으면 살짝 짙은 회색으로 → 흰자와 대비는 유지)
x_col = np.array(cfg.get('x_color', np.maximum(pupil_col, 0.09).tolist()), np.float32)
print('X_COLOR', x_col.round(3).tolist())


def x_coverage(x, z, aa):
    """X 선 덮임 정도 0..1 (선분까지 거리, 둥근 끝). aa = 가장자리 부드럽게 할 폭 (GLB 단위)"""
    cov = np.zeros_like(x, dtype=np.float32)
    for pp in pupil_list:
        r = pp['r']
        thick = r * cfg.get('x_thickness', 0.26)
        # 전체 크기(가로·세로 폭, 둥근 끝 포함) = 눈동자 지름 × x_size → 대각선 끝점 반폭 = r × x_size − 두께/2
        half = max(0.0, r * cfg.get('x_size', 0.85) - thick / 2)
        ccx, ccz = (pp['cx'], pp['cz']) if cfg.get('x_center') == 'pupil' else (pp['ex'], pp['ez'])
        for sgn in (1, -1):
            ax, az = ccx - half, ccz - sgn * half
            vx, vz = 2 * half, 2 * sgn * half
            tt = np.clip(((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz), 0, 1)
            d = np.hypot(x - (ax + tt * vx), z - (az + tt * vz))
            cov = np.maximum(cov, np.clip((thick / 2 - d) / aa + 0.5, 0, 1))
    return cov


x_alpha = x_coverage(XX, ZZ, PX)
result = filled * (1 - x_alpha[:, :, None]) + x_col * x_alpha[:, :, None]
# 패치 범위 = 흰자 안쪽 전체 + 메운 곳: 패치 경계가 눈동자 바로 옆이면 원본 텍스처 밉맵에 섞인 눈동자 색이 테두리처럼 보임
#   → 경계를 흰자 윤곽선 쪽으로 밀어냄. 메우지 않은 흰자 텍셀은 원본 색 그대로 복사 (아래 텍셀 단계)
changed = (white_area | fill) & covered
preview = np.where(occluder[:, :, None], color, result)
save_png(os.path.join(out_dir, f'{name}_face_dead.png'), np.where(covered[:, :, None], preview, 0.5))
save_png(os.path.join(out_dir, f'{name}_face_mask.png'), np.repeat(changed[:, :, None].astype(np.float32), 3, axis=2))

# 5) 텍스처 공간으로: 바뀐 영역을 덮는 앞 표면 삼각형의 텍셀
# 전체 삼각형 UV 덮임 지도: 섬 바깥 여백(gutter) 텍셀만 골라 넓혀 덮기 위해 (다른 부위 텍셀은 건드리지 않음)
uv_cov = np.zeros((H, W), bool)
for t in range(len(tris)):
    uvp = tri_uv[t] * np.array([W, H])
    cu0, cu1 = max(0, int(math.floor(uvp[:, 0].min()))), min(W - 1, int(math.ceil(uvp[:, 0].max())))
    cv0, cv1 = max(0, int(math.floor(uvp[:, 1].min()))), min(H - 1, int(math.ceil(uvp[:, 1].max())))
    if cu1 < cu0 or cv1 < cv0:
        continue
    cuu, cvv = np.meshgrid(np.arange(cu0, cu1 + 1) + 0.5, np.arange(cv0, cv1 + 1) + 0.5)
    wb = bary(cuu, cvv, uvp[0], uvp[1], uvp[2])
    if wb is None:
        continue
    ins = (wb[0] >= 0) & (wb[1] >= 0) & (wb[2] >= 0)
    uv_cov[cv0:cv1 + 1, cu0:cu1 + 1] |= ins
GUTTER = cfg.get('gutter_px', 4)
dy_all = []
out_rgba = {}
# 텍셀이 속한 눈: 1 = 정면에서 왼쪽(캐릭터 오른쪽 눈), 2 = 정면에서 오른쪽
out_side = {}
# 모든 삼각형 (법선이 뒤집힌 눈 주름 삼각형도 포함). 뒤통수 등은 정면 표면에서 먼 깊이로 걸러짐
head_tris = np.nonzero((cz > Z0 - 0.02) & (cz < Z1 + 0.02) & (np.abs(cx) < X1 + 0.02))[0]
for t in head_tris:
    a, b, c = p[t]
    gx = (np.array([a[0], b[0], c[0]]) - X0) / PX
    gz = (np.array([a[2], b[2], c[2]]) - Z0) / PX
    i0, i1 = max(0, int(math.floor(gx.min()))), min(GW - 1, int(math.ceil(gx.max())))
    j0, j1 = max(0, int(math.floor(gz.min()))), min(GH - 1, int(math.ceil(gz.max())))
    if i1 < i0 or j1 < j0 or not changed[j0:j1 + 1, i0:i1 + 1].any():
        continue
    uv = tri_uv[t] * np.array([W, H])
    u0, u1 = int(math.floor(uv[:, 0].min())) - GUTTER, int(math.ceil(uv[:, 0].max())) + GUTTER
    v0, v1 = int(math.floor(uv[:, 1].min())) - GUTTER, int(math.ceil(uv[:, 1].max())) + GUTTER
    uu, vv = np.meshgrid(np.arange(u0, u1 + 1) + 0.5, np.arange(v0, v1 + 1) + 0.5)
    w = bary(uu, vv, uv[0], uv[1], uv[2])
    if w is None:
        continue
    w0, w1, w2 = w
    # 삼각형 안 + 섬 바깥 여백(어느 삼각형에도 속하지 않는 텍셀, 삼각형에서 GUTTER px 안): 원본 텍스처의 여백에 남은 눈 색이
    # 밉맵·선형 보간으로 섞여 나오지 않게 같이 덮음
    strict = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
    tol = GUTTER / max(1.0, np.abs(np.cross(uv[1] - uv[0], uv[2] - uv[0])) ** 0.5)
    near_t = (w0 >= -tol) & (w1 >= -tol) & (w2 >= -tol)
    pu_i = np.clip((uu - 0.5).astype(np.int64), 0, W - 1)
    pv_i = np.clip((vv - 0.5).astype(np.int64), 0, H - 1)
    inside = strict | (near_t & ~uv_cov[pv_i, pu_i])
    if not inside.any():
        continue
    x = w0 * a[0] + w1 * b[0] + w2 * c[0]
    y = w0 * a[1] + w1 * b[1] + w2 * c[1]
    z = w0 * a[2] + w1 * b[2] + w2 * c[2]
    gi = np.clip(((x - X0) / PX).astype(np.int64), 0, GW - 1)
    gj = np.clip(((z - Z0) / PX).astype(np.int64), 0, GH - 1)
    # 눈 타원 영역의 모든 앞면 텍셀 (볼록한 눈 주름의 얇은 삼각형도 빠짐없이), 단 앞머리·챙 자체(가장 앞 표면 + 가림 물체)는 제외
    front_most = y <= depth[gj, gi] + 0.003
    near_face = y <= depth[gj, gi] + cfg.get('behind_depth', 0.08)
    vis = inside & changed[gj, gi] & near_face & ~(occluder[gj, gi] & front_most)
    if not vis.any():
        continue
    # 텍셀마다: 메운 색은 격자 쌍선형 보간, X는 텍셀 위치에서 정확히 다시 계산 (격자보다 텍셀이 촘촘해 계단 현상 방지)
    xv, zv = x[vis], z[vis]
    fx = np.clip((xv - X0) / PX - 0.5, 0, GW - 1.001)
    fz = np.clip((zv - Z0) / PX - 0.5, 0, GH - 1.001)
    ix, iz = fx.astype(np.int64), fz.astype(np.int64)
    tx, tz = (fx - ix)[:, None], (fz - iz)[:, None]
    fc = (filled[iz, ix] * (1 - tx) * (1 - tz) + filled[iz, ix + 1] * tx * (1 - tz)
         + filled[iz + 1, ix] * (1 - tx) * tz + filled[iz + 1, ix + 1] * tx * tz)
    # 텍셀 하나의 표면 크기 (삼각형 3D 넓이 / UV 픽셀 넓이) → 가장자리 부드럽게 할 폭
    area3 = np.linalg.norm(np.cross(b - a, c - a))
    areauv = abs(np.cross(uv[1] - uv[0], uv[2] - uv[0]))
    texel = math.sqrt(area3 / max(areauv, 1e-9))
    # X는 가장 앞 표면 근처만 (눈 부위가 여러 겹 껍질이라, 안쪽 겹에 정면 투영 X를 그리면 비스듬히 볼 때 선이 어긋나 보임 → 안쪽은 피부색만)
    dy_all.append(y[vis] - depth[gj[vis], gi[vis]])
    on_front = (y[vis] <= depth[gj[vis], gi[vis]] + cfg.get('x_depth', 0.012)).astype(np.float32)
    xa = (x_coverage(xv, zv, max(texel, 1e-4)) * on_front)[:, None]
    # 메우지 않는 흰자 텍셀(삼각형 안)은 원본 텍셀 색 그대로 (격자로 다시 샘플하면 흐려짐), 메운 곳·섬 여백은 격자 색
    idx = np.argwhere(vis)
    pvs = np.clip(v0 + idx[:, 0], 0, H - 1)
    pus = np.clip(u0 + idx[:, 1], 0, W - 1)
    keep_orig = (~fill[gj[vis], gi[vis]] & strict[vis])[:, None]
    base_c = np.where(keep_orig, tex[pvs, pus], fc)
    rgb = base_c * (1 - xa) + x_col * xa
    side_v = np.where(xv < mid_x, 1, 2)
    for (vi, ui), col, sd in zip(idx, rgb, side_v):
        px_u, px_v = u0 + ui, v0 + vi
        if 0 <= px_u < W and 0 <= px_v < H:
            out_rgba[(px_v, px_u)] = col
            out_side[(px_v, px_u)] = int(sd)

if dy_all:
    dd = np.concatenate(dy_all)
    print('LAYER_DY', 'n', len(dd), 'hist', np.histogram(dd, bins=[-1, -0.003, 0.003, 0.006, 0.012, 0.02, 0.04, 0.08, 1])[0].tolist())
if not out_rgba:
    raise SystemExit('눈 영역 텍셀 없음')
# 텍스처 섬(UV 조각)별로 묶기: 32px 칸 8-이웃 연결 → 조각마다 사각형 (얼굴이 여러 UV 조각으로 나뉘어 있음)
CELL = 32
occ = {}
for (pv, pu), sd in out_side.items():
    occ[(sd, pv // CELL, pu // CELL)] = True
seen = set()
rects = []
for c0 in occ:
    if c0 in seen:
        continue
    st = [c0]
    seen.add(c0)
    cells = []
    while st:
        c = st.pop()
        cells.append(c)
        for dv in (-1, 0, 1):
            for du in (-1, 0, 1):
                nb = (c[0], c[1] + dv, c[2] + du)
                if nb in occ and nb not in seen:
                    seen.add(nb)
                    st.append(nb)
    cs = set(cells)
    sd0 = c0[0]
    pts_ = [k for k, sd in out_side.items() if sd == sd0 and (sd, k[0] // CELL, k[1] // CELL) in cs]
    a = np.array(pts_)
    PAD = 4
    rects.append({'v0': max(0, int(a[:, 0].min()) - PAD), 'v1': min(H, int(a[:, 0].max()) + 1 + PAD),
                  'u0': max(0, int(a[:, 1].min()) - PAD), 'u1': min(W, int(a[:, 1].max()) + 1 + PAD), 'n': len(pts_), 'side': sd0})
# 겹치는 사각형 합치기 (셰이더는 처음 맞는 사각형 하나만 씀)
merged = True
while merged:
    merged = False
    for ia in range(len(rects)):
        for ib in range(ia + 1, len(rects)):
            A, Bm = rects[ia], rects[ib]
            # 같은 눈 조각끼리만 합침. 다른 눈 조각 사각형이 겹치면 아래에서 텍셀 단위로 처리 (셰이더는 순서대로 검사)
            if A['side'] == Bm['side'] and A['u0'] < Bm['u1'] and Bm['u0'] < A['u1'] and A['v0'] < Bm['v1'] and Bm['v0'] < A['v1']:
                # 다른 눈 조각끼리 겹치면 '양쪽'(0) — 디버그 단독 눈 테스트에서만 영향
                rects[ia] = {'u0': min(A['u0'], Bm['u0']), 'u1': max(A['u1'], Bm['u1']), 'v0': min(A['v0'], Bm['v0']), 'v1': max(A['v1'], Bm['v1']), 'n': A['n'] + Bm['n'],
                             'side': A['side'] if A['side'] == Bm['side'] else 0}
                del rects[ib]
                merged = True
                break
        if merged:
            break
MAX_RECTS = 16
if len(rects) > MAX_RECTS:
    raise SystemExit(f'UV 조각 {len(rects)}개 > {MAX_RECTS} (셰이더 사각형 수 늘려야 함)')
# 선반(shelf) 배치: 높이 큰 순, 아틀라스 폭 = 조각 폭 합의 제곱근 기준
rects.sort(key=lambda r: -(r['v1'] - r['v0']))
total = sum((r['u1'] - r['u0']) * (r['v1'] - r['v0']) for r in rects)
AW = max(max(r['u1'] - r['u0'] for r in rects), int(math.ceil(math.sqrt(total) * 1.25 / 4) * 4))
x = y = shelf = 0
for r in rects:
    w, h = r['u1'] - r['u0'], r['v1'] - r['v0']
    if x + w > AW:
        x, y, shelf = 0, y + shelf, 0
    r['ax'], r['ay'] = x, y
    x += w
    shelf = max(shelf, h)
AH = int(math.ceil((y + shelf) / 4) * 4)
atlas = np.zeros((AH, AW, 4), np.float32)
for (pv, pu), rgb in out_rgba.items():
    sd_t = out_side.get((pv, pu), 0)
    for r in rects:
        # 자기 눈 사각형에 씀 (다른 눈 사각형과 겹친 곳도 셰이더가 알파 있는 쪽을 고름)
        if r['side'] in (0, sd_t) and r['v0'] <= pv < r['v1'] and r['u0'] <= pu < r['u1']:
            atlas[r['ay'] + pv - r['v0'], r['ax'] + pu - r['u0'], :3] = rgb
            atlas[r['ay'] + pv - r['v0'], r['ax'] + pu - r['u0'], 3] = 1
            break
# 투명 텍셀 색을 이웃 색으로 채움 (선형 보간·밉맵 때 검은 테두리 방지, 알파는 그대로 0)
filled_mask = atlas[:, :, 3] > 0
for _ in range(6):
    for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        sh = np.roll(np.roll(atlas, dj, axis=0), di, axis=1)
        shm = np.roll(np.roll(filled_mask, dj, axis=0), di, axis=1)
        m = (~filled_mask) & shm
        atlas[m, :3] = sh[m, :3]
        filled_mask = filled_mask | m
out = bpy.data.images.new(f'{name}_dead_eyes', AW, AH, alpha=True)
out.pixels.foreach_set(atlas.ravel())
out.filepath_raw = os.path.join(out_dir, f'{name}_dead_eyes.png')
out.file_format = 'PNG'
out.save()
# glTF UV(v 아래로) 기준: 원본 텍스처 사각형 uv, 아틀라스 사각형 atlas (x, y, w, h). Blender v(위로) = 1 - glTF v
rr = []
for r in rects:
    w, h = r['u1'] - r['u0'], r['v1'] - r['v0']
    rr.append({
        'uv': [round(r['u0'] / W, 6), round(1 - r['v1'] / H, 6), round(w / W, 6), round(h / H, 6)],
        'atlas': [round(r['ax'] / AW, 6), round(1 - (r['ay'] + h) / AH, 6), round(w / AW, 6), round(h / AH, 6)],
        'texels': r['n'],
        'side': r.get('side', 0),
    })
info = {'name': name, 'texture': [W, H], 'atlas': [AW, AH], 'rects': rr, 'eyes': eyes, 'skin': skin.round(4).tolist(), 'texels': len(out_rgba)}
json.dump(info, open(os.path.join(out_dir, f'{name}_dead_eyes.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('DEAD_EYES', json.dumps({k: info[k] for k in ('atlas', 'texels')}), len(rr), 'rects')

# 6) 사망 셰이프 키 'Dead': 눈알이 메시로 볼록 솟아 있어 X 주변에 눈알 윤곽 음영이 남음 → 눈 부위 정점을 주변 얼굴 곡면 깊이로 당김.
#    기본 형태(셰이프 키 0)는 정점 하나도 바꾸지 않음. 앞머리·비니 챙(가림 물체)은 그대로.
if shape_out:
    def smooth01(a, b, x):
        t = np.clip((x - a) / (b - a), 0, 1)
        return t * t * (3 - 2 * t)

    new_co = co.copy()
    moved = 0
    for e in eyes:
        ax_ = e['rx'] + margin
        az_ = e['rz'] + margin
        rn_px = np.sqrt(((XX - e['cx']) / ax_) ** 2 + ((ZZ - e['cz']) / az_) ** 2)
        # 얼굴 곡면: 눈 바깥 고리(1.15~1.9배)의 피부 픽셀 깊이로 2차 곡면
        ring = covered & (rn_px > 1.15) & (rn_px < 1.9) & warm & (diff < 0.25)
        if ring.sum() < 50:
            print('SHAPE_SKIP', e)
            continue
        Qf = lambda x, z: np.stack([np.ones_like(x), x, z, x * x, x * z, z * z], axis=-1)
        coef = np.linalg.lstsq(Qf(XX[ring], ZZ[ring]), depth[ring], rcond=None)[0]
        vx_, vz_ = co[:, 0], co[:, 2]
        rn_v = np.sqrt(((vx_ - e['cx']) / ax_) ** 2 + ((vz_ - e['cz']) / az_) ** 2)
        gi_v = np.clip(((vx_ - X0) / PX).astype(np.int64), 0, GW - 1)
        gj_v = np.clip(((vz_ - Z0) / PX).astype(np.int64), 0, GH - 1)
        surf_v = Qf(vx_, vz_) @ coef
        cand_v = (rn_v < 1.3) & domain[gj_v, gi_v] & (co[:, 1] < surf_v)
        front_v = co[:, 1] <= depth[gj_v, gi_v] + 0.003
        # 가장 앞 껍질 → 곡면 위, 안쪽 껍질 → 곡면 바로 뒤 (평탄해진 앞 껍질 밖으로 삐져나오지 않게)
        target = np.where(front_v, surf_v, surf_v + cfg.get('inner_offset', 0.002))
        w = 1 - smooth01(0.95, 1.3, rn_v)
        idx = np.nonzero(cand_v & (w > 0))[0]
        new_co[idx, 1] = co[idx, 1] + (target[idx] - co[idx, 1]) * w[idx]
        moved += len(idx)
    print('SHAPE_MOVED', moved, 'max_shift', float(np.abs(new_co - co).max()))
    mesh_obj.shape_key_add(name='Basis', from_mix=False)
    key = mesh_obj.shape_key_add(name='Dead', from_mix=False)
    inv = mw.inverted()
    from mathutils import Vector
    for i, kp in enumerate(key.data):
        if new_co[i, 1] != co[i, 1]:
            kp.co = inv @ Vector(new_co[i].tolist())
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(shape_out),
        export_format='GLB',
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_skins=True,
        export_morph=True,
        export_morph_normal=True,
        export_yup=True,
        export_image_format='AUTO',
        export_apply=False,
        export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=False,
    )
    print('SHAPE_EXPORTED', shape_out)

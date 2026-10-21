"""
얼굴 정면 렌더(measure_character.py의 *_face.png)에서 눈 측정 (읽기 전용).

python tools/measure_eyes.py <dir> <name> [<name> ...]

렌더 축척: 1000px = 1.0 단위, 이미지 중심 = (x 0, z 0.75). 측정 범위는 얼굴 영역(z 0.35~0.8, |x| < 0.25).
- 눈동자/홍채: 어두운(<75) 둥근 덩어리 (하이라이트 구멍 채움) 중 좌우 대칭 쌍
- 눈 전체(흰자+홍채): 눈동자에 붙은 밝은 무채색(흰자) 영역까지 합친 면적 → 등가 지름
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

PX = 1 / 1000
d = sys.argv[1]
out = {}
for name in sys.argv[2:]:
    img = np.asarray(Image.open(f'{d}/{name}_face.png').convert('RGB')).astype(int)
    lum = img.mean(axis=2)
    sat = img.max(axis=2) - img.min(axis=2)
    roi = np.zeros(lum.shape, bool)
    roi[450:900, 250:750] = True  # z 0.35~0.8, x -0.25~0.25
    dark = ndimage.binary_fill_holes((lum < 75) & roi)
    lab, n = ndimage.label(dark)
    blobs = []
    for i in range(1, n + 1):
        m = lab == i
        ys, xs = np.nonzero(m)
        area = len(xs)
        if area < 300 or area > 20000:
            continue
        w = xs.max() - xs.min() + 1
        h = ys.max() - ys.min() + 1
        if not (0.6 < w / h < 1.6 and area / (w * h) > 0.6):
            continue
        blobs.append({'cx': xs.mean(), 'cy': ys.mean(), 'w': w, 'h': h, 'area': area, 'mask': m})
    best = None
    for a in blobs:
        for b in blobs:
            if a['cx'] >= 500 or b['cx'] <= 500:
                continue
            score = abs(a['cy'] - b['cy']) + abs(a['area'] - b['area']) / 50 + abs((a['cx'] + b['cx']) / 2 - 500)
            if best is None or score < best[0]:
                best = (score, a, b)
    if not best:
        out[name] = None
        print(name, 'not found')
        continue
    _, a, b = best
    white = (lum > 200) & (sat < 40) & roi

    def eye_diam(bl):
        # 눈동자 + 맞닿은 흰자 덩어리 (흰자 쪽 연결 성분만)
        grown = ndimage.binary_dilation(bl['mask'], iterations=3)
        wl, _ = ndimage.label(white)
        ids = set(np.unique(wl[grown & white])) - {0}
        m = bl['mask'] | np.isin(wl, list(ids))
        return 2 * np.sqrt(m.sum() / np.pi) * PX

    out[name] = {
        'pupil_d': round(float((a['w'] + a['h'] + b['w'] + b['h']) / 4 * PX), 4),
        'eye_d': round(float((eye_diam(a) + eye_diam(b)) / 2), 4),
        'eye_spacing': round(float(abs(b['cx'] - a['cx']) * PX), 4),
        'eye_z': round(float(0.75 + (500 - (a['cy'] + b['cy']) / 2) * PX), 4),
    }
    print(name, out[name])
json.dump(out, open(f'{d}/eyes.json', 'w'), indent=1)

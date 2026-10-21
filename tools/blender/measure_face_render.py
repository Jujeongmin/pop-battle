"""
비교 렌더(06_head_front.png)에서 얼굴 피부·눈 흰자 영역을 색으로 분리해 크기를 잰다 (PIL + numpy, Blender 불필요).
python tools/blender/measure_face_render.py <png> <blue_center_px> <pink_center_px> <ortho_scale> <camera_z>
결과는 렌더 해상도 한계(1px ≈ ortho/폭) 안의 근사치.
"""
import sys
from collections import deque

import numpy as np
from PIL import Image

path, cx_blue, cx_pink, ortho, camz = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
im = np.asarray(Image.open(path).convert('RGB')).astype(int)
H, W, _ = im.shape
mm = ortho / W
r, g, b = im[..., 0], im[..., 1], im[..., 2]
skin = (r > 95) & (r - b >= 25) & (r - b <= 75) & (r - g >= 10) & (r - g <= 40) & (g > b)
white = (np.abs(r - g) < 7) & (np.abs(r - b) < 9) & (r > 132) & (r < 188)


def blobs(mask, x0, x1, y0, y1, minsize):
    m = np.zeros_like(mask)
    m[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
    seen = np.zeros(mask.shape, bool)
    out = []
    for sy, sx in zip(*np.nonzero(m)):
        if seen[sy, sx]:
            continue
        q = deque([(sy, sx)])
        seen[sy, sx] = True
        pts = []
        while q:
            y, x = q.popleft()
            pts.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and m[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if len(pts) >= minsize:
            out.append(np.array(pts))
    return sorted(out, key=len, reverse=True)


def z(y):
    return camz + (H / 2 - y) * mm


for name, cx in (('blue', cx_blue), ('pink', cx_pink)):
    half = int(0.33 / mm)
    x0, x1 = max(0, cx - half), min(W, cx + half)
    y0, y1 = int(H / 2 - 0.2 / mm), int(H / 2 + 0.32 / mm)
    s = blobs(skin, x0, x1, y0, y1, 1500)
    if not s:
        print(name, 'no face')
        continue
    f = s[0]
    rows = {}
    for y, x in f:
        a = rows.setdefault(y, [x, x])
        a[0] = min(a[0], x)
        a[1] = max(a[1], x)
    wy = max(rows, key=lambda y: rows[y][1] - rows[y][0])
    eyes = []
    for e in blobs(white, x0, x1, y0, y1, 150)[:2]:
        eyes.append(((e[:, 1].min() + e[:, 1].max()) / 2, (e[:, 0].min() + e[:, 0].max()) / 2,
                     (e[:, 1].max() - e[:, 1].min()) * mm, (e[:, 0].max() - e[:, 0].min()) * mm))
    eyes.sort()
    line = '%s face w %.3f at z %.3f, face z %.3f..%.3f (h %.3f) | eyes %s' % (
        name, (rows[wy][1] - rows[wy][0]) * mm, z(wy), z(f[:, 0].max()), z(f[:, 0].min()),
        (f[:, 0].max() - f[:, 0].min()) * mm,
        ['w%.3f h%.3f z%.3f x%.3f' % (e[2], e[3], z(e[1]), (e[0] - cx) * mm) for e in eyes])
    if len(eyes) == 2:
        line += ' | spacing %.3f' % ((eyes[1][0] - eyes[0][0]) * mm)
    print(line)

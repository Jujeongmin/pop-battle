"""팝건 계급 스프라이트 시트(4열 × 3행, 투명 배경) → 12개 PNG (512×512, 가운데, 원본 비율·방향·알파 그대로).

배경은 시트에 이미 투명(알파 0)으로 들어 있음 → 색으로 배경을 지우지 않음 (총의 흰 부분이 지워질 일이 없음).
1) 알파 > 64 인 연결 영역 = 팝건 12개의 몸체 (정확히 12개가 아니면 멈추고 알림)
2) 부드러운 가장자리(알파 1~64)는 가장 가까운 몸체에 붙임 (12px 이내) → 가장자리 그대로, 옆 팝건과 합쳐지지 않음
3) 위→아래, 왼쪽→오른쪽 순서로 Lv 파일명에 매핑, 경계 상자를 잘라 512 안에 맞춰 가운데 배치

사용: python tools/split_popgun_sheet.py <시트> <출력 폴더>
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

FILES = ['001', '005', '010', '020', '030', '040', '050', '060', '070', '080', '090', '100']
SIZE = 512
PAD = 24
CORE_ALPHA = 64
HALO_PX = 12


def main(sheet: str, out_dir: str) -> None:
    a = np.array(Image.open(sheet).convert('RGBA'))
    alpha = a[:, :, 3]
    core, n = ndimage.label(alpha > CORE_ALPHA)
    sizes = ndimage.sum(np.ones_like(core), core, index=range(1, n + 1))
    big = [i + 1 for i, s in enumerate(sizes) if s > 2000]
    if len(big) != 12:
        print(f'error: expected 12 guns, found {len(big)} (alpha>{CORE_ALPHA} regions over 2000px)')
        sys.exit(1)
    seeds = np.where(np.isin(core, big), core, 0)
    # 가장자리: 가장 가까운 몸체 번호
    dist, (iy, ix) = ndimage.distance_transform_edt(seeds == 0, return_indices=True)
    owner = seeds[iy, ix]
    owner[(alpha == 0) | (dist > HALO_PX)] = 0

    centers = {i: ndimage.center_of_mass(seeds == i) for i in big}
    rows = sorted(big, key=lambda i: centers[i][0])
    order = [i for r in range(3) for i in sorted(rows[r * 4:(r + 1) * 4], key=lambda i: centers[i][1])]

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for k, i in enumerate(order):
        ys, xs = np.nonzero(owner == i)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        part = a[y0:y1, x0:x1].copy()
        part[owner[y0:y1, x0:x1] != i, 3] = 0
        piece = Image.fromarray(part)
        pw, ph = piece.size
        scale = (SIZE - PAD * 2) / max(pw, ph)
        piece = piece.resize((round(pw * scale), round(ph * scale)), Image.LANCZOS)
        canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
        canvas.alpha_composite(piece, ((SIZE - piece.width) // 2, (SIZE - piece.height) // 2))
        name = out / f'popgun_lv_{FILES[k]}.png'
        canvas.save(name, optimize=True)
        cy, cx = centers[i]
        print(f'{name.name}: sheet center ({cx:.0f},{cy:.0f}) src {pw}x{ph} -> {piece.width}x{piece.height}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])

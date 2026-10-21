"""
머리·얼굴 스킨 가중치 정리 — `clean_head_weights.py`와 같은 규칙을 GLB 가중치 버퍼에 직접 적용 (Blender 재내보내기 없음).

python tools/blender/clean_head_weights_inplace.py <in.glb> <out.glb> [--fade 0.46 0.50]

규칙 (clean_head_weights.py와 동일):
- 레스트 정점 높이(glTF Y, 원본 높이 1.0 단위)로 k = smoothstep(fade0, fade1)
- 팔·어깨 본(Shoulder/UpperArm/LowerArm/Hand/손가락) 가중치 × k 만큼 빼서 Spine에 더함
- 정점당 영향 4개 제한: Spine 칸이 없으면 0이 된 칸을 쓰고, 칸이 없으면 5개 중 큰 4개만 남기고 다시 정규화 (Blender 내보내기와 같은 처리)
본·바인드 행렬·클립·형상·UV·텍스처는 바이트 그대로. JOINTS_0(u8/u16)·WEIGHTS_0(float) 버퍼만 바뀐다.
"""
import argparse
import json

import numpy as np

from scale_head_region import accessor_view, read_glb, write_glb

ARM = ('Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'Thumb', 'Index', 'Middle', 'Ring', 'Little')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp')
    ap.add_argument('out')
    ap.add_argument('--fade', nargs=2, type=float, default=[0.46, 0.50])
    a = ap.parse_args()
    z0, z1 = a.fade

    gltf, binary = read_glb(a.inp)
    names = [gltf['nodes'][j]['name'] for j in gltf['skins'][0]['joints']]
    spine = names.index('Spine')
    is_arm = np.array([n.startswith(ARM) for n in names])
    prim = gltf['meshes'][0]['primitives'][0]
    at = prim['attributes']
    pos = accessor_view(gltf, binary, at['POSITION'])[0]
    jnt_view, jnt_start, jnt_acc = accessor_view(gltf, binary, at['JOINTS_0'])
    wgt_view, wgt_start, wgt_acc = accessor_view(gltf, binary, at['WEIGHTS_0'])
    assert wgt_acc['componentType'] == 5126, '가중치가 float가 아님'
    jdtype = jnt_view.dtype
    joints = jnt_view.astype(int).copy()
    weights = wgt_view.astype(np.float64).copy()

    y = pos[:, 1].astype(np.float64)
    t = np.clip((y - z0) / (z1 - z0), 0, 1)
    k = t * t * (3 - 2 * t)

    changed = 0
    moved_total = 0.0
    replaced_slot = 0
    for i in np.nonzero(k > 0)[0]:
        j = joints[i]
        w = weights[i]
        arm_slots = is_arm[j] & (w > 0)
        if not arm_slots.any():
            continue
        d = w[arm_slots] * k[i]
        w[arm_slots] -= d
        moved = float(d.sum())
        if moved <= 1e-6:
            continue
        w[w <= 1e-5] = 0.0
        sp = np.nonzero((j == spine) & (w > 0))[0]
        if len(sp):
            w[sp[0]] += moved
        else:
            free = np.nonzero(w == 0)[0]
            if len(free):
                j[free[0]] = spine
                w[free[0]] = moved
            else:
                # 5개 영향 → 큰 4개만 (Blender 내보내기와 같은 제한)
                cj = np.append(j, spine)
                cw = np.append(w, moved)
                keep = np.argsort(-cw)[:4]
                j[:] = cj[keep]
                w[:] = cw[keep]
                replaced_slot += 1
        s = w.sum()
        if s > 0:
            w /= s
        # 0 가중치 칸은 관례대로 관절 0
        j[w == 0] = 0
        changed += 1
        moved_total += moved

    binary[jnt_start:jnt_start + joints.size * jdtype.itemsize] = joints.astype(jdtype).tobytes()
    binary[wgt_start:wgt_start + weights.size * 4] = weights.astype('<f4').tobytes()
    extras = gltf.setdefault('asset', {}).setdefault('extras', {})
    extras['popBattleHeadWeights'] = {'fade': [z0, z1], 'rule': 'arm/shoulder -> Spine', 'source': 'tools/blender/clean_head_weights_inplace.py'}
    write_glb(a.out, gltf, binary)

    head = y >= z1
    arm_after = (weights * is_arm[joints]).sum(1)
    print(json.dumps({'changed_verts': changed, 'moved_weight': round(moved_total, 2), 'five_to_four': replaced_slot,
                      'head_verts_with_arm_weight_after': int((arm_after[head] > 1e-4).sum()),
                      'weight_sum_minmax': [round(float(weights.sum(1).min()), 5), round(float(weights.sum(1).max()), 5)]}))


if __name__ == '__main__':
    main()

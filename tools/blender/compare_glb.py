"""
두 캐릭터 GLB 비교 (읽기 전용, numpy만 사용).

python tools/blender/compare_glb.py <a.glb> <b.glb>

- 구조: 정점·삼각형 수, 본 이름, 클립 이름·길이·채널 수, 텍스처 바이트 해시
- 본: 레스트 위치(역바인드 행렬의 역)와 레스트 회전 차이(도) — 게임 손 IK는 Hand 본 로컬 축을 쓴다
- 정점: 순서가 같으면 그대로, 아니면 위치+UV 최근접으로 대응시켜 위치 이동량·스킨 가중치 차이
- 높이 구간별(원본 높이 1.0 기준) 이동량·가중치 변화 요약
"""
import hashlib
import json
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit('\\', 1)[0] if '\\' in __file__ else __file__.rsplit('/', 1)[0])
from scale_head_region import accessor_view, read_glb  # noqa: E402


def load(path):
    g, b = read_glb(path)
    prim = g['meshes'][0]['primitives'][0]
    at = prim['attributes']
    pos = accessor_view(g, b, at['POSITION'])[0].astype(np.float64)
    uv = accessor_view(g, b, at['TEXCOORD_0'])[0].astype(np.float64)
    jnt = accessor_view(g, b, at['JOINTS_0'])[0].astype(int)
    wgt = accessor_view(g, b, at['WEIGHTS_0'])[0].astype(np.float64)
    idx = accessor_view(g, b, prim['indices'])[0]
    skin = g['skins'][0]
    names = [g['nodes'][j]['name'] for j in skin['joints']]
    ibm = accessor_view(g, b, skin['inverseBindMatrices'])[0].reshape(-1, 4, 4).transpose(0, 2, 1).astype(np.float64)
    rest = np.linalg.inv(ibm)
    # 정점별 본 이름 → 가중치 (이름 기준이라 본 순서가 달라도 비교 가능)
    dense = np.zeros((len(pos), len(names)))
    for k in range(4):
        np.add.at(dense, (np.arange(len(pos)), jnt[:, k]), wgt[:, k])
    clips = {}
    for an in g.get('animations', []):
        dur = 0.0
        for s in an['samplers']:
            dur = max(dur, g['accessors'][s['input']]['max'][0])
        clips[an['name']] = (round(dur, 4), len(an['channels']))
    img = g['images'][0]
    bv = g['bufferViews'][img['bufferView']]
    img_hash = hashlib.sha256(bytes(b[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']])).hexdigest()[:16]
    return dict(g=g, pos=pos, uv=uv, dense=dense, names=names, rest=rest, tris=idx.size // 3, clips=clips, img=img_hash,
                generator=g.get('asset', {}).get('generator'), extras=g.get('asset', {}).get('extras'))


def rot_angle_deg(m1, m2):
    r1 = m1[:3, :3] / np.linalg.norm(m1[:3, :3], axis=0)
    r2 = m2[:3, :3] / np.linalg.norm(m2[:3, :3], axis=0)
    r = r1.T @ r2
    return float(np.degrees(np.arccos(np.clip((np.trace(r) - 1) / 2, -1, 1))))


def main():
    A, B = load(sys.argv[1]), load(sys.argv[2])
    out = {'files': sys.argv[1:3]}
    out['structure'] = {
        'verts': [len(A['pos']), len(B['pos'])], 'tris': [A['tris'], B['tris']],
        'bones': [len(A['names']), len(B['names'])],
        'bones_only_a': sorted(set(A['names']) - set(B['names'])), 'bones_only_b': sorted(set(B['names']) - set(A['names'])),
        'texture_same': A['img'] == B['img'], 'generator': [A['generator'], B['generator']], 'extras': [A['extras'], B['extras']],
        'bbox_a': [A['pos'].min(0).round(4).tolist(), A['pos'].max(0).round(4).tolist()],
        'bbox_b': [B['pos'].min(0).round(4).tolist(), B['pos'].max(0).round(4).tolist()],
    }
    out['clips'] = {k: [A['clips'].get(k), B['clips'].get(k)] for k in sorted(set(A['clips']) | set(B['clips']))}

    bones = {}
    for n in A['names']:
        if n not in B['names']:
            continue
        ma = A['rest'][A['names'].index(n)]
        mb = B['rest'][B['names'].index(n)]
        d = float(np.linalg.norm(ma[:3, 3] - mb[:3, 3]))
        ang = rot_angle_deg(ma, mb)
        if d > 1e-4 or ang > 0.05:
            bones[n] = {'moved': round(d, 4), 'rot_deg': round(ang, 2), 'a': ma[:3, 3].round(4).tolist(), 'b': mb[:3, 3].round(4).tolist()}
    out['bones_changed'] = bones

    # 정점 대응
    if len(A['pos']) == len(B['pos']) and np.allclose(A['uv'], B['uv'], atol=1e-6):
        match = np.arange(len(A['pos']))
        out['vertex_match'] = 'same order'
    else:
        # UV가 같으면 UV+위치로 최근접 (재내보내기로 순서가 바뀐 경우)
        feat_a = np.hstack([A['uv'] * 4, A['pos']])
        feat_b = np.hstack([B['uv'] * 4, B['pos']])
        match = np.empty(len(A['pos']), int)
        dist = np.empty(len(A['pos']))
        for s in range(0, len(feat_a), 512):
            d = ((feat_a[s:s + 512, None, :] - feat_b[None, :, :]) ** 2).sum(-1)
            match[s:s + 512] = d.argmin(1)
            dist[s:s + 512] = np.sqrt(d.min(1))
        out['vertex_match'] = f'nearest uv+pos (median feature dist {np.median(dist):.5f}, max {dist.max():.4f})'
    move = np.linalg.norm(B['pos'][match] - A['pos'], axis=1)
    # 가중치: 본 이름 공통 열로 정렬
    common = [n for n in A['names'] if n in B['names']]
    wa = A['dense'][:, [A['names'].index(n) for n in common]]
    wb = B['dense'][match][:, [B['names'].index(n) for n in common]]
    wdiff = np.abs(wa - wb).sum(1) / 2
    arm = np.array([n.startswith(('Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'Index', 'Middle', 'Ring', 'Thumb')) for n in common])
    y = A['pos'][:, 1]
    bands = []
    for lo, hi, label in [(0, 0.06, '신발'), (0.06, 0.25, '다리'), (0.25, 0.46, '몸통·팔'), (0.46, 0.5, '목'), (0.5, 1.2, '머리+모자')]:
        m = (y >= lo) & (y < hi)
        bands.append({'band': label, 'verts': int(m.sum()), 'moved_max': round(float(move[m].max()), 4) if m.any() else 0,
                      'moved_mean': round(float(move[m].mean()), 4) if m.any() else 0,
                      'weight_changed_verts(>0.01)': int((wdiff[m] > 0.01).sum()),
                      'arm_weight_a': round(float(wa[m][:, arm].sum(1).max()), 3) if m.any() else 0,
                      'arm_weight_b': round(float(wb[m][:, arm].sum(1).max()), 3) if m.any() else 0})
    out['vertex_bands'] = bands
    out['moved_verts(>0.5mm)'] = int((move > 5e-4).sum())
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()

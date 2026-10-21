"""
캐릭터 GLB의 머리(+모자) 영역만 균일 확대 (본·스킨 가중치·UV·텍스처·애니메이션은 그대로).

python tools/blender/scale_head_region.py <in.glb> <out.glb> [--scale 1.12] [--neck-from 0.465] [--neck-to 0.505]

- 원본 GLB의 POSITION·NORMAL 버퍼 값만 바꾸고 나머지(본 축, 바인드 행렬, 클립, 이미지)는 바이트 그대로 둔다.
  (Blender glTF 내보내기를 거치면 본 방향·클립 샘플링이 바뀔 수 있어 게임 손 IK가 깨질 위험 → 피함)
- 좌표는 glTF 그대로 (Y 위, 원본 높이 1.0). 머리 피벗 = (머리 중심 x·z, 목 높이 neck-from~neck-to 사이 아래쪽).
- 목 구간(neck-from→neck-to)은 smoothstep으로 0→1 감쇠해 이음새 없이 이어짐.
- 목 구간에서는 팔 계열 본(Shoulder/UpperArm/LowerArm/Hand/손가락) 가중치만큼 확대량을 줄여 어깨·팔은 움직이지 않음.
  (머리 정점에도 어깨 가중치가 최대 약 0.19 번져 있음 — 블루도 같음 — 머리 안쪽은 제한하지 않음)
- 법선은 변형의 야코비안 역전치로 변환 (감쇠 구간 음영 유지).
numpy만 사용 (Blender 내장 파이썬 또는 일반 파이썬).
"""
import argparse
import json
import struct

import numpy as np

ARM_PREFIXES = ('Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'Index', 'Middle', 'Ring', 'Thumb', 'Pinky')
COMPONENT = {5126: ('f4', 4), 5121: ('u1', 1), 5123: ('u2', 2), 5125: ('u4', 4)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    data = open(path, 'rb').read()
    magic, version, length = struct.unpack_from('<4sII', data, 0)
    assert magic == b'glTF' and version == 2
    jlen, jtype = struct.unpack_from('<I4s', data, 12)
    assert jtype == b'JSON'
    gltf = json.loads(data[20:20 + jlen])
    off = 20 + jlen
    blen, btype = struct.unpack_from('<I4s', data, off)
    assert btype == b'BIN\x00'
    binary = bytearray(data[off + 8:off + 8 + blen])
    return gltf, binary


def write_glb(path, gltf, binary):
    j = json.dumps(gltf, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    j += b' ' * ((4 - len(j) % 4) % 4)
    b = bytes(binary) + b'\x00' * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(j) + 8 + len(b)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total))
        f.write(struct.pack('<I4s', len(j), b'JSON'))
        f.write(j)
        f.write(struct.pack('<I4s', len(b), b'BIN\x00'))
        f.write(b)


def accessor_view(gltf, binary, idx):
    acc = gltf['accessors'][idx]
    bv = gltf['bufferViews'][acc['bufferView']]
    dtype, size = COMPONENT[acc['componentType']]
    n = NCOMP[acc['type']]
    stride = bv.get('byteStride', size * n)
    assert stride == size * n, '인터리브 버퍼는 지원 안 함'
    start = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    count = acc['count']
    arr = np.frombuffer(binary, dtype='<' + dtype, count=count * n, offset=start).reshape(count, n)
    if acc.get('normalized') and dtype != 'f4':
        arr = arr.astype(np.float64) / np.iinfo(dtype).max
    return arr, start, acc


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t), np.where((x > e0) & (x < e1), 6 * t * (1 - t) / (e1 - e0), 0.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp')
    ap.add_argument('out')
    ap.add_argument('--scale', type=float, default=1.12)
    ap.add_argument('--neck-from', type=float, default=0.465)
    ap.add_argument('--neck-to', type=float, default=0.505)
    a = ap.parse_args()

    gltf, binary = read_glb(a.inp)
    skin = gltf['skins'][0]
    joint_names = [gltf['nodes'][j].get('name', '') for j in skin['joints']]
    arm_joint = np.array([n.startswith(ARM_PREFIXES) for n in joint_names])

    report = []
    for mi, mesh in enumerate(gltf['meshes']):
        for pi, prim in enumerate(mesh['primitives']):
            at = prim['attributes']
            pos, pos_start, pos_acc = accessor_view(gltf, binary, at['POSITION'])
            nrm, nrm_start, _ = accessor_view(gltf, binary, at['NORMAL'])
            joints, _, _ = accessor_view(gltf, binary, at['JOINTS_0'])
            weights, _, _ = accessor_view(gltf, binary, at['WEIGHTS_0'])
            assert 'TANGENT' not in at, '탄젠트가 있으면 함께 변환해야 함'
            p = pos.astype(np.float64)
            n = nrm.astype(np.float64)
            arm_w = (weights * arm_joint[joints.astype(int)]).sum(axis=1)

            # 머리 중심 (목 위 정점 경계 중심) → 수평 피벗, 수직 피벗은 목 구간 아래
            head = p[p[:, 1] >= a.neck_to]
            pivot = np.array([(head[:, 0].min() + head[:, 0].max()) / 2, a.neck_from + (a.neck_to - a.neck_from) * 0.6,
                              (head[:, 2].min() + head[:, 2].max()) / 2])
            w, dw = smoothstep(a.neck_from, a.neck_to, p[:, 1])
            # 팔 가중치 제한은 목 구간에서만 (머리 안쪽의 작은 어깨 가중치 번짐 때문에 모자가 찌그러지지 않게)
            keep = np.where(p[:, 1] < a.neck_to, 1.0 - np.clip(arm_w, 0, 1), 1.0)
            w = w * keep
            dw = dw * keep
            f = 1.0 + (a.scale - 1.0) * w
            df = (a.scale - 1.0) * dw
            d = p - pivot
            new_p = pivot + d * f[:, None]

            # 야코비안 J = f·I + d ⊗ (0, df, 0)  → 법선 = J^-T n
            new_n = np.empty_like(n)
            for i in range(len(p)):
                if w[i] == 0 and df[i] == 0:
                    new_n[i] = n[i]
                    continue
                J = np.eye(3) * f[i]
                J[:, 1] += d[i] * df[i]
                v = np.linalg.solve(J.T, n[i])
                new_n[i] = v / np.linalg.norm(v)

            moved = int((w > 0).sum())
            binary[pos_start:pos_start + new_p.size * 4] = new_p.astype('<f4').tobytes()
            binary[nrm_start:nrm_start + new_n.size * 4] = new_n.astype('<f4').tobytes()
            pos_acc['min'] = [float(v) for v in new_p.min(axis=0)]
            pos_acc['max'] = [float(v) for v in new_p.max(axis=0)]
            report.append({'mesh': mi, 'primitive': pi, 'pivot': pivot.round(4).tolist(), 'vertices': len(p),
                           'moved': moved, 'fully_scaled': int((w > 0.999).sum()),
                           'arm_limited': int(((arm_w > 0.01) & (smoothstep(a.neck_from, a.neck_to, p[:, 1])[0] > 0)).sum()),
                           'bbox_before': [p.min(axis=0).round(4).tolist(), p.max(axis=0).round(4).tolist()],
                           'bbox_after': [new_p.min(axis=0).round(4).tolist(), new_p.max(axis=0).round(4).tolist()]})

    gltf.setdefault('asset', {})['extras'] = {
        **gltf.get('asset', {}).get('extras', {}),
        'popBattleHeadScale': {'scale': a.scale, 'neckFrom': a.neck_from, 'neckTo': a.neck_to, 'source': 'tools/blender/scale_head_region.py'},
    }
    write_glb(a.out, gltf, binary)
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()

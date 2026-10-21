// 두 GLB의 기본 형태가 같은지 비교 (모프 타깃 추가 전후 검증용). 사용: node tools/compare-glb-base.mjs <before.glb> <after.glb>
// 메시 속성(위치·법선·UV·관절·가중치)·인덱스·스킨 바인드 행렬·애니메이션 키·텍스처 바이트를 비교하고 최대 차이를 출력한다.
// 정점 순서까지 같아야 "같음" (모프 타깃·extras는 비교 대상 아님).
import fs from 'node:fs';

const COMP = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function load(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));
  const read = (i) => {
    const a = gltf.accessors[i];
    const bv = gltf.bufferViews[a.bufferView];
    const [Arr, size] = COMP[a.componentType];
    const n = NCOMP[a.type];
    const stride = bv.byteStride || size * n;
    const out = new Float64Array(a.count * n);
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    for (let k = 0; k < a.count; k++) {
      const view = new Arr(bin.buffer, bin.byteOffset + base + k * stride, n);
      for (let c = 0; c < n; c++) out[k * n + c] = view[c];
    }
    if (a.normalized) {
      const max = { 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 }[a.componentType];
      if (max) for (let k = 0; k < out.length; k++) out[k] /= max;
    }
    return out;
  };
  const view = (i) => {
    const bv = gltf.bufferViews[i];
    return bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  };
  return { gltf, read, view };
}

const [A, B] = [load(process.argv[2]), load(process.argv[3])];
let ok = true;
const maxDiff = (x, y) => {
  if (x.length !== y.length) return Infinity;
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]));
  return m;
};
const report = (label, d, tol = 1e-6) => {
  const pass = d <= tol;
  ok &&= pass;
  console.log(`${pass ? 'SAME' : 'DIFF'} ${label}: ${d === Infinity ? '개수 다름' : d.toExponential(2)}`);
};

A.gltf.meshes.forEach((m, mi) => {
  m.primitives.forEach((pa, pi) => {
    const pb = B.gltf.meshes[mi]?.primitives[pi];
    if (!pb) {
      ok = false;
      console.log(`DIFF mesh ${mi}/${pi} 없음`);
      return;
    }
    for (const attr of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0']) {
      if (pa.attributes[attr] === undefined) continue;
      report(`mesh${mi} ${attr}`, maxDiff(A.read(pa.attributes[attr]), B.read(pb.attributes[attr])), attr === 'WEIGHTS_0' ? 1e-4 : 1e-6);
    }
    report(`mesh${mi} indices`, maxDiff(A.read(pa.indices), B.read(pb.indices)), 0);
    console.log(`INFO mesh${mi} morph targets: ${pa.targets?.length ?? 0} → ${pb.targets?.length ?? 0} ${JSON.stringify(B.gltf.meshes[mi].extras?.targetNames ?? [])}`);
  });
});
(A.gltf.skins ?? []).forEach((s, si) => {
  report(`skin${si} inverseBindMatrices`, maxDiff(A.read(s.inverseBindMatrices), B.read(B.gltf.skins[si].inverseBindMatrices)));
  report(`skin${si} joints`, s.joints.length === B.gltf.skins[si].joints.length ? 0 : Infinity, 0);
});
report('animations count', (A.gltf.animations?.length ?? 0) === (B.gltf.animations?.length ?? 0) ? 0 : Infinity, 0);
(A.gltf.animations ?? []).forEach((an, ai) => {
  const bn = B.gltf.animations[ai];
  let d = an.channels.length === bn.channels.length ? 0 : Infinity;
  an.samplers.forEach((s, k) => {
    if (d === Infinity) return;
    d = Math.max(d, maxDiff(A.read(s.input), B.read(bn.samplers[k].input)), maxDiff(A.read(s.output), B.read(bn.samplers[k].output)));
  });
  report(`anim ${an.name}`, d);
});
(A.gltf.images ?? []).forEach((im, ii) => {
  const a = A.view(im.bufferView);
  const b = B.view(B.gltf.images[ii].bufferView);
  report(`image${ii} bytes`, a.length === b.length && a.equals(b) ? 0 : Infinity, 0);
});
console.log(ok ? 'RESULT 기본 형태 동일' : 'RESULT 차이 있음');
process.exit(ok ? 0 : 1);

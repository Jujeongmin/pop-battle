// 원본 GLB에 다른 GLB(같은 정점 순서)의 모프 타깃만 덧붙인다. 기존 데이터(정점·법선·UV·가중치·애니메이션·텍스처)는 바이트 그대로.
// 사용: node tools/add-morph-target.mjs <base.glb> <with-morph.glb> <out.glb>
// with-morph.glb는 base.glb를 Blender로 다시 내보내며 셰이프 키를 넣은 파일 (tools/blender/dead_eyes.py --shape-key).
// 정점 수·인덱스가 base와 같은지 확인한 뒤, 타깃의 POSITION·NORMAL 차이값을 base 버퍼 뒤에 붙이고 primitive.targets·mesh.weights·targetNames를 추가.
import fs from 'node:fs';

function parse(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`GLB 아님: ${file}`);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));
  return { gltf, bin };
}

/** float VEC3 접근자를 촘촘한 Float32 바이트로 (희소 접근자는 0 배열에 펼침 — Blender는 바뀐 정점이 적으면 희소로 내보냄) */
function accessorBytes(g, i) {
  const a = g.gltf.accessors[i];
  if (a.componentType !== 5126 || a.type !== 'VEC3') throw new Error('모프 타깃은 float VEC3만 지원');
  const out = new Float32Array(a.count * 3);
  if (a.bufferView !== undefined) {
    const bv = g.gltf.bufferViews[a.bufferView];
    const stride = bv.byteStride || 12;
    const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
    for (let k = 0; k < a.count; k++) for (let c = 0; c < 3; c++) out[k * 3 + c] = g.bin.readFloatLE(start + k * stride + c * 4);
  }
  if (a.sparse) {
    const sp = a.sparse;
    const ibv = g.gltf.bufferViews[sp.indices.bufferView];
    const vbv = g.gltf.bufferViews[sp.values.bufferView];
    const iStart = (ibv.byteOffset || 0) + (sp.indices.byteOffset || 0);
    const vStart = (vbv.byteOffset || 0) + (sp.values.byteOffset || 0);
    const isize = { 5121: 1, 5123: 2, 5125: 4 }[sp.indices.componentType];
    for (let k = 0; k < sp.count; k++) {
      const idx = isize === 1 ? g.bin.readUInt8(iStart + k) : isize === 2 ? g.bin.readUInt16LE(iStart + k * 2) : g.bin.readUInt32LE(iStart + k * 4);
      for (let c = 0; c < 3; c++) out[idx * 3 + c] = g.bin.readFloatLE(vStart + (k * 3 + c) * 4);
    }
  }
  return { acc: a, bytes: Buffer.from(out.buffer) };
}

/** 접근자를 Float64 배열로 (촘촘한 float만) */
function denseVec(g, i, n) {
  const a = g.gltf.accessors[i];
  const bv = g.gltf.bufferViews[a.bufferView];
  const stride = bv.byteStride || n * 4;
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = g.bin.readFloatLE(start + k * stride + c * 4);
  return out;
}

const [basePath, morphPath, outPath] = process.argv.slice(2);
const base = parse(basePath);
const morph = parse(morphPath);
const gj = base.gltf;

let extra = [];
let offset = base.bin.length;
const pad4 = (n) => (4 - (n % 4)) % 4;
offset += pad4(offset);
const firstPad = offset - base.bin.length;

gj.meshes.forEach((m, mi) => {
  const mm = morph.gltf.meshes[mi];
  m.primitives.forEach((p, pi) => {
    const mp = mm.primitives[pi];
    if (!mp?.targets?.length) return;
    const countBase = gj.accessors[p.attributes.POSITION].count;
    const countMorph = morph.gltf.accessors[mp.attributes.POSITION].count;
    // 정점 수가 다르면(Blender가 정점을 하나 더 가른 경우 등) 위치+UV로 짝지어 차이값을 옮김
    let remap = null;
    if (countBase !== countMorph) {
      const key = (g, prim, k) => {
        const P = denseVec(g, prim.attributes.POSITION, 3);
        const U = denseVec(g, prim.attributes.TEXCOORD_0, 2);
        return (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2], U[i * 2], U[i * 2 + 1]].map((v) => Math.round(v * 1e4)).join(',');
      };
      const kb = key(base, p);
      const km = key(morph, mp);
      const index = new Map();
      for (let i = 0; i < countMorph; i++) index.set(km(i), i);
      remap = new Int32Array(countBase);
      let miss = 0;
      for (let i = 0; i < countBase; i++) {
        const j = index.get(kb(i));
        remap[i] = j ?? -1;
        if (j === undefined) miss++;
      }
      // 못 찾은 정점: 위치만으로 가장 가까운 정점 (UV 경계에서 갈라진 정점)
      if (miss > 0) {
        const PB = denseVec(base, p.attributes.POSITION, 3);
        const PM = denseVec(morph, mp.attributes.POSITION, 3);
        for (let i = 0; i < countBase; i++) {
          if (remap[i] >= 0) continue;
          let best = -1;
          let bd = Infinity;
          for (let j = 0; j < countMorph; j++) {
            const d = (PB[i * 3] - PM[j * 3]) ** 2 + (PB[i * 3 + 1] - PM[j * 3 + 1]) ** 2 + (PB[i * 3 + 2] - PM[j * 3 + 2]) ** 2;
            if (d < bd) {
              bd = d;
              best = j;
            }
          }
          remap[i] = best;
          console.log(`REMAP 정점 ${i} → ${best} (거리 ${Math.sqrt(bd).toExponential(2)})`);
        }
      }
      console.log(`REMAP 정점 수 ${countBase} vs ${countMorph}: 위치+UV로 짝지음, UV로 못 찾은 정점 ${miss}개는 가장 가까운 위치로`);
    }
    p.targets = mp.targets.map((t) => {
      const out = {};
      for (const [attr, idx] of Object.entries(t)) {
        if (attr !== 'POSITION' && attr !== 'NORMAL') continue;
        let { acc, bytes } = accessorBytes(morph, idx);
        if (remap) {
          const src = new Float32Array(bytes.buffer, bytes.byteOffset, acc.count * 3);
          const dst = new Float32Array(remap.length * 3);
          for (let i = 0; i < remap.length; i++) if (remap[i] >= 0) for (let c = 0; c < 3; c++) dst[i * 3 + c] = src[remap[i] * 3 + c];
          bytes = Buffer.from(dst.buffer);
          acc = { ...acc, count: remap.length };
        }
        const bvIndex = gj.bufferViews.length;
        gj.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
        const newAcc = { bufferView: bvIndex, componentType: 5126, count: acc.count, type: 'VEC3' };
        // POSITION 타깃은 min/max 필수
        const f = new Float32Array(bytes.buffer, bytes.byteOffset, acc.count * 3);
        const mn = [Infinity, Infinity, Infinity];
        const mx = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < acc.count; k++) for (let c = 0; c < 3; c++) {
          mn[c] = Math.min(mn[c], f[k * 3 + c]);
          mx[c] = Math.max(mx[c], f[k * 3 + c]);
        }
        newAcc.min = mn;
        newAcc.max = mx;
        out[attr] = gj.accessors.length;
        gj.accessors.push(newAcc);
        extra.push(Buffer.from(bytes));
        offset += bytes.length;
        const pad = pad4(offset);
        if (pad) {
          extra.push(Buffer.alloc(pad));
          offset += pad;
        }
      }
      return out;
    });
  });
  if (mm.weights) m.weights = mm.weights.map(() => 0);
  if (mm.extras?.targetNames) m.extras = { ...(m.extras ?? {}), targetNames: mm.extras.targetNames };
});

const newBin = Buffer.concat([base.bin, Buffer.alloc(firstPad), ...extra]);
gj.buffers[0].byteLength = newBin.length;
let json = Buffer.from(JSON.stringify(gj), 'utf8');
json = Buffer.concat([json, Buffer.alloc(pad4(json.length), 0x20)]);
const binPadded = Buffer.concat([newBin, Buffer.alloc(pad4(newBin.length))]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + binPadded.length, 8);
const jh = Buffer.alloc(8);
jh.writeUInt32LE(json.length, 0);
jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8);
bh.writeUInt32LE(binPadded.length, 0);
bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(outPath, Buffer.concat([header, jh, json, bh, binPadded]));
console.log(`ADDED morph targets → ${outPath} (+${newBin.length - base.bin.length} bytes)`);

// GLB 정적 검증 도구. 사용: node tools/inspect-glb.mjs <file.glb> [--bones]
// 메시·머티리얼·정점/삼각형·텍스처 크기·스켈레톤·스키닝 가중치·애니메이션을 보고한다.
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const showBones = process.argv.includes('--bones');
if (!file) {
  console.error('usage: node tools/inspect-glb.mjs <file.glb> [--bones]');
  process.exit(1);
}

const buf = fs.readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('GLB 매직 넘버 아님');
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));

const COMP = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(i) {
  const a = gltf.accessors[i];
  const bv = gltf.bufferViews[a.bufferView];
  const [Arr, size] = COMP[a.componentType];
  const n = NCOMP[a.type];
  const stride = bv.byteStride || size * n;
  const out = new Float64Array(a.count * n);
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  for (let e = 0; e < a.count; e++) {
    for (let c = 0; c < n; c++) {
      const off = base + e * stride + c * size;
      const view = new Arr(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + size));
      let v = view[0];
      if (a.normalized) v /= Arr === Uint8Array ? 255 : Arr === Uint16Array ? 65535 : 1;
      out[e * n + c] = v;
    }
  }
  return { data: out, n, count: a.count };
}

function imageSize(bytes, mime) {
  if (mime === 'image/png') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  // JPEG: SOF 마커 탐색
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    const len = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
    }
    i += 2 + len;
  }
  return [0, 0];
}

const kb = (b) => `${(b / 1024).toFixed(0)}KB`;
console.log(`# ${path.basename(file)}  (${kb(buf.length)})`);
console.log(`generator: ${gltf.asset.generator ?? '-'}`);
console.log(`extensionsUsed: ${(gltf.extensionsUsed ?? []).join(', ') || '-'}`);

// 노드 계층
const parent = {};
gltf.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[c] = i)));
const nonIdentity = gltf.nodes
  .map((n, i) => ({ i, n }))
  .filter(({ n }) => n.scale && n.scale.some((s) => Math.abs(s - 1) > 1e-3));
if (nonIdentity.length) console.log(`! 스케일이 1이 아닌 노드: ${nonIdentity.map(({ n }) => `${n.name}=${n.scale.map((s) => s.toFixed(3))}`).join(', ')}`);

// 메시
let totalTris = 0;
let totalVerts = 0;
for (const mesh of gltf.meshes ?? []) {
  for (const p of mesh.primitives) {
    const pos = gltf.accessors[p.attributes.POSITION];
    const tris = p.indices != null ? gltf.accessors[p.indices].count / 3 : pos.count / 3;
    totalTris += tris;
    totalVerts += pos.count;
    const size = pos.max.map((v, k) => v - pos.min[k]);
    console.log(`mesh "${mesh.name}": verts ${pos.count}, tris ${tris}, attrs [${Object.keys(p.attributes).join(',')}], material ${p.material}`);
    console.log(`  bounds min ${pos.min.map((v) => v.toFixed(3))} max ${pos.max.map((v) => v.toFixed(3))} size ${size.map((v) => v.toFixed(3))}`);
    const center = pos.min.map((v, k) => (v + pos.max[k]) / 2);
    console.log(`  center ${center.map((v) => v.toFixed(3))}`);

    // 스키닝 검사
    if (p.attributes.JOINTS_0 != null && p.attributes.WEIGHTS_0 != null) {
      const J = readAccessor(p.attributes.JOINTS_0);
      const W = readAccessor(p.attributes.WEIGHTS_0);
      let unweighted = 0;
      let badSum = 0;
      let maxInf = 0;
      const jointUse = new Map();
      for (let v = 0; v < W.count; v++) {
        let sum = 0;
        let inf = 0;
        for (let k = 0; k < 4; k++) {
          const w = W.data[v * 4 + k];
          sum += w;
          if (w > 1e-4) {
            inf++;
            const j = J.data[v * 4 + k];
            jointUse.set(j, (jointUse.get(j) ?? 0) + w);
          }
        }
        if (sum < 1e-4) unweighted++;
        else if (Math.abs(sum - 1) > 0.02) badSum++;
        maxInf = Math.max(maxInf, inf);
      }
      const skin = gltf.skins[0];
      const jointNames = skin.joints.map((j) => gltf.nodes[j].name);
      const unused = jointNames.filter((_, k) => !jointUse.has(k));
      console.log(`  skin: joints ${jointNames.length}, max influences ${maxInf}, unweighted verts ${unweighted}, weight sum != 1: ${badSum}`);
      console.log(`  weightless joints (${unused.length}): ${unused.join(', ') || '-'}`);
      const ranked = [...jointUse.entries()].sort((a, b) => b[1] - a[1]).map(([j, w]) => `${jointNames[j]}:${w.toFixed(0)}`);
      console.log(`  weight mass by joint: ${ranked.join(' ')}`);
    }
  }
}
console.log(`TOTAL verts ${totalVerts}, tris ${totalTris}`);

// 머티리얼·텍스처
for (const [i, m] of (gltf.materials ?? []).entries()) {
  const pbr = m.pbrMetallicRoughness ?? {};
  console.log(`material ${i} "${m.name}": metallic ${pbr.metallicFactor ?? 1}, roughness ${pbr.roughnessFactor ?? 1}, baseColorTex ${pbr.baseColorTexture?.index ?? '-'}, mrTex ${pbr.metallicRoughnessTexture?.index ?? '-'}, normalTex ${m.normalTexture?.index ?? '-'}, alpha ${m.alphaMode ?? 'OPAQUE'}, doubleSided ${!!m.doubleSided}`);
}
for (const [i, img] of (gltf.images ?? []).entries()) {
  const bv = gltf.bufferViews[img.bufferView];
  const bytes = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  const [w, h] = imageSize(Buffer.from(bytes), img.mimeType);
  console.log(`image ${i} "${img.name}": ${img.mimeType} ${w}x${h} ${kb(bv.byteLength)} (GPU ~${kb(w * h * 4 * 1.33)})`);
}

// 스켈레톤
if (gltf.skins?.length) {
  const skin = gltf.skins[0];
  const joints = new Set(skin.joints);
  const roots = skin.joints.filter((j) => !joints.has(parent[j]));
  console.log(`skeleton roots: ${roots.map((r) => gltf.nodes[r].name).join(', ')}`);
  if (showBones) {
    const print = (i, d) => {
      const n = gltf.nodes[i];
      console.log(`${'  '.repeat(d)}${n.name}`);
      (n.children ?? []).filter((c) => joints.has(c)).forEach((c) => print(c, d + 1));
    };
    roots.forEach((r) => print(r, 1));
  }
}

// 애니메이션
for (const anim of gltf.animations ?? []) {
  const targets = new Set();
  let duration = 0;
  let hipsY = null;
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    duration = Math.max(duration, gltf.accessors[s.input].max[0]);
    targets.add(`${gltf.nodes[ch.target.node].name}.${ch.target.path}`);
    if (ch.target.path === 'translation') {
      const out = gltf.accessors[s.output];
      const name = gltf.nodes[ch.target.node].name;
      if (out.min && out.max) {
        const range = out.max.map((v, k) => v - out.min[k]);
        if (range.some((r) => r > 0.02)) hipsY = `${name} translation range ${range.map((r) => r.toFixed(3))}`;
      }
    }
  }
  const paths = [...targets];
  const rot = paths.filter((p) => p.endsWith('.rotation')).length;
  const tr = paths.filter((p) => p.endsWith('.translation')).length;
  const sc = paths.filter((p) => p.endsWith('.scale')).length;
  console.log(`anim "${anim.name}": ${duration.toFixed(2)}s, channels ${anim.channels.length} (rot ${rot}, trans ${tr}, scale ${sc})${hipsY ? `, ${hipsY}` : ''}`);
}

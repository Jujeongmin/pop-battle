import * as THREE from 'three';
import { ARENA } from '../../config/maps';
import { KitMerger, lighten, seededRandom, trs, type KitModels } from './kit';

/**
 * 경기장 바깥 장난감 도시 (충돌 없음, 원거리 배경).
 * 모든 건물은 브릭 키트 조각을 크게 키워 조립 (경기장 엄폐물과 같은 모델·텍스처 → 같은 게임 에셋처럼 보임).
 * 둥근 지붕·나무 잎·풍선처럼 키트에 없는 둥근 모양만 three.js 기본 도형.
 *
 * 거리별 구성 (경기장 중심 기준):
 * - 가까운 띠: 광장 가장자리 나무 줄 + 순환 도로 바깥 낮은 집·작은 탑 (벽 너머로 지붕만 보임)
 * - 중간 띠 (75~125m): 블록 아파트·둥근 탑, 다양한 높이
 * - 먼 띠 (125~230m): 스터드 없는 상자 브릭으로 만든 큰 실루엣 (안개로 수평선에 녹음)
 * 도로·광장·랜드마크 자리는 비움. 배치는 시드 고정 (매번 같음).
 */

/** 도시에 쓰는 색 (경기장 팔레트 기반 파스텔) */
const P = ARENA.palette;
const BODY = [lighten(P.blue, 0.3), lighten(P.yellow, 0.25), lighten(P.orange, 0.3), lighten(P.pink, 0.25), lighten(P.mint, 0.2), lighten(P.lavender, 0.15), 0xfaf3e6, 0xffd9c2];
const ROOF = [0xff8f8f, 0x7fb2ff, 0xffc65c, 0x8fd9a8, 0xb9a2ff, 0xff9ec7];
const WINDOW = 0xe3f1ff;
const TRUNK = 0xc9946b;
const LEAF = [0x8fdc9a, 0x9fe3b0, 0xffb7d0, 0xb6e88f];

/** 비워 둘 자리 (랜드마크·간판) */
export interface Keepout {
  x: number;
  z: number;
  r: number;
}

/** 도로·광장 위인지 (반폭 여유 m) */
export function onRoad(x: number, z: number, margin: number): boolean {
  const g = ARENA.ground;
  const [rx, rz] = g.ringRoadHalf;
  // 광장 + 순환 도로 안쪽
  if (Math.abs(x) < rx + margin && Math.abs(z) < rz + margin) return true;
  // 남북·동서 큰길
  if (Math.abs(x) < g.avenueHalfWidth + margin && Math.abs(z) > rz - margin) return true;
  if (Math.abs(z) < g.avenueHalfWidth + margin && Math.abs(x) > rx - margin) return true;
  // 바깥 격자 도로
  for (const c of CROSS_ROADS) {
    if (Math.abs(Math.abs(x) - c) < 3 + margin) return true;
    if (Math.abs(Math.abs(z) - c) < 3 + margin) return true;
  }
  return false;
}
/** 바깥 격자 도로 위치 (|x|, |z| 기준) */
export const CROSS_ROADS = [92, 160];

export function buildCity(kit: KitModels, city: KitMerger, keepouts: readonly Keepout[]): void {
  const rnd = seededRandom(20261020);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const blocked = (x: number, z: number, r: number) =>
    onRoad(x, z, r) || keepouts.some((k) => Math.hypot(x - k.x, z - k.z) < k.r + r);

  // ---------- 광장 가장자리 나무 줄 (벽 너머로 잎이 보임) ----------
  const [px, pz] = ARENA.ground.plazaHalf;
  for (let z = -pz + 3; z <= pz - 3; z += 5.5) {
    for (const sx of [-1, 1]) {
      const x = sx * (px - 2.2);
      if (keepouts.some((k) => Math.hypot(x - k.x, z - k.z) < k.r)) continue;
      tree(kit, city, x, z, 3.6 + rnd() * 1.4, pick(LEAF), rnd() < 0.3);
    }
  }
  for (let x = -px + 3; x <= px - 3; x += 5.5) {
    for (const sz of [-1, 1]) {
      const z = sz * (pz - 2.2);
      if (Math.abs(x) < 12) continue; // 간판 자리
      tree(kit, city, x, z, 3.6 + rnd() * 1.4, pick(LEAF), rnd() < 0.3);
    }
  }

  // ---------- 가까운·중간 띠: 12m 격자 ----------
  const near = 12;
  for (let gx = -132; gx <= 132; gx += near) {
    for (let gz = -132; gz <= 132; gz += near) {
      const x = gx + (rnd() - 0.5) * 3;
      const z = gz + (rnd() - 0.5) * 3;
      const d = Math.hypot(x, z);
      if (d > 128) continue;
      const roll = rnd();
      if (blocked(x, z, 4.5)) {
        // 도로 가장자리 여유가 조금 부족하면 나무만
        if (!blocked(x, z, 1.8) && roll < 0.55) tree(kit, city, x, z, 3.5 + rnd() * 2, pick(LEAF), rnd() < 0.4);
        continue;
      }
      const rot = Math.round(rnd() * 3) * (Math.PI / 2) + (rnd() - 0.5) * 0.3;
      const midBand = d > 75;
      if (roll < 0.12) {
        // 나무 무리
        for (let i = 0; i < 3; i++) tree(kit, city, x + (rnd() - 0.5) * 7, z + (rnd() - 0.5) * 7, 3.5 + rnd() * 2.5, pick(LEAF), rnd() < 0.4);
        continue;
      }
      if (!midBand) {
        // 가까운 띠: 낮은 집 위주
        if (roll < 0.72) house(kit, city, x, z, rot, 17 + rnd() * 6, rnd() < 0.35 ? 2 : 1, pick(BODY), pick(ROOF), rnd);
        else roundTower(kit, city, x, z, 40 + rnd() * 12, 1 + Math.floor(rnd() * 2), pick(BODY), pick(ROOF), rnd);
      } else if (roll < 0.45) {
        block(kit, city, x, z, rot, 26 + rnd() * 12, 3 + Math.floor(rnd() * 4), pick(BODY), pick(BODY), pick(ROOF), rnd);
      } else if (roll < 0.7) {
        house(kit, city, x, z, rot, 20 + rnd() * 8, 2 + Math.floor(rnd() * 2), pick(BODY), pick(ROOF), rnd);
      } else if (roll < 0.9) {
        roundTower(kit, city, x, z, 48 + rnd() * 18, 2 + Math.floor(rnd() * 3), pick(BODY), pick(ROOF), rnd);
      } else {
        tree(kit, city, x, z, 4 + rnd() * 2, pick(LEAF), false);
      }
    }
  }

  // ---------- 먼 띠: 20m 격자, 큰 상자 실루엣 ----------
  for (let gx = -230; gx <= 230; gx += 20) {
    for (let gz = -230; gz <= 230; gz += 20) {
      const x = gx + (rnd() - 0.5) * 6;
      const z = gz + (rnd() - 0.5) * 6;
      const d = Math.hypot(x, z);
      if (d < 132 || d > 235) continue;
      if (blocked(x, z, 7) || rnd() < 0.2) continue;
      farTower(kit, city, x, z, Math.round(rnd() * 3) * (Math.PI / 2), 12 + rnd() * 26, pick(BODY), pick(ROOF), rnd);
    }
  }
}

// ======================= 건물 조립 =======================

const UP = new THREE.Vector3(0, 1, 0);
const sphere = new THREE.SphereGeometry(1, 12, 8);
const dome = new THREE.SphereGeometry(1, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2);
const cone = new THREE.ConeGeometry(1, 1, 12);
const windowBox = new THREE.BoxGeometry(1, 1, 1);

/** 로컬(건물 기준) 오프셋 → 월드 행렬 */
function local(x: number, z: number, rot: number, lx: number, y: number, lz: number, r2: number, scale: number | [number, number, number]): THREE.Matrix4 {
  const v = new THREE.Vector3(lx, 0, lz).applyAxisAngle(UP, rot);
  return trs(x + v.x, y, z + v.z, rot + r2, scale);
}

/** 박공지붕 집: 2x4 브릭 두 개(4×4 스터드) × 층 + 경사 브릭 두 개 + 창문 */
function house(kit: KitModels, m: KitMerger, x: number, z: number, rot: number, k: number, levels: number, body: number, roof: number, rnd: () => number): void {
  const lv = 0.096 * k;
  for (let l = 0; l < levels; l++) {
    const c = l % 2 === 0 ? body : lighten(body, 0.25);
    m.addKit(kit.box2x4, local(x, z, rot, 0, l * lv, -0.08 * k, 0, k), c);
    m.addKit(kit.box2x4, local(x, z, rot, 0, l * lv, 0.08 * k, 0, k), c);
    // 앞뒤 창문 2개씩
    for (const side of [-1, 1]) {
      for (const wx of [-0.08, 0.08]) {
        m.addBasic(windowBox, local(x, z, rot, wx * k, l * lv + lv * 0.3, side * 0.161 * k, 0, [0.06 * k, 0.045 * k, 0.012 * k]), WINDOW);
      }
    }
  }
  const top = levels * lv;
  m.addKit(kit.slope2x4, local(x, z, rot, -0.08 * k, top, 0, 0, k), roof);
  m.addKit(kit.slope2x4, local(x, z, rot, 0.08 * k, top, 0, Math.PI, k), roof);
  if (rnd() < 0.5) m.addKit(kit.round1x1, local(x, z, rot, 0.09 * k, top, 0.09 * k, 0, k * 0.9), lighten(roof, 0.4));
}

/** 둥근 탑: 1x1 둥근 브릭을 크게 쌓고 원뿔 또는 반구 지붕 */
function roundTower(kit: KitModels, m: KitMerger, x: number, z: number, k: number, levels: number, body: number, roof: number, rnd: () => number): void {
  const lv = 0.096 * k;
  const radius = 0.04 * k;
  for (let l = 0; l < levels; l++) {
    m.addKit(kit.boxRound, trs(x, l * lv, z, 0, k), l % 2 === 0 ? body : 0xfffaf2);
    // 둥근 창 띠
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + l * 0.6;
      m.addBasic(windowBox, trs(x + Math.sin(a) * radius, l * lv + lv * 0.35, z + Math.cos(a) * radius, a, [radius * 0.45, radius * 0.4, 0.15]), WINDOW);
    }
  }
  const top = levels * lv;
  if (rnd() < 0.55) m.addBasic(cone, trs(x, top + radius * 0.75, z, 0, [radius * 1.25, radius * 1.5, radius * 1.25]), roof);
  else m.addBasic(dome, trs(x, top - 0.005 * k, z, 0, radius * 1.05), roof);
}

/** 블록 아파트: 2x2 브릭 줄무늬 층 + 사면 경사 지붕(모서리 경사 브릭 4개) 또는 평지붕 물탱크 */
function block(kit: KitModels, m: KitMerger, x: number, z: number, rot: number, k: number, levels: number, a: number, b: number, roof: number, rnd: () => number): void {
  const lv = 0.096 * k;
  const half = 0.08 * k;
  const hipRoof = rnd() < 0.6;
  for (let l = 0; l < levels; l++) {
    // 맨 위 층은 평지붕일 때만 스터드가 보임
    const studs = !hipRoof && l === levels - 1;
    m.addKit(studs ? kit.brick2x2 : kit.box2x2, local(x, z, rot, 0, l * lv, 0, 0, k), l % 2 === 0 ? a : b);
    // 네 면 창문 2개씩
    for (let f = 0; f < 4; f++) {
      const fr = rot + (f * Math.PI) / 2;
      for (const wx of [-0.4, 0.4]) {
        m.addBasic(windowBox, local(x, z, fr, wx * half, l * lv + lv * 0.3, half + 0.02, 0, [half * 0.45, lv * 0.42, 0.12]), WINDOW);
      }
    }
  }
  const top = levels * lv;
  if (hipRoof) {
    // 사면 지붕: 모서리 경사 브릭(2x2, 높은 모서리 +x,-z)을 반 크기로 네 사분면에, 높은 모서리가 가운데로 오게
    const kk = k / 2;
    const q = 0.04 * k;
    for (const [sx, sz] of [[-1, 1], [1, 1], [1, -1], [-1, -1]] as const) {
      // 회전 r: (1,-1) 방향을 (-sx,-sz)로
      const target = Math.atan2(-sx, -sz);
      const base = Math.atan2(1, -1);
      m.addKit(kit.slopeCorner, local(x, z, rot, sx * q, top, sz * q, target - base, kk), roof);
    }
  } else {
    m.addKit(kit.round1x1, local(x, z, rot, 0.03 * k, top, -0.03 * k, 0, k * 0.6), lighten(roof, 0.3));
  }
}

/** 먼 실루엣: 스터드 없는 상자 브릭을 세로로 늘려 1~2단 + 지붕 */
function farTower(kit: KitModels, m: KitMerger, x: number, z: number, rot: number, h: number, body: number, roof: number, rnd: () => number): void {
  const w = 6 + rnd() * 6;
  const d = 6 + rnd() * 5;
  // 상자 브릭 2x2: 0.16 × 0.096 × 0.16
  m.addKit(kit.box2x2, local(x, z, rot, 0, 0, 0, 0, [w / 0.16, h / 0.096, d / 0.16]), body);
  if (rnd() < 0.5) {
    const h2 = h * (0.25 + rnd() * 0.3);
    m.addKit(kit.box2x2, local(x, z, rot, 0, h, 0, 0, [(w * 0.6) / 0.16, h2 / 0.096, (d * 0.6) / 0.16]), lighten(body, 0.3));
    if (rnd() < 0.5) m.addBasic(cone, trs(x, h + h2 + 2.5, z, 0, [w * 0.35, 5, w * 0.35]), roof);
  } else if (rnd() < 0.6) {
    m.addBasic(dome, trs(x, h - 0.2, z, 0, Math.min(w, d) * 0.5), roof);
  }
}

/** 장난감 나무: 둥근 기둥 줄기 + 공 모양 잎 (또는 원뿔 세 개 침엽수) */
export function tree(kit: KitModels, m: KitMerger, x: number, z: number, h: number, leaf: number, pine: boolean): void {
  const trunkH = h * 0.42;
  // 1x1 둥근 브릭(지름 0.08 × 높이 0.096)을 가늘고 길게
  m.addKit(kit.boxRound, trs(x, 0, z, 0, [0.38 / 0.08, trunkH / 0.096, 0.38 / 0.08]), TRUNK);
  if (pine) {
    for (let i = 0; i < 3; i++) {
      const r = h * (0.32 - i * 0.07);
      m.addBasic(cone, trs(x, trunkH * 0.8 + i * h * 0.2 + r * 0.6, z, 0, [r, r * 1.2, r]), leaf);
    }
  } else {
    const r = h * 0.3;
    m.addBasic(sphere, trs(x, trunkH + r * 0.8, z, 0, [r, r * 0.92, r]), leaf);
  }
}

/** 풍선: 약간 길쭉한 공 + 매듭 + 줄 (줄 끝 anchor에 묶임 → 떠 있어 보이지 않게) */
export function balloon(m: KitMerger, x: number, y: number, z: number, r: number, color: number, anchor: THREE.Vector3): void {
  m.addBasic(sphere, trs(x, y, z, 0, [r, r * 1.18, r]), color);
  m.addBasic(cone, trs(x, y - r * 1.2, z, Math.PI, [r * 0.18, r * 0.2, r * 0.18]), color);
  const top = new THREE.Vector3(x, y - r * 1.25, z);
  const dir = anchor.clone().sub(top);
  const rope = new THREE.CylinderGeometry(0.02, 0.02, 1, 4);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  m.addBasic(rope, new THREE.Matrix4().compose(top.clone().add(anchor).multiplyScalar(0.5), q, new THREE.Vector3(1, dir.length(), 1)), 0xfffdf8);
  rope.dispose();
}

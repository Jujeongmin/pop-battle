import * as THREE from 'three';
import { ARENA, plain, type ArenaModelKey, type ArenaTheme } from '../../config/maps';
import type { MapShell } from './arenaLayout';
import { KitMerger, lighten, trs, type KitModels } from './kit';

/**
 * POP! ARENA 바깥 벽: 장난감 브릭을 엇갈려 쌓은 낮은 담장 + 색 기둥 + 모서리 탑 + 삼각 깃발 줄.
 * - 벽 안쪽 면은 이전 경계와 같은 평면 (x ±19.5, z ±25.5) → 플레이 영역·봇 이동 격자 그대로
 * - 브릭은 경계 평면에서 2cm 뒤로 (기둥 안쪽 면과 겹쳐 깜빡이지 않게). 충돌 면은 경계 평면
 * - 덮개 플레이트 아래 브릭은 스터드 없는 같은 크기 모델 (안 보이는 스터드 삼각형 절약)
 * - 충돌: 보이는 벽·기둥과 같은 크기의 상자 (사격·카메라·이동 모두) +
 *   보이는 벽 위 ~ 10m는 이동만 막는 상자 (사격·카메라·시야 판정은 통과 → 허공에 탄흔·카메라 걸림 없음)
 */

export interface WallInstance {
  model: ArenaModelKey;
  color: number;
  matrix: THREE.Matrix4;
  /** false = 단색 장난감 도형 (놀이터 담장) */
  textured?: boolean;
}
export interface WallCollider {
  center: THREE.Vector3;
  half: THREE.Vector3;
  /** true = 캐릭터 이동만 막음 (사격·카메라·시야 쿼리에서 제외) */
  movementOnly: boolean;
  /** 디버그 표시 이름 */
  label: string;
}
export interface ArenaWallBuild {
  /** 그림자 있는 인스턴스 배치에 들어갈 브릭 (벽·기둥) */
  instances: WallInstance[];
  colliders: WallCollider[];
}

const S = ARENA.brickScale;
const STUD = 0.08 * S;
const LEVEL = ARENA.brickBodyHeight * S;
const PLATE = ARENA.plateBodyHeight * S;
const INSET = 0.02;
const WALL_DEPTH = STUD;
/** 일반 기둥 2x2 (1.12m), 모서리 탑 2x2 × 9배 (1.44m) */
const PILLAR = 2 * STUD;
const CORNER_SCALE = 9;
const CORNER = 0.16 * CORNER_SCALE;
const CORNER_LEVEL = ARENA.brickBodyHeight * CORNER_SCALE;
const CORNER_PLATE = ARENA.plateBodyHeight * CORNER_SCALE;

export const PIECES: Record<number, [brick: ArenaModelKey, plate: ArenaModelKey]> = {
  8: ['brick1x8', 'plate1x8'],
  6: ['brick1x6', 'plate1x6'],
  4: ['brick1x4', 'plate1x4'],
  2: ['brick1x2', 'plate1x2'],
};

type SideName = 'N' | 'S' | 'E' | 'W';
interface Side {
  name: SideName;
  /** 벽을 따라가는 축의 안쪽 반길이 */
  half: number;
  /** 안쪽 면 좌표 (절댓값) */
  face: number;
  /** 줄별 색 (아래 → 위) */
  rows: number[];
  /** 높은 구간 (발판 옆) 이 있는지 */
  raised: boolean;
}

/** 진영 색 (북 분홍·남 파랑): 모든 맵에서 같음 */
const TEAM = ARENA.palette;

/** 벽 따라 거리(along)·바깥쪽 거리(out) → 월드 x, z */
function place(side: SideName, along: number, out: number, face: number): [number, number] {
  switch (side) {
    case 'N':
      return [along, face + out];
    case 'S':
      return [along, -(face + out)];
    case 'E':
      return [face + out, along];
    case 'W':
      return [-(face + out), along];
  }
}
const rotOf = (side: SideName) => (side === 'N' || side === 'S' ? 0 : Math.PI / 2);

/** 한 줄을 스터드 길이 조각으로 나누기 (홀수 줄은 반 칸 밀어 엇갈려 쌓기) */
/** 벽 반길이 half 안에 0부터 step 간격으로 놓은 기둥 자리 (모서리 기둥과 2m 안으로 붙는 자리는 뺌). POP! ARENA 남·북(19.5, 6.7) = 0·±6.7·±13.4 */
function evenMids(half: number, step: number): number[] {
  let n = Math.floor(half / step);
  if (half - n * step < 2) n--;
  const out: number[] = [];
  for (let i = n; i >= -n; i--) out.push(i * step);
  return out;
}

export function rowSequence(n: number, offset: boolean): number[] {
  const seq: number[] = [];
  let rem = n;
  if (offset && rem >= 6) {
    const first = rem >= 10 ? 4 : 2;
    seq.push(first);
    rem -= first;
  }
  while (rem > 0) {
    const pick = rem >= 8 ? 8 : rem >= 6 ? 6 : rem >= 4 ? 4 : 2;
    seq.push(pick);
    rem -= pick;
  }
  return seq;
}

/**
 * shell: 경기장 크기. raised: 동·서 벽 가운데(발판 옆 |z| ≤ raisedHalfZ)를 높게 — 벽 가까이에 발판이 있는 맵(POP! ARENA)만.
 * theme: 색 + 모양 (brick = 브릭 엇갈려 쌓기, soft = 둥근 벽판 두 장 + 원기둥 기둥). 충돌은 모양과 상관없이 같음
 */
export function buildArenaWall(kit: KitModels, decor: KitMerger, shell: MapShell, raised: boolean, theme: ArenaTheme): ArenaWallBuild {
  const P = theme.palette;
  const CREAM = theme.wallCream;
  const CAP = P.white;
  const PILLAR_COLORS = [P.blue, P.yellow, P.pink, P.orange, P.mint, P.lavender];
  const PENNANT_COLORS = [P.pink, P.yellow, P.blue, P.orange, P.mint, P.lavender];
  const soft = theme.wallStyle === 'soft';
  const { halfX, halfZ } = shell;
  // 경계 안쪽 면 (이전 벽 중심선 ± 두께/2 와 같음)
  const faceX = halfX - shell.boundaryThickness / 2;
  const faceZ = halfZ - shell.boundaryThickness / 2;
  const { rows: ROWS, raisedRows: RAISED_ROWS, raisedHalfZ, colliderHeight } = ARENA.wall;
  const wallTop = ROWS * LEVEL + PLATE;
  const raisedTop = RAISED_ROWS * LEVEL + PLATE;

  const sides: Side[] = [
    { name: 'N', half: faceX, face: faceZ, raised: false, rows: [lighten(P.pink, 0.2), CREAM, lighten(P.yellow, 0.15)] },
    { name: 'S', half: faceX, face: faceZ, raised: false, rows: [lighten(P.blue, 0.28), CREAM, lighten(P.yellow, 0.15)] },
    {
      name: 'E', half: faceZ, face: faceX, raised,
      rows: [lighten(P.lavender, 0.1), CREAM, lighten(P.orange, 0.2), lighten(P.lavender, 0.1), CREAM],
    },
    {
      name: 'W', half: faceZ, face: faceX, raised,
      rows: [lighten(P.mint, 0.1), CREAM, lighten(P.orange, 0.2), lighten(P.mint, 0.1), CREAM],
    },
  ];

  const instances: WallInstance[] = [];
  const colliders: WallCollider[] = [];
  const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, label: string, movementOnly = false) =>
    colliders.push({ center: new THREE.Vector3(cx, cy, cz), half: new THREE.Vector3(hx, hy, hz), movementOnly, label });
  /** 벽 좌표계 상자 → 월드 상자 (along/out 반길이) */
  const sideBox = (side: Side, along: number, out: number, y0: number, y1: number, halfAlong: number, halfOut: number, label: string, movementOnly = false) => {
    const [x, z] = place(side.name, along, out, side.face);
    const ns = side.name === 'N' || side.name === 'S';
    box(x, (y0 + y1) / 2, z, ns ? halfAlong : halfOut, (y1 - y0) / 2, ns ? halfOut : halfAlong, label, movementOnly);
  };

  let pillarIndex = 0;
  for (const side of sides) {
    const rot = rotOf(side.name);
    const cornerAlong = side.half + CORNER / 2;
    // 중간 기둥: 높은 구간이 있는 벽은 높은 구간 끝(±9.4)에 맞춘 자리, 나머지는 약 6.7~9m 간격으로 고르게 (POP! ARENA 남·북 = 6.7)
    const mids = side.raised ? [17.7, 9.4, 0, -9.4, -17.7] : evenMids(side.half, side.name === 'E' || side.name === 'W' ? 8.8 : 6.7);
    const stops = [-cornerAlong, ...mids.slice().reverse(), cornerAlong].sort((a, b) => a - b);
    const isRaised = (a: number) => side.raised && Math.abs(a) <= raisedHalfZ + 1e-3;

    // --- 놀이터 담장: 기둥 사이를 둥근 벽판 두 장(아래 색·위 크림)으로 (벽판 끝은 기둥 속에 숨음) ---
    for (let i = 0; soft && i < stops.length - 1; i++) {
      const a0 = stops[i]!;
      const a1 = stops[i + 1]!;
      const [x, z] = place(side.name, (a0 + a1) / 2, INSET + WALL_DEPTH / 2, side.face);
      const lower = wallTop * 0.62;
      // 벽판 모델은 긴 변이 z축 → 남·북 벽(브릭 회전 0)은 90° 돌림
      const yaw = rot + Math.PI / 2;
      instances.push({ model: 'pWall', color: side.rows[0]!, textured: false, matrix: trs(x, 0, z, yaw, [WALL_DEPTH / 0.2, lower, a1 - a0]) });
      instances.push({ model: 'pWall', color: CREAM, textured: false, matrix: trs(x, lower, z, yaw, [WALL_DEPTH / 0.2, wallTop - lower, a1 - a0]) });
    }

    // --- 담장: 기둥 사이를 브릭으로 채움 (조각 끝은 기둥 속에 숨음) ---
    for (let i = 0; !soft && i < stops.length - 1; i++) {
      const a0 = stops[i]!;
      const a1 = stops[i + 1]!;
      const rows = isRaised(a0) && isRaised(a1) ? RAISED_ROWS : ROWS;
      let n = Math.ceil((a1 - a0) / STUD - 1e-6);
      if (n % 2) n++;
      const start = (a0 + a1) / 2 - (n * STUD) / 2;
      for (let r = 0; r <= rows; r++) {
        const cap = r === rows;
        const seq = rowSequence(n, (cap ? rows - 1 : r) % 2 === 1);
        let p = start;
        seq.forEach((studs, k) => {
          const [brick, plate] = PIECES[studs]!;
          const center = p + (studs * STUD) / 2;
          const [x, z] = place(side.name, center, INSET + WALL_DEPTH / 2, side.face);
          const base = side.rows[r % side.rows.length] ?? CREAM;
          const color = cap ? CAP : k % 2 === 0 ? base : lighten(base, 0.22);
          instances.push({ model: cap ? plate : plain(brick), color, matrix: trs(x, cap ? rows * LEVEL : r * LEVEL, z, rot, S) });
          p += studs * STUD;
        });
      }
    }

    // --- 충돌: 담장 (보이는 높이까지), 발판 옆 높은 구간, 그 위 이동 전용 ---
    const fullAlong = side.half + 0.6;
    sideBox(side, 0, 0.3, 0, wallTop, fullAlong, 0.3, '바깥 벽');
    if (side.raised) sideBox(side, 0, 0.3, wallTop, raisedTop, raisedHalfZ, 0.3, '바깥 벽 (높은 구간)');
    sideBox(side, 0, 0.6, wallTop, colliderHeight, side.half + 1.5, 0.6, '경계 (이동만 막음)', true);

    // --- 중간 기둥: 브릭 2x2 줄무늬 + 덮개 + 꼭대기 장식 ---
    for (const a of mids) {
      const color = PILLAR_COLORS[pillarIndex % PILLAR_COLORS.length]!;
      const levels = isRaised(a) ? 6 : 4;
      const [x, z] = place(side.name, a, PILLAR / 2, side.face);
      const top = levels * LEVEL;
      if (soft) {
        // 원기둥 두 토막 (색 + 흰 머리)
        instances.push({ model: 'pCylinder', color, textured: false, matrix: trs(x, 0, z, 0, [PILLAR, top * 0.7, PILLAR]) });
        instances.push({ model: 'pCylinder', color: CAP, textured: false, matrix: trs(x, top * 0.7, z, 0, [PILLAR, top * 0.3 + PLATE, PILLAR]) });
      } else {
        for (let l = 0; l < levels; l++) {
          instances.push({ model: 'box2x2', color: l % 2 === 0 ? color : CAP, matrix: trs(x, l * LEVEL, z, rot, S) });
        }
        instances.push({ model: 'plate2x2', color: CAP, matrix: trs(x, top, z, rot, S) });
      }
      sideBox(side, a, PILLAR / 2, 0, top + PLATE, PILLAR / 2, PILLAR / 2, '벽 기둥');
      const decorY = top + PLATE;
      if (pillarIndex % 2 === 0) {
        // 둥근 손잡이 (1x1 둥근 브릭 확대)
        decor.addKit(kit.round1x1, trs(x, decorY, z, 0, 11), PILLAR_COLORS[(pillarIndex + 2) % PILLAR_COLORS.length]!);
      } else {
        // 깃발 (진영 색: 북 분홍, 남 파랑, 동서는 기둥 색)
        const flagColor = side.name === 'N' ? TEAM.pink : side.name === 'S' ? TEAM.blue : color;
        decor.addKit(kit.flag, trs(x, decorY, z, rot + Math.PI / 2, 1.5), flagColor, true);
      }
      pillarIndex++;
    }

    // --- 삼각 깃발 줄: 기둥 꼭대기 사이 ---
    const pillarTop = (a: number) => {
      if (Math.abs(Math.abs(a) - cornerAlong) < 1e-3) return 5 * CORNER_LEVEL + CORNER_PLATE;
      return (isRaised(a) ? 6 : 4) * LEVEL + PLATE;
    };
    for (let i = 0; i < stops.length - 1; i++) {
      const a0 = stops[i]!;
      const a1 = stops[i + 1]!;
      const minY = (isRaised(a0) && isRaised(a1) ? raisedTop : wallTop) + 0.35;
      addBunting(decor, side, a0, a1, pillarTop(a0) - 0.2, pillarTop(a1) - 0.2, minY, i, PENNANT_COLORS);
    }
  }

  // --- 모서리 탑: 2x2 브릭 9배 줄무늬 5단 + 덮개 + 원뿔 지붕 + 깃발 ---
  const coneGeo = new THREE.ConeGeometry(1.05, 1.5, 16);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (faceX + CORNER / 2);
      const z = sz * (faceZ + CORNER / 2);
      const team = sz > 0 ? TEAM.pink : TEAM.blue;
      const top = 5 * CORNER_LEVEL;
      if (soft) {
        instances.push({ model: 'pCylinder', color: team, textured: false, matrix: trs(x, 0, z, 0, [CORNER, top * 0.7, CORNER]) });
        instances.push({ model: 'pCylinder', color: CAP, textured: false, matrix: trs(x, top * 0.7, z, 0, [CORNER, top * 0.3 + CORNER_PLATE, CORNER]) });
      } else {
        for (let l = 0; l < 5; l++) {
          instances.push({ model: 'box2x2', color: l % 2 === 0 ? team : CAP, matrix: trs(x, l * CORNER_LEVEL, z, 0, CORNER_SCALE) });
        }
        instances.push({ model: 'plate2x2', color: CAP, matrix: trs(x, top, z, 0, CORNER_SCALE) });
      }
      box(x, (top + CORNER_PLATE) / 2, z, CORNER / 2, (top + CORNER_PLATE) / 2, CORNER / 2, '모서리 탑');
      const roofY = top + CORNER_PLATE;
      decor.addBasic(coneGeo, trs(x, roofY + 0.75, z, 0, 1), P.yellow);
      decor.addKit(kit.flag, trs(x, roofY + 1.35, z, 0, 1.4), team, true);
    }
  }
  coneGeo.dispose();

  return { instances, colliders };
}

/** 두 기둥 사이 처진 줄 + 삼각 깃발 */
function addBunting(decor: KitMerger, side: Side, a0: number, a1: number, y0: number, y1: number, minY: number, seed: number, colors: readonly number[]): void {
  const len = a1 - a0;
  const sag = Math.min(0.5, len * 0.06);
  const out = INSET + WALL_DEPTH / 2;
  const rot = rotOf(side.name);
  const yAt = (t: number) => Math.max(minY, y0 + (y1 - y0) * t - 4 * sag * t * (1 - t));
  // 줄: 짧은 원기둥 여러 개
  const segs = 8;
  const rope = new THREE.CylinderGeometry(0.02, 0.02, 1, 5);
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const p0 = new THREE.Vector3(...xyz(side, a0 + len * t0, out, yAt(t0)));
    const p1 = new THREE.Vector3(...xyz(side, a0 + len * t1, out, yAt(t1)));
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    const dir = p1.clone().sub(p0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    decor.addBasic(rope, new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, dir.length(), 1)), 0xfffdf8);
  }
  rope.dispose();
  // 깃발: 0.6m 간격, 기둥 바로 옆은 비움
  const tri = pennantGeometry();
  const count = Math.max(1, Math.floor((len - 1.4) / 0.6));
  for (let i = 0; i < count; i++) {
    const t = (0.7 + (i + 0.5) * ((len - 1.4) / count)) / len;
    const [x, y, z] = xyz(side, a0 + len * t, out, yAt(t) - 0.01);
    decor.addBasic(tri, trs(x, y, z, rot, 1), colors[(i + seed) % colors.length]!);
  }
  tri.dispose();
}

function xyz(side: Side, along: number, out: number, y: number): [number, number, number] {
  const [x, z] = place(side.name, along, out, side.face);
  return [x, y, z];
}

/** 아래로 늘어진 삼각 깃발 (폭 0.36, 길이 0.42, 양면) */
function pennantGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.18, 0, 0, 0.18, 0, 0, 0, -0.42, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 2, 1]);
  return g;
}

// TOY PLAYGROUND 배치 (시험 중, 개발 서버 ?map=maze). 50 × 66m — POP! ARENA(40 × 52m)보다 큼. 분위기 = 장난감 놀이터(PLAYGROUND_THEME).
// 브릭 대신 둥근 장난감 도형(Prototype Kit): 벽판·원기둥·둥근 상자·장난감 상자.
// 높은 벽판(2.6m)으로 나눈 방·복도를 도는 근거리 맵: 시야가 짧아 샷건·권총·뿅망치가 강하고, 문마다 매복·돌파가 일어남.
//
//  z +33 ┌──────────────── 북쪽 스폰 (분홍) ────────────────┐
//        │ [가림]   ║ [낮은]  [높은]  [낮은] ║          [가림] │  x ±10 짧은 벽 (z 16~21)
//        │  차로    ═══════   ═══════   ═══════   차로        │  z 13 벽 (문 x ±4~9, 바깥 끝)
//        │ 지그 ║  [낮은] 복도 z 7~13  [낮은]  ║ 지그          │  x ±15 차로 벽 (z 3~13, 가운데 틈 z ±3)
//        │ 재그 ║ [기둥] ══╗ 방 문 ╔══ [기둥]  ║ 재그          │  가운데 방 14 × 14 (북·남 문 4m, 동·서 문 5m)
//        │          ═문 ║  기둥 낮은+ 기둥 ║ 문═                │
//        │               (남쪽 = 거울상)                      │
//  z -33 └──────────────── 남쪽 스폰 (파랑) ────────────────┘
import { ARENA, PLAYGROUND_THEME, type ArenaModelKey } from '../../config/maps';
import { spawnNorth, symmetricLayout, type ArenaPiece, type MapShell } from './arenaLayout';

export const MAZE_SIZE: MapShell = { halfX: 25, halfZ: 33, boundaryThickness: 1 };

const C = PLAYGROUND_THEME.palette;
const prop = (model: ArenaModelKey, x: number, z: number, sx: number, sy: number, sz: number, color: number, rotDeg = 0, round = false): ArenaPiece =>
  ({ kind: 'prop', model, x, z, rotDeg, sx, sy, sz, color, round });
/** 벽판: 두 점 사이 둥근 벽 (두께 0.5m, 높이 2.6m — 점프로 못 넘음). 모델 긴 변 = z축 */
const wall = (x1: number, z1: number, x2: number, z2: number, color: number): ArenaPiece =>
  prop('pWall', (x1 + x2) / 2, (z1 + z2) / 2, 0.5 / 0.2, 2.6, Math.hypot(x2 - x1, z2 - z1), color, (Math.atan2(x2 - x1, z2 - z1) * 180) / Math.PI);
/** 낮은 엄폐물: 둥근 상자 0.45m (넘겨 쏠 수 있음). rot 0 = 긴 변 x */
const low = (x: number, z: number, color: number, rotDeg = 0) => prop('pCubeRounded', x, z, 2.4, 0.45, 1.2, color, rotDeg);
/** 높은 엄폐물: 장난감 상자 1.6m 정육면체 */
const crate = (x: number, z: number, color: number, rotDeg = 0) => prop('pCrate', x, z, 3.2, 3.2, 3.2, color, rotDeg);
/** 기둥: 원기둥 1.3m 지름, 1.6m */
const post = (x: number, z: number, color: number) => prop('pCylinder', x, z, 1.3, 1.6, 1.3, color, 0, true);

/** 가운데 줄 (거울 복제 안 함) */
const MIDDLE: ArenaPiece[] = [
  // 가운데 방 바닥 + 방 가운데 낮은 십자 (넘어 다닐 수 있고 넘겨 쏠 수 있음)
  { kind: 'zone', x: 0, z: 0, w: 13.5, d: 13.5, color: 0xfff1d6 },
  low(0, 0, C.yellow),
  low(0, 0, C.orange, 90),
  // 차로 가운데 높은 엄폐물 (차로 끝에서 끝까지 곧게 보지 못하게)
  crate(-20, 0, C.orange),
  crate(20, 0, C.orange),
];

/** 북쪽 절반 (z > 0). 남쪽은 거울상 */
const NORTH: ArenaPiece[] = [
  ...spawnNorth(MAZE_SIZE, true),
  // 넓은 맵: 차로 끝에서 스폰 구석이 곧게 보이지 않게 스폰 양끝 가림 추가
  // 진영 색 (남쪽 거울상은 파랑)
  crate(-20.5, 25.4, ARENA.palette.pink),
  crate(20.5, 25.4, ARENA.palette.pink),

  // --- 가운데 방 (x ±7, z ±7): 북쪽 문(x ±2) + 동·서 문(z ±2.5) ---
  wall(-7, 7, -2, 7, C.lavender),
  wall(2, 7, 7, 7, C.lavender),
  wall(-7, 2.5, -7, 7, C.mint),
  wall(7, 2.5, 7, 7, C.mint),
  // 방 안 기둥 (문으로 들어오자마자 숨을 곳)
  post(-3.8, 3.8, C.pink),
  post(3.8, 3.8, C.blue),

  // --- 방 옆 구역 (x 7~15, z 0~7) ---
  crate(-11, 4.5, C.yellow, 15),
  crate(11, 4.5, C.yellow, -15),

  // --- 복도 (z 7~13): 북쪽 벽 z 13 — 문 x ±(4~9)와 바깥 끝(|x| > 15)으로 열림 ---
  { kind: 'zone', x: 0, z: 10, w: 29.5, d: 5.5, color: 0xe8f3ff },
  wall(-15, 13, -9, 13, C.blue),
  wall(-4, 13, 4, 13, C.pink),
  wall(9, 13, 15, 13, C.blue),
  low(-11.5, 10, C.orange),
  low(11.5, 10, C.orange),

  // --- 차로 벽 (x ±15, z 3~13): 가운데 틈(z ±3)으로 방 옆 구역과 연결, 복도 벽 끝과 이어짐 ---
  wall(-15, 3, -15, 13, C.mint),
  wall(15, 3, 15, 13, C.lavender),

  // --- 스폰 앞 구역 (z 13~25): 짧은 벽 + 엄폐물로 문 앞을 곧게 지나가지 못하게 ---
  wall(-10, 16, -10, 21, C.mint),
  wall(10, 16, 10, 21, C.lavender),
  low(-5.5, 17.5, C.yellow),
  low(5.5, 17.5, C.yellow),
  post(0, 18.5, C.orange),

  // --- 차로 (x 15~24.5): 높은 엄폐물 지그재그 ---
  { kind: 'zone', x: -20, z: 10, w: 9, d: 18, color: 0xdff6ec },
  { kind: 'zone', x: 20, z: 10, w: 9, d: 18, color: 0xebe4ff },
  crate(-18.8, 6.5, C.mint),
  crate(18.8, 6.5, C.lavender),
  crate(-21.8, 12.5, C.blue, 10),
  crate(21.8, 12.5, C.blue, -10),
  low(-18.5, 18, C.yellow, 90),
  low(18.5, 18, C.yellow, 90),
];

export const MAZE_LAYOUT: readonly ArenaPiece[] = symmetricLayout(MIDDLE, NORTH);

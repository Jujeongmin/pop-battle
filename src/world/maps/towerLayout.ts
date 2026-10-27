// CANDY TOWER 배치 (시험 중, 개발 서버 ?map=tower). 54 × 70m — POP! ARENA(40 × 52m)보다 큼. 분위기 = 노을 사탕 마을(CANDY_THEME).
// 중앙 큰 탑을 차지하려는 싸움: 탑 위는 사방이 보이지만 가릴 곳이 적고, 탑 둘레는 마카롱(육각 도형) 낮은 엄폐물 고리, 양옆 넓은 차로는 우회로.
//
//  z +35 ┌────────────────── 북쪽 스폰 (분홍) ──────────────────┐
//        │ [가림]           [낮은 1x8] (스폰 출구 앞)       [가림] │
//        │  차로  │  [높은]                     [높은]  │  차로  │  x ±16.5 차로 벽 (z 4~20, 가운데 틈 z ±4)
//        │ 지그   │     [낮은]   경사로·계단   [낮은]     │ 낮은   │
//        │ 재그   ┊ [낮은] 계단 ■ 탑 13.4m 1.6m ■ 계단 [낮은] ┊ 엄폐  │  탑 위 가운데 십자 높은 엄폐물
//        │        │         (남쪽 = 거울상)              │        │
//  z -35 └────────────────── 남쪽 스폰 (파랑) ──────────────────┘
import { ARENA, CANDY_THEME } from '../../config/maps';
import { spawnNorth, symmetricLayout, type ArenaPiece, type MapShell } from './arenaLayout';

export const TOWER_SIZE: MapShell = { halfX: 27, halfZ: 35, boundaryThickness: 1 };

const C = CANDY_THEME.palette;
/** 마카롱: 납작한 육각 도형 (낮은 엄폐물 높이 0.45m, 넘겨 쏠 수 있음) */
const macaron = (x: number, z: number, color: number): ArenaPiece => ({ kind: 'prop', model: 'pHexagon', x, z, rotDeg: 0, sx: 2.2, sy: 0.45, sz: 2.2, color, round: true });
/** 사탕 기둥: 높은 원기둥 (1.6m, 점프로 못 올라감) */
const candyPost = (x: number, z: number, color: number): ArenaPiece => ({ kind: 'prop', model: 'pCylinder', x, z, rotDeg: 0, sx: 1.4, sy: 1.6, sz: 1.4, color, round: true });
const TOWER_H = 1.6;
/** 탑 크기: 플레이트(4.48 × 2.24) 3 × 6장 */
const TOWER = 13.44;
const EDGE = TOWER / 2;

/** 가운데 줄 (거울 복제 안 함) */
const MIDDLE: ArenaPiece[] = [
  { kind: 'zone', x: 0, z: 0, w: 30, d: 30, color: 0xfff1d6 },
  // 탑: 노란 몸체 + 흰 윗면. 위 가운데 십자 높은 엄폐물 = 탑 위에서도 한쪽 끝에서 반대쪽 끝까지 곧게 보이지 않게
  { kind: 'platform', x: 0, z: 0, w: TOWER, d: TOWER, h: TOWER_H, color: C.yellow, topColor: C.white },
  { kind: 'brick', model: 'brick2x4', x: 0, z: 0, rotDeg: 0, levels: 2, color: C.orange, baseY: TOWER_H },
  { kind: 'brick', model: 'brick2x4', x: 0, z: 0, rotDeg: 90, levels: 2, color: C.pink, baseY: TOWER_H },
  // 동·서 계단 (탑 옆에서 바로 오름)
  { kind: 'stairs', x: EDGE + 1.6, z: 0, width: 2.2, length: 3.2, h: TOWER_H, dirDeg: 270, color: C.white },
  { kind: 'stairs', x: -EDGE - 1.6, z: 0, width: 2.2, length: 3.2, h: TOWER_H, dirDeg: 90, color: C.white },
  // 계단 앞 마카롱 (탑 아래에서 머리만 내밀고 쏘기)
  macaron(-13.5, 0, C.mint),
  macaron(13.5, 0, C.lavender),
  // 차로 가운데 높은 엄폐물 (차로를 끝에서 끝까지 곧게 보지 못하게)
  { kind: 'brick', model: 'brick2x4', x: -21.5, z: 0, rotDeg: 90, levels: 2, color: C.orange },
  { kind: 'brick', model: 'brick2x4', x: 21.5, z: 0, rotDeg: 90, levels: 2, color: C.orange },
];

/** 북쪽 절반 (z > 0). 남쪽은 거울상 */
const NORTH: ArenaPiece[] = [
  ...spawnNorth(TOWER_SIZE),
  // 넓은 맵: 차로 끝에서 스폰 구석이 곧게 보이지 않게 스폰 양끝 가림 추가
  // (진영 색: 남쪽 거울상은 파랑)
  { kind: 'brick', model: 'brick2x4', x: -21.5, z: 27, rotDeg: 0, levels: 2, color: ARENA.palette.pink },
  { kind: 'brick', model: 'brick2x4', x: 21.5, z: 27, rotDeg: 0, levels: 2, color: ARENA.palette.pink },

  // --- 탑 북쪽: 경사로(서) + 계단(동) ---
  { kind: 'ramp', x: -2.6, z: EDGE + 1.6, width: 2.2, length: 3.2, h: TOWER_H, dirDeg: 180, color: C.pink },
  { kind: 'stairs', x: 2.6, z: EDGE + 1.6, width: 2.2, length: 3.2, h: TOWER_H, dirDeg: 180, color: C.white },
  // 탑 위 모서리 턱 (엎드려 버티지 못하게 낮게만)
  { kind: 'brick', model: 'brick2x2', x: -5.3, z: 5.3, rotDeg: 0, levels: 0, color: C.pink, baseY: TOWER_H },
  { kind: 'brick', model: 'brick2x2', x: 5.3, z: 5.3, rotDeg: 0, levels: 0, color: C.pink, baseY: TOWER_H },

  // --- 탑 둘레 고리: 대각선 낮은 엄폐물 + 진입로 양옆 높은 엄폐물 ---
  macaron(-11, 8.5, C.yellow),
  macaron(11, 8.5, C.pink),
  { kind: 'brick', model: 'brick2x4', x: -7.5, z: 14, rotDeg: 90, levels: 2, color: C.blue },
  { kind: 'brick', model: 'brick2x4', x: 7.5, z: 14, rotDeg: 90, levels: 2, color: C.blue },
  { kind: 'brick', model: 'brick2x4', x: 0, z: 14.5, rotDeg: 0, levels: 1, color: C.orange },
  candyPost(-12.5, 18.5, C.mint),
  candyPost(12.5, 18.5, C.lavender),
  // 스폰 출구 앞 긴 낮은 엄폐물
  { kind: 'brick', model: 'brick1x8', x: 0, z: 20.5, rotDeg: 0, levels: 1, color: C.yellow },

  // --- 차로 벽 (x ±16.5, z 4~20): 가운데 틈(z ±4)과 양끝으로 연결 ---
  { kind: 'wall', x1: -16.5, z1: 4, x2: -16.5, z2: 20, height: 3, thickness: 0.5, color: C.mint },
  { kind: 'wall', x1: 16.5, z1: 4, x2: 16.5, z2: 20, height: 3, thickness: 0.5, color: C.lavender },
  // 서쪽 차로: 높은 엄폐물 지그재그 (근거리)
  { kind: 'zone', x: -21.5, z: 12, w: 9.5, d: 16, color: 0xdff6ec },
  { kind: 'brick', model: 'brick2x4', x: -23.5, z: 8.5, rotDeg: 0, levels: 2, color: C.mint },
  { kind: 'brick', model: 'brick2x4', x: -19.5, z: 14.5, rotDeg: 0, levels: 2, color: C.mint },
  macaron(-23, 20.5, C.orange),
  // 동쪽 차로: 낮은 엄폐물 (중거리)
  { kind: 'zone', x: 21.5, z: 12, w: 9.5, d: 16, color: 0xebe4ff },
  { kind: 'brick', model: 'brick2x4', x: 19.5, z: 8.5, rotDeg: 0, levels: 1, color: C.lavender },
  { kind: 'brick', model: 'brick2x4', x: 23.5, z: 14.5, rotDeg: 0, levels: 1, color: C.lavender },
  candyPost(21, 20.5, C.yellow),
];

export const TOWER_LAYOUT: readonly ArenaPiece[] = symmetricLayout(MIDDLE, NORTH);

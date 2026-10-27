// LONG SHOT 배치 (시험 중, 개발 서버 ?map=range). 44 × 112m 긴 맵 — 스나이퍼 전용 원거리 교전. 분위기 = 장난감 사막 협곡(RANGE_THEME).
// 가운데 32m(z −16~16)는 낙사 구역(바닥 없음, 떨어지면 낙사) → 건너갈 수 없어 양쪽 땅에서 원거리로만 싸움.
// 양쪽 땅(각 40m)에는 엄폐물이 띄엄띄엄: 낭떠러지 앞 낮은 엄폐물, 중간 기둥·발판, 뒤쪽 높은 저격대(3.2m).
//
//  z +56 ┌──────────── 북쪽 스폰 (분홍) ────────────┐
//        │ [가림]        스폰 가림막            [가림] │  z 48
//        │      계단 ▓▓▓ 저격대 3.2m ▓▓▓ 계단        │  z 42 (앞 턱 + 양끝 기둥)
//        │ ▓발판▓   [기둥]        [낮은]    ▓발판▓ │  z 31 양옆 발판 1.6m
//        │   [높은]   [낮은]   [기둥]     [높은]   │
//        │ [낮은]       [낮은 1x8]          [낮은] │  z 18 낭떠러지 앞 엄폐물
//        │═══════════ 노란 띠 (낭떠러지) ═══════════│  z 16
//        │         낙사 구역 32m (아래 바다)          │
//        │═══════════════════════════════════════│  z −16
//        │               (남쪽 = 거울상)              │
//  z -56 └──────────── 남쪽 스폰 (파랑) ────────────┘
import { ARENA, RANGE_THEME } from '../../config/maps';
import { spawnNorth, symmetricLayout, type ArenaPiece, type MapShell } from './arenaLayout';

export const RANGE_SIZE: MapShell = { halfX: 22, halfZ: 56, boundaryThickness: 1 };
/** 낙사 구역 (경기장 폭 전체) */
export const RANGE_PIT = { z0: -16, z1: 16 } as const;

const C = RANGE_THEME.palette;
const PERCH_H = 3.2;
/** 저격대: 플레이트(4.48 × 2.24) 3 × 2장 */
const PERCH_W = 13.44;
const PERCH_D = 4.48;
const PERCH_Z = 42;
const SIDE_H = 1.6;
const SIDE_Z = 31;

/** 북쪽 절반 (z > 16). 남쪽은 거울상. 가운데 줄(낙사 구역)에는 아무것도 없음 */
const NORTH: ArenaPiece[] = [
  ...spawnNorth(RANGE_SIZE),
  // 넓은 맵: 스폰 구석이 곧게 보이지 않게 스폰 양끝 가림 (진영 색: 남쪽 거울상은 파랑)
  { kind: 'brick', model: 'brick2x4', x: -17, z: 47.4, rotDeg: 0, levels: 2, color: ARENA.palette.pink },
  { kind: 'brick', model: 'brick2x4', x: 17, z: 47.4, rotDeg: 0, levels: 2, color: ARENA.palette.pink },

  // 바닥: 땅 가운데 모래 길 + 낭떠러지 앞 노란 경고 띠
  { kind: 'zone', x: 0, z: 30, w: 26, d: 28, color: 0xead2a6 },
  { kind: 'zone', x: 0, z: 16.75, w: 43, d: 1.5, color: 0xffd66b },

  // --- 저격대 (z 42, 3.2m): 양끝 긴 계단, 앞 턱(엎드려 쏘기), 양끝 높은 기둥(숨었다 나와 쏘기) ---
  { kind: 'platform', x: 0, z: PERCH_Z, w: PERCH_W, d: PERCH_D, h: PERCH_H, color: C.orange, topColor: C.white },
  { kind: 'stairs', x: PERCH_W / 2 + 3.2, z: PERCH_Z, width: 2.4, length: 6.4, h: PERCH_H, dirDeg: 270, color: C.white },
  { kind: 'stairs', x: -PERCH_W / 2 - 3.2, z: PERCH_Z, width: 2.4, length: 6.4, h: PERCH_H, dirDeg: 90, color: C.white },
  { kind: 'brick', model: 'brick2x4', x: -4.48, z: PERCH_Z - 1.68, rotDeg: 0, levels: 0, color: C.yellow, baseY: PERCH_H },
  { kind: 'brick', model: 'brick2x4', x: 0, z: PERCH_Z - 1.68, rotDeg: 0, levels: 0, color: C.yellow, baseY: PERCH_H },
  { kind: 'brick', model: 'brick2x4', x: 4.48, z: PERCH_Z - 1.68, rotDeg: 0, levels: 0, color: C.yellow, baseY: PERCH_H },
  { kind: 'brick', model: 'brick2x2', x: -6, z: PERCH_Z + 0.6, rotDeg: 0, levels: 2, color: C.pink, baseY: PERCH_H },
  { kind: 'brick', model: 'brick2x2', x: 6, z: PERCH_Z + 0.6, rotDeg: 0, levels: 2, color: C.pink, baseY: PERCH_H },

  // --- 양옆 발판 (z 31, 1.6m): 뒤(북쪽)에서 경사로·계단으로 오름, 앞 가장자리 턱 ---
  { kind: 'platform', x: -16, z: SIDE_Z, w: 4.48, d: 6.72, h: SIDE_H, color: C.mint, topColor: C.white },
  { kind: 'platform', x: 16, z: SIDE_Z, w: 4.48, d: 6.72, h: SIDE_H, color: C.lavender, topColor: C.white },
  { kind: 'ramp', x: -16, z: SIDE_Z + 3.36 + 1.6, width: 2.4, length: 3.2, h: SIDE_H, dirDeg: 180, color: C.mint },
  { kind: 'stairs', x: 16, z: SIDE_Z + 3.36 + 1.6, width: 2.4, length: 3.2, h: SIDE_H, dirDeg: 180, color: C.white },
  { kind: 'brick', model: 'brick2x4', x: -16, z: SIDE_Z - 2.8, rotDeg: 0, levels: 0, color: C.yellow, baseY: SIDE_H },
  { kind: 'brick', model: 'brick2x4', x: 16, z: SIDE_Z - 2.8, rotDeg: 0, levels: 0, color: C.yellow, baseY: SIDE_H },

  // --- 땅 가운데: 엄폐물 조금씩 (높은 것 = 숨는 곳, 낮은 것 = 넘겨 쏘는 곳) ---
  { kind: 'brick', model: 'brick2x2', x: -7, z: 33, rotDeg: 0, levels: 2, color: C.orange },
  { kind: 'brick', model: 'brick2x4', x: 6.5, z: 32, rotDeg: 0, levels: 1, color: C.mint },
  { kind: 'brick', model: 'brick2x4', x: -14, z: 23.5, rotDeg: 90, levels: 2, color: C.blue },
  { kind: 'brick', model: 'brick2x4', x: 14, z: 24.5, rotDeg: 90, levels: 2, color: C.pink },
  { kind: 'brick', model: 'brick2x4', x: -4.5, z: 25.5, rotDeg: 0, levels: 1, color: C.lavender },
  { kind: 'brick', model: 'brick2x2', x: 4, z: 24, rotDeg: 0, levels: 2, color: C.orange },

  // --- 낭떠러지 앞 (z 18~19): 낮은 엄폐물 줄 (가장 가깝지만 건너편과도 32m 이상) ---
  { kind: 'brick', model: 'brick2x4', x: -16, z: 18.8, rotDeg: 0, levels: 1, color: C.yellow },
  { kind: 'brick', model: 'brick1x8', x: 0, z: 18.6, rotDeg: 0, levels: 1, color: C.yellow },
  { kind: 'brick', model: 'brick2x4', x: 16, z: 18.8, rotDeg: 0, levels: 1, color: C.yellow },
];

export const RANGE_LAYOUT: readonly ArenaPiece[] = symmetricLayout([], NORTH);

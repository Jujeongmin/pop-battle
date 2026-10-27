// POP! ARENA 배치 데이터 (빌더 ArenaMap.ts와 분리). 단위 m, 바닥 y = 0, +z = 북쪽(봇 진영), -z = 남쪽(플레이어 진영).
// 앞뒤(z) 대칭: north() 로 적은 조각을 mirror()가 남쪽에 그대로 복제 → 두 진영의 이동 거리·엄폐 구성이 같다.
//
//  z +26 ┌──────────────── 북쪽 스폰 (분홍) ───────────────┐
//        │  깃발     [1x8 높은]   출구   [1x8 높은]    깃발  │  z 18 스폰 가림막 (출구 3곳: 가운데·양옆)
//        │ 서쪽 차로 │                              │ 동쪽 차로 │
//        │ (근거리)  │  [낮은 1x8]                   │ (중거리)  │
//        │ 지그재그  │ [낮은]   [높은 +]   [낮은]    │ 낮은 엄폐 │
//        │ [발판1.6] ┊ 기둥    중앙 교전 구역   기둥 ┊ [발판1.6] │  x ±10 구분 벽 (가운데 틈 z ±3.5)
//        │  경사로·계단 양끝                                    │
//  z -26 └──────────────── 남쪽 스폰 (파랑) ───────────────┘
//          x -20                    0                      x +20
import { ARENA, type ArenaModelKey } from '../../config/maps';

const C = ARENA.palette;

/**
 * 브릭 (Brick Kit). rotDeg: 0이면 긴 변이 x축.
 * levels 0 = 턱: 플레이트 1장 0.224m (발판 가장자리. 아래를 겨누면 총구가 발 위 0.41m까지 내려가 0.45m 엄폐물도 막힘).
 * levels 1 = 낮은 엄폐물: 같은 크기 플레이트 2장 0.448m (총구 높이 0.51~0.59m보다 낮아 넘겨 쏠 수 있음, 상체·머리 노출).
 * levels 2 = 높은 엄폐물: 브릭 2단.
 * 2단 이상은 같은 크기 플레이트를 위에 덮어 1.57m: 점프 최고점(발 약 1.2m)에서 캡슐 아랫면이 모서리에 걸려 올라서지 못하게
 */
export interface BrickPiece {
  kind: 'brick';
  model: 'brick2x4' | 'brick1x8' | 'brick2x2';
  x: number;
  z: number;
  rotDeg: number;
  levels: number;
  color: number;
  /** 놓이는 바닥 높이 (발판 위면 발판 높이) */
  baseY?: number;
}

/** 벽 (Prototype Kit wall을 늘림). 두 점 사이 직선 */
export interface WallPiece {
  kind: 'wall';
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  height: number;
  thickness: number;
  color: number;
  /** 충돌 높이 (없으면 height) */
  colliderHeight?: number;
}

/** 발판: 큐브 몸체 + 윗면 브릭 플레이트(4x8)를 깔아 장난감 블록 느낌. w(x)·d(z)는 플레이트 크기(4.48×2.24)의 배수 */
export interface PlatformPiece {
  kind: 'platform';
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: number;
  topColor: number;
}

/** 경사로·계단. dirDeg = 올라가는 방향 (0 = +z, 90 = +x, 180 = -z). 충돌체는 둘 다 매끈한 경사면 */
export interface RampPiece {
  kind: 'ramp' | 'stairs';
  x: number;
  z: number;
  width: number;
  length: number;
  h: number;
  dirDeg: number;
  color: number;
}

/** 장식 (충돌 없음) */
export interface FlagPiece {
  kind: 'flag';
  x: number;
  z: number;
  color: number;
  scale: number;
}

/** 바닥 구역 색 (충돌 없음, 이동 경로·진영 구분용) */
export interface ZonePiece {
  kind: 'zone';
  x: number;
  z: number;
  w: number;
  d: number;
  color: number;
}

/**
 * 장난감 도형 하나 (Prototype Kit 모델을 늘려 씀, 단색). sx·sy·sz = 모델 원래 크기에 곱하는 배율 (rotDeg 0이면 모델 축 그대로).
 * 충돌 = 늘린 모델의 상자 (round면 둥근 모양 안쪽으로 조금 줄임), collide false = 장식
 */
export interface PropPiece {
  kind: 'prop';
  model: ArenaModelKey;
  x: number;
  z: number;
  rotDeg: number;
  sx: number;
  sy: number;
  sz: number;
  color: number;
  baseY?: number;
  collide?: boolean;
  round?: boolean;
}

export type ArenaPiece = BrickPiece | WallPiece | PlatformPiece | RampPiece | FlagPiece | ZonePiece | PropPiece;

/** 경기장 틀 크기 (바깥 벽 중심선 반폭). 담장·바닥·스폰 구역·바깥 광장·도시가 이 크기를 따라감 */
export interface MapShell {
  halfX: number;
  halfZ: number;
  boundaryThickness: number;
}

/** POP! ARENA 크기 (40 × 52m) */
export const ARENA_SIZE: MapShell = { halfX: 20, halfZ: 26, boundaryThickness: 1 };

/** 북쪽 조각을 남쪽에 거울상으로 복제 (z → -z) */
export function mirror(p: ArenaPiece): ArenaPiece {
  switch (p.kind) {
    case 'brick':
    case 'prop':
      return { ...p, z: -p.z, rotDeg: -p.rotDeg };
    case 'wall':
      return { ...p, z1: -p.z1, z2: -p.z2 };
    case 'platform':
    case 'flag':
    case 'zone':
      return { ...p, z: -p.z };
    case 'ramp':
    case 'stairs':
      return { ...p, z: -p.z, dirDeg: 180 - p.dirDeg };
  }
}

/** 진영 색: 북쪽(봇) 분홍, 남쪽(플레이어) 파랑 → 어느 쪽에 있는지 바로 알 수 있게 */
export function teamColor(p: ArenaPiece, south: boolean): ArenaPiece {
  if (!south) return p;
  if ('color' in p && p.color === C.pink) return { ...p, color: C.blue };
  if (p.kind === 'zone' && p.color === SPAWN_ZONE_NORTH) return { ...p, color: SPAWN_ZONE_SOUTH };
  return p;
}

export const SPAWN_ZONE_NORTH = 0xffe3ef;
const SPAWN_ZONE_SOUTH = 0xdcebff;
const PLATFORM_H = 1.6;
// 발판 4.48(x) × 6.72(z) = 플레이트 1 × 3장
const PF_W = 4.48;
const PF_D = 6.72;

/**
 * 북쪽 스폰 구역 (POP! ARENA 기준 z 18~26): 바닥 색 + 가림막 + 깃발 — 모든 맵 공용 (스폰 위치 arenaSpawns.ts와 짝).
 * 큰 맵은 북쪽 벽에 붙어 있도록 z를 (halfZ − 26)만큼 밀고, 바닥 색 폭은 맵 폭에 맞춤
 */
export function spawnNorth(shell: MapShell, soft = false): ArenaPiece[] {
  const dz = shell.halfZ - ARENA_SIZE.halfZ;
  return SPAWN_NORTH_ARENA.map((p) => {
    if (p.kind === 'zone') return { ...p, z: p.z + dz, w: shell.halfX * 2 - 1 };
    if (p.kind === 'wall') return { ...p, z1: p.z1 + dz, z2: p.z2 + dz };
    // soft(놀이터 테마): 가림막 브릭 1x8 2단(4.48 × 1.12 × 1.57m) → 같은 크기 둥근 상자
    if (soft && p.kind === 'brick') return { kind: 'prop', model: 'pCubeRounded', x: p.x, z: p.z + dz, rotDeg: p.rotDeg, sx: 4.48, sy: 1.57, sz: 1.12, color: p.color };
    return { ...p, z: p.z + dz };
  });
}

const SPAWN_NORTH_ARENA: readonly ArenaPiece[] = [
  { kind: 'zone', x: 0, z: 22.25, w: 39, d: 7.5, color: SPAWN_ZONE_NORTH },
  // 스폰 가림막: 가운데 출구(6.7m)와 양옆 출구 → 스폰에서 여러 경로, 가운데 직선 시야는 중앙 큰 엄폐물이 막음
  { kind: 'brick', model: 'brick1x8', x: -5.6, z: 18, rotDeg: 0, levels: 2, color: C.pink },
  { kind: 'brick', model: 'brick1x8', x: 5.6, z: 18, rotDeg: 0, levels: 2, color: C.pink },
  // 가운데 출구 안쪽 가림: 출구 틈으로 가운데 스폰이 들여다보이지 않게 (좌우로 돌아 나감)
  { kind: 'brick', model: 'brick1x8', x: 0, z: 21, rotDeg: 0, levels: 2, color: C.pink },
  // 차로 입구 가림: 차로 끝에서 스폰 안쪽까지 곧장 보이지 않게 (양옆으로 지나갈 틈)
  { kind: 'brick', model: 'brick1x8', x: -15, z: 20, rotDeg: 0, levels: 2, color: C.pink },
  { kind: 'brick', model: 'brick1x8', x: 15, z: 20, rotDeg: 0, levels: 2, color: C.pink },
  { kind: 'flag', x: -9, z: 24.5, color: C.pink, scale: 2.2 },
  { kind: 'flag', x: 9, z: 24.5, color: C.pink, scale: 2.2 },
];

/** 북쪽 절반 (z > 0)에만 있는 조각. 남쪽은 mirror로 생성 */
const NORTH: ArenaPiece[] = [
  ...spawnNorth(ARENA_SIZE),

  // --- 차로 구분 벽 (x ±10, z 3.5~14): 가운데 틈(중앙↔차로)과 양끝으로 연결, 막다른 길 없음 ---
  { kind: 'wall', x1: -10, z1: 3.5, x2: -10, z2: 14, height: 3, thickness: 0.5, color: C.mint },
  { kind: 'wall', x1: 10, z1: 3.5, x2: 10, z2: 14, height: 3, thickness: 0.5, color: C.lavender },

  // --- 중앙 교전 구역 (|x| < 10) ---
  { kind: 'brick', model: 'brick2x4', x: -4.5, z: 3.8, rotDeg: 0, levels: 1, color: C.yellow },
  { kind: 'brick', model: 'brick2x4', x: 4.5, z: 3.8, rotDeg: 0, levels: 1, color: C.orange },
  // 스폰 출구 앞 긴 낮은 엄폐물
  { kind: 'brick', model: 'brick1x8', x: 0, z: 8.5, rotDeg: 0, levels: 1, color: C.yellow },
  // 중앙 양옆 높은 엄폐물 (출구에서 중앙으로 들어올 때 몸을 숨길 곳)
  { kind: 'brick', model: 'brick2x4', x: -6.6, z: 11.5, rotDeg: 90, levels: 2, color: C.orange },
  { kind: 'brick', model: 'brick2x4', x: 6.6, z: 11.5, rotDeg: 90, levels: 2, color: C.yellow },

  // --- 서쪽 차로 (x -20~-10): 근거리, 코너·지그재그 ---
  { kind: 'zone', x: -15, z: 9, w: 9.5, d: 18, color: 0xdff6ec },
  { kind: 'brick', model: 'brick2x4', x: -17.4, z: 9.4, rotDeg: 0, levels: 2, color: C.mint },
  { kind: 'brick', model: 'brick2x4', x: -12.6, z: 12, rotDeg: 0, levels: 2, color: C.mint },
  { kind: 'brick', model: 'brick2x2', x: -15.2, z: 15, rotDeg: 0, levels: 1, color: C.yellow },
  // 발판 접근: 경사로(바깥쪽) + 계단(안쪽)
  { kind: 'ramp', x: -16.1, z: PF_D / 2 + 1.6, width: 2.2, length: 3.2, h: PLATFORM_H, dirDeg: 180, color: C.mint },
  { kind: 'stairs', x: -13.9, z: PF_D / 2 + 1.6, width: 2.2, length: 3.2, h: PLATFORM_H, dirDeg: 180, color: C.white },

  // --- 동쪽 차로 (x 10~20): 중거리, 낮은 엄폐물을 띄엄띄엄 ---
  { kind: 'zone', x: 15, z: 9, w: 9.5, d: 18, color: 0xebe4ff },
  { kind: 'brick', model: 'brick2x4', x: 12.4, z: 9.4, rotDeg: 90, levels: 1, color: C.lavender },
  { kind: 'brick', model: 'brick2x4', x: 17.6, z: 12, rotDeg: 90, levels: 1, color: C.lavender },
  { kind: 'brick', model: 'brick2x4', x: 15, z: 15.4, rotDeg: 0, levels: 1, color: C.yellow },
  { kind: 'ramp', x: 16.1, z: PF_D / 2 + 1.6, width: 2.2, length: 3.2, h: PLATFORM_H, dirDeg: 180, color: C.lavender },
  { kind: 'stairs', x: 13.9, z: PF_D / 2 + 1.6, width: 2.2, length: 3.2, h: PLATFORM_H, dirDeg: 180, color: C.white },
];

/** 가운데 줄 (z = 0 근처, 거울 복제 안 함) */
const MIDDLE: ArenaPiece[] = [
  { kind: 'zone', x: 0, z: 0, w: 19.5, d: 36, color: 0xfff6dc },
  // 중앙 큰 엄폐물: 2단 브릭 두 개를 십자로 (어느 방향에서도 몸을 숨길 수 있음, 스폰↔스폰 직선 시야 차단)
  { kind: 'brick', model: 'brick2x4', x: 0, z: 0, rotDeg: 0, levels: 2, color: C.blue },
  { kind: 'brick', model: 'brick2x4', x: 0, z: 0, rotDeg: 90, levels: 2, color: C.pink },
  // 구분 벽 틈 앞 기둥 (중앙 ↔ 차로 오갈 때 엄폐)
  { kind: 'brick', model: 'brick2x2', x: -7.2, z: 0, rotDeg: 0, levels: 2, color: C.orange },
  { kind: 'brick', model: 'brick2x2', x: 7.2, z: 0, rotDeg: 0, levels: 2, color: C.orange },
  // 양쪽 차로 가운데 낮은 2층 발판 (양끝에서 오를 수 있어 우회 진입로가 두 곳)
  { kind: 'platform', x: -15, z: 0, w: PF_W, d: PF_D, h: PLATFORM_H, color: C.mint, topColor: C.white },
  { kind: 'platform', x: 15, z: 0, w: PF_W, d: PF_D, h: PLATFORM_H, color: C.lavender, topColor: C.white },
  // 발판 위: 중앙 쪽 가장자리는 낮은 턱(아래로 쏠 수 있게), 바깥 모서리는 높은 기둥(숨었다가 옆으로 나와 쏘기).
  // 발판에서 계속 엎드려 버티며 맵을 내려다보지 못하게 전면 엄폐는 주지 않음
  { kind: 'brick', model: 'brick2x4', x: -13.3, z: 0, rotDeg: 90, levels: 0, color: C.yellow, baseY: PLATFORM_H },
  { kind: 'brick', model: 'brick2x4', x: 13.3, z: 0, rotDeg: 90, levels: 0, color: C.yellow, baseY: PLATFORM_H },
  { kind: 'brick', model: 'brick2x2', x: -16.5, z: 2.6, rotDeg: 0, levels: 2, color: C.orange, baseY: PLATFORM_H },
  { kind: 'brick', model: 'brick2x2', x: -16.5, z: -2.6, rotDeg: 0, levels: 2, color: C.orange, baseY: PLATFORM_H },
  { kind: 'brick', model: 'brick2x2', x: 16.5, z: 2.6, rotDeg: 0, levels: 2, color: C.orange, baseY: PLATFORM_H },
  { kind: 'brick', model: 'brick2x2', x: 16.5, z: -2.6, rotDeg: 0, levels: 2, color: C.orange, baseY: PLATFORM_H },
];

/** 가운데 줄 + 북쪽 절반 + 거울상 남쪽 (남쪽 분홍 → 파랑) — 앞뒤 대칭 맵 공용 */
export function symmetricLayout(middle: readonly ArenaPiece[], north: readonly ArenaPiece[]): readonly ArenaPiece[] {
  return [...middle, ...north, ...north.map((p) => teamColor(mirror(p), true))];
}

export const ARENA_LAYOUT: readonly ArenaPiece[] = symmetricLayout(MIDDLE, NORTH);

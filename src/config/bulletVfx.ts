// 시각용 장난감 탄환·타격 연출 (클레이·고무 POP) 설정. 화면 표현 전용 — 데미지·사거리·명중 판정(config/weapons.ts)과 무관.
// 사격은 히트스캔: 판정은 발사 순간 끝나고, 탄환은 총구 → 실제 탄착 지점까지 날아가는 연출만 한다.
import type { CharacterId } from './characters';

export interface BulletVfxProfile {
  /** 탄환 길이 / 지름 (m). 캡슐: 둥근 앞뒤 + 굵은 몸통 */
  length: number;
  diameter: number;
  /** 기본 색 (사수 색을 모를 때만. 보통은 팀·캐릭터 색 — bulletColorFor) */
  color: string;
  /** 화면상 이동 속도 (m/s) */
  speed: number;
  /** 아무리 멀어도 이 시간 안에 도착 (먼 탄착이 너무 늦게 보이지 않게, s) */
  maxTravelTime: number;
  /** 꼬리 길이 (m, 이동한 거리보다 길어지지 않음), 꼬리 불투명도 */
  trailLength: number;
  trailOpacity: number;
  /** 벽·바닥 탄착 크기 배율 */
  impactScale: number;
  /** 탄환을 그리는 최대 거리 (m). 넘으면 탄환만 숨김 (탄착 효과는 그대로) */
  maxDistance: number;
  /** 총구 POP: 방울 수, 크기 배율 (기존 별 화염 크기는 weapons.ts effects.flashScale) */
  muzzleDroplets: number;
  muzzleScale: number;
  /** 캐릭터 명중: 방울 수, 크기 배율 (헤드샷은 VFX_HEADSHOT 배율 추가) */
  hitDroplets: number;
  hitScale: number;
  /** 벽·바닥 탄착 방울 수 */
  impactDroplets: number;
  /**
   * 총알 궤적 (combat/Tracers.ts, 발광 줄): width = 굵기(m), life = 보이는 시간(s), glow = 밝기 배율(1 = 탄환 색 그대로),
   * whiten = 탄환 색을 흰색 쪽으로 섞는 비율(밝은 바닥·하늘에서도 보이게), every = N발마다 하나 (샷건 대표 궤적)
   */
  tracer?: { width: number; life: number; glow: number; whiten: number; every: number };
}

export type BulletVfxId = 'rifle' | 'shotgun' | 'sniper' | 'pistol';

/** 무기별 탄환·연출. 무기 id가 없으면 rifle */
export const BULLET_VFX: Record<BulletVfxId, BulletVfxProfile> = {
  // 중간 크기 굵은 캡슐, 빠르고 경쾌한 POP (연사 리듬: 방울 적게)
  rifle: {
    length: 0.13, diameter: 0.075, color: '#ffb43c', speed: 75, maxTravelTime: 0.32, trailLength: 0.3, trailOpacity: 0.32,
    impactScale: 1, maxDistance: 90, muzzleDroplets: 2, muzzleScale: 1, hitDroplets: 6, hitScale: 1, impactDroplets: 4,
    // 얇고 빠르게 사라짐 (연사해도 화면이 복잡하지 않게)
    tracer: { width: 0.036, life: 0.12, glow: 1, whiten: 0.1, every: 1 },
  },
  // 작은 고무 구슬 여러 개 (펠릿마다 1발): 펠릿마다 방울은 적게, 합치면 풍성
  shotgun: {
    length: 0.055, diameter: 0.05, color: '#ff7aa8', speed: 55, maxTravelTime: 0.3, trailLength: 0.16, trailOpacity: 0.25,
    impactScale: 0.6, maxDistance: 60, muzzleDroplets: 5, muzzleScale: 1.3, hitDroplets: 3, hitScale: 0.75, impactDroplets: 2,
    // 펠릿 8발 중 3발마다 하나 (가운데·양옆 대표 궤적으로 퍼짐만 보이게)
    tracer: { width: 0.03, life: 0.13, glow: 1, whiten: 0.08, every: 3 },
  },
  // 크고 길쭉한 묵직한 탄환, 큰 POP
  sniper: {
    length: 0.19, diameter: 0.095, color: '#5fb4ff', speed: 110, maxTravelTime: 0.35, trailLength: 0.5, trailOpacity: 0.35,
    impactScale: 1.4, maxDistance: 140, muzzleDroplets: 4, muzzleScale: 1.5, hitDroplets: 10, hitScale: 1.45, impactDroplets: 6,
    // 굵고 밝고 오래 (맞은 쪽도 어디서 쐈는지 알 수 있게)
    tracer: { width: 0.08, life: 0.5, glow: 1.1, whiten: 0.2, every: 1 },
  },
  // 작고 통통, 절제된 파티클
  pistol: {
    length: 0.085, diameter: 0.06, color: '#6fe0b4', speed: 60, maxTravelTime: 0.3, trailLength: 0.2, trailOpacity: 0.28,
    impactScale: 0.8, maxDistance: 70, muzzleDroplets: 1, muzzleScale: 0.8, hitDroplets: 4, hitScale: 0.8, impactDroplets: 3,
    // 라이플보다 짧고 가볍게
    tracer: { width: 0.028, life: 0.09, glow: 1, whiten: 0.08, every: 1 },
  },
};

/** 헤드샷: 방울 수·크기 배율 (+ 기존 노란 별 POP). 화면을 가리지 않을 정도로만 */
export const VFX_HEADSHOT = { dropletMul: 1.5, scaleMul: 1.25 };

/**
 * 탄환 색 (시각 전용, 데미지·속도와 무관).
 * TDM = 사수의 실제 팀 색 (캐릭터 RED와 팀 RED는 별개 — 팀 정보로만 판정), FFA = 사수 캐릭터 대표색.
 * BLACK·WHITE는 원래 색이 어둡거나 흰색이라 바닥·하늘에서 안 보여서 차콜·라벤더 클레이로
 */
export const BULLET_TEAM_COLORS = { BLUE: '#3d8bff', RED: '#ff4b4b' } as const;
export const BULLET_CHARACTER_COLORS: Record<CharacterId, string> = {
  blue: '#4f8dff',
  white: '#b08cff',
  yellow: '#ffc21a',
  red: '#ff5a3c',
  pink: '#ff6fae',
  black: '#4b5068',
};

/**
 * 품질 (PC·모바일): 방울 수 배율, 동시 방울 상한. 터치 기기(모바일)는 기본 'low'.
 * 개발 서버 콘솔에서 __game.setVfxQuality('high'|'low')
 */
export const VFX_QUALITY = {
  high: { dropletMul: 1, maxDroplets: 220 },
  low: { dropletMul: 0.5, maxDroplets: 110 },
} as const;
export type VfxQuality = keyof typeof VFX_QUALITY;
export const DEFAULT_VFX_QUALITY: VfxQuality =
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'low' : 'high';

/** 동시에 보이는 탄환 수 상한 (넘치면 가장 오래된 것부터 재사용) */
export const BULLET_POOL: Record<BulletVfxId, number> = { rifle: 48, shotgun: 96, sniper: 12, pistol: 32 };

export function bulletVfxIdOf(weaponId: string | undefined): BulletVfxId {
  return weaponId && weaponId in BULLET_VFX ? (weaponId as BulletVfxId) : 'rifle';
}

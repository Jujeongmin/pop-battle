// 전투 공통 설정: 진영·적대 규칙, 체력, 리스폰 보호, 캐릭터 히트박스.

export type HostilityMode =
  /** 다른 진영끼리만 적 (지금: 플레이어 vs 봇) */
  | 'teams'
  /** 자기 자신 빼고 모두 적 (추후 개인전) */
  | 'ffa';

export const TEAMS = {
  player: 'players',
  bots: 'bots',
} as const;

export const COMBAT = {
  hostility: 'teams' as HostilityMode,
  /** 같은 진영 피해 */
  friendlyFire: false,
  player: {
    // 최대 체력은 캐릭터 능력치 (config/characters.ts CHARACTERS[id].stats.maxHp)
    /** 리스폰 후 무적 시간. 공격(발사)하면 즉시 해제 */
    spawnProtection: 2,
  },
  /** 피해 방향 표시 유지 시간 */
  damageIndicatorTime: 1.1,
};

/**
 * 캐릭터 판정 영역 (판정 전용 콜라이더, 이동 캡슐과 별개).
 * 머리 범위는 GLB 바인드 포즈 정점 분석값: 원본 높이 1.0 기준 y 0.5 이상이 머리(폭 0.56, 깊이 0.6, 모자 포함).
 */
export const CHARACTER_HITBOX = {
  /** 이 높이(원본 비율 0..1) 이상 정점을 머리로 본다 */
  headFromRatio: 0.5,
  /** 머리 구 반지름 = 머리 정점 범위 평균 반폭 × 이 값 */
  headRadiusScale: 0.95,
  /** 몸통 캡슐 반지름 기본값 (m). 실제로는 캐릭터마다 몸통 정점 실측으로 다시 정함 (아래 세 값) */
  bodyRadius: 0.22,
  /** 몸통 실측 높이 구간 (GLB 높이 비율): 골반 위 ~ 어깨 아래 */
  torsoBand: [0.16, 0.4] as [number, number],
  /** 몸통 좌우 반폭 = 몸통 정점 |x|의 이 백분위수 (장식·머리카락 제외) */
  torsoPercentile: 0.9,
  /** 캡슐 반지름 = 몸통 반폭 × 이 값 (캡슐은 원통이라 앞뒤가 얇은 몸통보다 조금 작게) */
  bodyWidthScale: 1.0,
  /** 몸통 캡슐 위쪽 끝이 머리 구 안으로 들어가는 정도 (머리 반지름 비율) */
  bodyTopIntoHead: 0.35,
};

// 봇 AI 설정. 감지·전투·이동·리스폰은 전부 여기 숫자로 조절한다.

export type BotDifficultyName = 'easy' | 'normal' | 'hard';

export interface BotDifficulty {
  /** 조준 오차 반각(도). 정지 표적 기준 */
  aimErrorDeg: number;
  /** 표적 이동 속도 1m/s당 추가 조준 오차(도) */
  aimErrorPerTargetSpeed: number;
  /** 자기가 움직이는 중 추가 조준 오차(도) */
  aimErrorMovingAdd: number;
  /** 적 발견 → 첫 발사까지 (s) */
  reactionTime: number;
  /** 연속 사격 길이 (s) */
  burstTime: number;
  /** 연속 사격 사이 쉬는 시간 (s) */
  burstPause: number;
  /** 머리를 노리는 비율 (0..1) */
  headshotChance: number;
  /** 조준 방향 회전 속도 (도/s) */
  turnSpeedDeg: number;
}

export const BOT_DIFFICULTY: Record<BotDifficultyName, BotDifficulty> = {
  easy: { aimErrorDeg: 5, aimErrorPerTargetSpeed: 1.2, aimErrorMovingAdd: 2.5, reactionTime: 0.8, burstTime: 0.5, burstPause: 0.7, headshotChance: 0.05, turnSpeedDeg: 220 },
  normal: { aimErrorDeg: 3, aimErrorPerTargetSpeed: 0.8, aimErrorMovingAdd: 1.5, reactionTime: 0.45, burstTime: 0.7, burstPause: 0.45, headshotChance: 0.15, turnSpeedDeg: 320 },
  hard: { aimErrorDeg: 1.4, aimErrorPerTargetSpeed: 0.4, aimErrorMovingAdd: 0.8, reactionTime: 0.25, burstTime: 1.0, burstPause: 0.3, headshotChance: 0.3, turnSpeedDeg: 480 },
};

export const BOT = {
  difficulty: 'normal' as BotDifficultyName,
  /**
   * 봇별 주무기 id (config/weapons.ts WEAPONS). 지금은 봇 AI가 라이플 전용이라 'rifle'만 사용.
   * 다른 무기를 넣으려면 봇 무기 모델·장착값·무기별 교전 거리 AI가 먼저 필요 (아직 미구현 → 라이플로 대체하고 경고)
   */
  primaryWeapons: ['rifle', 'rifle', 'rifle'] as string[],
  // 최대 체력은 봇 캐릭터 능력치 (config/characters.ts CHARACTERS[id].stats.maxHp)
  /** 리스폰 대기 (s) */
  respawnDelay: 3,
  /** 리스폰 보호 (s). 공격하면 즉시 해제 */
  spawnProtection: 2,
  /** 다른 캐릭터와 이 거리 안이면 그 스폰은 쓰지 않음 */
  spawnClearance: 2.5,
  /** 봇 스폰 지점 (발 위치 y 포함) */
  spawns: [
    { x: -8, y: 0.2, z: 20 },
    { x: 0, y: 0.2, z: 24 },
    { x: 10, y: 0.2, z: 20 },
    { x: -20, y: 0.2, z: 10 },
    { x: 20, y: 0.2, z: 8 },
    { x: -18, y: 0.2, z: -14 },
  ],
  ai: {
    /** 감지(시야·소리) 갱신 간격 (s). 봇마다 어긋나게 실행 */
    perceptionInterval: 0.15,
    /** 상태 결정 간격 (s) */
    decisionInterval: 0.1,
    /** 경로 재계산 최소 간격 (s) */
    repathInterval: 0.6,
  },
  detection: {
    /** 시야 거리 (m) */
    range: 30,
    /** 시야각 (도, 전체) */
    fovDeg: 130,
    /** 총소리를 듣는 거리 (m). 각도 무관 */
    hearRange: 24,
    /** 시야에서 사라진 뒤 마지막 위치를 추적하는 시간 (s) */
    loseSightTime: 4,
    /** 마지막 위치 추적 중 도착해도 안 보이면 수색을 접기까지 (s) */
    searchTime: 2.5,
  },
  combat: {
    /** 선호 교전 거리 (m): 가까우면 물러나고 멀면 접근 */
    preferredMin: 6,
    preferredMax: 15,
    /** 이보다 멀면 추격 시 달리기 */
    sprintBeyond: 10,
    /** 옆걸음 방향 바꾸는 간격 (s) 범위 */
    strafeMin: 0.7,
    strafeMax: 1.6,
    /** 옆걸음 한 번에 가려는 거리 (m) */
    strafeDistance: 2.5,
    /** 조준 방향이 표적과 이 각도(도) 안일 때만 발사 */
    fireConeDeg: 6,
    /** 시야를 잃고 이 시간(s) 뒤 추격으로 전환 */
    losLostGrace: 0.35,
    /** 사격 위치 탐색: 표적 주위 이 거리 범위에서 시야가 열린 지점을 찾는다 */
    firingPositionSamples: 10,
    /** 재장전 엄폐: 이 범위(m) 안에서 표적 시야가 막힌 지점 */
    coverSearchMin: 2,
    coverSearchMax: 7,
    coverSamples: 14,
  },
  patrol: {
    idleMin: 0.8,
    idleMax: 2.2,
    /** 순찰 목표 거리 범위 (m) */
    minDist: 6,
    maxDist: 18,
  },
  movement: {
    /** 웨이포인트 도착 판정 (m) */
    arriveRadius: 0.4,
    /** 이 시간(s) 동안 이동량이 거의 없으면 막힌 것으로 보고 재탐색 */
    stuckTime: 0.7,
    stuckDistance: 0.12,
    /** 몸 회전 속도 (라디안/s 지수 감쇠 계수) */
    turnSharpness: 10,
  },
  nav: {
    cellSize: 0.5,
    /** 바닥 위 이 높이(m)부터 장애물 검사 (낮은 단은 넘어가게) */
    probeBottom: 0.3,
    probeTop: 1.5,
    /** 장애물과 유지 거리: 칸 중심 기준이라 캡슐 반지름 0.3 + 칸 반대각선(0.18)이어야 칸 모서리를 지나도 닿지 않음 */
    clearance: 0.5,
    /** 바깥 벽 안쪽 범위 */
    minX: -29,
    maxX: 29,
    minZ: -29,
    maxZ: 29,
  },
  /** 봇 효과음 거리 감쇠: 이 거리에서 0 */
  soundFalloff: 36,
};

// 멀티플레이 테스트 룸 공용 규칙·메시지 형식. 클라이언트(src/net)와 Verse8 서버(server/src/server.ts)가 함께 import 한다.
// 서버는 isolated-vm에서 돌기 때문에 이 파일은 three.js·DOM·다른 게임 모듈을 import 하지 않는다 (순수 데이터·함수만).
// 무기·캐릭터 수치는 config/weapons.ts·config/characters.ts의 복사본 → 클라이언트가 시작할 때 checkNetRules로 어긋남을 검사.

/** 룸 정원 (멀티플레이 테스트: 최대 4명) */
export const NET_MAX_PLAYERS = 4;
/** 자유 테스트 모드 시작에 필요한 최소 인원 */
export const NET_MIN_PLAYERS = 2;
/** TDM 팀당 최대 인원 */
export const NET_TEAM_SIZE = 2;

/** 게임 모드: 팀 데스매치(2v2) / 개인전(4인) / 자유 테스트(기존 1v1~4인 테스트, 시간·점수 제한 없음) */
export type NetMode = 'tdm' | 'ffa' | 'test';
/** 매치 단계 (서버 소유): 대기실 → 카운트다운 → 진행 → 결과 → 대기실 */
export type NetMatchPhase = 'lobby' | 'countdown' | 'playing' | 'result';
export type NetTeam = 'BLUE' | 'RED';

export interface NetModeRule {
  label: string;
  short: string;
  /** 시작에 필요한 인원 (이 인원 이상, TDM은 팀별 NET_TEAM_SIZE명씩) */
  requiredPlayers: number;
  /** 제한 시간 (ms, 0 = 없음) */
  timeLimitMs: number;
  /** 목표 킬 (TDM = 팀 킬, FFA = 개인 킬, 0 = 없음) */
  scoreToWin: number;
  teams: boolean;
}

export const NET_MODE_RULES: Record<NetMode, NetModeRule> = {
  tdm: { label: 'Team Deathmatch', short: 'TDM 2v2', requiredPlayers: 4, timeLimitMs: 180_000, scoreToWin: 20, teams: true },
  ffa: { label: 'Free For All', short: 'FFA 4인', requiredPlayers: 4, timeLimitMs: 180_000, scoreToWin: 15, teams: false },
  test: { label: '자유 테스트', short: 'TEST', requiredPlayers: NET_MIN_PLAYERS, timeLimitMs: 0, scoreToWin: 0, teams: false },
};

/** 개발 빌드 테스트용 제한 시간 범위 (초). 기본 규칙(3분)은 그대로 */
export const NET_TEST_TIME_LIMIT_SEC = { min: 20, max: 180 } as const;

export function isNetMode(m: unknown): m is NetMode {
  return m === 'tdm' || m === 'ffa' || m === 'test';
}
/** 테스트 룸 id 접두사 (빠른 매칭이 다른 룸을 건드리지 않게) */
export const NET_ROOM_PREFIX = 'pb-';

export const NET_TIMING = {
  /** 클라이언트 상태 전송 간격 (ms). throttle 창보다 길어야 leading-only throttle이 패킷을 버리지 않는다 */
  sendIntervalMs: 50,
  /** remoteFunction throttle 창 (ms, SDK 최소 30) */
  throttleMs: 40,
  /** 리스폰 대기 (ms) = MOVEMENT.respawnDelay */
  respawnDelayMs: 2500,
  /** 리스폰 보호 (ms) = COMBAT.player.spawnProtection */
  spawnProtectionMs: 2000,
  /** 매치 시작 카운트다운 (ms): 3 → 2 → 1 → GO */
  countdownMs: 3000,
  /** RTT 측정 간격 (ms). 일반 호출은 함수 이름당 초당 10회 제한 */
  pingIntervalMs: 1000,
} as const;

/** 서버 피해 계산용 무기 수치 (config/weapons.ts와 같은 값) */
export interface NetWeaponRule {
  damage: number;
  headshotMultiplier: number;
  rpm: number;
  pellets: number;
  range: number;
  falloff?: { startDistance: number; endDistance: number; minMultiplier: number; farDistance?: number; farMultiplier?: number };
}

export const NET_WEAPONS: Record<string, NetWeaponRule> = {
  rifle: { damage: 12, headshotMultiplier: 1.5, rpm: 600, pellets: 1, range: 150 },
  shotgun: {
    damage: 15, headshotMultiplier: 1.5, rpm: 80, pellets: 8, range: 60,
    falloff: { startDistance: 3, endDistance: 7, minMultiplier: 0.5, farDistance: 15, farMultiplier: 0.2 },
  },
  sniper: { damage: 80, headshotMultiplier: 1.5, rpm: 45, pellets: 1, range: 300 },
  pistol: { damage: 15, headshotMultiplier: 1.5, rpm: 300, pellets: 1, range: 80 },
  melee: { damage: 40, headshotMultiplier: 1, rpm: 60 / 0.7, pellets: 1, range: 1.6 },
};

/** 캐릭터 최대 체력 (config/characters.ts stats.maxHp와 같은 값) */
export const NET_CHARACTER_HP: Record<string, number> = {
  blue: 100,
  white: 120,
  yellow: 110,
  red: 120,
  pink: 115,
  black: 130,
};
export const NET_DEFAULT_HP = 100;

/** 거리별 피해 배율 (combat/hitscan.ts falloffMultiplier와 같은 식) */
export function netFalloff(rule: NetWeaponRule, distance: number): number {
  const f = rule.falloff;
  if (!f) return 1;
  if (distance <= f.startDistance) return 1;
  if (distance >= f.endDistance) {
    if (f.farDistance === undefined || f.farMultiplier === undefined || f.farDistance <= f.endDistance) return f.minMultiplier;
    const t = Math.min(1, (distance - f.endDistance) / (f.farDistance - f.endDistance));
    return f.minMultiplier + (f.farMultiplier - f.minMultiplier) * t;
  }
  const t = (distance - f.startDistance) / (f.endDistance - f.startDistance);
  return 1 + (f.minMultiplier - 1) * t;
}

/** 서버 피해 계산 (헤드샷 배율·거리 감소). 클라이언트가 보낸 피해량은 쓰지 않는다 */
export function netDamage(weapon: string, headshot: boolean, distance: number): number {
  const r = NET_WEAPONS[weapon];
  if (!r) return 0;
  return r.damage * (headshot ? r.headshotMultiplier : 1) * netFalloff(r, distance);
}

/** 서버 검증 허용치 */
export const NET_VALIDATION = {
  /** 클라이언트가 말한 거리와 서버가 아는 두 위치 사이 거리 차이 허용 (m). 지연·보간으로 위치가 어긋나는 만큼 */
  distanceTolerance: 4,
  /** 사거리 초과 허용 (m) */
  rangeSlack: 1.5,
  /** 연사 속도 검증: 순간 몰림(패킷 묶음) 허용 발 수 */
  burstShots: 3,
  /** 연사 속도 허용 배율 (rpm × 이 값까지) */
  rateSlack: 1.25,
  /** 패킷당 최대 발사·명중 기록 수 */
  maxShotsPerPacket: 24,
  maxHitsPerPacket: 32,
} as const;

/** 이동 모드 (PlayerController.mode) */
export const NET_MODES = ['ground', 'air', 'slide'] as const;

/**
 * 클라이언트 → 서버 상태 패킷 (50ms마다, throttle 호출 'st').
 * 숫자는 보낼 때 소수 3자리(위치)·2~3자리(각도)로 줄인다.
 */
export interface NetStatePacket {
  /** 순번 (보간 버퍼 중복 제거) */
  q: number;
  /** 보낸 시각 (보낸 쪽 performance.now, ms) */
  t: number;
  /** 발 위치 */
  p: [number, number, number];
  /** 속도 */
  v: [number, number, number];
  /** 몸 방향 (rad) */
  y: number;
  /** 총 방향 (정규화) */
  a: [number, number, number];
  /** 상체 숙임 (rad) */
  pi: number;
  /** 이동 모드 NET_MODES 인덱스 */
  m: number;
  /** 비트: 1 grounded, 2 sprinting, 4 strafing, 8 dead(클라이언트 표시), 16 jumped, 32 landed */
  f: number;
  /** 들고 있는 무기 id */
  w: string;
  /** 캐릭터 id */
  c: string;
  /** 재장전 진행도, 근접 휘두르기, 볼트, ADS 블렌드, 반동 밀림 */
  rl: number;
  ms: number;
  bp: number;
  ads: number;
  k: number;
  /** 이번 패킷 사이에 쏜 탄 (연출용) */
  s?: NetShot[];
  /** 이번 패킷 사이에 맞혔다고 판단한 명중 (서버가 검증·피해 계산) */
  h?: NetHitClaim[];
}

/** 탄 1발 연출 (총구 → 탄착) */
export interface NetShot {
  w: string;
  f: [number, number, number];
  e: [number, number, number];
  /** 0 = 허공, 1 = 캐릭터, 2 = 벽·바닥 */
  h: 0 | 1 | 2;
  /** 탄착면 법선 (h = 2일 때 방울 방향) */
  n?: [number, number, number];
}

/** 명중 주장 1건 (펠릿마다 1건) */
export interface NetHitClaim {
  /** 맞은 계정 */
  v: string;
  w: string;
  /** 1 = 머리 */
  hd: 0 | 1;
  /** 총구 → 탄착 거리 (m) */
  d: number;
}

/** 룸 상태 players[account] (서버가 소유, 모든 클라이언트에 푸시) */
export interface NetPlayerRecord {
  slot: number;
  char: string;
  hp: number;
  max: number;
  dead: boolean;
  /** 리스폰 가능 시각 (서버 ms) */
  respawnAt: number;
  /** 보호 끝 시각 (서버 ms) */
  prot: number;
  k: number;
  d: number;
  /** TDM 팀 (FFA·테스트는 null) */
  team?: NetTeam | null;
  /** 연사 검증 토큰 (서버 내부) */
  rb?: { tokens: number; t: number };
}

export type NetPlayers = Record<string, NetPlayerRecord>;

/** 결과 화면 한 줄 (매치 중 나간 사람도 남김) */
export interface NetStanding {
  account: string;
  slot: number;
  char: string;
  team: NetTeam | null;
  k: number;
  d: number;
  left?: boolean;
}

/** 서버가 확정한 매치 결과 (모든 클라이언트에 같은 값) */
export interface NetMatchResult {
  mode: NetMode;
  reason: 'score' | 'time';
  teamScore: Record<NetTeam, number>;
  /** 이긴 계정들 (TDM = 이긴 팀 전원, FFA = 공동 1위 포함) */
  winners: string[];
  winnerTeam: NetTeam | null;
  draw: boolean;
  /** 순위 (킬 많은 순 → 데스 적은 순) */
  standings: NetStanding[];
  endedAt: number;
}

/** 룸 공용 상태 (서버 소유, 모든 클라이언트에 푸시) */
export interface NetRoomState {
  players: NetPlayers;
  host: string | null;
  mode: NetMode;
  phase: NetMatchPhase;
  /** GO 시각 (서버 ms) */
  startAt: number;
  /** 제한 시간 끝 (서버 ms, 0 = 없음) */
  endAt: number;
  /** 이번 매치 제한 시간 (ms, 0 = 없음). 기본은 모드 규칙, 개발 빌드 테스트용으로 짧게 시작할 수 있음 */
  timeLimitMs: number;
  teamScore: Record<NetTeam, number>;
  result: NetMatchResult | null;
  /** 매치 중 나간 사람 기록 (결과에 포함) */
  gone: Record<string, NetStanding>;
}

/** 서버 → 룸 'hits' 메시지의 1건 */
export interface NetHitResult {
  /** 공격자 (자멸·낙사는 null) */
  a: string | null;
  v: string;
  w: string | null;
  dmg: number;
  hp: number;
  hd: boolean;
  kill: boolean;
  /** 'weapon' | 'suicide' | 'fall' */
  cause: string;
}

/** 서버 → 공격자 'rej' 메시지 (거부된 명중, 디버그용) */
export interface NetRejected {
  v: string;
  w: string;
  reason: string;
}

/** 클라이언트 쪽 원본 규칙과 비교 (개발 서버 콘솔 경고용) */
export function checkNetRules(
  weapons: ReadonlyArray<{ id: string; damage: number; headshotMultiplier: number; rpm: number; pellets: number; range: number; falloff?: NetWeaponRule['falloff'] }>,
  characters: Readonly<Record<string, { stats: { maxHp: number } }>>,
): string[] {
  const issues: string[] = [];
  for (const w of weapons) {
    const r = NET_WEAPONS[w.id];
    if (!r) {
      issues.push(`무기 ${w.id}: 서버 규칙 없음`);
      continue;
    }
    for (const k of ['damage', 'headshotMultiplier', 'rpm', 'pellets', 'range'] as const) {
      if (Math.abs(r[k] - w[k]) > 1e-6) issues.push(`무기 ${w.id}.${k}: 게임 ${w[k]} / 서버 ${r[k]}`);
    }
    if (JSON.stringify(r.falloff ?? null) !== JSON.stringify(w.falloff ?? null)) issues.push(`무기 ${w.id}.falloff 다름`);
  }
  for (const [id, c] of Object.entries(characters)) {
    if (NET_CHARACTER_HP[id] !== c.stats.maxHp) issues.push(`캐릭터 ${id}.maxHp: 게임 ${c.stats.maxHp} / 서버 ${NET_CHARACTER_HP[id]}`);
  }
  return issues;
}

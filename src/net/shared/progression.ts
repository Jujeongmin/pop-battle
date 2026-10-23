// 플레이어 레벨·경험치·팝건 계급 (서버·클라이언트 공용, 순수 데이터·함수만 — 서버 isolated-vm에서도 import).
// 레벨은 표시·성장용: 전투 능력치(HP·공격력·이동속도)와 무관하고, 실력 랭킹과도 별개.
//
// 밸런스 수정은 PROGRESSION_DESIGN만 바꾸면 됨: 구간별 목표 시간 → 구간 경험치 합 → 레벨별 요구량(선형 증가, 구간 경계에서
// 이전 레벨보다 줄지 않음)을 자동으로 만든다. 레벨별 숫자를 조건문으로 나열하지 않음.

export const MAX_LEVEL = 100;

export const PROGRESSION_DESIGN = {
  /** 평균 경기당 경험치 가정: 완료 100 + 승률 50% × 승리 50 + 평균 5킬 × 10 = 175 */
  xpPerMatch: 175,
  /** 매칭·대기 포함 경기당 평균 시간 (분): 경기 3분 + 대기 1분 */
  minutesPerMatch: 4,
  /** Lv.1 → 2 요구 경험치 (첫 레벨은 2~3판) */
  firstLevelXp: 400,
  /** 구간별 목표 누적 플레이 시간 (from 레벨 → to 레벨) — 합계 1,043시간 */
  segments: [
    { from: 1, to: 10, hours: 3 },
    { from: 10, to: 25, hours: 20 },
    { from: 25, to: 40, hours: 60 },
    { from: 40, to: 60, hours: 160 },
    { from: 60, to: 80, hours: 300 },
    { from: 80, to: 100, hours: 500 },
  ],
  /** 표시용 반올림 단위 */
  round: 10,
} as const;

/** 시간당 예상 경험치 (설계 가정) */
export const XP_PER_HOUR = (PROGRESSION_DESIGN.xpPerMatch * 60) / PROGRESSION_DESIGN.minutesPerMatch;

/**
 * 레벨별 요구 경험치 표 (index L = Lv.L → L+1에 필요한 XP, L = 1..99). 구간마다 합이 목표 시간 × 시간당 XP가 되도록
 * 앞 레벨 값에서 이어지는 선형 증가 (구간 경계에서 줄지 않음). 마지막 반올림 오차는 구간 마지막 레벨에서 맞춤
 */
function buildRequirements(): number[] {
  const d = PROGRESSION_DESIGN;
  const req: number[] = new Array(MAX_LEVEL).fill(0);
  let start: number = d.firstLevelXp;
  let slope = 0;
  for (const seg of d.segments) {
    const n = seg.to - seg.from;
    const total = seg.hours * XP_PER_HOUR;
    // 첫 구간은 firstLevelXp에서, 이후 구간은 앞 구간 마지막 값 + 앞 기울기에서 시작
    if (seg.from !== 1) start = req[seg.from - 1]! + slope;
    slope = Math.max(0, (total - n * start) / ((n * (n - 1)) / 2));
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const L = seg.from + i;
      const v = i === n - 1 ? total - sum : Math.round((start + slope * i) / d.round) * d.round;
      req[L] = Math.max(v, req[L - 1] ?? 0);
      sum += req[L]!;
    }
  }
  return req;
}

/** 레벨별 요구 경험치 (LEVEL_XP[L] = Lv.L → L+1, L = 1..99) */
export const LEVEL_XP: readonly number[] = buildRequirements();

/** 누적 경험치: Lv.L 시작에 필요한 총 XP (CUM_XP[1] = 0, CUM_XP[100] = 최대) */
export const CUM_XP: readonly number[] = (() => {
  const c = new Array(MAX_LEVEL + 1).fill(0);
  for (let L = 2; L <= MAX_LEVEL; L++) c[L] = c[L - 1] + LEVEL_XP[L - 1]!;
  return c;
})();

/** 최대 누적 경험치 (Lv.100 도달 = 이 값, 넘는 경험치는 저장하지 않음) */
export const MAX_XP = CUM_XP[MAX_LEVEL]!;

export interface LevelInfo {
  level: number;
  /** 누적 경험치 (0..MAX_XP) */
  xp: number;
  /** 이번 레벨에서 쌓인 경험치 */
  into: number;
  /** 다음 레벨까지 필요한 경험치 (최대 레벨은 0) */
  need: number;
  /** 진행률 0..1 (최대 레벨 1) */
  progress: number;
  max: boolean;
}

/** 누적 경험치 → 레벨 정보 */
export function levelInfo(rawXp: number): LevelInfo {
  const xp = Math.max(0, Math.min(MAX_XP, Math.floor(Number.isFinite(rawXp) ? rawXp : 0)));
  let level = 1;
  while (level < MAX_LEVEL && xp >= CUM_XP[level + 1]!) level++;
  if (level >= MAX_LEVEL) return { level: MAX_LEVEL, xp, into: 0, need: 0, progress: 1, max: true };
  const into = xp - CUM_XP[level]!;
  const need = LEVEL_XP[level]!;
  return { level, xp, into, need, progress: into / need, max: false };
}

// ---------------- 팝건 계급 (12단계 아이콘 · 6개 이름 구간은 따로) ----------------

/** 팝건 아이콘 단계: 시작 레벨 → 파일 (public/assets/ui/popgun/). 파일만 바꾸면 그대로 적용 */
export const POPGUN_TIERS = [1, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((from, i) => ({
  tier: i + 1,
  from,
  file: `popgun_lv_${String(from).padStart(3, '0')}.png`,
}));

/** 계급 이름 구간 (아이콘 단계와 별도 관리, 디자인 시안 기준: 루키 1~10 · 브론즈 11~25 · 실버 26~40 · 골드 41~60 · 다이아 61~80 · 마스터 81~100) */
export const RANK_NAMES = [
  { from: 1, name: '루키 팝' },
  { from: 11, name: '브론즈 팝' },
  { from: 26, name: '실버 팝' },
  { from: 41, name: '골드 팝' },
  { from: 61, name: '다이아 팝' },
  { from: 81, name: '마스터 팝' },
] as const;

/** 레벨에 맞는 가장 높은 해금 단계 */
export function popgunTier(level: number): (typeof POPGUN_TIERS)[number] {
  let t = POPGUN_TIERS[0]!;
  for (const x of POPGUN_TIERS) if (level >= x.from) t = x;
  return t;
}

export function rankName(level: number): string {
  let n: string = RANK_NAMES[0].name;
  for (const x of RANK_NAMES) if (level >= x.from) n = x.name;
  return n;
}

// ---------------- 경기 경험치 보상 (서버가 확정 결과로 계산) ----------------

export const MATCH_XP = {
  complete: 100,
  win: 50,
  kill: 10,
  /** FFA 순위 보너스 (1·2·3위). 2명 경기는 1위만, 3명은 2위까지 (꼴찌는 순위 보너스 없음) */
  ffaRank: [50, 30, 15],
  /** 이보다 짧게 끝난 경기는 보상 없음 (비정상 경기) */
  minMatchMs: 20_000,
  /** 완료 보상 전액에 필요한 경기 시간 (짧게 끝난 정상 경기는 비례, 최소 minCompleteRatio) */
  fullMatchMs: 90_000,
  minCompleteRatio: 0.5,
  /** 같은 상대를 이번 경기에서 이 횟수보다 많이 처치해도 킬 보상은 여기까지 (킬 주고받기 방지) */
  killsPerVictim: 6,
  /** 분당 킬 보상 상한 (짧은 경기에서 킬 몰아주기 방지, 최소 5킬) */
  killsPerMinute: 8,
  /** 경기당 최대 경험치 */
  maxPerMatch: 450,
} as const;

export interface MatchXpInput {
  mode: 'tdm' | 'ffa' | 'test';
  /** 실제 경기 시간 (GO → 종료, ms) */
  playedMs: number;
  /** 중도 이탈 (끝날 때 방에 없음) */
  left: boolean;
  /** 승리 (TDM 이긴 팀, FFA 단독 1위). 무승부는 false */
  win: boolean;
  /** 상대별 처치 수 (서버 기록) */
  killsByVictim: readonly number[];
  /** FFA 순위 (공동 순위 같은 값, 1부터) */
  rank: number;
  /** 경기 참가 인원 (끝까지 남은 사람 + 나간 사람) */
  players: number;
}

export interface MatchXp {
  complete: number;
  win: number;
  kill: number;
  rank: number;
  total: number;
  /** 보상이 없거나 줄어든 이유 */
  note?: 'test' | 'left' | 'short' | 'capped';
}

/** 경기 경험치 (서버 확정 결과 기준). 데스는 차감 없음 */
export function matchXp(m: MatchXpInput): MatchXp {
  const R = MATCH_XP;
  const zero = (note: MatchXp['note']): MatchXp => ({ complete: 0, win: 0, kill: 0, rank: 0, total: 0, note });
  if (m.mode === 'test') return zero('test');
  if (m.left) return zero('left');
  if (m.playedMs < R.minMatchMs) return zero('short');
  const ratio = Math.max(R.minCompleteRatio, Math.min(1, m.playedMs / R.fullMatchMs));
  const complete = Math.round(R.complete * ratio);
  const win = m.win ? Math.round(R.win * ratio) : 0;
  const perVictim = m.killsByVictim.reduce((s, k) => s + Math.min(R.killsPerVictim, Math.max(0, k)), 0);
  const killCap = Math.max(5, Math.ceil((m.playedMs / 60_000) * R.killsPerMinute));
  const kills = Math.min(perVictim, killCap);
  const kill = kills * R.kill;
  const ranked = Math.min(R.ffaRank.length, m.players - 1);
  const rank = m.mode === 'ffa' && m.rank >= 1 && m.rank <= ranked ? R.ffaRank[m.rank - 1]! : 0;
  const raw = complete + win + kill + rank;
  const total = Math.min(R.maxPerMatch, raw);
  const capped = total < raw || kills < m.killsByVictim.reduce((s, k) => s + k, 0) || ratio < 1;
  return { complete, win, kill, rank, total, ...(capped ? { note: 'capped' as const } : {}) };
}

/** 순위 (결과 화면과 같은 규칙): 최다 킬 동점 = 모두 1위, 그 아래는 킬 → 데스, 킬·데스 같으면 같은 순위. list는 킬↓·데스↑ 정렬 */
export function standingRanks(list: ReadonlyArray<{ k: number; d: number }>): number[] {
  const top = list[0]?.k ?? 0;
  const ranks: number[] = [];
  list.forEach((e, i) => {
    const prev = list[i - 1];
    if (e.k === top) ranks.push(1);
    else if (prev && prev.k === e.k && prev.d === e.d) ranks.push(ranks[i - 1]!);
    else ranks.push(i + 1);
  });
  return ranks;
}

/** 경기 경험치 결과 (서버 → 결과 화면): 항목별 보상 + 지급 전·후 누적 경험치 */
export interface XpAward extends MatchXp {
  before: number;
  after: number;
}

/** 계정별 서버 저장 값 (Verse8 계정별 글로벌 사용자 상태) */
export interface StoredProgress {
  /** 누적 경험치 */
  xp: number;
  /** 저장 때 레벨 (표시·조회용 사본, 원본은 xp) */
  lv: number;
  /** 마지막 경험치 갱신 시각 (ms) */
  xpAt: number;
  /** 최근 보상 받은 경기 id (중복 지급 방지) */
  xpm: string[];
}

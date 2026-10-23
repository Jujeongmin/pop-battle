// 랭킹·공식 전적 (서버·클라이언트 공용, 순수 데이터·함수만).
//
// 랭킹 = 레벨 기준 통합 랭킹 (TDM·FFA 구분 없음): 레벨 높은 순 → 같은 레벨이면 누적 경험치 높은 순 → 같으면 사용자 ID로 고정 순서.
// 레벨은 누적 경험치로 정해지므로 정렬 키 하나 = 경험치 × 2^20 + ID에서 만든 값(0..2^20-1). 전적은 순위에 쓰지 않음 (표시만).
// 서버가 키 내림차순으로 상위 100명만 읽고, 내 순위는 "내 키보다 큰 사람 수 + 1" (목록 밖이어도). 키 0 = 공식 경기 기록 없음.
//
// 전적은 서버가 매치 종료 때 확정 결과로만 누적 (TDM·FFA, TEST·개발용 제한 시간·20초 미만 경기 제외, 같은 경기 id 한 번만).
// 표시: 팀전 승·패 (무승부는 따로 세고 표시 안 함), 개인전 최종 1위 횟수. 중도 이탈은 팀전 패배로 기록.

export interface RankStats {
  /** 공통: 공식 경기 수 · 킬 · 데스 */
  m: number;
  k: number;
  d: number;
  /** TDM 승 · 패 · 무 · 킬 */
  tw: number;
  tl: number;
  td: number;
  tk: number;
  /** FFA 경기 · 1·2·3위 · 킬 */
  fm: number;
  f1: number;
  f2: number;
  f3: number;
  fk: number;
}

export function emptyStats(): RankStats {
  return { m: 0, k: 0, d: 0, tw: 0, tl: 0, td: 0, tk: 0, fm: 0, f1: 0, f2: 0, f3: 0, fk: 0 };
}

/** 저장값 → 전적 (모르는 키·이상한 값은 0) */
export function readStats(v: unknown): RankStats {
  const s = emptyStats();
  if (v && typeof v === 'object') {
    for (const key of Object.keys(s) as Array<keyof RankStats>) {
      const n = (v as Record<string, unknown>)[key];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) s[key] = Math.floor(n);
    }
  }
  return s;
}

export interface RankMatchInput {
  mode: 'tdm' | 'ffa';
  k: number;
  d: number;
  left: boolean;
  /** TDM: win | lose | draw (이탈은 lose), FFA: 단독 1위면 win */
  outcome: 'win' | 'lose' | 'draw';
  /** FFA 순위 (공동 순위 같은 값) */
  rank: number;
  players: number;
}

/** 경기 하나 반영한 새 전적 */
export function addMatch(prev: RankStats, m: RankMatchInput): RankStats {
  const s = { ...prev };
  s.m++;
  s.k += m.k;
  s.d += m.d;
  if (m.mode === 'tdm') {
    const out = m.left ? 'lose' : m.outcome;
    if (out === 'win') s.tw++;
    else if (out === 'draw') s.td++;
    else s.tl++;
    s.tk += m.k;
  } else {
    s.fm++;
    s.fk += m.k;
    if (!m.left) {
      // 1위 = 최종 단독 1위 (공동 1위·무승부는 1위 횟수에 넣지 않음)
      if (m.rank === 1 && m.outcome === 'win') s.f1++;
      else if (m.rank === 2) s.f2++;
      else if (m.rank === 3) s.f3++;
    }
  }
  return s;
}

/** 사용자 ID → 0..2^20-1 (같은 경험치일 때 고정 순서, FNV-1a) */
function idOrder(account: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < account.length; i++) {
    h ^= account.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0xfffff;
}

/** 정렬 키 (클수록 위): 누적 경험치 → 사용자 ID 고정 순서. 공식 경기 기록이 없으면 0 */
export function rankKey(xp: number, account: string, stats: RankStats): number {
  if (stats.m <= 0) return 0;
  return 1 + Math.max(0, Math.floor(xp)) * 0x100000 + idOrder(account);
}

/** 랭킹 컬렉션 정렬 키 필드 */
export const RANK_KEY_FIELD = 'kx';

/** 랭킹 컬렉션 이름 (계정마다 한 줄) */
export const RANK_COLLECTION = 'pb_rank';
/** 한 번에 보여 주는 최대 인원 */
export const RANK_PAGE = 100;

/** 서버 → 클라이언트 랭킹 한 줄 (계정 id 없음) */
export interface RankRow {
  rank: number;
  nick: string;
  lv: number;
  me: boolean;
  s: RankStats;
}

export interface RankingResult {
  ok: boolean;
  reason?: string;
  rows: RankRow[];
  /** 내 줄 (공식 기록이 없으면 rank 0 = 순위 없음) */
  mine: RankRow | null;
  /** 랭킹에 오른 전체 인원 */
  total: number;
}

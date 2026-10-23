// 공식 전적·랭킹 (서버·클라이언트 공용, 순수 데이터·함수만). 레벨·경험치와 별개 (레벨이 높아도 순위가 오르지 않음).
//
// 전적은 서버가 매치 종료 때 확정 결과로만 누적 (TDM·FFA, TEST·개발용 제한 시간·20초 미만 경기 제외).
// 중도 이탈은 경기 수에 들어가고 TDM 패배 · FFA 순위 점수 0으로 기록 (나가서 전적을 지키는 것 방지). 재접속해 끝까지 남으면 정상 집계.
//
// 랭킹은 정렬 키(숫자 하나) 3개를 랭킹 컬렉션에 저장 → 서버가 키 내림차순으로 상위 100명만 읽고, 내 순위는 "내 키보다 큰 사람 수 + 1".
// 키가 같으면 같은 순위. 키 0 = 그 모드 기록 없음 (목록 제외, '순위 없음').

export type RankKind = 'all' | 'tdm' | 'ffa';

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
  /** 전체 랭킹 점수 (RANK_POINTS) */
  pt: number;
}

export function emptyStats(): RankStats {
  return { m: 0, k: 0, d: 0, tw: 0, tl: 0, td: 0, tk: 0, fm: 0, f1: 0, f2: 0, f3: 0, fk: 0, pt: 0 };
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

/**
 * 전체 랭킹 점수: 경기당 기대값이 TDM·FFA 모두 같게 (한 모드만 유리하지 않게).
 * TDM 승 30 · 무 10 · 패 0 (승률 50% → 평균 15), FFA 순위 = 30 × (인원 − 순위) ÷ (인원 − 1) (1위 30 → 꼴찌 0, 평균 15).
 * 킬은 경기 결과보다 작게 1점 (두 모드 평균 킬 수가 비슷: 약 5킬)
 */
export const RANK_POINTS = { tdmWin: 30, tdmDraw: 10, ffaTop: 30, kill: 1 } as const;

export interface RankMatchInput {
  mode: 'tdm' | 'ffa';
  k: number;
  d: number;
  left: boolean;
  /** TDM: win | lose | draw (이탈은 lose) */
  outcome: 'win' | 'lose' | 'draw';
  /** FFA 순위 (공동 순위 같은 값) */
  rank: number;
  players: number;
}

/** 경기 하나 반영한 새 전적 */
export function addMatch(prev: RankStats, m: RankMatchInput): RankStats {
  const s = { ...prev };
  const P = RANK_POINTS;
  s.m++;
  s.k += m.k;
  s.d += m.d;
  s.pt += m.k * P.kill;
  if (m.mode === 'tdm') {
    const out = m.left ? 'lose' : m.outcome;
    if (out === 'win') {
      s.tw++;
      s.pt += P.tdmWin;
    } else if (out === 'draw') {
      s.td++;
      s.pt += P.tdmDraw;
    } else s.tl++;
    s.tk += m.k;
  } else {
    s.fm++;
    s.fk += m.k;
    if (!m.left) {
      if (m.rank === 1) s.f1++;
      else if (m.rank === 2) s.f2++;
      else if (m.rank === 3) s.f3++;
      if (m.players > 1) s.pt += Math.round((P.ffaTop * (m.players - Math.min(m.rank, m.players))) / (m.players - 1));
    }
  }
  return s;
}

const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) : 0);

/**
 * 정렬 키 (클수록 위, 0 = 기록 없음). 여러 기준을 숫자 하나로 (서버 컬렉션 정렬이 한 필드로 되게):
 * - 전체: 점수 → 누적 킬
 * - TDM: 승리 수 → 승률 → TDM 킬
 * - FFA: 누적 킬 → 1위 횟수 → 1위 비율
 */
export function rankKeys(s: RankStats): Record<RankKind, number> {
  const tdmGames = s.tw + s.tl + s.td;
  return {
    all: s.m > 0 ? 1 + s.pt * 1e7 + Math.min(s.k, 9_999_999) : 0,
    tdm: tdmGames > 0 ? 1 + s.tw * 1e7 + rate(s.tw, tdmGames) * 1e4 + Math.min(s.tk, 9_999) : 0,
    ffa: s.fm > 0 ? 1 + s.fk * 1e7 + Math.min(s.f1, 999) * 1e4 + rate(s.f1, s.fm) : 0,
  };
}

/** 랭킹 컬렉션 필드 이름 (정렬 키) */
export const RANK_KEY_FIELD: Record<RankKind, string> = { all: 'ka', tdm: 'kt', ffa: 'kf' };

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
  kind: RankKind;
  rows: RankRow[];
  /** 내 줄 (공식 기록이 없으면 rank 0 = 순위 없음) */
  mine: RankRow | null;
  /** 이 랭킹에 기록이 있는 전체 인원 */
  total: number;
}

// 결과 화면 데이터: 연습전(로컬 Match)·멀티(서버 확정 NetMatchResult)를 같은 형식으로 바꾼다 (렌더링과 무관한 순수 로직).
// 승패·무승부는 원래 판정(Match.finish / 서버 finishMatch) 값을 그대로 쓰고 여기서 다시 계산하지 않는다.
import { safeDisplayNick } from '../net/shared/nickFilter';
import { standingRanks, type XpAward } from '../net/shared/progression';
import { CHARACTERS, type CharacterId } from '../config/characters';
import type { MatchResult } from '../match/Match';
import type { MatchRules } from '../config/match';
import { NET_MODE_RULES, type NetMatchResult, type NetTeam } from '../net/shared/protocol';

export interface ResultEntry {
  /** 참가자 id (멀티 = 계정, 연습전 = 참가자 id). 화면 표시 금지 */
  readonly id: string;
  /** 표시 이름 (닉네임·봇 이름) */
  readonly nick: string;
  readonly char: CharacterId;
  readonly team: NetTeam | null;
  readonly k: number;
  readonly d: number;
  /** 1부터 (공동 순위 같은 값) */
  readonly rank: number;
  readonly me: boolean;
  /** 이긴 쪽 (TDM = 이긴 팀, FFA = 1위·공동 1위) */
  readonly win: boolean;
  readonly mvp: boolean;
  /** 매치 중 나감: quit = 직접 나감, drop = 끊김 */
  readonly left: 'quit' | 'drop' | null;
}

export interface ResultData {
  /** 같은 결과를 두 번 띄우지 않기 위한 키 */
  readonly key: string;
  /** 배치 방식: tdm = 이긴 팀 앞·진 팀 뒤, ffa = 순위 시상대 (자유 테스트·연습전 포함) */
  readonly layout: 'tdm' | 'ffa';
  readonly practice: boolean;
  /** 내 경험치 지급 결과 (서버 확정, 멀티 TDM·FFA만. 연습전·TEST는 없음) */
  readonly xp?: XpAward;
  readonly label: string;
  readonly reason: 'score' | 'time';
  /** 목표 점수 (0 = 없음) */
  readonly goal: number;
  /** 이 화면 플레이어 기준 */
  readonly outcome: 'win' | 'lose' | 'draw';
  readonly draw: boolean;
  readonly teamScore: Readonly<Record<NetTeam, number>> | null;
  readonly winnerTeam: NetTeam | null;
  /** 순위 순서 (원래 결과의 정렬 그대로: 킬 많은 순 → 데스 적은 순 → 자리/등록 순) */
  readonly entries: readonly ResultEntry[];
}

interface RawEntry {
  id: string;
  nick: string;
  char: string;
  team: NetTeam | null;
  k: number;
  d: number;
  me: boolean;
  left: 'quit' | 'drop' | null;
}

function charOf(id: string): CharacterId {
  return id in CHARACTERS ? (id as CharacterId) : 'blue';
}

/**
 * 순위: 최다 킬 동점 = 모두 1위 (승패 규칙과 같은 공동 1위·무승부). 그 아래는 킬 → 데스 순이고
 * 킬·데스가 모두 같으면 같은 순위 (기존 순위표 규칙). list는 이미 킬 내림차순 → 데스 오름차순으로 정렬돼 있음
 */
export function rankList(list: ReadonlyArray<{ k: number; d: number }>): number[] {
  // 서버 경험치 순위 보너스와 같은 함수 (net/shared/progression)
  return standingRanks(list);
}

/**
 * MVP 한 명: 최다 킬 (0킬이면 없음) → 데스 적은 순 → 이긴 쪽 → 순위표 순서.
 * 모든 화면이 같은 결과(같은 정렬)를 받으므로 모두 같은 사람이 MVP
 */
export function pickMvp(list: ReadonlyArray<{ k: number; d: number; win: boolean }>): number {
  let best = -1;
  list.forEach((e, i) => {
    if (e.k <= 0) return;
    const b = list[best];
    if (!b || e.k > b.k || (e.k === b.k && (e.d < b.d || (e.d === b.d && e.win && !b.win)))) best = i;
  });
  return best;
}

function finish(raw: RawEntry[], winners: ReadonlySet<string>): ResultEntry[] {
  const ranks = rankList(raw);
  const withWin = raw.map((e) => ({ ...e, win: winners.has(e.id) }));
  const mvp = pickMvp(withWin);
  return withWin.map((e, i) => ({ ...e, char: charOf(e.char), rank: ranks[i]!, mvp: i === mvp }));
}

/** 멀티: 서버가 확정한 결과 그대로 (닉네임·캐릭터는 결과에 함께 저장된 값 → 다른 사람과 뒤바뀌지 않음) */
export function fromNetResult(r: NetMatchResult, me: string, roomId: string, myNick: string | null): ResultData {
  const raw: RawEntry[] = r.standings.map((s) => ({
    id: s.account,
    nick: safeDisplayNick(s.nick) ?? (s.account === me ? myNick ?? '플레이어' : `P${s.slot + 1}`),
    char: s.char,
    team: s.team,
    k: s.k,
    d: s.d,
    me: s.account === me,
    left: s.left ? (s.quit ? 'quit' : 'drop') : null,
  }));
  const mine = r.winners.includes(me);
  // 기존 판정 그대로: TDM 무승부는 모두 무승부, FFA 공동 1위는 1위끼리 무승부·나머지 패배
  const outcome = r.draw ? (r.mode === 'tdm' || mine ? 'draw' : 'lose') : mine ? 'win' : 'lose';
  const rule = NET_MODE_RULES[r.mode];
  return {
    key: `net:${roomId}:${r.endedAt}`,
    layout: r.mode === 'tdm' ? 'tdm' : 'ffa',
    practice: false,
    label: rule.label,
    reason: r.reason,
    goal: rule.scoreToWin,
    outcome,
    draw: r.draw,
    teamScore: r.mode === 'tdm' ? { ...r.teamScore } : null,
    winnerTeam: r.winnerTeam,
    entries: finish(raw, new Set(r.winners)),
    ...(r.xp?.[me] ? { xp: r.xp[me] } : {}),
  };
}

/** 연습전 (개인전 + 봇): 로컬 Match 결과 */
export function fromPracticeResult(
  r: MatchResult,
  rules: MatchRules,
  round: number,
  who: (id: string) => { nick: string; char: string },
): ResultData {
  const raw: RawEntry[] = r.standings.map((s) => {
    const w = who(s.id);
    return { id: s.id, nick: w.nick, char: w.char, team: null, k: s.kills, d: s.deaths, me: s.isLocal, left: null };
  });
  return {
    key: `practice:${round}`,
    layout: 'ffa',
    practice: true,
    label: rules.label,
    reason: r.reason,
    goal: rules.scoreToWin,
    outcome: r.localOutcome,
    draw: r.draw,
    teamScore: null,
    winnerTeam: null,
    entries: finish(raw, new Set(r.winners)),
  };
}

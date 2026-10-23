// 리텐션 (서버 집계 · 개발자 콘솔 retention() 공용). 날짜는 UTC 일 번호(1970-01-01 = 0)로 통일.
// 기록(서버 actPing, 계정당 하루 1번): 유저 문서 {f: 최초 접속일, l: 마지막 접속일} + 접속일 문서 {d: 접속일, f: 최초 접속일, k: d - f}.
// 두 컬렉션 모두 계정·닉네임 없이 날짜 숫자만 (익명 집계용). 계정 ↔ 유저 문서 연결은 그 계정의 비공개 사용자 상태(act)에만.
// Dn 리텐션 = (최초 접속 후 정확히 n일째 접속한 유저 수) / (최초 접속일이 오늘 - n 이전인 유저 수). 그 사이 날짜 재방문은 세지 않음.

export const RETENTION_DAYS = [1, 3, 7, 14, 30] as const;
export type RetentionDay = (typeof RETENTION_DAYS)[number];

const DAY_MS = 86_400_000;

/** UTC 일 번호 */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** 일 번호 → 'YYYY-MM-DD' (UTC) */
export function dayLabel(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 비율 (%) — 대상이 0명이면 null (= N/A, 0%와 구분) */
export function rate(retained: number, eligible: number): number | null {
  return eligible > 0 ? Math.round((retained / eligible) * 1000) / 10 : null;
}

/** 이 코호트(최초 접속일)의 Dn을 오늘 관측할 수 있는지 (n일째 날이 지났거나 오늘) */
export function observable(firstDay: number, n: number, today: number): boolean {
  return firstDay + n <= today;
}

export interface RetentionCell {
  n: RetentionDay;
  /** 계산 대상 유저 수 (분모) */
  eligible: number;
  /** n일째 재접속 유저 수 (분자) */
  retained: number;
  /** % (대상 0명 = null) */
  rate: number | null;
}

export interface RetentionSummary {
  today: string;
  /** 기록 시작 이후 최초 접속한 유저 수 */
  users: number;
  /** 최근 30일(오늘 포함) 안에 접속한 유저 수 */
  active30: number;
  /** 오늘(UTC) 접속 유저 수 */
  activeToday: number;
  /** 가장 이른 최초 접속일 (기록 시작일, 없으면 null) */
  since: string | null;
  cells: RetentionCell[];
}

export interface RetentionCohortRow {
  day: string;
  users: number;
  /** Dn별 비율 (관측 전 = null) + 재접속 수 */
  cells: Array<{ n: RetentionDay; retained: number | null; rate: number | null }>;
}

export interface RetentionDailyRow {
  day: string;
  dau: number;
  newUsers: number;
}

export type RetentionView = 'summary' | 'cohort' | 'daily';

export type RetentionResult =
  | { ok: true; view: 'summary'; data: RetentionSummary }
  | { ok: true; view: 'cohort'; data: RetentionCohortRow[] }
  | { ok: true; view: 'daily'; data: RetentionDailyRow[] }
  | { ok: false; reason: 'not_admin' | 'too_fast' | 'bad_view' | 'error'; account?: string; waitMs?: number };

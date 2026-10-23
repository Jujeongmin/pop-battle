// 개발자 콘솔 retention(): 서버 retentionGet의 집계 결과만 출력 (관리자 확인은 서버가 계정으로, 이 파일은 표시만).
// retention() / retention('summary') = 전체 Dn, retention('cohort') = 최근 30일 최초 접속일별, retention('daily') = 최근 30일 DAU·신규.
// 개인 정보(계정·닉네임) 없음. 권한이 없으면 내 계정 주소만 알려 줌 (관리자 목록에 넣을 때 확인용)
import type { RetentionResult, RetentionView } from './shared/retention';

type Caller = (view: RetentionView) => Promise<RetentionResult>;

const pct = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(1)}%`);

export function installRetentionConsole(call: Caller): void {
  (window as unknown as { retention: (view?: RetentionView) => Promise<RetentionResult | null> }).retention = async (view = 'summary') => {
    let r: RetentionResult;
    try {
      r = await call(view);
    } catch (e) {
      console.error('[retention] 서버에 연결하지 못했어요', e);
      return null;
    }
    if (!r.ok) {
      const why =
        r.reason === 'not_admin'
          ? `관리자 계정만 볼 수 있어요 (지금 계정: ${r.account ?? '알 수 없음'} — 서버 RETENTION_ADMINS에 있어야 함)`
          : r.reason === 'too_fast'
            ? `잠시 뒤 다시 (${Math.ceil((r.waitMs ?? 0) / 1000)}초)`
            : r.reason === 'bad_view'
              ? "보기 이름: 'summary' · 'cohort' · 'daily'"
              : '집계 중 오류 (서버 로그 확인)';
      console.warn(`[retention] ${why}`);
      return r;
    }
    if (r.view === 'summary') {
      const d = r.data;
      console.log(
        `%cPOP! BATTLE — RETENTION%c\n기준 UTC ${d.today} · 기록 시작 ${d.since ?? '없음'}\n\n전체 가입 유저: ${d.users.toLocaleString()}명\n최근 30일 활성 유저: ${d.active30.toLocaleString()}명\n오늘 접속 유저: ${d.activeToday.toLocaleString()}명`,
        'font-weight:900;font-size:14px',
        '',
      );
      console.table(Object.fromEntries(d.cells.map((c) => [`D${c.n}`, { 리텐션: pct(c.rate), '재방문(n일째)': c.retained, '계산 대상': c.eligible }])));
      console.log('Dn = 최초 접속 후 정확히 n일째(UTC) 접속한 유저 / 최초 접속 후 n일이 지난 유저. 대상 0명은 N/A');
    } else if (r.view === 'cohort') {
      console.log('%cPOP! BATTLE — 코호트 리텐션 (최근 30일, 최초 접속일 UTC)', 'font-weight:900');
      if (!r.data.length) console.log('기록된 코호트가 없어요');
      else console.table(Object.fromEntries(r.data.map((row) => [row.day, { '신규 유저': row.users, ...Object.fromEntries(row.cells.map((c) => [`D${c.n}`, c.rate === null && c.retained === null ? 'N/A' : `${pct(c.rate)} (${c.retained})`])) }])));
    } else {
      console.log('%cPOP! BATTLE — 일별 (최근 30일, UTC)', 'font-weight:900');
      console.table(Object.fromEntries(r.data.map((row) => [row.day, { DAU: row.dau, 신규: row.newUsers }])));
    }
    return r;
  };
}

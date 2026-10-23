// 내 누적 경험치의 이 기기 사본 (localStorage, 표시용). 원본은 서버의 계정별 글로벌 사용자 상태(progressGet ·
// 매치 종료 때 서버가 지급) — 이 값을 서버로 보내지 않으며, 서버 없는 빌드·연결 전에만 화면에 씀.
const KEY = 'popbattle.xp';

export function loadXpCache(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function saveXpCache(xp: number): void {
  try {
    localStorage.setItem(KEY, String(Math.max(0, Math.floor(xp))));
  } catch {
    // 저장 못 해도 이번 접속에서는 그대로
  }
}

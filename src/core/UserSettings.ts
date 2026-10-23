// 사용자 설정 (이 기기·브라우저에만 저장). 게임 밸런스 값은 없음 — 소리 크기와 마우스 시점 감도 배율만.
// 모바일 터치 설정은 TouchInput이 따로 저장 (popbattle.touch).

export interface UserSettings {
  /** 효과음 크기 0..1 (예전 '전체 소리' 저장값을 그대로 이어 씀) */
  volume: number;
  /** 배경음 크기 0..1 (배경음 버스, 음악이 아직 없어 설정 화면에서는 잠김) */
  music: number;
  /** PC 마우스 시점 감도 배율 (기본 1 = 기존 감도) */
  mouseSensitivity: number;
}

export const USER_DEFAULTS: UserSettings = { volume: 0.6, music: 0.5, mouseSensitivity: 1 };
export const USER_LIMITS = {
  volume: [0, 1, 0.05],
  music: [0, 1, 0.05],
  mouseSensitivity: [0.4, 2.5, 0.05],
} as const;

const KEY = 'popbattle.settings';

export function loadUserSettings(): UserSettings {
  const s = { ...USER_DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return s;
    const v = JSON.parse(raw) as Partial<UserSettings>;
    for (const k of Object.keys(USER_LIMITS) as Array<keyof UserSettings>) {
      const n = v[k];
      if (typeof n === 'number' && Number.isFinite(n)) s[k] = Math.min(USER_LIMITS[k][1], Math.max(USER_LIMITS[k][0], n));
    }
  } catch {
    /* 저장소를 못 쓰면 기본값 */
  }
  return s;
}

export function saveUserSettings(s: UserSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 저장 못 해도 이번 세션에는 적용 */
  }
}

// 게임 언어 (한국어 / English): 설정 > 일반 > 언어. 처음에는 브라우저 언어(한국어면 ko, 그 밖은 en), 고르면 이 기기에 기억.
// 화면 글자는 한국어로 작성돼 있고, en이면 i18n/translate.ts가 표시 직전에 바꿈 (사전 i18n/en.ts).
export type Lang = 'ko' | 'en';

const KEY = 'popbattle.lang';
const listeners = new Set<(lang: Lang) => void>();

function browserLang(): Lang {
  const langs = typeof navigator !== 'undefined' ? [...(navigator.languages ?? []), navigator.language] : [];
  return langs.some((l) => typeof l === 'string' && l.toLowerCase().startsWith('ko')) ? 'ko' : 'en';
}

function saved(): Lang | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'ko' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

let current: Lang = saved() ?? browserLang();

export function getLang(): Lang {
  return current;
}

/** 언어 바꾸기 (기억 + 화면 즉시 다시 번역) */
export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // 저장 못 해도 이번에는 그대로
  }
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  for (const cb of listeners) cb(lang);
}

export function onLangChange(cb: (lang: Lang) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

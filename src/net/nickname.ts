// 표시용 닉네임 (이 기기 저장). Verse8 SDK에 닉네임 API가 없어 직접 둠 — 화면 표시에만 쓰고, 서버 식별은 계정(account).
// 규칙(길이·허용 문자)은 서버와 같은 sanitizeNick (protocol.ts). 서버도 받을 때 다시 검사한다.
import { sanitizeNick } from './shared/protocol';

const KEY = 'popbattle.nick';

/** 저장된 닉네임 (없거나 규칙에 안 맞으면 null) */
export function loadNickname(): string | null {
  try {
    return sanitizeNick(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function saveNickname(nick: string): void {
  try {
    localStorage.setItem(KEY, nick);
  } catch {
    // 저장 못 해도 이번 접속에서는 그대로 사용
  }
}

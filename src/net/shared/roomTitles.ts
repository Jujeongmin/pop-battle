// 방 제목 (방을 만들 때 서버가 번호 하나만 무작위로 정해 저장 → 화면은 보는 사람 언어로).
// 서버에는 번호(1~ROOM_TITLE_COUNT)만 있고 문구는 여기만 (언어별 문자열을 서버에 중복 저장하지 않음).
import { ROOM_TITLE_COUNT } from './protocol';

export type RoomTitleLang = 'ko' | 'en';

/** id = 배열 위치 + 1 (01~20). 문구를 바꿔도 id는 그대로 */
export const ROOM_TITLES: ReadonlyArray<{ ko: string; en: string }> = [
  { ko: '나랑 뜨실 분~?', en: "Who's up for a match?" },
  { ko: '초보도 환영해요!', en: 'Beginners welcome!' },
  { ko: '고수만 들어와!', en: 'Pros only!' },
  { ko: '재밌게 놀아요~', en: "Let's have fun!" },
  { ko: '우리 팀 이길 사람?', en: 'Think you can beat us?' },
  { ko: '실력보다 재미!', en: 'Fun over skill!' },
  { ko: '한 판만 하고 가요', en: 'Just one more match!' },
  { ko: '덤벼라 덤벼~!', en: 'Bring it on!' },
  { ko: '같이 놀 사람~?', en: 'Wanna play together?' },
  { ko: '오늘은 내가 1등!', en: "I'm taking first place!" },
  { ko: '살살 부탁해요~', en: 'Go easy on me!' },
  { ko: '승부는 지금부터!', en: 'Game on!' },
  { ko: '질 자신이 없는데?', en: "I can't lose!" },
  { ko: '아무나 들어오세요!', en: "Everyone's welcome!" },
  { ko: '오늘도 즐겜!', en: 'Good vibes only!' },
  { ko: '우리 팀 모여라!', en: 'Team up!' },
  { ko: '승자는 누구~?', en: 'Who will win?' },
  { ko: '초보끼리 놀아요', en: 'Beginners unite!' },
  { ko: '이번 판은 진지하게!', en: "Let's get serious!" },
  { ko: '도전자 구합니다!', en: 'Challengers wanted!' },
];

if (ROOM_TITLES.length !== ROOM_TITLE_COUNT) throw new Error(`방 제목 수 ${ROOM_TITLES.length} ≠ ROOM_TITLE_COUNT ${ROOM_TITLE_COUNT}`);

/** 제목 번호 → 이 언어 문구. 번호가 없거나(예전 방) 모르는 번호면 null (부르는 쪽이 대체 표시) */
export function roomTitle(id: number | undefined, lang: RoomTitleLang): string | null {
  if (!id || !Number.isInteger(id) || id < 1 || id > ROOM_TITLES.length) return null;
  return ROOM_TITLES[id - 1]![lang];
}

/** 보는 사람 언어: 게임에 언어 설정이 없어 브라우저 언어 (한국어면 ko, 그 밖은 en) */
export function viewerLang(): RoomTitleLang {
  const langs = typeof navigator !== 'undefined' ? [...(navigator.languages ?? []), navigator.language] : [];
  return langs.find((l) => !!l)?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

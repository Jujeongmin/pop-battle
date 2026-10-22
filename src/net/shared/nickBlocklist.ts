// 닉네임 금칙어 목록 (검사 로직은 nickFilter.ts). 클라이언트·서버 공용이라 순수 데이터만.
// 추가·수정은 이 파일만 고치면 됨. 항목은 원래 표기로 적고, 정규화(소문자·숫자 치환·반복 축약·자모 분해)는 검사 쪽이 같은 규칙으로 함.
//
// 종류
// - KO_CONTAINS: 한국어 욕설·성적 비속어·혐오 표현. 닉네임 어디에 들어 있어도 차단 (음절 단위 + 자모 단위 비교)
// - KO_JAMO: 초성 줄임말 (ㅅㅂ 등). 입력에 자모 그대로 쓴 경우만 (완성 음절 경계에서 우연히 생기는 자모 열은 무시 → 오탐 방지)
// - EN_CONTAINS: 영어 욕설·혐오 표현 중 정상 단어 안에 거의 나오지 않는 것. 어디에 있어도 차단
// - EN_WORD: 정상 단어 안에 자주 나오는 짧은 말 (ass → class, sex → essex 등). 단어 전체가 같을 때만 차단
// - ALLOW: 금칙어를 품은 정상 단어. 검사 전에 지움 (예: 시발점, 시바견)

export const KO_CONTAINS: readonly string[] = [
  // 일반 욕설
  '씨발', '시발', '씨빨', '씨팔', '시팔', '씨바', '시바', '쓰발', '씌발', '씹', '좆', '좃', '존나', '지랄', '병신', '븅신', '빙신', '븡신',
  '개새끼', '개새기', '개색기', '개색끼', '개색히', '개세끼', '새끼', '쌔끼', '미친놈', '미친년', '미친새', '닥쳐', '꺼져', '엠창', '니미', '느금', '니애미', '느그애미',
  '애미뒤진', '애비뒤진', '염병', '육시랄', '호로새', '후레자식', '썅',
  // 성적 비속어
  '보지', '자지', '섹스', '섹수', '야동', '창녀', '창놈', '강간', '딸딸이', '자위', '펠라',
  // 혐오·차별 표현
  '한남충', '김치녀', '된장녀', '맘충', '틀딱', '급식충', '짱깨', '쪽바리', '깜둥이', '흑형', '똥꼬충', '호모새', '장애새', '정신병자', '찐따',
];

export const KO_JAMO: readonly string[] = ['ㅅㅂ', 'ㅆㅂ', 'ㅄ', 'ㅂㅅ', 'ㅈㄹ', 'ㅈㄴ', 'ㄴㄱㅁ', 'ㅁㅊ', 'ㅆㄹㄱ', 'ㅅㄲ'];

export const EN_CONTAINS: readonly string[] = [
  'fuck', 'fuk', 'fck', 'shit', 'bitch', 'cunt', 'whore', 'slut', 'bastard', 'asshole', 'dickhead', 'motherf', 'porn', 'pussy', 'blowjob', 'handjob', 'cumshot',
  'nigger', 'nigga', 'faggot', 'retard', 'kike', 'chink', 'tranny', 'hitler',
  // 한국어 욕설의 로마자 표기·한/영 전환 없이 친 자판 그대로 (씨발 → tlqkf, 병신 → qudtls, 지랄 → wlfkf, 개새끼 → rotoRl)
  'sibal', 'ssibal', 'shibal', 'tlqkf', 'qudtls', 'wlfkf', 'rotorl', 'byungsin', 'byeongsin',
];

export const EN_WORD: readonly string[] = ['ass', 'asses', 'dick', 'dicks', 'cock', 'cocks', 'sex', 'sexy', 'cum', 'fag', 'fags', 'spic', 'nazi', 'nazis', 'rape', 'tits', 'boobs', 'damn', 'wtf', 'stfu', 'rapist', 'rapists'];

export const ALLOW: readonly string[] = ['시발점', '시발역', '시발택시', '시바견', '시바이누', '스시바', '새끼손가락', '새끼발가락', '자지러', '보지마', '보지않', '꺼져가', 'scunthorpe', 'cockpit', 'peacock', 'shitake', 'shiitake'];

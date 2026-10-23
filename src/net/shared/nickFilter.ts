// 닉네임 검사 (클라이언트 입력 1차·서버 최종 공용, 순수 함수). 금칙어 목록은 nickBlocklist.ts.
// 형식: 앞뒤 공백 제거·연속 공백 하나로, 2~12자, 한글·영문·숫자·공백만 (특수문자·제어 문자·HTML 불가).
// 금칙어: 우회 입력을 정규화해서 비교 — 대소문자, 글자 사이 공백, 숫자→영문 치환(0→o, 1→i, 3→e, 4→a, 5→s, 7→t, 8→b, 9→g, v→u),
// 같은 글자 반복, 한글 늘이기(씨이발), 자모 분리 입력(시ㅂ알·ㅅ ㅂ). 오탐을 줄이려고:
// - 정상 단어에도 들어가는 짧은 영어는 단어 전체가 같을 때만 (EN_WORD)
// - 한 글자 한국어 금칙어(씹·좆)는 자모 단위로 비교하지 않음 (조지 → ㅈㅗㅈㅣ 오탐 방지)
// - 초성 줄임말은 입력에 자모 그대로 쓴 경우만 (곳바 → ㄱㅗㅅㅂㅏ의 'ㅅㅂ' 오탐 방지)
// - 금칙어를 품은 정상 단어(ALLOW)는 먼저 지움
// 자모 우회 추가 (2026-10-23): 홀로 쓴 자음 뒤의 영문 l·I·i·숫자 1은 모음 'ㅣ'로 봄 (보ㅈl킹), 자모 열에서 같은 자모 연속은 하나로 (보ㅗ지).
// 원본 닉네임은 그대로 저장·표시하고, 이 정규화 문자열은 검사에만 씀
// 사칭(운영자·관리자·GM 등)도 금칙어 목록으로 차단. 화면 표시용 safeDisplayNick: 지금 규칙에 걸리는 예전 닉네임은 '닉네임 변경 필요'
import { ALLOW, EN_CONTAINS, EN_WORD, KO_CONTAINS, KO_JAMO } from './nickBlocklist';

export const NICK_RULE = { min: 2, max: 12 } as const;

/** 지금 규칙에 맞지 않는 예전 닉네임 대신 화면에 쓰는 이름 (계정·전적은 그대로) */
export const NICK_PLACEHOLDER = '닉네임 변경 필요';

/**
 * 화면 표시용 닉네임: 규칙을 통과하면 정리된 값, 값은 있는데 규칙에 걸리면(정책 강화 전에 정한 이름 등) NICK_PLACEHOLDER, 없으면 null.
 * 랭킹·대기실·결과·로비 이름표 등 다른 사람에게 보이는 곳에서 표시 직전에 씀
 */
export function safeDisplayNick(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const r = checkNickname(raw);
  return r.ok ? r.value : NICK_PLACEHOLDER;
}

/** 실패 이유: empty = 비어 있음, length = 글자 수, chars = 허용하지 않는 문자, blocked = 금칙어 (어떤 말에 걸렸는지는 알려 주지 않음) */
export type NickFailReason = 'empty' | 'length' | 'chars' | 'blocked';
export type NickCheck = { ok: true; value: string } | { ok: false; reason: NickFailReason };

const ALLOWED_CHARS = /^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 ]+$/;

/** 형식 정리 (공백만). 검사 전 단계 */
export function tidyNick(raw: unknown): string {
  return typeof raw === 'string' ? raw.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

/** 닉네임 검사: 형식 → 금칙어. 통과하면 정리된 값 */
export function checkNickname(raw: unknown): NickCheck {
  const s = tidyNick(raw);
  if (!s) return { ok: false, reason: 'empty' };
  const len = [...s].length;
  if (len < NICK_RULE.min || len > NICK_RULE.max) return { ok: false, reason: 'length' };
  if (!ALLOWED_CHARS.test(s)) return { ok: false, reason: 'chars' };
  if (isBlockedNick(s)) return { ok: false, reason: 'blocked' };
  return { ok: true, value: s };
}

// ---------------- 정규화 ----------------

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', v: 'u' };

/** 영어 비교용: 소문자 영문·숫자만 남기고 숫자 치환, 3번 이상 반복은 하나로 (full = 2번 반복도 하나로) */
function enForm(s: string, full = false): string {
  const letters = s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/[0-9v]/g, (c) => LEET[c] ?? c);
  return letters.replace(full ? /(.)\1+/g : /(.)\1{2,}/g, '$1');
}

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const JUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

function syllable(c: string): { cho: number; jung: number; jong: number } | null {
  const code = c.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  return { cho: Math.floor(code / 588), jung: Math.floor((code % 588) / 28), jong: code % 28 };
}

/** 한글 음절·자모만 남기고, 늘인 소리(씨이발의 '이': 앞 음절과 같은 모음 + 받침 없음) 제거 */
function koForm(s: string): string {
  const out: string[] = [];
  for (const c of s.replace(/[^가-힣ㄱ-ㅎㅏ-ㅣ]/g, '')) {
    const cur = syllable(c);
    const prev = out.length ? syllable(out[out.length - 1]!) : null;
    if (cur && prev && cur.cho === 11 && cur.jong === 0 && prev.jong === 0 && cur.jung === prev.jung) continue;
    out.push(c);
  }
  return out.join('');
}

/** 홀로 쓴 자음 뒤의 영문 l·I·i·숫자 1 → 모음 'ㅣ' (모양이 같아 자모 우회에 쓰임: 보ㅈl킹 → 보ㅈㅣ킹) */
function hangulLookalikes(s: string): string {
  return s.replace(/([ㄱ-ㅎ])[lIi1]/g, '$1ㅣ');
}

/** 자모 열로 분해 (자모 분리 입력과 비교). 홀로 쓴 자음 뒤의 소리 없는 'ㅇ'은 지움 (시ㅂ알 → ㅅㅣㅂㅏㄹ), 같은 자모 연속은 하나로 (보ㅗ지 → ㅂㅗㅈㅣ) */
function jamoForm(s: string): string {
  let out = '';
  let prevLoose = false;
  for (const c of s) {
    const sy = syllable(c);
    if (!sy) {
      out += c;
      prevLoose = /[ㄱ-ㅎ]/.test(c);
      continue;
    }
    out += (sy.cho === 11 && prevLoose ? '' : CHO[sy.cho]) + JUNG[sy.jung] + JONG[sy.jong];
    prevLoose = false;
  }
  return out.replace(/([ㄱ-ㅎㅏ-ㅣ])\1+/g, '$1');
}

/** 초성 뼈대(음절 → 초성, 홀로 쓴 자음 그대로, 모음·그 밖은 버림)에 KO_JAMO가 있고 그 구간에 홀로 쓴 자음이 있으면 true */
function looseInitials(s: string): boolean {
  let skeleton = '';
  const loose: boolean[] = [];
  for (const c of koForm(s)) {
    const sy = syllable(c);
    if (sy) {
      skeleton += CHO[sy.cho];
      loose.push(false);
    } else if (/[ㄱ-ㅎ]/.test(c)) {
      skeleton += c;
      loose.push(true);
    }
  }
  return KO_JAMO.some((j) => {
    for (let p = skeleton.indexOf(j); p >= 0; p = skeleton.indexOf(j, p + 1)) {
      if (loose.slice(p, p + j.length).some(Boolean)) return true;
    }
    return false;
  });
}

// 목록도 같은 규칙으로 한 번만 정규화
const EN_CONTAINS_N = EN_CONTAINS.map((w) => enForm(w));
const EN_CONTAINS_FULL = EN_CONTAINS.map((w) => enForm(w, true));
const EN_WORD_N = new Set(EN_WORD.map((w) => enForm(w)));
const KO_N = KO_CONTAINS.map((w) => koForm(w));
const KO_JAMO_N = KO_CONTAINS.filter((w) => [...w].length >= 2).map((w) => jamoForm(koForm(w)));
const ALLOW_N = ALLOW.map((w) => w.toLowerCase());

/** 금칙어 포함 여부 (형식 검사를 통과한 문자열 기준) */
export function isBlockedNick(s: string): boolean {
  let compact = hangulLookalikes(s).toLowerCase().replace(/\s+/g, '');
  for (const a of ALLOW_N) compact = compact.split(a).join('');
  // 초성 줄임말: 입력에 자모 그대로
  const looseJamo = compact.replace(/[^ㄱ-ㅎㅏ-ㅣ]/g, '');
  if (looseJamo && KO_JAMO.some((j) => compact.includes(j))) return true;
  // 홀로 쓴 자음 + 완성 음절 섞기 (ㅅ발·ㅂ신·시ㅂ): 초성 뼈대에서 줄임말을 찾되, 홀로 쓴 자음이 걸친 경우만 (사방 → ㅅㅂ 오탐 방지)
  if (looseJamo && looseInitials(compact)) return true;
  // 영어: 붙여 쓴 전체에서 찾기 + 단어 전체가 같은 짧은 말
  const en = enForm(compact);
  const enFull = enForm(compact, true);
  if (en && (EN_CONTAINS_N.some((w) => en.includes(w)) || EN_CONTAINS_FULL.some((w) => enFull.includes(w)))) return true;
  const tokens = s.toLowerCase().split(' ').map((t) => enForm(t)).filter(Boolean);
  if (en && (EN_WORD_N.has(en) || tokens.some((t) => EN_WORD_N.has(t)))) return true;
  // 한국어: 음절 단위, 자모 단위 (두 글자 이상 금칙어만)
  const ko = koForm(compact);
  if (ko && KO_N.some((w) => ko.includes(w))) return true;
  const jamo = jamoForm(ko);
  return !!jamo && KO_JAMO_N.some((w) => jamo.includes(w));
}

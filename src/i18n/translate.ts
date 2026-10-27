// 화면 번역: 게임 글자는 한국어로 작성돼 있고, 영어일 때 표시 직전에 사전(i18n/en.ts)으로 바꿈.
// - 페이지의 글자 노드와 placeholder·title·aria-label 속성을 감시(MutationObserver)해 새로 생기거나 바뀔 때만 번역
//   → 수백 곳의 화면 코드를 고치지 않고 사전 한 곳만 관리. 한국어로 돌아가면 원문으로 복원
// - 한글이 없는 글자(숫자·타이머·탄약)는 바로 건너뜀 → HUD가 매 프레임 바뀌어도 부담 없음
// - 입력 칸(input·textarea)과 data-i18n-skip 안쪽은 번역하지 않음 (사용자가 쓴 글)
// - 사전에 없는 문장은 ' · '로 나눠 조각마다 다시 찾음. 그래도 없으면 원문 (개발 콘솔 __i18nMissing()로 목록)
import { EN_EXACT, EN_PATTERNS } from './en';
import { getLang, onLangChange } from './lang';

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const ATTRS = ['placeholder', 'title', 'aria-label'] as const;
const missing = new Set<string>();

/** 문장 하나 번역 (en이 아니거나 한글이 없으면 그대로) */
export function t(s: string): string {
  if (getLang() !== 'en' || !HANGUL.test(s)) return s;
  const lead = s.match(/^\s*/)![0];
  const tail = s.match(/\s*$/)![0];
  const core = s.trim();
  const out = translateCore(core);
  return out === null ? s : lead + out + tail;
}

function translateCore(core: string): string | null {
  const exact = EN_EXACT[core];
  if (exact !== undefined) return exact;
  // 앞에 붙은 '· ' (이어 붙일 설명 조각)
  if (core.startsWith('· ')) {
    const r = translateCore(core.slice(2).trim());
    return r === null ? null : `· ${r}`;
  }
  // 뒤에 붙은 ' ·' (다음 조각과 이어지는 조작 안내 등)
  if (core.endsWith(' ·')) {
    const r = translateCore(core.slice(0, -2).trim());
    return r === null ? null : `${r} ·`;
  }
  // 패턴에 끼운 조각(이름·이유)도 사전에 있으면 번역 (닉네임처럼 없는 것은 그대로).
  // 결과에 한글이 남으면 아래 ' · ' 조각 번역을 먼저 해 보고, 그래도 안 되면 이 결과를 씀
  let partial: string | null = null;
  for (const [re, rep] of EN_PATTERNS) {
    const m = core.match(re);
    if (!m) continue;
    const groups = (m as unknown as string[]).map((g, i) => (i === 0 || g === undefined || !HANGUL.test(g) ? g : (translateCore(g.trim()) ?? g)));
    const out = typeof rep === 'string' ? rep.replace(/\$(\d)/g, (_s, i: string) => groups[Number(i)] ?? '') : rep(...groups);
    const r = core.replace(re, () => out);
    if (!HANGUL.test(r)) return r;
    partial ??= r;
  }
  // ' · '로 이어 붙인 문장: 조각마다
  if (core.includes(' · ')) {
    const parts = core.split(' · ');
    let changed = false;
    const done = parts.map((p) => {
      if (!HANGUL.test(p)) return p;
      const r = translateCore(p.trim());
      if (r === null) return p;
      changed = true;
      return r;
    });
    if (changed && (partial === null || !done.some((d) => HANGUL.test(d)))) return done.join(' · ');
  }
  if (partial !== null) return partial;
  if (import.meta.env.DEV) missing.add(core);
  return null;
}

// ---------------- DOM 감시 ----------------

/** 글자 노드: 원문 · 마지막으로 넣은 번역 */
const textSrc = new WeakMap<Text, { src: string; out: string }>();
/** 속성: 요소 → 속성 이름 → 원문 · 번역 */
const attrSrc = new WeakMap<Element, Map<string, { src: string; out: string }>>();

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    const tag = e.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SCRIPT' || tag === 'STYLE') return true;
    if ((e as HTMLElement).dataset?.i18nSkip !== undefined) return true;
  }
  return false;
}

function doText(node: Text): void {
  const data = node.data;
  const rec = textSrc.get(node);
  // 우리가 넣은 번역이 그대로면 원문 유지, 아니면 화면 코드가 새로 쓴 원문
  const src = rec && rec.out === data ? rec.src : data;
  if (!HANGUL.test(src) && !rec) return;
  if (skipped(node.parentElement)) return;
  const out = t(src);
  if (out !== data) node.data = out;
  textSrc.set(node, { src, out });
}

function doAttrs(el: Element): void {
  for (const name of ATTRS) {
    const v = el.getAttribute(name);
    if (v === null) continue;
    let map = attrSrc.get(el);
    const rec = map?.get(name);
    const src = rec && rec.out === v ? rec.src : v;
    if (!HANGUL.test(src) && !rec) continue;
    const out = t(src);
    if (out !== v) el.setAttribute(name, out);
    if (!map) attrSrc.set(el, (map = new Map()));
    map.set(name, { src, out });
  }
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    doAttrs(el);
    return;
  }
  doAttrs(el);
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text);
    else doAttrs(n as Element);
  }
}

/** 화면 번역 시작 (한 번). 언어가 바뀌면 전체를 다시 */
export function installTranslator(root: HTMLElement = document.body): void {
  document.documentElement.lang = getLang();
  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') doText(m.target as Text);
      else if (m.type === 'attributes') doAttrs(m.target as Element);
      else for (const n of m.addedNodes) walk(n);
    }
  });
  obs.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  walk(root);
  onLangChange(() => walk(root));
  if (import.meta.env.DEV) (window as unknown as { __i18nMissing: () => string[] }).__i18nMissing = () => [...missing];
}

// 세로로 든 터치 기기에서도 가로형 화면: 게임 전체(#app)를 90° 돌려 그림 (회전 안내 없이 바로 플레이).
// - #app 크기를 가로·세로 바꿔 놓고(인라인 스타일) 시계 방향 90° 회전 → 렌더러·UI는 그대로 가로 화면으로 동작
// - CSS의 화면 크기 기준(미디어 쿼리 width/height, vw/vh 단위)은 실제 화면(세로) 기준이라 회전 중에는 서로 바꿔 둠
//   (스타일시트 규칙을 실행 중에 고쳤다가 회전이 풀리면 원래대로)
// - 터치 좌표(clientX/Y)는 화면 기준이라 게임 화면 좌표로 바꿔 써야 함 → toGame / gameDelta / viewW·viewH
const CLASS = 'pop-rotated';

let rotated = false;
let app: HTMLElement | null = null;
/** 고친 규칙의 원래 값 (회전이 풀리면 되돌림) */
const savedMedia = new Map<CSSMediaRule, string>();
const savedStyle = new Map<CSSStyleDeclaration, Map<string, [string, string]>>();
/** 이미 바꾼 스타일시트 (늦게 불러온 시트도 한 번만) */
let doneSheets = new WeakSet<CSSStyleSheet>();

/** 지금 돌려서 그리는 중인지 */
export function isRotated(): boolean {
  return rotated;
}

/** 게임 화면 너비·높이 (돌려 그리면 실제 화면과 반대) */
export function viewW(): number {
  return rotated ? innerHeight : innerWidth;
}
export function viewH(): number {
  return rotated ? innerWidth : innerHeight;
}

/** 화면 좌표(clientX/Y) → 게임 화면 좌표 */
export function toGame(x: number, y: number): { x: number; y: number } {
  return rotated ? { x: y, y: innerWidth - x } : { x, y };
}

/** 화면에서 움직인 양 → 게임 화면에서 움직인 양 (드래그·시점 회전) */
export function gameDelta(dx: number, dy: number): { x: number; y: number } {
  return rotated ? { x: dy, y: -dx } : { x: dx, y: dy };
}

/** 회전 감시 시작 (터치 기기 + 세로일 때만 돌림). 바뀌면 onChange */
export function installScreenRotation(root: HTMLElement, onChange?: () => void): void {
  app = root;
  const coarse = matchMedia('(pointer: coarse)');
  const check = () => {
    const want = coarse.matches && innerHeight > innerWidth;
    if (want !== rotated) {
      apply(want);
      onChange?.();
    } else if (rotated) {
      sizeApp();
    }
  };
  addEventListener('resize', check);
  // 늦게 불러온 스타일시트(배포 빌드 CSS 파일 등)도 돌린 상태면 바꿔 둠
  addEventListener('load', () => rotated && swapSheets());
  addEventListener('orientationchange', check);
  coarse.addEventListener('change', check);
  check();
}

function sizeApp(): void {
  if (!app) return;
  const s = app.style;
  if (rotated) {
    s.position = 'fixed';
    s.left = '0';
    s.top = '0';
    s.width = `${innerHeight}px`;
    s.height = `${innerWidth}px`;
    s.transformOrigin = '0 0';
    s.transform = `translateX(${innerWidth}px) rotate(90deg)`;
  } else {
    for (const k of ['position', 'left', 'top', 'width', 'height', 'transformOrigin', 'transform'] as const) s[k] = '';
  }
}

function apply(on: boolean): void {
  rotated = on;
  document.documentElement.classList.toggle(CLASS, on);
  if (on) {
    swapSheets();
  } else {
    for (const [rule, text] of savedMedia) rule.media.mediaText = text;
    for (const [style, props] of savedStyle) for (const [name, [value, prio]] of props) style.setProperty(name, value, prio);
    savedMedia.clear();
    savedStyle.clear();
    doneSheets = new WeakSet();
  }
  sizeApp();
}

function swapSheets(): void {
  for (const sheet of [...document.styleSheets]) {
    if (doneSheets.has(sheet)) continue;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 다른 출처 스타일시트는 읽을 수 없음
    }
    doneSheets.add(sheet);
    swapRules(rules);
  }
}

/** 규칙 안의 화면 크기 기준을 가로·세로 바꿈 (미디어 쿼리 안쪽 규칙까지) */
function swapRules(rules: CSSRuleList): void {
  for (const rule of [...rules]) {
    if (rule instanceof CSSMediaRule) {
      const text = rule.media.mediaText;
      const next = swapMedia(text);
      if (next !== text) {
        savedMedia.set(rule, text);
        rule.media.mediaText = next;
      }
      swapRules(rule.cssRules);
    } else if (rule instanceof CSSStyleRule) {
      swapStyle(rule.style);
      if (rule.cssRules?.length) swapRules(rule.cssRules);
    } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
      swapRules((rule as CSSGroupingRule).cssRules);
    }
  }
}

function swapMedia(text: string): string {
  return text
    .replace(/(min|max)-(width|height)/g, (_, m: string, d: string) => `${m}-${d === 'width' ? 'h_' : 'w_'}`)
    .replace(/(min|max)-w_/g, '$1-width')
    .replace(/(min|max)-h_/g, '$1-height')
    .replace(/orientation:\s*(portrait|landscape)/g, (_, o: string) => `orientation: ${o === 'portrait' ? 'landscape' : 'portrait'}`);
}

const UNIT = /(\d*\.?\d+)(vw|vh)\b/g;

function swapStyle(style: CSSStyleDeclaration): void {
  for (let i = 0; i < style.length; i++) {
    const name = style[i]!;
    const value = style.getPropertyValue(name);
    if (!/\d(vw|vh)\b/.test(value)) continue;
    const prio = style.getPropertyPriority(name);
    let props = savedStyle.get(style);
    if (!props) savedStyle.set(style, (props = new Map()));
    if (!props.has(name)) props.set(name, [value, prio]);
    style.setProperty(name, value.replace(UNIT, (_, n: string, u: string) => `${n}${u === 'vw' ? 'vh' : 'vw'}`), prio);
  }
}

// 임시: 갤럭시 멀티터치 시점 튐 원인 조사용 터치 기록 (원인을 찾으면 이 파일과 ui/lobby/touchLogUi.ts를 지움).
// 켜는 법: 주소 ?touchlog=1, 또는 설정(모바일 터치) > '터치 기록 (임시)' 스위치 (이 기기에 기억).
// 꺼져 있으면 기록 함수는 바로 돌아감. 켜져 있으면 터치·포인터 이벤트를 최근 N줄만 메모리에 남김 (전송 없음).
import { isRotated } from './screenRotation';

const KEY = 'popbattle.touchlog';
const MAX_LINES = 900;
/** 한 이벤트의 시점 이동량(px, 감도 곱하기 전)이 이보다 크면 튐으로 표시 */
const JUMP_PX = 80;

function fromUrl(): boolean {
  try {
    return new URLSearchParams(location.search).get('touchlog') === '1';
  } catch {
    return false;
  }
}

function fromStorage(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

const lines: string[] = [];
const jumps: number[] = [];
let seq = 0;
let t0 = 0;
let enabled = fromUrl() || fromStorage();

export function touchLogEnabled(): boolean {
  return enabled;
}

export function setTouchLogEnabled(on: boolean): void {
  enabled = on || fromUrl();
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // 저장 못 해도 이번에는 적용
  }
}

export function clearTouchLog(): void {
  lines.length = 0;
  jumps.length = 0;
}

function push(line: string): void {
  if (!t0) t0 = performance.now();
  const t = Math.round(performance.now() - t0);
  lines.push(`${++seq} ${t} ${line}`);
  if (lines.length > MAX_LINES) lines.shift();
}

function list(touches: TouchList): string {
  let s = '';
  for (const t of touches) s += `${s ? ' ' : ''}${t.identifier}@${Math.round(t.clientX)},${Math.round(t.clientY)}`;
  return s;
}

/** 터치 이벤트 하나 (처리한 뒤의 역할·이동량과 함께) */
export function logTouch(
  e: TouchEvent,
  roles: { move: number | null; look: number | null; fire: number | null },
  look: { dx: number; dy: number },
  stick: { x: number; y: number },
): void {
  if (!enabled) return;
  const type = e.type.replace('touch', 'T');
  let target = '';
  if (e.type === 'touchstart') {
    const el = e.changedTouches[0]?.target;
    target = el instanceof Element ? ` tgt=${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(' ')[0]}` : '';
  }
  const r = `m${roles.move ?? '-'} l${roles.look ?? '-'} f${roles.fire ?? '-'}`;
  const d = look.dx || look.dy ? ` d=${look.dx.toFixed(1)},${look.dy.toFixed(1)}` : '';
  const jump = Math.hypot(look.dx, look.dy) > JUMP_PX;
  push(`${type} c[${list(e.changedTouches)}] a[${list(e.touches)}]${target} -> ${r}${d} stick=${stick.x.toFixed(2)},${stick.y.toFixed(2)}${jump ? ' !!JUMP' : ''}`);
  if (jump) jumps.push(seq);
}

/** 포인터 이벤트 (버튼 누름 경로와 손가락 번호 비교용) */
export function logPointer(e: PointerEvent): void {
  if (!enabled || e.pointerType === 'mouse') return;
  push(`P${e.type.replace('pointer', '')} id${e.pointerId}${e.isPrimary ? '*' : ''} ${Math.round(e.clientX)},${Math.round(e.clientY)}`);
}

export function logNote(text: string): void {
  if (enabled) push(`# ${text}`);
}

/** 복사용 글: 기기 정보 + 튐 위치 + 최근 기록 */
export function touchLogText(): string {
  const head = [
    `POP BATTLE touchlog ${new Date().toISOString()}`,
    `ua ${navigator.userAgent}`,
    `view ${innerWidth}x${innerHeight} dpr ${devicePixelRatio} rotated ${isRotated()} screen ${screen.width}x${screen.height} ${screen.orientation?.type ?? ''}`,
    `jumps ${jumps.length ? jumps.join(',') : 'none'} (line no.)`,
    'format: no ms type c[changed id@x,y] a[all touches] -> m(move id) l(look id) f(fire id) d=look px stick=x,y',
  ];
  return [...head, ...lines].join('\n');
}

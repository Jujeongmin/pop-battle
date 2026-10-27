// 임시: 터치 기록 스위치·보기 창 (core/touchLog.ts와 함께, 원인을 찾으면 지움).
// 설정(모바일 터치)과 일시정지 메뉴 설정에 붙음. 보기 창에서 글을 복사해 전달.
import { clearTouchLog, setTouchLogEnabled, touchLogEnabled, touchLogText } from '../../core/touchLog';
import { button, el, slider } from './lobbyDom';

export function touchLogControls(): HTMLElement {
  const box = el('div', 'lb-touchlog');
  box.append(
    slider({
      label: '터치 기록 (임시)',
      min: 0,
      max: 1,
      step: 1,
      toggle: true,
      get: () => (touchLogEnabled() ? 1 : 0),
      set: (v) => setTouchLogEnabled(v >= 0.5),
      format: (v) => (v >= 0.5 ? '켬' : '끔'),
    }),
    button('기록 보기', 'lb-touchlog-open', openTouchLogView),
  );
  return box;
}

function openTouchLogView(): void {
  const layer = el('div', 'lb-touchlog-view');
  // 이 창의 터치·클릭이 게임 조작으로 넘어가지 않게
  for (const t of ['pointerdown', 'mousedown', 'touchstart', 'touchmove', 'touchend', 'click', 'keydown'] as const) {
    layer.addEventListener(t, (e) => e.stopPropagation());
  }
  const text = el('textarea', 'lb-touchlog-text');
  text.readOnly = true;
  text.value = touchLogText();
  const status = el('span', 'lb-touchlog-status');
  const copy = button('복사', 'lb-touchlog-btn', () => {
    text.focus();
    text.select();
    const done = (ok: boolean) => (status.textContent = ok ? '복사했어요' : '글을 길게 눌러 전체 선택 후 복사해 주세요');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text.value).then(() => done(true), () => done(document.execCommand('copy')));
    else done(document.execCommand('copy'));
  });
  const clear = button('지우기', 'lb-touchlog-btn', () => {
    clearTouchLog();
    text.value = touchLogText();
    status.textContent = '';
  });
  const close = button('닫기', 'lb-touchlog-btn', () => layer.remove());
  const bar = el('div', 'lb-touchlog-bar');
  bar.append(copy, clear, close, status);
  layer.append(bar, text);
  document.body.append(layer);
}

// UI 진단 (배포·에디터 환경에서도 동작): 로컬과 Verse8 에디터의 화면이 다를 때 원인을 찾기 위한 정보.
// Ctrl+Alt+U로 화면에 표시 (다시 누르면 닫힘), 콘솔에서는 __uiDebug(). 게임 상태는 바꾸지 않음.
// 확인 항목: 빌드 시각, 실제 뷰포트·컨테이너 크기, 배율, 로비 CSS가 끝까지 적용됐는지(앞·뒤 규칙 표본), 메뉴 계산 스타일, 적용 중인 미디어 쿼리.
declare const __BUILD_TIME__: string;

/** lobby.css 앞부분(옛 규칙)·뒷부분(최신 규칙)에서 하나씩 고른 선택자: 뒤쪽이 없으면 CSS가 일부만 적용된 것 */
const PROBE_SELECTORS = ['.lb-lobby', '.lb-nav-brand', '.lb-identity', '.lb-presence-retry', '.lb-return-button', '.lb-room-status', '.lobby-nametag'];
const MEDIA = ['(max-width: 1000px)', '(max-width: 900px)', '(max-width: 760px)', '(max-width: 720px)', '(max-height: 520px)', '(hover: hover)', '(hover: none) and (pointer: coarse)'];

export function uiDebugInfo(container: HTMLElement): Record<string, unknown> {
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  };
  const sheets = [...document.styleSheets].map((s) => {
    let rules = -1;
    let found: string[] = [];
    try {
      const list = [...s.cssRules];
      rules = list.length;
      const text = list.map((r) => r.cssText).join('\n');
      found = PROBE_SELECTORS.filter((sel) => text.includes(sel));
    } catch {
      // 다른 출처 CSS는 규칙을 읽을 수 없음
    }
    const owner = s.ownerNode as HTMLElement | null;
    return { href: s.href ?? owner?.getAttribute('data-vite-dev-id') ?? owner?.tagName ?? 'inline', rules, has: found };
  });
  const nav = document.querySelector('.lb-nav');
  const cs = nav ? getComputedStyle(nav) : null;
  const lobby = document.querySelector('.lb-lobby');
  return {
    build: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'unknown',
    location: location.origin + location.pathname,
    inIframe: window.self !== window.top,
    viewport: { inner: [innerWidth, innerHeight], client: [document.documentElement.clientWidth, document.documentElement.clientHeight], visual: visualViewport ? [Math.round(visualViewport.width), Math.round(visualViewport.height), visualViewport.scale] : null, dpr: devicePixelRatio },
    container: rect(container),
    lobbyRoot: rect(lobby),
    lobbyScale: lobby ? getComputedStyle(lobby).getPropertyValue('--lu').trim() : null,
    touchMode: container.classList.contains('touch-mode'),
    media: MEDIA.filter((m) => matchMedia(m).matches),
    nav: cs ? { display: cs.display, flexDirection: cs.flexDirection, position: cs.position, top: cs.top, rect: rect(nav) } : null,
    brand: rect(document.querySelector('.lb-nav-brand')),
    identity: rect(document.querySelector('.lb-identity')),
    menuButton: rect(document.querySelector('.lb-menu-button')),
    stylesheets: sheets,
  };
}

/** Ctrl+Alt+U 화면 표시 (텍스트만, 복사 가능) */
export function installUiDebug(container: HTMLElement): void {
  let box: HTMLPreElement | null = null;
  Object.assign(window, { __uiDebug: () => uiDebugInfo(container) });
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.altKey && e.code === 'KeyU')) return;
    e.preventDefault();
    if (box) {
      box.remove();
      box = null;
      return;
    }
    box = document.createElement('pre');
    box.textContent = JSON.stringify(uiDebugInfo(container), null, 1);
    Object.assign(box.style, {
      position: 'absolute', left: '8px', bottom: '8px', zIndex: '99', maxWidth: 'min(560px, 94vw)', maxHeight: '70vh', overflow: 'auto',
      margin: '0', padding: '8px 10px', background: 'rgba(20,24,40,.88)', color: '#e8f0ff', font: '11px/1.35 monospace', borderRadius: '8px', whiteSpace: 'pre-wrap', userSelect: 'text',
    });
    container.appendChild(box);
  });
}

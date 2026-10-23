// 확장 화면 추천 (처음 매치에 들어갈 때 한 번, PC): Verse8 일반 화면은 바깥 머리·옆 메뉴 때문에 게임 영역이 작음.
// "확장 화면으로 플레이" / "이대로 시작" 중 고르면 기억 (이 기기). 고른 버튼 클릭(사용자 동작) 안에서 바로 이어서 시작 →
// 전체 화면·포인터 잠금이 브라우저에 막히지 않음. 터치 기기·이미 전체 화면·전체 화면을 못 쓰는 환경이면 묻지 않고 바로 시작.
import { trapFocus } from './lobby/lobbyDom';

const KEY = 'popbattle.fullscreen';

function saved(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function save(v: 'yes' | 'no'): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // 저장 못 해도 이번에는 그대로
  }
}

/** 작은 화면(바깥 메뉴에 가려진 일반 보기)인지 */
function smallView(): boolean {
  return innerWidth < 1280 || innerHeight < 760;
}

/**
 * 필요하면 확장 화면을 추천한 뒤 then 실행 (then은 버튼 클릭 안에서 동기로 불림).
 * 'yes'를 고른 적 있으면 묻지 않고 확장 화면 시도 후 시작
 */
export function withFullscreenOffer(parent: HTMLElement, touch: boolean, then: () => void): void {
  const can = document.fullscreenEnabled && !document.fullscreenElement && !touch;
  const choice = saved();
  if (!can || choice === 'no' || (choice === null && !smallView())) {
    then();
    return;
  }
  if (choice === 'yes') {
    void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
    then();
    return;
  }
  const box = document.createElement('div');
  box.className = 'fs-offer';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'fs-offer-title');
  const card = document.createElement('div');
  card.className = 'fs-offer-card';
  const title = document.createElement('h2');
  title.id = 'fs-offer-title';
  title.tabIndex = -1;
  title.textContent = '확장 화면으로 플레이할까요?';
  const desc = document.createElement('p');
  desc.textContent = '게임 화면이 더 넓어져 조준과 시야가 편해요. 고른 방식은 기억해 둘게요.';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'fs-offer-yes';
  yes.textContent = '확장 화면으로 플레이';
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'fs-offer-no';
  no.textContent = '이대로 시작';
  const row = document.createElement('div');
  row.className = 'fs-offer-row';
  row.append(yes, no);
  card.append(title, desc, row);
  box.append(card);
  const stop = new AbortController();
  const close = () => {
    stop.abort();
    box.remove();
  };
  for (const t of ['pointerdown', 'mousedown', 'click', 'keydown', 'keyup', 'wheel'] as const) box.addEventListener(t, (e) => e.stopPropagation(), { signal: stop.signal });
  yes.addEventListener('click', () => {
    save('yes');
    close();
    void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
    then();
  });
  no.addEventListener('click', () => {
    save('no');
    close();
    then();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') no.click();
  });
  trapFocus(box, stop.signal);
  parent.append(box);
  title.focus();
}

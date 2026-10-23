// 확장 화면 묻기 (처음 매치에 들어갈 때 한 번, PC): Verse8 일반 화면은 바깥 머리·옆 메뉴 때문에 게임 영역이 작음.
// "확장 화면으로 플레이" / "이대로 시작" 중 고르면 기억 (이 기기) → 이후엔 묻지 않고, 설정(일반 > 화면)에서 바꿈.
// 실제 상태가 저장값보다 우선: 이미 확장돼 있으면(게임 안 전체 화면, 또는 Verse8 바깥 확장 버튼으로 게임 창이 화면 거의 전체)
// 묻지 않고, 설정 스위치도 실제 상태를 보여 줌. Verse8은 확장 상태를 알려 주는 API·메시지가 없어(SDK·문서 확인) 게임 창 크기로 판단.
// 고른 버튼 클릭(사용자 동작) 안에서 바로 이어서 시작 → 전체 화면·포인터 잠금이 브라우저에 막히지 않음.
// 터치 기기·이미 전체 화면·전체 화면을 못 쓰는 환경이면 묻지 않고 바로 시작.
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

/** 이 환경에서 확장(전체) 화면을 쓸 수 있는지 (Verse8 iframe이 허용하지 않으면 false) */
export function fullscreenAvailable(): boolean {
  return document.fullscreenEnabled;
}

/** 바깥(Verse8 확장 버튼·최대화 창)이 게임 창을 화면 거의 전체로 키운 상태 */
function outerExpanded(): boolean {
  const sw = screen.availWidth || screen.width;
  const sh = screen.availHeight || screen.height;
  return sw > 0 && sh > 0 && innerWidth >= sw * 0.92 && innerHeight >= sh * 0.85;
}

/** 실제 확장 상태 (저장값이 아니라 지금 화면): 게임 안 전체 화면이거나 바깥이 게임 창을 크게 키움 */
export function isExpanded(): boolean {
  return !!document.fullscreenElement || outerExpanded();
}

/** 확장 상태가 바뀌면 cb (전체 화면 전환·창 크기 변화). 해제 함수 반환 */
export function onExpandChange(cb: (expanded: boolean) => void): () => void {
  let last = isExpanded();
  const check = () => {
    const now = isExpanded();
    if (now !== last) {
      last = now;
      cb(now);
    }
  };
  document.addEventListener('fullscreenchange', check);
  window.addEventListener('resize', check);
  return () => {
    document.removeEventListener('fullscreenchange', check);
    window.removeEventListener('resize', check);
  };
}

/**
 * 설정·안내 화면에서 확장 켜기/끄기 (버튼 클릭 안에서 불림). 고른 값은 기억, 결과 안내 문구 반환 (성공·이미 그 상태면 빈 문자열).
 * 바깥(Verse8)이 확장한 상태는 게임이 되돌릴 수 없음 → 안내만
 */
export async function setExpanded(on: boolean): Promise<string> {
  save(on ? 'yes' : 'no');
  if (on) {
    if (isExpanded()) return '';
    if (!document.fullscreenEnabled) return '이 화면에서는 게임이 확장 화면을 열 수 없어요. Verse8 화면의 확장 버튼을 눌러 주세요.';
    // 거부(reject)뿐 아니라 응답 없이 멈추는 환경도 있음 → 1.5초 안에 확장되지 않으면 안내
    const asked = document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(
      () => true,
      () => false,
    );
    const ok = await Promise.race([asked, new Promise<boolean>((r) => window.setTimeout(() => r(false), 1500))]);
    return ok || isExpanded() ? '' : '확장 화면이 열리지 않았어요(브라우저가 거부). Verse8 화면의 확장 버튼을 눌러 주세요.';
  }
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => undefined);
    return '';
  }
  return outerExpanded() ? '바깥 화면이 확장돼 있어요. Verse8 화면의 확장 해제 버튼으로 돌아갈 수 있어요.' : '';
}

/**
 * 필요하면 확장 화면을 추천한 뒤 then 실행 (then은 버튼 클릭 안에서 동기로 불림).
 * 'yes'를 고른 적 있으면 묻지 않고 확장 화면 시도 후 시작
 */
export function withFullscreenOffer(parent: HTMLElement, touch: boolean, then: () => void): void {
  // 이미 확장 상태(바깥 확장 포함)면 묻지도 요청하지도 않음 — 실제 상태 우선
  const can = document.fullscreenEnabled && !isExpanded() && !touch;
  const choice = saved();
  if (!can || choice === 'no') {
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
  desc.textContent = '게임 화면이 더 넓어져 조준과 시야가 편해요. 고른 방식은 기억해 두고, 설정 > 일반에서 언제든 바꿀 수 있어요.';
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

// 매치 일시정지 메뉴: 매치 중 조작(포인터 잠금·터치 조작)을 놓쳤을 때 게임이 연다 (ESC·터치 ‖).
// 계속하기 · 설정(로비 설정과 같은 슬라이더) · 조작 안내(PC·터치 구분) · 매치 나가기(확인 뒤).
// 메뉴는 열고 닫기만 요청받고, 실제 상태(연습전 정지·멀티 계속 진행)는 게임이 정한다 (PauseHost).
import './pause.css';
// Kenney UI 스킨: 로비·방·일시정지 CSS 모두 뒤에 와야 함 (Game 모듈 import 순서상 이 파일이 마지막)
import './kenney.css';
import './screens.css';
// 메인 로비 파스텔 스킨 (마지막 층, 로고·프로필·상단 메뉴·방 목록)
import './pastel.css';
import { button, el, slider, type PauseHost, type PauseLockInfo, trapFocus } from './lobbyDom';

/** lock = 마우스 고정 안내 (매치 시작 직후·브라우저가 고정을 거부했을 때, 일반 일시정지와 구분) */
type View = 'main' | 'settings' | 'controls' | 'lock';

/** 조작 안내 (코드 기준: core/Input.ts·TouchInput.ts, 개발 키 제외) */
const PC_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['WASD', '이동'],
  ['W 두 번 + 유지', '달리기'],
  ['SPACE', '점프'],
  ['SHIFT', '슬라이딩'],
  ['마우스', '시점'],
  ['왼쪽 클릭', '사격'],
  ['오른쪽 클릭', '조준(ADS) 켜기/끄기'],
  ['R', '재장전'],
  ['1 · 2 · 3', '주무기 · 권총 · 뿅망치'],
  ['마우스 휠', '무기 바꾸기'],
  ['ESC', '메뉴'],
];
const TOUCH_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['왼쪽 화면 드래그', '조이스틱 이동 (앞으로 계속 밀면 달리기)'],
  ['오른쪽 화면 드래그', '시점'],
  ['사격 버튼', '사격 (누른 채 끌면 시점도 회전)'],
  ['ADS 버튼', '조준 켜기/끄기'],
  ['점프 · 슬라이딩', '버튼'],
  ['재장전', '버튼'],
  ['아래 무기 칸', '터치해서 무기 바꾸기'],
  ['왼쪽 위 ‖', '메뉴'],
];

export class PauseMenu {
  private readonly root = el('div', 'lb-pause');
  private readonly card = el('section', 'lb-pause-card');
  private readonly body = el('div', 'lb-pause-body');
  private readonly confirmBox = el('div', 'lb-pause-confirm');
  private readonly abort = new AbortController();
  private open = false;
  private view: View = 'main';
  private leaving = false;
  private hideTimer: number | null = null;
  /** 일시정지 이유 한 줄 (창을 벗어남 등, 없으면 빈 문자열) */
  private note = '';
  private lockInfo: PauseLockInfo = { errors: 0, suggestFullscreen: false, blocked: false };

  constructor(
    container: HTMLElement,
    private readonly host: PauseHost,
  ) {
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', '일시정지');
    this.root.hidden = true;
    // 메뉴 위의 입력은 게임 캔버스·터치 레이어·로비 단축키로 내려가지 않게
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'wheel', 'contextmenu'] as const) {
      this.root.addEventListener(type, (e) => e.stopPropagation(), { signal: this.abort.signal });
    }
    for (const type of ['keydown', 'keyup'] as const) {
      this.root.addEventListener(type, (e) => e.stopPropagation(), { signal: this.abort.signal });
    }
    // ESC: 확인 창만 닫음 (브라우저는 ESC 처리 안의 포인터 잠금을 거부 → 계속하기는 버튼으로만)
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.open || e.key !== 'Escape') return;
        e.preventDefault();
        if (!this.confirmBox.hidden && !this.leaving) this.closeConfirm();
        else if (this.view !== 'main') this.go('main');
      },
      { capture: true, signal: this.abort.signal },
    );
    this.confirmBox.hidden = true;
    this.card.append(this.body, this.confirmBox);
    const backdrop = el('div', 'lb-pause-backdrop');
    // 마우스 고정 안내: "게임 화면을 클릭" → 뒤 화면 아무 곳 클릭도 다시 시도 (클릭 안에서 요청)
    backdrop.addEventListener('click', () => {
      if (this.open && this.view === 'lock') this.host.resume();
    }, { signal: this.abort.signal });
    this.root.append(backdrop, this.card);
    // 열린 동안 Tab은 메뉴 안에서만
    trapFocus(this.card, this.abort.signal);
    container.appendChild(this.root);
  }

  get visible(): boolean {
    return this.open;
  }

  /**
   * 열기 (게임이 조작을 놓친 걸 알았을 때). kind: pause = 일시정지(ESC·창 벗어남, note에 이유), lock = 마우스 고정 안내
   */
  show(kind: 'pause' | 'lock' = 'pause', note = ''): void {
    if (this.open) return;
    this.open = true;
    this.leaving = false;
    this.note = note;
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.closeConfirm();
    this.go(kind === 'lock' ? 'lock' : 'main');
    this.root.hidden = false;
    this.root.classList.remove('lb-pause-closing');
    // 다음 프레임에 열림 애니메이션
    requestAnimationFrame(() => this.root.classList.add('lb-pause-open'));
  }

  /** 닫기 (조작이 돌아왔거나 로비로 나감, host는 부르지 않음) */
  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('lb-pause-open');
    this.root.classList.add('lb-pause-closing');
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      if (!this.open) this.root.hidden = true;
    }, 140);
  }

  /** 마우스 고정 안내로 바꾸거나 내용 갱신 (열려 있을 때만, 같은 화면이면 다시 그리기만 → 깜빡임·반복 열림 없음) */
  showLock(info: PauseLockInfo): void {
    this.lockInfo = info;
    if (!this.open) return;
    if (!this.confirmBox.hidden) return;
    this.go('lock');
  }

  get lockView(): boolean {
    return this.open && this.view === 'lock';
  }

  dispose(): void {
    this.abort.abort();
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.root.remove();
  }

  // ---------------- 화면 ----------------

  private go(view: View): void {
    this.view = view;
    this.body.textContent = '';
    this.root.classList.toggle('lb-pause-lockview', view === 'lock');
    this.root.setAttribute('aria-label', view === 'lock' ? '마우스 고정 안내' : '일시정지');
    if (view === 'lock') return this.drawLock();
    this.body.append(this.header(view));
    if (view === 'main') this.drawMain();
    else if (view === 'settings') this.drawSettings();
    else this.drawControls();
  }

  private header(view: View): HTMLElement {
    const head = el('header', 'lb-pause-head');
    if (view !== 'main') {
      const back = button('', 'lb-pause-back', () => this.go('main'), '<span aria-hidden="true">‹</span>');
      back.setAttribute('aria-label', '뒤로');
      head.append(back);
    }
    const titles = el('div', 'lb-pause-titles');
    titles.append(
      el('h2', 'lb-pause-title', view === 'main' ? '일시정지' : view === 'settings' ? '설정' : '조작 안내'),
      el('span', 'lb-pause-label', this.host.matchLabel()),
    );
    head.append(titles);
    return head;
  }

  /** 마우스 고정 안내: 제목·설명 · 게임 화면 활성화(클릭 안에서 잠금 요청) · 로비로 · (임베드에서 계속 거부되면) 확장 화면 */
  private drawLock(): void {
    const head = el('header', 'lb-pause-head');
    const titles = el('div', 'lb-pause-titles');
    titles.append(el('h2', 'lb-pause-title lb-pause-lock-title', '게임 화면을 클릭해 조준을 시작하세요'), el('span', 'lb-pause-label', this.host.matchLabel()));
    head.append(el('span', 'lb-pause-lock-icon', '◎'), titles);
    this.body.append(head, el('p', 'lb-pause-lock-desc', '마우스가 게임 화면에 고정되어야 시점을 움직일 수 있어요.'));
    const { errors, suggestFullscreen, blocked } = this.lockInfo;
    if (blocked) {
      this.body.append(el('p', 'lb-pause-lock-error', '지금 게임 창은 웹페이지 설정상 마우스 고정이 허용되지 않아요. 확장 화면이나 게임 페이지를 직접 열면 조준할 수 있어요.'));
    } else if (errors > 0) {
      const why = suggestFullscreen
        ? '브라우저가 마우스 고정을 계속 거부했어요. 이 화면(웹페이지 안 게임 창)에서는 막혀 있을 수 있어요 — 확장 화면에서는 대부분 돼요.'
        : '브라우저가 마우스 고정을 거부했어요. ESC를 누른 직후라면 1초 뒤 다시 눌러 주세요.';
      this.body.append(el('p', 'lb-pause-lock-error', why));
    }
    if (this.host.multiplayer()) this.body.append(el('p', 'lb-pause-note', '멀티플레이는 기다리는 동안에도 계속 진행돼요'));
    const go = button('게임 화면 활성화', 'lb-pause-resume', () => this.host.resume());
    const row = el('div', 'lb-pause-list');
    if (suggestFullscreen) row.append(button('확장 화면으로 전환', 'lb-pause-item', () => this.host.fullscreen()));
    row.append(button('로비로 돌아가기', 'lb-pause-item lb-pause-leave', () => this.openConfirm()));
    this.body.append(go, row);
    requestAnimationFrame(() => {
      if (this.open && this.view === 'lock') go.focus({ preventScroll: true });
    });
  }

  private drawMain(): void {
    if (this.note) this.body.append(el('p', 'lb-pause-note lb-pause-reason', this.note));
    if (this.host.multiplayer()) {
      this.body.append(el('p', 'lb-pause-note', '멀티플레이 중에는 게임이 멈추지 않아요 · 다른 플레이어와 시간은 계속 진행돼요'));
    }
    // 계속하기: 클릭 처리 안에서 바로 요청 (포인터 잠금·터치 조작은 사용자 동작 안에서만 됨). 닫기는 게임이 조작이 돌아온 걸 보고
    const resume = button('계속하기', 'lb-pause-resume', () => this.host.resume());
    const list = el('div', 'lb-pause-list');
    list.append(
      button('설정', 'lb-pause-item', () => this.go('settings')),
      button('조작 안내', 'lb-pause-item', () => this.go('controls')),
      button('매치 나가기', 'lb-pause-item lb-pause-leave', () => this.openConfirm()),
    );
    this.body.append(resume, list);
    requestAnimationFrame(() => {
      if (this.open && this.view === 'main') resume.focus({ preventScroll: true });
    });
  }

  private drawSettings(): void {
    const s = this.host.settings();
    const box = el('div', 'lb-pause-scroll');
    box.append(el('div', 'lb-section', '사운드'));
    for (const x of s.sound) box.append(slider(x));
    if (this.host.touch()) {
      box.append(el('div', 'lb-section', '모바일 터치'));
      for (const x of s.touch) box.append(slider(x));
    } else {
      box.append(el('div', 'lb-section', '조작 (PC)'));
      for (const x of s.controls) box.append(slider(x));
    }
    this.body.append(box);
  }

  private drawControls(): void {
    const box = el('div', 'lb-pause-scroll');
    const list = el('dl', 'lb-pause-keys');
    for (const [key, action] of this.host.touch() ? TOUCH_CONTROLS : PC_CONTROLS) {
      list.append(el('dt', '', key), el('dd', '', action));
    }
    box.append(list);
    this.body.append(box);
  }

  // ---------------- 매치 나가기 확인 ----------------

  private openConfirm(): void {
    this.confirmBox.textContent = '';
    const text = el('div', 'lb-pause-confirm-text');
    text.append(el('b', '', '매치에서 나갈까요?'), el('p', '', '진행 중인 매치에서 나가요.'));
    if (this.host.multiplayer()) text.append(el('p', '', '나가면 이번 매치에는 다시 들어올 수 없어요.'));
    const row = el('div', 'lb-pause-confirm-row');
    const cancel = button('취소', 'lb-pause-cancel', () => this.closeConfirm());
    const leave = button('나가기', 'lb-pause-confirm-leave', () => {
      if (this.leaving) return;
      this.leaving = true;
      leave.disabled = true;
      cancel.disabled = true;
      leave.textContent = '나가는 중…';
      void this.host.leaveMatch().finally(() => {
        this.leaving = false;
        // 로비로 돌아가면 게임이 hide() — 실패로 남아 있으면 다시 누를 수 있게
        if (this.open) {
          leave.disabled = false;
          cancel.disabled = false;
          leave.textContent = '나가기';
        }
      });
    });
    row.append(cancel, leave);
    this.confirmBox.append(text, row);
    this.confirmBox.hidden = false;
    this.card.classList.add('lb-pause-confirming');
    requestAnimationFrame(() => cancel.focus({ preventScroll: true }));
  }

  private closeConfirm(): void {
    this.confirmBox.hidden = true;
    this.card.classList.remove('lb-pause-confirming');
  }
}

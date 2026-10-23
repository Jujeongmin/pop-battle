// 모바일 터치 조작 (가로 화면). KeyboardMouseInput과 같은 InputState를 채우고, 게임 로직(이동·사격·ADS·달리기)은 그대로 공유한다.
// - 왼쪽 영역: 떠다니는 가상 조이스틱 (아날로그, moveSource = 'joystick' → Game의 JoystickAutoSprint가 달리기 판정)
// - 오른쪽 빈 영역: 드래그로 시점 회전 (사격 버튼을 누른 채 끌어도 회전)
// - 오른쪽 아래 버튼: 사격(누르는 동안) · ADS 토글 · 점프 · 슬라이딩 · 재장전 / 왼쪽 위: 일시정지
// 손가락마다 pointerId로 역할을 나눠 서로 취소하지 않음 (이동하며 회전·사격·점프 동시에).
import { createInputState } from './Input';
import { toGame, viewH, viewW } from './screenRotation';

export interface TouchSettings {
  /** 시점 회전 감도 배율 (PC 마우스 감도 기준) */
  lookSensitivity: number;
  /** 조이스틱 크기 배율 */
  joystickScale: number;
  /** 버튼 크기 배율 */
  buttonScale: number;
}

export const TOUCH_DEFAULTS: TouchSettings = { lookSensitivity: 1.6, joystickScale: 1, buttonScale: 1 };
export const TOUCH_LIMITS = {
  lookSensitivity: [0.5, 3.5, 0.1],
  joystickScale: [0.7, 1.4, 0.05],
  buttonScale: [0.7, 1.4, 0.05],
} as const;

const SETTINGS_KEY = 'popbattle.touch';
/** 조이스틱 반지름 (px, 배율 1, 화면 배율 --tu 곱하기 전) */
const STICK_RADIUS = 58;
/** 조이스틱 데드존 (반지름 비율) */
const STICK_DEADZONE = 0.12;
/** 화면 왼쪽 이 비율까지 = 조이스틱 영역 */
const MOVE_ZONE = 0.42;

type ButtonKind = 'fire' | 'ads' | 'jump' | 'slide' | 'reload';

function loadSettings(): TouchSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...TOUCH_DEFAULTS };
    const v = JSON.parse(raw) as Partial<TouchSettings>;
    const s = { ...TOUCH_DEFAULTS };
    for (const k of Object.keys(TOUCH_LIMITS) as Array<keyof TouchSettings>) {
      const n = v[k];
      if (typeof n === 'number' && Number.isFinite(n)) s[k] = Math.min(TOUCH_LIMITS[k][1], Math.max(TOUCH_LIMITS[k][0], n));
    }
    return s;
  } catch {
    return { ...TOUCH_DEFAULTS };
  }
}

/** 손가락을 이 요소에 묶음 (영역 밖으로 나가도 같은 역할 유지). 이미 끝난 포인터면 무시 */
function capture(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    /* 포인터가 이미 사라짐 */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

const ICONS: Record<ButtonKind, string> = {
  fire: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/><path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  ads: '<b>ADS</b>',
  jump: '<svg viewBox="0 0 24 24"><path d="M12 4l7 8h-4.5v7h-5v-7H5z" fill="currentColor"/></svg>',
  slide: '<svg viewBox="0 0 24 24"><path d="M3 17h13l5-5M14 7.5a2.3 2.3 0 1 0 0.01 0M9 13l3-3 3 2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  reload: '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.1-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M20.5 3.5v5.2h-5.2z" fill="currentColor"/></svg>',
};

export class TouchInput {
  readonly state = createInputState();
  readonly root = el('div', 'touch-layer hidden');
  settings: TouchSettings = loadSettings();
  /** 터치로 게임 조작 중 (PC의 포인터 잠금에 해당) */
  active = false;
  /** 일시정지 버튼 */
  onPause: (() => void) | null = null;

  private readonly stick = el('div', 'tc-stick');
  private readonly knob = el('div', 'tc-knob');
  private readonly buttons = new Map<ButtonKind, HTMLButtonElement>();
  private movePointer = -1;
  private lookPointer = -1;
  private firePointer = -1;
  private readonly moveOrigin = { x: 0, y: 0 };
  private readonly lastLook = { x: 0, y: 0 };
  private readonly lastFire = { x: 0, y: 0 };
  private readonly abort = new AbortController();
  private settingsPanel: HTMLDivElement | null = null;
  /** 메인 로비: 고정 카메라라 드래그 시점 회전 없음 */
  private lobby = false;

  constructor(container: HTMLElement) {
    const opts = { signal: this.abort.signal };
    this.state.moveSource = 'joystick';
    this.stick.appendChild(this.knob);
    this.root.appendChild(this.stick);
    for (const kind of ['fire', 'ads', 'jump', 'slide', 'reload'] as const) {
      const b = el('button', `tc-btn tc-${kind}`, ICONS[kind]);
      b.type = 'button';
      b.setAttribute('aria-label', kind);
      b.addEventListener('pointerdown', (e) => this.onButtonDown(kind, b, e), opts);
      b.addEventListener('pointermove', (e) => this.onButtonMove(kind, e), opts);
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) b.addEventListener(t, (e) => this.onButtonUp(kind, b, e), opts);
      this.buttons.set(kind, b);
      this.root.appendChild(b);
    }
    const pause = el('button', 'tc-pause', '<i></i><i></i>');
    pause.type = 'button';
    pause.setAttribute('aria-label', '일시정지');
    pause.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, opts);
    pause.addEventListener('click', () => this.onPause?.(), opts);
    this.root.appendChild(pause);
    // 빈 영역: 왼쪽 = 조이스틱, 오른쪽 = 시점
    this.root.addEventListener('pointerdown', this.onAreaDown, opts);
    this.root.addEventListener('pointermove', this.onAreaMove, opts);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) this.root.addEventListener(t, this.onAreaUp, opts);
    // iOS 사파리 핀치 확대·길게 눌러 메뉴 차단 (게임 영역에서만)
    for (const t of ['gesturestart', 'gesturechange', 'contextmenu'] as const) this.root.addEventListener(t, (e) => e.preventDefault(), opts);
    this.root.addEventListener('touchstart', (e) => e.preventDefault(), { signal: this.abort.signal, passive: false });
    window.addEventListener('blur', () => this.releaseAll(), opts);
    // 화면 크기·회전·브라우저 주소창 크기 변화 → 버튼 배율 다시 계산 (진행 중 손가락은 놓은 것으로)
    const onResize = () => this.root.style.setProperty('--tu', this.unit.toFixed(3));
    window.addEventListener('resize', onResize, opts);
    window.visualViewport?.addEventListener('resize', onResize, opts);
    window.addEventListener('orientationchange', () => this.releaseAll(), opts);
    document.addEventListener('visibilitychange', () => document.hidden && this.releaseAll(), opts);
    container.appendChild(this.root);
    this.applySettings();
  }

  /** 게임 조작 시작 (PC의 포인터 잠금에 해당) */
  start(): void {
    this.active = true;
    this.root.classList.remove('hidden');
  }

  /** 일시정지·메뉴 */
  stop(): void {
    this.active = false;
    this.root.classList.add('hidden');
    this.releaseAll();
  }

  setSettings(next: Partial<TouchSettings>): void {
    this.settings = { ...this.settings, ...next };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* 저장 못 해도 이번 세션에는 적용 */
    }
    this.applySettings();
  }

  /** 터치 설정 창 (시점 감도·조이스틱 크기·버튼 크기, 기기에 저장) */
  openSettings(): void {
    if (this.settingsPanel) return;
    const panel = el('div', 'tc-settings');
    const card = el('div', 'tc-settings-card');
    card.appendChild(el('b', 'tc-settings-title', '터치 설정'));
    const rows: Array<[keyof TouchSettings, string, (v: number) => string]> = [
      ['lookSensitivity', '시점 회전 감도', (v) => `${v.toFixed(1)}×`],
      ['joystickScale', '조이스틱 크기', (v) => `${Math.round(v * 100)}%`],
      ['buttonScale', '버튼 크기', (v) => `${Math.round(v * 100)}%`],
    ];
    const inputs: Array<[keyof TouchSettings, HTMLInputElement, HTMLElement, (v: number) => string]> = [];
    for (const [key, label, fmt] of rows) {
      const row = el('label', 'tc-settings-row');
      const val = el('span', 'tc-settings-val', fmt(this.settings[key]));
      const input = el('input', '');
      input.type = 'range';
      [input.min, input.max, input.step] = TOUCH_LIMITS[key].map(String) as [string, string, string];
      input.value = String(this.settings[key]);
      input.oninput = () => {
        const v = Number(input.value);
        val.textContent = fmt(v);
        this.setSettings({ [key]: v });
      };
      row.append(el('span', '', label), input, val);
      card.appendChild(row);
      inputs.push([key, input, val, fmt]);
    }
    const btns = el('div', 'tc-settings-btns');
    const reset = el('button', 'tc-settings-btn', '기본값');
    reset.type = 'button';
    reset.onclick = () => {
      this.setSettings({ ...TOUCH_DEFAULTS });
      for (const [key, input, val, fmt] of inputs) {
        input.value = String(this.settings[key]);
        val.textContent = fmt(this.settings[key]);
      }
    };
    const close = el('button', 'tc-settings-btn primary', '닫기');
    close.type = 'button';
    close.onclick = () => {
      panel.remove();
      this.settingsPanel = null;
    };
    btns.append(reset, close);
    card.appendChild(btns);
    panel.appendChild(card);
    // 설정 창 안의 조작이 게임 시작(캔버스 터치)으로 넘어가지 않게
    for (const t of ['pointerdown', 'mousedown', 'click', 'touchstart'] as const) panel.addEventListener(t, (e) => e.stopPropagation());
    panel.addEventListener('pointerdown', (e) => {
      if (e.target === panel) close.click();
    });
    this.root.parentElement?.appendChild(panel);
    this.settingsPanel = panel;
  }

  /** 무기 슬롯 터치 (HUD 슬롯 바) */
  pressSlot(slot: number): void {
    if (this.active) this.state.slotPressed = slot;
  }

  /** 재장전 중 표시 (버튼 회전) */
  setReloading(on: boolean): void {
    this.buttons.get('reload')?.classList.toggle('busy', on);
  }

  /** ADS 켜짐 표시 */
  setAiming(on: boolean): void {
    this.buttons.get('ads')?.classList.toggle('on', on);
  }

  /** 메인 로비 자유 이동: 사격·ADS·재장전·일시정지 버튼 숨김, 드래그 시점 회전 없음 (이동·점프·슬라이딩만, 메뉴는 로비 버튼) */
  setLobbyMode(on: boolean): void {
    this.lobby = on;
    this.lookPointer = -1;
    this.root.classList.toggle('lobby', on);
    if (on) {
      this.firePointer = -1;
      this.state.fireHeld = false;
    }
  }

  /** 근접무기: 재장전·ADS 버튼 흐리게 */
  setMelee(on: boolean): void {
    this.root.classList.toggle('melee', on);
  }

  endFrame(): void {
    const s = this.state;
    s.lookDX = 0;
    s.lookDY = 0;
    s.jumpPressed = false;
    s.slidePressed = false;
    s.aimTogglePressed = false;
    s.reloadPressed = false;
    s.slotPressed = 0;
  }

  dispose(): void {
    this.abort.abort();
    this.root.remove();
  }

  private applySettings(): void {
    this.root.style.setProperty('--stick', String(this.settings.joystickScale));
    this.root.style.setProperty('--btn', String(this.settings.buttonScale));
    this.root.style.setProperty('--tu', this.unit.toFixed(3));
  }

  /** 화면 크기 배율 (CSS --tu와 같은 식): 높이 400px 기준, 0.75~1.3 */
  private get unit(): number {
    return Math.min(1.3, Math.max(0.75, viewH() / 400));
  }

  private get radius(): number {
    return STICK_RADIUS * this.unit * this.settings.joystickScale;
  }

  private releaseAll(): void {
    this.movePointer = this.lookPointer = this.firePointer = -1;
    this.resetStick();
    this.state.fireHeld = false;
    for (const b of this.buttons.values()) b.classList.remove('down');
  }

  private resetStick(): void {
    this.state.moveX = 0;
    this.state.moveY = 0;
    this.stick.classList.remove('live');
    this.stick.style.removeProperty('left');
    this.stick.style.removeProperty('top');
    this.knob.style.transform = '';
  }

  private readonly onAreaDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' || !this.active) return;
    e.preventDefault();
    // 게임 화면 좌표 (세로로 든 기기에서 돌려 그릴 때도 같은 기준)
    const p = toGame(e.clientX, e.clientY);
    const leftZone = p.x < viewW() * MOVE_ZONE;
    if (leftZone && this.movePointer < 0) {
      this.movePointer = e.pointerId;
      // 떠다니는 조이스틱: 엄지를 댄 곳이 중심 (화면 밖으로 나가지 않게)
      const r = this.radius;
      const x = Math.max(r + 8, Math.min(viewW() * MOVE_ZONE - r, p.x));
      const y = Math.max(r + 8, Math.min(viewH() - r - 8, p.y));
      this.moveOrigin.x = x;
      this.moveOrigin.y = y;
      this.stick.classList.add('live');
      this.stick.style.left = `${x}px`;
      this.stick.style.top = `${y}px`;
      this.updateStick(p.x, p.y);
    } else if (!leftZone && this.lookPointer < 0 && !this.lobby) {
      this.lookPointer = e.pointerId;
      this.lastLook.x = p.x;
      this.lastLook.y = p.y;
    } else {
      return;
    }
    capture(this.root, e.pointerId);
  };

  private readonly onAreaMove = (e: PointerEvent): void => {
    const p = toGame(e.clientX, e.clientY);
    if (e.pointerId === this.movePointer) {
      this.updateStick(p.x, p.y);
    } else if (e.pointerId === this.lookPointer) {
      this.addLook(p.x - this.lastLook.x, p.y - this.lastLook.y);
      this.lastLook.x = p.x;
      this.lastLook.y = p.y;
    }
  };

  private readonly onAreaUp = (e: PointerEvent): void => {
    if (e.pointerId === this.movePointer) {
      this.movePointer = -1;
      this.resetStick();
    } else if (e.pointerId === this.lookPointer) {
      this.lookPointer = -1;
    }
  };

  private updateStick(x: number, y: number): void {
    const r = this.radius;
    let dx = (x - this.moveOrigin.x) / r;
    let dy = (y - this.moveOrigin.y) / r;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    this.knob.style.transform = `translate(${(dx * r).toFixed(1)}px, ${(dy * r).toFixed(1)}px)`;
    // 데드존 밖은 0..1로 다시 펴서 아날로그 (작게 밀면 천천히 걷기). 화면 위 = 앞
    const mag = Math.min(1, len);
    const k = mag <= STICK_DEADZONE ? 0 : (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE) / Math.max(mag, 1e-6);
    this.state.moveX = dx * k;
    this.state.moveY = -dy * k;
  }

  private addLook(dx: number, dy: number): void {
    const s = this.settings.lookSensitivity;
    this.state.lookDX += dx * s;
    this.state.lookDY += dy * s;
  }

  private onButtonDown(kind: ButtonKind, b: HTMLButtonElement, e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!this.active) return;
    // 사격 버튼을 이미 다른 손가락이 누르고 있으면 그 손가락이 계속 조준·사격 (두 번째 손가락은 무시 → 시점 튐 없음)
    if (kind === 'fire' && this.firePointer >= 0) return;
    capture(b, e.pointerId);
    b.classList.add('down');
    switch (kind) {
      case 'fire':
        this.firePointer = e.pointerId;
        {
          const p = toGame(e.clientX, e.clientY);
          this.lastFire.x = p.x;
          this.lastFire.y = p.y;
        }
        this.state.fireHeld = true;
        break;
      case 'ads': this.state.aimTogglePressed = true; break;
      case 'jump': this.state.jumpPressed = true; break;
      case 'slide': this.state.slidePressed = true; break;
      case 'reload': this.state.reloadPressed = true; break;
    }
  }

  /** 사격 버튼을 누른 채 끌면 시점 회전 (쏘면서 조준) */
  private onButtonMove(kind: ButtonKind, e: PointerEvent): void {
    if (kind !== 'fire' || e.pointerId !== this.firePointer) return;
    e.stopPropagation();
    const p = toGame(e.clientX, e.clientY);
    this.addLook(p.x - this.lastFire.x, p.y - this.lastFire.y);
    this.lastFire.x = p.x;
    this.lastFire.y = p.y;
  }

  private onButtonUp(kind: ButtonKind, b: HTMLButtonElement, e: PointerEvent): void {
    e.stopPropagation();
    // 무시한 두 번째 사격 손가락이 떨어져도 누르고 있는 손가락의 표시·사격은 그대로
    if (kind === 'fire' && e.pointerId !== this.firePointer) return;
    b.classList.remove('down');
    if (kind === 'fire' && e.pointerId === this.firePointer) {
      this.firePointer = -1;
      this.state.fireHeld = false;
    }
  }
}

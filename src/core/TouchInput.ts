// 모바일 터치 조작 (가로 화면). KeyboardMouseInput과 같은 InputState를 채우고, 게임 로직(이동·사격·ADS·달리기)은 그대로 공유한다.
// - 왼쪽 영역: 떠다니는 가상 조이스틱 (아날로그, moveSource = 'joystick' → Game의 JoystickAutoSprint가 달리기 판정)
// - 오른쪽 빈 영역: 드래그로 시점 회전 (사격 버튼을 누른 채 끌어도 회전)
// - 오른쪽 아래 버튼: 사격(누르는 동안) · ADS 토글 · 점프 · 슬라이딩 · 재장전 / 왼쪽 위: 일시정지
// 버튼 누름(사격·점프 등)은 PointerEvent, 이동·시점 드래그는 TouchEvent의 Touch.identifier 하나로만 추적한다.
// 손가락의 역할(이동·시점·사격 버튼 시점)은 touchstart에서 정하고 그 손가락의 touchend/touchcancel까지 유지 (이동하며 회전·사격·점프 동시에).
import { createInputState } from './Input';
import { toGame, viewH, viewW } from './screenRotation';
import { bindButtonActivation } from '../ui/buttonActivation';
import { logNote, logPointer, logTouch } from './touchLog';

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
const FIRE_HOLD_MS = 200;

type ButtonKind = 'fire' | 'ads' | 'jump' | 'slide' | 'reload';
type FireMode = 'rifle' | 'shotgun' | 'sniper' | 'pistol' | 'direct';

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

/** 버튼 크기 설정이 이보다 크면 큰 버튼 배치 (.touch-layer.big: 667×375에서도 화면 가운데 조준 영역을 비움) */
const BIG_BUTTONS = 1.1;

// 아이콘: 24×24, 선 굵기 2.4 통일. 사격 = 탄환(쏘기), ADS = 조준경(확대 조준) — 둘이 헷갈리지 않게 모양을 나눔
const ICONS: Record<ButtonKind, string> = {
  fire: '<svg viewBox="0 0 24 24"><g transform="rotate(45 12 12)"><path d="M12 2.5c2.7 1.9 3.7 4.6 3.7 7.4v6.3H8.3V9.9c0-2.8 1-5.5 3.7-7.4z" fill="currentColor"/><rect x="7.6" y="17.6" width="8.8" height="3.4" rx="1.2" fill="currentColor"/></g><path d="M2.5 15.5l2.6-2.6M4.6 19.4l2.6-2.6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity=".75"/></svg>',
  ads: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.3" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 2v5.2M12 16.8V22M2 12h5.2M16.8 12H22" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
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
  /** 사격 버튼 홀드가 요청한 ADS 상태. Game이 적용한 뒤 endFrame에서 비운다. */
  aimRequest: boolean | null = null;
  /** 권총 길게 누르기만 반자동 무기를 기존 RPM으로 반복 발사한다. */
  automaticFire = false;

  private readonly stick = el('div', 'tc-stick');
  private readonly knob = el('div', 'tc-knob');
  private readonly buttons = new Map<ButtonKind, HTMLButtonElement>();
  /** 역할별 Touch.identifier: 이동(왼쪽 빈 영역) · 시점(오른쪽 빈 영역) · 사격 버튼을 누른 채 끄는 시점 */
  private moveTouchId: number | null = null;
  private lookTouchId: number | null = null;
  private fireTouchId: number | null = null;
  private firePointer = -1;
  private fireMode: FireMode = 'rifle';
  private fireLong = false;
  private firePulse = false;
  private fireHoldTimer: number | null = null;
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
      pause.classList.add('down');
    }, opts);
    for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) pause.addEventListener(t, () => pause.classList.remove('down'), opts);
    bindButtonActivation(pause, () => this.onPause?.());
    this.root.appendChild(pause);
    // 빈 영역: 왼쪽 = 조이스틱, 오른쪽 = 시점, 사격 버튼 = 누른 채 끌면 시점 (모두 Touch.identifier 기준)
    // iOS 사파리 핀치 확대·길게 눌러 메뉴 차단 (게임 영역에서만)
    for (const t of ['gesturestart', 'gesturechange', 'contextmenu'] as const) this.root.addEventListener(t, (e) => e.preventDefault(), opts);
    this.root.addEventListener('touchstart', this.onTouchStart, { signal: this.abort.signal, passive: false });
    this.root.addEventListener('touchmove', this.onTouchMove, { signal: this.abort.signal, passive: false });
    for (const t of ['touchend', 'touchcancel'] as const) this.root.addEventListener(t, this.onTouchEnd, { signal: this.abort.signal, passive: false });
    // 임시 터치 기록 (core/touchLog.ts, 꺼져 있으면 아무것도 안 함)
    for (const t of ['pointerdown', 'pointerup', 'pointercancel'] as const) window.addEventListener(t, logPointer, { ...opts, capture: true });
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

  /** 무기 교체 시 진행 중인 모바일 사격을 발사 없이 취소한다. */
  setWeapon(id: string): void {
    this.cancelFire();
    this.fireMode = id === 'rifle' ? 'rifle' : id === 'shotgun' ? 'shotgun' : id === 'sniper' ? 'sniper' : id === 'pistol' ? 'pistol' : 'direct';
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
    this.lookTouchId = null;
    this.root.classList.toggle('lobby', on);
    if (on) {
      this.fireTouchId = null;
      this.cancelFire();
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
    this.aimRequest = null;
    if (this.firePulse) {
      this.firePulse = false;
      s.fireHeld = this.firePointer >= 0 && (this.fireMode === 'rifle' || this.fireMode === 'direct');
    }
  }

  dispose(): void {
    this.abort.abort();
    this.root.remove();
  }

  private applySettings(): void {
    this.root.style.setProperty('--stick', String(this.settings.joystickScale));
    this.root.style.setProperty('--btn', String(this.settings.buttonScale));
    this.root.style.setProperty('--tu', this.unit.toFixed(3));
    this.root.classList.toggle('big', this.settings.buttonScale > BIG_BUTTONS);
  }

  /** 화면 크기 배율 (CSS --tu와 같은 식): 높이 400px 기준, 0.75~1.3 */
  private get unit(): number {
    return Math.min(1.3, Math.max(0.75, viewH() / 400));
  }

  private get radius(): number {
    return STICK_RADIUS * this.unit * this.settings.joystickScale;
  }

  private releaseAll(): void {
    logNote('releaseAll');
    this.moveTouchId = null;
    this.lookTouchId = null;
    this.fireTouchId = null;
    this.cancelFire();
    this.resetStick();
    for (const b of this.buttons.values()) b.classList.remove('down');
  }

  private cancelFire(): void {
    if (this.fireHoldTimer !== null) window.clearTimeout(this.fireHoldTimer);
    this.fireHoldTimer = null;
    this.firePointer = -1;
    this.fireLong = false;
    this.firePulse = false;
    this.automaticFire = false;
    this.state.fireHeld = false;
    this.aimRequest = false;
  }

  private startFireHold(pointerId: number): void {
    this.fireHoldTimer = window.setTimeout(() => {
      this.fireHoldTimer = null;
      if (this.firePointer !== pointerId) return;
      this.fireLong = true;
      this.aimRequest = true;
      if (this.fireMode === 'pistol') {
        this.automaticFire = true;
        this.state.fireHeld = true;
      }
    }, FIRE_HOLD_MS);
  }

  private pulseFire(): void {
    this.firePulse = true;
    this.state.fireHeld = true;
  }

  private resetStick(): void {
    this.state.moveX = 0;
    this.state.moveY = 0;
    this.stick.classList.remove('live');
    this.stick.style.removeProperty('left');
    this.stick.style.removeProperty('top');
    this.knob.style.transform = '';
  }

  private beginStick(x: number, y: number): void {
    const r = this.radius;
    const originX = Math.max(r + 8, Math.min(viewW() * MOVE_ZONE - r, x));
    const originY = Math.max(r + 8, Math.min(viewH() - r - 8, y));
    this.moveOrigin.x = originX;
    this.moveOrigin.y = originY;
    this.stick.classList.add('live');
    this.stick.style.left = `${originX}px`;
    this.stick.style.top = `${originY}px`;
    this.updateStick(x, y);
  }

  /**
   * 새 손가락의 역할을 정한다. 좌표·번호는 그 손가락 자신의 Touch에서만 읽고, 시점 기준점은 닿은 위치에서 시작한다
   * (다른 손가락의 좌표나 예전 손가락의 마지막 위치와 비교하지 않음 → 다시 닿는 순간 회전 없음).
   */
  private readonly onTouchStart = (e: TouchEvent): void => {
    e.preventDefault();
    if (!this.active) return;
    const lx = this.state.lookDX;
    const ly = this.state.lookDY;
    this.dropLostTouches(e.touches);
    for (const touch of e.changedTouches) {
      const id = touch.identifier;
      // Android는 뗀 손가락 번호를 새 손가락에 다시 준다: 끝 이벤트를 놓쳐 그 번호가 아직 역할을 갖고 있으면 여기서 끝낸다
      this.endTouch(id);
      const p = toGame(touch.clientX, touch.clientY);
      const button = touch.target instanceof Element ? touch.target.closest('button') : null;
      if (button) {
        // 버튼 누름은 PointerEvent가 처리. 사격 버튼만 누른 채 끌면 시점 (먼저 누른 손가락 하나만)
        if (button === this.buttons.get('fire') && this.fireTouchId === null) {
          this.fireTouchId = id;
          this.lastFire.x = p.x;
          this.lastFire.y = p.y;
        }
      } else if (p.x < viewW() * MOVE_ZONE) {
        if (this.moveTouchId === null) {
          this.moveTouchId = id;
          this.beginStick(p.x, p.y);
        }
      } else if (this.lookTouchId === null && !this.lobby) {
        this.lookTouchId = id;
        this.lastLook.x = p.x;
        this.lastLook.y = p.y;
      }
    }
    this.log(e, lx, ly);
  };

  /** 임시 터치 기록: 이번 이벤트 뒤 역할과 이 이벤트가 만든 시점 이동량(px, 감도 곱하기 전) */
  private log(e: TouchEvent, lx: number, ly: number): void {
    const s = this.settings.lookSensitivity;
    logTouch(
      e,
      { move: this.moveTouchId, look: this.lookTouchId, fire: this.fireTouchId },
      { dx: (this.state.lookDX - lx) / s, dy: (this.state.lookDY - ly) / s },
      { x: this.state.moveX, y: this.state.moveY },
    );
  }

  private readonly onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    if (!this.active) return;
    const lx = this.state.lookDX;
    const ly = this.state.lookDY;
    this.dropLostTouches(e.touches);
    for (const touch of e.changedTouches) {
      const id = touch.identifier;
      if (id === this.moveTouchId) {
        const p = toGame(touch.clientX, touch.clientY);
        this.updateStick(p.x, p.y);
      } else if (id === this.lookTouchId) {
        this.dragLook(touch, this.lastLook);
      } else if (id === this.fireTouchId) {
        this.dragLook(touch, this.lastFire);
      }
    }
    this.log(e, lx, ly);
  };

  private readonly onTouchEnd = (e: TouchEvent): void => {
    for (const touch of e.changedTouches) if (this.endTouch(touch.identifier)) e.preventDefault();
    this.log(e, this.state.lookDX, this.state.lookDY);
  };

  /** 이 번호의 역할을 끝냄. 역할이 있었으면 true */
  private endTouch(id: number): boolean {
    if (id === this.moveTouchId) {
      this.moveTouchId = null;
      this.resetStick();
      return true;
    }
    if (id === this.lookTouchId) {
      this.lookTouchId = null;
      return true;
    }
    if (id === this.fireTouchId) {
      this.fireTouchId = null;
      return true;
    }
    return false;
  }

  /** 화면에 더 이상 없는 손가락의 역할을 끝냄 (touchend/touchcancel을 못 받은 경우) */
  private dropLostTouches(touches: TouchList): void {
    for (const id of [this.moveTouchId, this.lookTouchId, this.fireTouchId]) {
      if (id === null) continue;
      let down = false;
      for (const t of touches) if (t.identifier === id) down = true;
      if (!down) this.endTouch(id);
    }
  }

  /** 같은 손가락의 직전 위치에서 움직인 만큼만 시점 회전 */
  private dragLook(touch: Touch, last: { x: number; y: number }): void {
    const p = toGame(touch.clientX, touch.clientY);
    this.addLook(p.x - last.x, p.y - last.y);
    last.x = p.x;
    last.y = p.y;
  }

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
        this.fireLong = false;
        this.firePulse = this.fireMode === 'rifle' || this.fireMode === 'direct';
        this.automaticFire = false;
        this.state.fireHeld = this.fireMode === 'rifle' || this.fireMode === 'direct';
        if (this.fireMode === 'sniper') this.aimRequest = true;
        else if (this.fireMode !== 'direct') this.startFireHold(e.pointerId);
        break;
      case 'ads': this.state.aimTogglePressed = true; break;
      case 'jump': this.state.jumpPressed = true; break;
      case 'slide': this.state.slidePressed = true; break;
      case 'reload': this.state.reloadPressed = true; break;
    }
  }

  private onButtonUp(kind: ButtonKind, b: HTMLButtonElement, e: PointerEvent): void {
    e.stopPropagation();
    // 무시한 두 번째 사격 손가락이 떨어져도 누르고 있는 손가락의 표시·사격은 그대로
    if (kind === 'fire' && e.pointerId !== this.firePointer) return;
    b.classList.remove('down');
    if (kind === 'fire' && e.pointerId === this.firePointer) {
      const cancelled = e.type !== 'pointerup';
      if (this.fireHoldTimer !== null) window.clearTimeout(this.fireHoldTimer);
      this.fireHoldTimer = null;
      this.firePointer = -1;
      this.state.fireHeld = false;
      this.automaticFire = false;
      if (
        !cancelled &&
        (this.fireMode === 'shotgun' || this.fireMode === 'sniper' || (this.fireMode === 'pistol' && !this.fireLong) ||
          ((this.fireMode === 'rifle' || this.fireMode === 'direct') && this.firePulse))
      ) this.pulseFire();
      if (this.fireMode !== 'direct') this.aimRequest = false;
      this.fireLong = false;
    }
  }
}

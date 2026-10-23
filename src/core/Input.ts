// 원시 입력(키보드·마우스)을 게임 액션으로 변환한다.
// 게임 로직은 InputState만 읽으므로, 모바일 가상 패드는 같은 상태를 채우면 된다
// (달리기는 core/JoystickAutoSprint.ts로 조이스틱 → sprint 변환).
import { MOVEMENT } from '../config/gameConfig';

export interface InputState {
  /** -1..1, +Y = 앞 */
  moveX: number;
  moveY: number;
  lookDX: number;
  lookDY: number;
  /** 달리기 (PC: W 더블 탭 후 W 유지, 모바일: 조이스틱 전방 유지) */
  sprint: boolean;
  /**
   * 이동 입력 장치. 'joystick'이면 sprint 대신 Game이 JoystickAutoSprint로 달리기를 정한다
   * (모바일 가상 패드가 moveX/moveY와 함께 채움)
   */
  moveSource: 'keyboard' | 'joystick';
  fireHeld: boolean;
  /** 이번 프레임에 눌린 엣지 입력 */
  jumpPressed: boolean;
  slidePressed: boolean;
  aimTogglePressed: boolean;
  reloadPressed: boolean;
  /** 이번 프레임에 누른 무기 슬롯 (1·2·3, 없으면 0) */
  slotPressed: number;
  /** 마우스 휠 단계 (+ = 다음 슬롯, - = 이전 슬롯) */
  wheelSteps: number;
  suicidePressed: boolean;
  debugTogglePressed: boolean;
}

export function createInputState(): InputState {
  return {
    moveX: 0, moveY: 0, lookDX: 0, lookDY: 0,
    sprint: false, moveSource: 'keyboard', fireHeld: false,
    jumpPressed: false, slidePressed: false, aimTogglePressed: false,
    reloadPressed: false, slotPressed: 0, wheelSteps: 0, suicidePressed: false, debugTogglePressed: false,
  };
}

/**
 * 게임 키의 브라우저 기본 동작을 막는다. Ctrl은 게임 조작에 쓰지 않는다
 * (Ctrl+W 등 탭 닫기 단축키는 페이지가 막을 수 없음).
 */
const BLOCKED_KEYS = new Set(['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'Tab']);

export class KeyboardMouseInput {
  readonly state = createInputState();
  private readonly keys = new Set<string>();
  private mouseLeft = false;
  private locked = false;
  /** W 더블 탭으로 켜진 달리기 (W를 떼면 꺼짐) */
  private sprintLatched = false;
  /** 마지막으로 W를 뗀 시각 (ms, 더블 탭 판정) */
  private wReleasedAt = -Infinity;
  /** 휠 누적량 (트랙패드처럼 작은 이벤트가 많이 와도 일정 양마다 한 칸) */
  private wheelAccum = 0;
  private readonly abort = new AbortController();
  onLockChange: ((locked: boolean) => void) | null = null;
  /**
   * 로비 자유 이동 (커서 보이는 상태): 포인터 잠금 없이 이동·점프·슬라이딩 키를 받음. 마우스 시점·사격·포인터 잠금 요청은 없음.
   * 글자 입력 칸에 포커스가 있으면 키를 받지 않음 (방 코드 입력 중 캐릭터가 움직이지 않게)
   */
  private cursorKeys = false;
  /** 포인터 잠금 재시도 타이머 (requestLock) */
  private retryTimer: number | null = null;

  constructor(private readonly element: HTMLElement) {
    const opts = { signal: this.abort.signal };
    window.addEventListener('keydown', this.onKeyDown, opts);
    window.addEventListener('keyup', this.onKeyUp, opts);
    window.addEventListener('blur', this.onBlur, opts);
    element.addEventListener('mousedown', this.onMouseDown, opts);
    window.addEventListener('mouseup', this.onMouseUp, opts);
    window.addEventListener('mousemove', this.onMouseMove, opts);
    window.addEventListener('wheel', this.onWheel, { signal: this.abort.signal, passive: false });
    // 우클릭 ADS 토글 시 브라우저 컨텍스트 메뉴 차단
    window.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    document.addEventListener('pointerlockchange', this.onPointerLockChange, opts);
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** 로비 자유 이동 키 모드 켜기/끄기 (바뀌면 눌려 있던 키를 비워 키가 남지 않게) */
  setCursorKeys(on: boolean): void {
    if (on === this.cursorKeys) return;
    this.cursorKeys = on;
    this.onBlur();
  }

  requestLock(): void {
    if (this.locked) return;
    // 사용자 제스처가 아니거나 문서가 포커스를 잃은 경우 거부될 수 있다 (다음 클릭에서 재시도)
    this.tryLock();
    // ESC로 잠금을 푼 직후(약 1초)는 브라우저가 다시 잡기를 거부함 (일시정지 메뉴 '계속하기'를 바로 누르면 반응 없음)
    // → 클릭(사용자 동작)이 아직 유효한 동안 한 번 더. 그사이 잡히면 취소
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.locked && document.hasFocus()) this.tryLock();
    }, 1100);
  }

  private tryLock(): void {
    Promise.resolve(this.element.requestPointerLock?.()).catch(() => undefined);
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** 프레임마다 게임이 상태를 읽은 뒤 호출해 엣지 입력과 마우스 델타를 비운다. */
  endFrame(): void {
    const s = this.state;
    s.lookDX = 0;
    s.lookDY = 0;
    s.jumpPressed = false;
    s.slidePressed = false;
    s.aimTogglePressed = false;
    s.reloadPressed = false;
    s.slotPressed = 0;
    s.wheelSteps = 0;
    s.suicidePressed = false;
    s.debugTogglePressed = false;
  }

  dispose(): void {
    this.abort.abort();
    this.releaseLock();
  }

  private refreshAxes(): void {
    const k = this.keys;
    const s = this.state;
    s.moveX = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    s.moveY = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    // 달리기: W 더블 탭으로 켜지고 W를 누르고 있으며 앞으로 가는 동안만 (W+A·W+D 대각선 포함, W+S는 아님)
    s.sprint = this.sprintLatched && k.has('KeyW') && s.moveY > 0;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Backquote') {
      if (!e.repeat) this.state.debugTogglePressed = true;
      e.preventDefault();
      return;
    }
    if (!this.locked && !(this.cursorKeys && !isTyping(e.target))) return;
    // 로비(커서 모드)에서 TAB은 게임이 메뉴 단축키로 처리 (여기서 막지 않음)
    if (BLOCKED_KEYS.has(e.code) && (this.locked || e.code !== 'Tab')) e.preventDefault();
    // 키 반복(길게 누름)은 새 입력이 아님 → 더블 탭으로 잘못 인식되지 않음
    if (e.repeat) return;
    this.keys.add(e.code);
    switch (e.code) {
      case 'KeyW':
        // 첫 W를 뗀 뒤 정해진 시간 안에 다시 누르면 달리기 (길게 한 번 누르는 것으로는 켜지지 않음)
        if (performance.now() - this.wReleasedAt <= MOVEMENT.sprintInput.doubleTapWindow * 1000) this.sprintLatched = true;
        break;
      case 'Space': this.state.jumpPressed = true; break;
      case 'ShiftLeft':
      case 'ShiftRight': this.state.slidePressed = true; break;
      case 'KeyR': this.state.reloadPressed = true; break;
      case 'Digit1': this.state.slotPressed = 1; break;
      case 'Digit2': this.state.slotPressed = 2; break;
      case 'Digit3': this.state.slotPressed = 3; break;
      case 'KeyK': this.state.suicidePressed = true; break;
    }
    this.refreshAxes();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    // 커서 모드: 포커스된 버튼이 Space 떼기로 눌리지 않게
    if (this.cursorKeys && !this.locked && e.code === 'Space' && !isTyping(e.target)) e.preventDefault();
    if (e.code === 'KeyW' && this.keys.has('KeyW')) {
      // W를 떼면 달리기 즉시 해제, 이 시각부터 더블 탭 대기
      this.sprintLatched = false;
      this.wReleasedAt = performance.now();
    }
    this.keys.delete(e.code);
    this.refreshAxes();
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.sprintLatched = false;
    this.wReleasedAt = -Infinity;
    this.mouseLeft = false;
    this.state.fireHeld = false;
    this.refreshAxes();
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    // 로비: 화면 클릭으로 포인터 잠금·사격하지 않음 (커서로 UI 조작)
    if (this.cursorKeys && !this.locked) return;
    if (!this.locked) {
      // 첫 클릭은 포인터 잠금만 하고 사격/조준하지 않는다
      this.requestLock();
      return;
    }
    if (e.button === 0) {
      this.mouseLeft = true;
      this.state.fireHeld = true;
    } else if (e.button === 2) {
      // 토글 방식: 누르는 순간에만 반응하고 떼는 것은 무시
      this.state.aimTogglePressed = true;
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseLeft = false;
      this.state.fireHeld = false;
    }
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.locked) return;
    e.preventDefault();
    // deltaMode 1(줄 단위)은 픽셀로 환산
    this.wheelAccum += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    // 마우스 휠 한 칸(보통 100px)이 큰 값이어도 한 칸만 이동. 트랙패드는 작은 값이 모여 40을 넘을 때마다 한 칸
    if (Math.abs(this.wheelAccum) >= 40) {
      this.state.wheelSteps += Math.sign(this.wheelAccum);
      this.wheelAccum = 0;
    }
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.state.lookDX += e.movementX;
    this.state.lookDY += e.movementY;
  };

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    if (this.locked && this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.locked) this.onBlur();
    this.state.fireHeld = this.locked && this.mouseLeft;
    this.onLockChange?.(this.locked);
  };
}

/** 글자 입력 중인 요소 (방 코드 입력 칸 등) — 게임 키로 쓰지 않음 */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type);
}

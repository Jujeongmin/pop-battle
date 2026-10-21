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

  requestLock(): void {
    if (!this.locked) {
      // 사용자 제스처가 아니거나 문서가 포커스를 잃은 경우 거부될 수 있다 (다음 클릭에서 재시도)
      Promise.resolve(this.element.requestPointerLock?.()).catch(() => undefined);
    }
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
    if (!this.locked) return;
    if (BLOCKED_KEYS.has(e.code)) e.preventDefault();
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
    if (!this.locked) this.onBlur();
    this.state.fireHeld = this.locked && this.mouseLeft;
    this.onLockChange?.(this.locked);
  };
}

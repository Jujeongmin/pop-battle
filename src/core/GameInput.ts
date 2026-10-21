// 게임 입력 묶음: 키보드·마우스(KeyboardMouseInput) + 모바일 터치(TouchInput) → 프레임마다 InputState 하나로 합침.
// Game은 이 state만 읽으므로 이동 속도·달리기·사격·ADS·무기 규칙은 PC·모바일이 같은 코드를 쓴다.
//
// 터치 모드 판단 (화면 크기로 정하지 않음):
// - 시작: 주 입력 장치가 터치(hover: none + pointer: coarse) → 터치 모드
// - 실제 손가락 터치(pointerType 'touch')가 오면 터치 모드, 실제 마우스 클릭이 오면 PC 모드 (터치 노트북·태블릿+키보드)
// "잠금"(조작 중) = PC는 포인터 잠금, 터치는 TouchInput.active.
import { createInputState, KeyboardMouseInput, type InputState } from './Input';
import { TouchInput } from './TouchInput';

export class GameInput {
  readonly kbm: KeyboardMouseInput;
  readonly touch: TouchInput;
  /** 이번 프레임 합친 입력 (beginFrame에서 갱신) */
  readonly state: InputState = createInputState();
  touchMode: boolean;
  onLockChange: ((locked: boolean) => void) | null = null;
  onTouchModeChange: ((on: boolean) => void) | null = null;
  private readonly abort = new AbortController();
  private landscapeTried = false;

  constructor(
    canvas: HTMLElement,
    private readonly container: HTMLElement,
  ) {
    this.kbm = new KeyboardMouseInput(canvas);
    this.touch = new TouchInput(container);
    this.touchMode = matchMedia('(hover: none) and (pointer: coarse)').matches;
    // 세로 화면 회전 안내 (터치 모드 + 세로일 때 CSS로 표시, 게임은 계속 동작)
    const hint = document.createElement('div');
    hint.className = 'rotate-hint';
    hint.innerHTML = '<div><b>↻</b><p>가로로 돌려 주세요</p><span>POP! BATTLE은 가로 화면에서 플레이해요</span></div>';
    container.appendChild(hint);
    container.classList.toggle('touch-mode', this.touchMode);
    this.kbm.onLockChange = (locked) => this.onLockChange?.(locked);
    this.touch.onPause = () => this.releaseLock();
    const opts = { signal: this.abort.signal, capture: true };
    // 입력 장치 전환 감지 (게임 메뉴 버튼 터치도 포함)
    window.addEventListener('pointerdown', this.onAnyPointer, opts);
    // 터치로 화면(캔버스)을 누르면 게임 시작 — 마우스 호환 이벤트(포인터 잠금 시도)는 막음
    canvas.addEventListener('pointerdown', this.onCanvasPointer, { signal: this.abort.signal });
  }

  get isLocked(): boolean {
    return this.touchMode ? this.touch.active : this.kbm.isLocked;
  }

  requestLock(): void {
    if (this.touchMode) this.startTouch();
    else this.kbm.requestLock();
  }

  releaseLock(): void {
    this.kbm.releaseLock();
    if (this.touch.active) {
      this.touch.stop();
      this.onLockChange?.(false);
    }
  }

  /** 프레임 시작: 두 입력을 합침. 터치 조이스틱이 움직이면 이동은 조이스틱(자동 달리기), 아니면 키보드 */
  beginFrame(): void {
    const k = this.kbm.state;
    const t = this.touch.state;
    const s = this.state;
    const touchOn = this.touch.active;
    const stick = touchOn && (t.moveX !== 0 || t.moveY !== 0);
    s.moveX = stick ? t.moveX : k.moveX;
    s.moveY = stick ? t.moveY : k.moveY;
    s.moveSource = stick ? 'joystick' : 'keyboard';
    s.sprint = !stick && k.sprint;
    s.lookDX = k.lookDX + (touchOn ? t.lookDX : 0);
    s.lookDY = k.lookDY + (touchOn ? t.lookDY : 0);
    s.fireHeld = k.fireHeld || (touchOn && t.fireHeld);
    s.jumpPressed = k.jumpPressed || (touchOn && t.jumpPressed);
    s.slidePressed = k.slidePressed || (touchOn && t.slidePressed);
    s.aimTogglePressed = k.aimTogglePressed || (touchOn && t.aimTogglePressed);
    s.reloadPressed = k.reloadPressed || (touchOn && t.reloadPressed);
    s.slotPressed = k.slotPressed || (touchOn ? t.slotPressed : 0);
    s.wheelSteps = k.wheelSteps;
    s.suicidePressed = k.suicidePressed;
    s.debugTogglePressed = k.debugTogglePressed;
  }

  endFrame(): void {
    this.kbm.endFrame();
    this.touch.endFrame();
  }

  dispose(): void {
    this.abort.abort();
    this.kbm.dispose();
    this.touch.dispose();
  }

  private setTouchMode(on: boolean): void {
    if (on === this.touchMode) return;
    // 조작 중에 장치가 바뀌면 일단 멈춤 (다시 누르면 새 장치로 시작)
    if (this.isLocked) this.releaseLock();
    this.touchMode = on;
    this.container.classList.toggle('touch-mode', on);
    this.onTouchModeChange?.(on);
  }

  private startTouch(): void {
    if (this.touch.active) return;
    this.touch.start();
    this.tryLandscape();
    this.onLockChange?.(true);
  }

  /**
   * 가로 고정: 브라우저가 전체 화면 + 화면 방향 잠금을 허용할 때만 (안드로이드 크롬 등). iOS·iframe에서 막히면 그냥 진행
   * (세로면 회전 안내만 표시). 세션당 한 번만 시도
   */
  private tryLandscape(): void {
    if (this.landscapeTried) return;
    this.landscapeTried = true;
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    if (!orientation?.lock || !document.fullscreenEnabled || document.fullscreenElement) return;
    document.documentElement
      .requestFullscreen({ navigationUI: 'hide' })
      .then(() => orientation.lock!('landscape'))
      .catch(() => undefined);
  }

  private readonly onAnyPointer = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') this.setTouchMode(true);
    else if (e.pointerType === 'mouse') this.setTouchMode(false);
  };

  private readonly onCanvasPointer = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return;
    // 터치 시작: 호환 마우스 이벤트(mousedown → 포인터 잠금 시도)를 막고 터치 조작 시작
    e.preventDefault();
    if (this.touchMode) this.startTouch();
  };
}

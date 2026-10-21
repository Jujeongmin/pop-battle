import { MOVEMENT } from '../config/gameConfig';

/**
 * 모바일 자동 달리기: 가상 조이스틱 입력(moveX, moveY: -1..1, +Y = 카메라 기준 앞) → 달리기 여부.
 * PC의 W 더블 탭과 같은 InputState.sprint를 채우므로 이동·애니메이션·ADS 해제는 PC와 같은 경로를 쓴다.
 * - 전방 ±enterAngleDeg 안 + 세기 enterStrength 이상을 holdTime 동안 연속 유지하면 달리기
 * - 조건이 끊기면 타이머 0부터 다시
 * - 달리는 중에는 exitAngleDeg·exitStrength까지 유지 (히스테리시스: 살짝 흔들려도 걷기·달리기 반복 전환 없음)
 * - 조이스틱을 놓거나(세기 0) 옆·뒤로 크게 돌리면 즉시 해제
 * - 슬라이딩 중에는 해제하고 타이머도 0 → 슬라이딩이 끝난 뒤 전방을 유지하면 다시 holdTime부터 계산
 */
export class JoystickAutoSprint {
  sprinting = false;
  /** 전방 유지 누적 시간 (s) */
  private held = 0;

  update(dt: number, moveX: number, moveY: number, sliding: boolean): boolean {
    const c = MOVEMENT.sprintInput.joystick;
    if (sliding) {
      this.reset();
      return false;
    }
    const strength = Math.min(1, Math.hypot(moveX, moveY));
    // 0° = 정면, 90° = 옆, 180° = 뒤
    const angle = strength > 1e-3 ? Math.abs((Math.atan2(moveX, moveY) * 180) / Math.PI) : 180;
    if (this.sprinting) {
      if (strength < c.exitStrength || angle > c.exitAngleDeg) this.reset();
    } else if (strength >= c.enterStrength && angle <= c.enterAngleDeg) {
      this.held += dt;
      if (this.held >= c.holdTime) this.sprinting = true;
    } else {
      this.held = 0;
    }
    return this.sprinting;
  }

  reset(): void {
    this.sprinting = false;
    this.held = 0;
  }
}

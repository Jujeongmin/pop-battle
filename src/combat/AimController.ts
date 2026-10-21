import type { AimProfile } from '../config/weapons';

/** ADS를 막는 행동. 새로 시작되면 ADS를 해제하고, 하나라도 진행 중이면 ADS 진입 불가. */
export type AimBlockReason = 'sprint' | 'airborne' | 'slide' | 'reload';
export type AimResetReason = 'death' | 'respawn' | 'weaponSwap' | 'unequip' | 'boltAction' | AimBlockReason;

/** 이번 프레임 행동 상태 (이동·재장전 시스템은 상태만 알려주고 ADS는 여기서만 바꾼다) */
export interface AimActionState {
  sprinting: boolean;
  airborne: boolean;
  sliding: boolean;
  reloading: boolean;
}

/**
 * 모든 무기 공통 ADS 컨트롤러 (라이플·샷건·스나이퍼).
 * 우클릭 1회 = 조준, 다시 1회 = 해제 (토글). 버튼을 떼는 것은 무시한다.
 * 무기별 차이는 AimProfile(FOV, 거리, 이동 속도, 정확도 등)로만 표현한다.
 */
export class AimController {
  private profile: AimProfile | null = null;
  /**
   * 화면(카메라·몸 표시·몸 비틀기)에 쓰는 프로필: ADS에 들어갈 때의 무기 프로필을 블렌드가 0이 될 때까지 유지.
   * ADS 중 무기를 바꾸면 프로필은 즉시 바뀌지만, 화면은 이전 무기의 ADS 위치에서 일반 시점으로 부드럽게 돌아온다
   * (권총 오버숄더 ↔ 주무기 ADS처럼 카메라 위치가 다른 무기 사이에서 한 프레임 튀는 것 방지)
   */
  private visual: AimProfile | null = null;
  private aiming = false;
  /** 0..1 선형 진행도 */
  private progress = 0;
  private readonly blockers = new Set<AimBlockReason>();
  private readonly listeners = new Set<(aiming: boolean, reason?: AimResetReason) => void>();

  get isAiming(): boolean {
    return this.aiming;
  }

  get currentProfile(): AimProfile | null {
    return this.profile;
  }

  /** 카메라·몸 표시용 프로필 (위 visual 설명) */
  get visualProfile(): AimProfile | null {
    return this.visual ?? this.profile;
  }

  /** 0..1 부드러운 블렌드 (카메라·HUD·무기 수치 보간용) */
  get blend(): number {
    const t = this.progress;
    return t * t * (3 - 2 * t);
  }

  /** 무기 장착/교체 시 호출. 교체하면 항상 ADS 해제. */
  setProfile(profile: AimProfile | null): void {
    this.profile = profile;
    if (this.progress <= 0) this.visual = profile;
    this.reset('weaponSwap');
  }

  /** 지금 ADS를 켤 수 있는지 (막는 행동이 하나도 없을 때) */
  get canAim(): boolean {
    return this.profile !== null && this.blockers.size === 0;
  }

  get activeBlockers(): ReadonlySet<AimBlockReason> {
    return this.blockers;
  }

  /**
   * 매 프레임 행동 상태 반영. 해제 조건(행동이 새로 시작됨)과 진입 가능 조건(진행 중인 행동 없음)을 함께 관리.
   * 행동이 끝나도 ADS를 자동으로 다시 켜지 않는다 (우클릭을 새로 눌러야 함).
   */
  updateActions(a: AimActionState): void {
    const reloadBlocks = a.reloading && !(this.profile?.keepAimWhileReloading ?? false);
    this.setBlocker('sprint', a.sprinting);
    this.setBlocker('airborne', a.airborne);
    this.setBlocker('slide', a.sliding);
    this.setBlocker('reload', reloadBlocks);
  }

  private setBlocker(reason: AimBlockReason, active: boolean): void {
    if (active) {
      if (this.blockers.has(reason)) return;
      this.blockers.add(reason);
      if (this.aiming) this.set(false, reason);
    } else {
      this.blockers.delete(reason);
    }
  }

  toggle(): void {
    this.set(!this.aiming);
  }

  set(aiming: boolean, reason?: AimResetReason): void {
    if (aiming && !this.canAim) return;
    if (aiming === this.aiming) return;
    this.aiming = aiming;
    if (aiming) this.visual = this.profile;
    for (const fn of this.listeners) fn(aiming, reason);
  }

  /** 사망·리스폰·무기 교체 등. instant면 블렌드도 즉시 0. */
  reset(reason: AimResetReason, instant = false): void {
    this.set(false, reason);
    if (instant) this.progress = 0;
  }

  onChange(fn: (aiming: boolean, reason?: AimResetReason) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(dt: number): void {
    const time = Math.max(0.01, this.visualProfile?.transitionTime ?? 0.15);
    const target = this.aiming ? 1 : 0;
    const step = dt / time;
    this.progress = target > this.progress ? Math.min(target, this.progress + step) : Math.max(target, this.progress - step);
    if (this.progress <= 0) this.visual = this.profile;
  }

  /** 프로필 값과 기본값(1)을 블렌드로 보간 */
  private mix(value: number | undefined): number {
    return value == null ? 1 : 1 + (value - 1) * this.blend;
  }

  /** 해제 즉시 1 (달리기 등 해제 원인 행동이 카메라 전환을 기다리지 않게) */
  get moveSpeedMultiplier(): number {
    return this.aiming ? this.mix(this.profile?.moveSpeedMultiplier) : 1;
  }

  get spreadMultiplier(): number {
    return this.mix(this.profile?.spreadMultiplier);
  }

  get recoilMultiplier(): number {
    return this.mix(this.profile?.recoilMultiplier);
  }

  get lookSensitivityMultiplier(): number {
    return this.mix(this.profile?.lookSensitivityMultiplier);
  }
}

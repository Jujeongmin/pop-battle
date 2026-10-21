import type { WeaponDef } from '../config/weapons';

export interface SpreadContext {
  moving: boolean;
  airborne: boolean;
  sliding: boolean;
  /** AimController.spreadMultiplier */
  aimMultiplier: number;
}

/** 탄약·연사·재장전·탄퍼짐 상태. 렌더링·물리와 무관한 순수 로직 (서버 판정으로 옮기기 쉬움). */
export class Weapon {
  magazine: number;
  reserve: number;
  reloading = false;
  reloadElapsed = 0;
  private cooldown = 0;
  private bloomDeg = 0;
  private triggerWasHeld = false;
  /** 시계를 넘겨받지 못할 때(봇 등) 쓰는 자체 시계 */
  private localTime = 0;
  /** 퀵스왑 무기: 마지막·그 전 발사 시각 (게임 시계, 무기를 넣어 둔 동안에도 흐름) */
  lastShotAt = -Infinity;
  prevShotAt = -Infinity;
  /** 마지막 발사의 후딜레이가 다른 무기 장착 완료로 취소됨 */
  recoveryCancelled = false;

  constructor(readonly def: WeaponDef) {
    this.magazine = def.magazineSize;
    this.reserve = def.reserveAmmo;
  }

  get fireInterval(): number {
    return 60 / this.def.rpm;
  }

  get reloadProgress(): number {
    return this.reloading ? Math.min(1, this.reloadElapsed / this.def.reloadTime) : 0;
  }

  get canReload(): boolean {
    return !this.reloading && this.magazine < this.def.magazineSize && this.reserve > 0;
  }

  /** @returns 재장전을 시작했으면 true */
  startReload(): boolean {
    if (!this.canReload) return false;
    this.reloading = true;
    this.reloadElapsed = 0;
    return true;
  }

  cancelReload(): void {
    this.reloading = false;
    this.reloadElapsed = 0;
  }

  /** 퀵스왑: 지금 후딜레이 중인지 (취소되지 않았고 일반 발사 간격이 안 지남) */
  recovering(now: number): boolean {
    return !!this.def.quickSwap && !this.recoveryCancelled && now < this.lastShotAt + this.fireInterval;
  }

  /** 퀵스왑: 다른 무기 장착이 완료됐을 때만 호출. 후딜레이 중이었으면 취소하고 true */
  cancelRecovery(now: number): boolean {
    if (!this.recovering(now)) return false;
    this.recoveryCancelled = true;
    return true;
  }

  /** 퀵스왑 무기의 다음 발사 가능 시각 (최소 간격·후딜레이 반영, 장착·교체 상태는 별도) */
  nextShotAt(): number {
    const q = this.def.quickSwap;
    if (!q) return -Infinity;
    const min = this.lastShotAt + q.minFireInterval;
    return this.recoveryCancelled ? min : Math.max(min, this.lastShotAt + this.fireInterval);
  }

  /**
   * 프레임 업데이트. 발사해야 할 탄 수를 돌려준다 (600RPM이면 프레임당 0~1발, 저프레임이면 여러 발).
   * @param opts.now 게임 시계 (퀵스왑 무기의 최소 간격 계산). 없으면 자체 시계
   * @param opts.canFire false면 방아쇠 상태만 기록하고 발사 안 함 (무기 교체 중: 반자동은 다시 눌러야 발사)
   * @returns { shots, reloadFinished, dryFire }
   */
  update(dt: number, triggerHeld: boolean, opts?: { now?: number; canFire?: boolean }): { shots: number; reloadFinished: boolean; dryFire: boolean } {
    this.localTime += dt;
    const now = opts?.now ?? this.localTime;
    const canFire = opts?.canFire ?? true;
    let reloadFinished = false;
    let dryFire = false;
    const s = this.def.spread;
    this.bloomDeg = Math.max(0, this.bloomDeg - s.bloomRecoveryDegPerSec * dt);

    if (this.reloading) {
      this.reloadElapsed += dt;
      if (this.reloadElapsed >= this.def.reloadTime) {
        const need = this.def.magazineSize - this.magazine;
        const take = Math.min(need, this.reserve);
        this.magazine += take;
        this.reserve -= take;
        this.reloading = false;
        reloadFinished = true;
      }
    }

    this.cooldown -= dt;
    let shots = 0;
    const pressedNow = triggerHeld && !this.triggerWasHeld;
    const wantFire = canFire && triggerHeld && (this.def.automatic || pressedNow);
    const q = this.def.quickSwap;
    if (wantFire && !this.reloading) {
      if (this.magazine <= 0) {
        if (pressedNow) dryFire = true;
      } else if (q) {
        // 퀵스왑 무기: 쿨다운 대신 마지막 발사 시각 기준 (교체해도 최소 간격은 초기화되지 않음)
        if (now >= this.nextShotAt()) {
          this.magazine--;
          shots = 1;
          this.prevShotAt = this.lastShotAt;
          this.lastShotAt = now;
          this.recoveryCancelled = false;
          this.bloomDeg = Math.min(s.bloomMaxDeg, this.bloomDeg + s.bloomPerShotDeg);
        }
      } else {
        // 쿨다운이 쌓이지 않게: 쉬다가 쏘면 바로 1발
        if (this.cooldown < -this.fireInterval) this.cooldown = 0;
        while (this.cooldown <= 0 && this.magazine > 0) {
          this.magazine--;
          shots++;
          this.cooldown += this.fireInterval;
          this.bloomDeg = Math.min(s.bloomMaxDeg, this.bloomDeg + s.bloomPerShotDeg);
          if (!this.def.automatic) break;
        }
      }
    }
    if (this.cooldown < 0 && !wantFire) this.cooldown = 0;
    this.triggerWasHeld = triggerHeld;
    return { shots, reloadFinished, dryFire };
  }

  /** 현재 탄퍼짐 반각(도). 점프·슬라이딩 중 정확도 감소, ADS 시 증가. */
  spreadDeg(ctx: SpreadContext): number {
    const s = this.def.spread;
    let deg = s.baseDeg + this.bloomDeg;
    if (ctx.moving) deg += s.movingAddDeg;
    if (ctx.airborne) deg += s.airAddDeg;
    else if (ctx.sliding) deg += s.slideAddDeg;
    return deg * ctx.aimMultiplier;
  }

  refill(): void {
    this.magazine = this.def.magazineSize;
    this.reserve = this.def.reserveAmmo;
    this.cancelReload();
    this.bloomDeg = 0;
    this.cooldown = 0;
    this.lastShotAt = -Infinity;
    this.prevShotAt = -Infinity;
    this.recoveryCancelled = false;
  }
}

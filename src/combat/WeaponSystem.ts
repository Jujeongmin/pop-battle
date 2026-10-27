import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { WEAPON_SWITCH_TIME, type WeaponDef } from '../config/weapons';
import type { AttackerInfo, Physics, RayHit } from '../physics/Physics';
import type { AimController } from './AimController';
import { canDamage } from './teams';
import { applyShotDamage, pelletInCone, traceFromMuzzle, type ShotResult } from './hitscan';
import { meleeAttack, type MeleeResult } from './melee';
import { Weapon } from './Weapon';

export type { ShotResult } from './hitscan';

/** 지금 쏘면 어떻게 되는지 (탄퍼짐 제외, 실제 사격과 같은 판정 경로) */
export interface ShotPrediction {
  /** 화면 중앙 조준점보다 앞에서 총구 경로가 막힘 */
  blocked: boolean;
  /** 실제 판정 경로 (탄퍼짐 없는 중앙 기준). 사격 경로 디버그 미리보기용 */
  shot: ShotResult;
  /** 실제 탄착 지점 */
  impact: THREE.Vector3;
  /** 카메라 중앙 레이가 처음 닿은 곳 (없으면 null) */
  cameraHit: RayHit | null;
  /** 실제로 맞을 적 피격 부위 (살아 있는 적만) */
  enemy: { name: string; part: 'head' | 'body' } | null;
}

export interface WeaponFrame {
  dt: number;
  triggerHeld: boolean;
  /** 모바일 권총 길게 누르기: 무기 자체 RPM을 유지하며 반자동 트리거를 반복한다. */
  automaticTrigger?: boolean;
  reloadPressed: boolean;
  canAct: boolean;
  camera: THREE.PerspectiveCamera;
  /** 카메라 레이 시작을 캐릭터 근처까지 당기기 위한 기준점 */
  pivot: THREE.Vector3;
  muzzle: THREE.Vector3;
  /** 장애물 관통 방지: 가슴 → 총구 → 조준점 경로 검사 기준 */
  chest: THREE.Vector3;
  moving: boolean;
  airborne: boolean;
  sliding: boolean;
  /** 근접 판정 방향: 캐릭터 몸 정면 (수평, 정규화). 없으면 카메라 방향 */
  bodyForward?: THREE.Vector3;
}

export interface WeaponCallbacks {
  /** 방아쇠 1회 발사 (총구 화염·발사음) */
  onFire(muzzle: THREE.Vector3, def: WeaponDef): void;
  /** 탄(펠릿) 1발 판정 결과 (궤적·탄착) */
  onShot(result: ShotResult): void;
  /** 방아쇠 1회의 모든 펠릿 결과 (히트마커·피해 숫자는 여기서 한 번만) */
  onVolley?(results: readonly ShotResult[]): void;
  /** 근접: 휘두르기 시작 / 판정 결과 */
  onMeleeSwing?(def: WeaponDef): void;
  onMelee?(result: MeleeResult, def: WeaponDef): void;
  /** 재장전 시작 / 완료 (사운드) */
  onReload?(phase: 'start' | 'end'): void;
  /** 빈 탄창으로 방아쇠 (사운드만, 판정·재장전 규칙과 무관) */
  onDryFire?(): void;
  onRecoil(pitchRad: number, yawRad: number, recoveryRatio: number, recoverySharpness: number): void;
}

const _fwd = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _tmp = new THREE.Vector3();
// predict 전용 (매 프레임 HUD 예측). 결과에 남는 값(aimDebug)은 복사해서 넣음
const _pFwd = new THREE.Vector3();
const _pOrigin = new THREE.Vector3();
const _pAim = new THREE.Vector3();

/**
 * 로컬 히트스캔 사격. 카메라 중앙 레이로 조준점을 구하고, 실제 탄은 총구에서 조준점으로 검사해
 * 엄폐물 뒤에서 카메라만 내밀고 쏘는 관통을 막는다. 멀티플레이 판정은 이후 서버로 이전.
 */
export class WeaponSystem {
  /** 현재 든 무기 (무기마다 인스턴스가 따로 있어 교체해도 탄약 유지) */
  weapon: Weapon;
  private readonly owned = new Map<string, Weapon>();
  private equipTimer = WEAPON_SWITCH_TIME;
  kick = 0;
  timeSinceShot = 99;
  lastSpreadDeg = 0;
  /** 근접: 휘두르기 경과 (-1 = 안 휘두름), 판정 완료 여부, 다음 공격까지 */
  private swingTime = -1;
  private swingHit = false;
  private meleeCooldown = 0;
  private readonly volley: ShotResult[] = [];
  /** 개발용: 켜면 탄마다 카메라 조준 레이 정보(aimDebug)를 결과에 담음 (사격 경로 디버그) */
  traceDebug = false;
  /** 게임 시계 (퀵스왑 최소 발사 간격 기준. 넣어 둔 무기에도 공통으로 흐름) */
  clock = 0;
  /** 디버그: 마지막 퀵스왑(후딜레이 취소) 시각 */
  lastQuickSwapAt = -Infinity;
  /**
   * 볼트액션 후 자동 재조준 예약 (ADS 상태로 쏜 볼트액션 무기). 볼트가 정상적으로 끝났을 때만 ADS 복귀.
   * 교체·재장전·사망·우클릭·ADS 불가 행동이면 취소 → 나중에 갑자기 켜지지 않음
   */
  private reaimFor: Weapon | null = null;

  constructor(
    def: WeaponDef,
    private readonly physics: Physics,
    private readonly aim: AimController,
    /** 쏘는 캐릭터 강체 (자기 캡슐·히트박스는 판정 제외) */
    private readonly shooter: RAPIER.RigidBody,
    /** 발사 순간 공격자 정보 (적대 판정·피해 방향 표시) */
    private readonly attacker: () => AttackerInfo,
    private readonly cb: WeaponCallbacks,
  ) {
    this.weapon = this.instance(def);
    this.equip(def);
  }

  /** 무기별 상태 (처음 들 때 한 번 만들고 계속 재사용) */
  private instance(def: WeaponDef): Weapon {
    let w = this.owned.get(def.id);
    if (!w) {
      w = new Weapon(def);
      this.owned.set(def.id, w);
    }
    return w;
  }

  /** 디버그·HUD: 무기 id별 상태 (없으면 아직 들어 본 적 없음) */
  stateOf(def: WeaponDef): Weapon | undefined {
    return this.owned.get(def.id);
  }

  get def(): WeaponDef {
    return this.weapon.def;
  }

  get isMelee(): boolean {
    return this.weapon.def.kind === 'melee';
  }

  /** 교체 중 (사격·ADS 불가) */
  get switching(): boolean {
    return this.equipTimer > 0;
  }

  /** 0..1 무기를 드는 진행도 */
  get raise(): number {
    return WEAPON_SWITCH_TIME > 0 ? 1 - this.equipTimer / WEAPON_SWITCH_TIME : 1;
  }

  /**
   * 볼트액션 진행도 0..1 (현재 무기가 후딜레이 중일 때만, 아니면 0).
   * 퀵스왑으로 후딜레이가 취소되면 recovering이 false → 연출도 바로 끝남 (발사 가능 상태와 일치)
   */
  get boltProgress(): number {
    const w = this.weapon;
    if (!w.def.quickSwap || !w.recovering(this.clock)) return 0;
    return Math.min(1, (this.clock - w.lastShotAt) / w.fireInterval);
  }

  /** 볼트액션 후 자동 재조준이 예약돼 있는지 */
  get reaimPending(): boolean {
    return this.reaimFor !== null;
  }

  /** 자동 재조준 예약 취소 (우클릭·사망 등) */
  cancelReaim(): void {
    this.reaimFor = null;
  }

  /** 근접 휘두르기 진행도 0..1 (안 휘두르면 0) */
  get swingProgress(): number {
    const m = this.weapon.def.melee;
    return m && this.swingTime >= 0 ? Math.min(1, this.swingTime / m.swingDuration) : 0;
  }

  get ready(): boolean {
    return this.equipTimer <= 0;
  }

  /**
   * 무기 장착/교체: 이전 무기 재장전 취소(탄약 상태는 그대로), 교체 시간 동안 사격·ADS 불가, ADS 해제.
   * 근접무기는 ADS 프로필이 없어 조준 자체가 불가.
   */
  equip(def: WeaponDef): void {
    // 교체하면 자동 재조준 예약 취소 (퀵스왑 후 스나이퍼로 돌아와도 우클릭 전까지 비조준)
    this.reaimFor = null;
    this.weapon.cancelReload();
    this.weapon = this.instance(def);
    this.weapon.cancelReload();
    this.equipTimer = WEAPON_SWITCH_TIME;
    this.kick = 0;
    this.swingTime = -1;
    this.meleeCooldown = 0;
    this.aim.setProfile(def.aim);
    // 즉시 교체(교체 시간 0)면 지금 장착 완료
    if (this.equipTimer <= 0) this.onEquipped();
  }

  /**
   * 무기 장착 완료 (즉시 교체면 equip 직후, 교체 시간이 있으면 끝난 순간).
   * - 퀵스왑: 다른 무기가 실제로 장착됐으므로 넣어 둔 스나이퍼의 후딜레이 취소 확정 (최소 발사 간격은 그대로)
   *   같은 슬롯 재선택은 equip이 일어나지 않아 취소 없음
   * - 빈 탄창으로 꺼내면 예비 탄약이 있을 때 자동 재장전 (중복 시작은 Weapon.startReload가 막음)
   */
  private onEquipped(): void {
    for (const w of this.owned.values()) {
      if (w !== this.weapon && w.cancelRecovery(this.clock)) this.lastQuickSwapAt = this.clock;
    }
    if (this.weapon.def.kind === 'gun' && this.weapon.magazine === 0) this.requestReload();
  }

  /** 디버그: 퀵스왑 무기 상태 (없으면 null) */
  quickSwapDebug(): { lastShotAgo: number; recovering: boolean; cancelled: boolean; nextShotIn: number; lastInterval: number; equipped: boolean } | null {
    const w = [...this.owned.values()].find((x) => x.def.quickSwap);
    if (!w) return null;
    return {
      lastShotAgo: this.clock - w.lastShotAt,
      recovering: w.recovering(this.clock),
      cancelled: w.recoveryCancelled,
      nextShotIn: Math.max(0, w.nextShotAt() - this.clock),
      lastInterval: w.lastShotAt - w.prevShotAt,
      equipped: w === this.weapon,
    };
  }

  /** 리스폰: 모든 무기 탄약 보충 */
  resetForRespawn(): void {
    this.reaimFor = null;
    for (const w of this.owned.values()) w.refill();
    this.equipTimer = WEAPON_SWITCH_TIME;
    this.kick = 0;
    this.swingTime = -1;
    this.meleeCooldown = 0;
  }

  update(f: WeaponFrame): void {
    this.clock += f.dt;
    const wasSwitching = this.equipTimer > 0;
    this.equipTimer = Math.max(0, this.equipTimer - f.dt);
    // 교체 시간이 있는 설정: 다른 무기의 장착이 실제로 끝난 순간에만 완료 처리
    // (교체 도중 되돌리면 그 무기는 완료되지 않으므로 퀵스왑 취소 없음)
    if (wasSwitching && this.equipTimer <= 0) this.onEquipped();
    this.timeSinceShot += f.dt;
    this.kick = Math.max(0, this.kick - f.dt * 0.6);
    this.updateReaim();
    if (this.isMelee) {
      this.updateMelee(f);
      return;
    }
    const w = this.weapon;

    if (f.canAct && f.reloadPressed) this.requestReload();
    // 교체 중에는 발사 불가. 방아쇠 상태는 계속 넘겨 반자동 무기는 교체 후 다시 눌러야 발사
    const triggerHeld = f.canAct && f.triggerHeld;
    const result = w.update(f.dt, triggerHeld, { now: this.clock, canFire: this.ready, automatic: f.automaticTrigger });
    if (result.reloadFinished) this.cb.onReload?.('end');
    // 빈 탄창으로 방아쇠 → 자동 재장전 (예비 탄약이 없으면 Weapon.canReload가 막는다)
    if (result.dryFire) {
      this.cb.onDryFire?.();
      this.requestReload();
    }

    this.lastSpreadDeg = w.spreadDeg({
      moving: f.moving,
      airborne: f.airborne,
      sliding: f.sliding,
      aimMultiplier: this.aim.spreadMultiplier,
    });
    for (let i = 0; i < result.shots; i++) this.fireOne(f);
    // 마지막 탄을 쏜 직후 자동 재장전 (수동 R과 같은 경로)
    if (result.shots > 0 && w.magazine === 0) this.requestReload();
  }

  get reloadProgress(): number {
    return this.weapon.reloadProgress;
  }

  /**
   * 재장전 단일 진입점 (R키·빈 탄창 방아쇠·마지막 탄 자동).
   * 이미 재장전 중이거나 탄창이 가득 찼거나 예비 탄약이 없으면 무시 → 중복 실행 없음.
   */
  requestReload(): boolean {
    // ADS 해제는 AimController가 재장전 상태를 보고 처리 (여기서 ADS를 직접 바꾸지 않음)
    if (!this.weapon.startReload()) return false;
    // 탄창 재장전은 볼트액션과 별개: 재장전이 시작되면 자동 재조준 없음
    this.reaimFor = null;
    this.cb.onReload?.('start');
    return true;
  }

  private fireOne(f: WeaponFrame): void {
    const def = this.weapon.def;
    this.timeSinceShot = 0;
    f.camera.getWorldDirection(_fwd);
    // 카메라 레이는 캐릭터 옆(피벗 투영점)에서 시작: 카메라와 캐릭터 사이 물체를 맞히지 않게
    const t0 = Math.max(0, _tmp.subVectors(f.pivot, f.camera.position).dot(_fwd));
    _origin.copy(f.camera.position).addScaledVector(_fwd, t0);

    const attacker = this.attacker();
    // 펠릿마다 개별 판정 (탄약은 Weapon.update에서 1발만 소모)
    this.volley.length = 0;
    const rotation = Math.random() * Math.PI * 2;
    for (let p = 0; p < def.pellets; p++) {
      pelletInCone(_fwd, this.lastSpreadDeg, p, def.pellets, rotation, _dir);
      const camHit = this.physics.raycast(_origin, _dir, def.range, undefined, this.shooter);
      const aimPoint = camHit ? camHit.point : _origin.clone().addScaledVector(_dir, def.range);
      const shot = traceFromMuzzle(this.physics, f.chest, f.muzzle, aimPoint, camHit, this.shooter);
      if (this.traceDebug) shot.aimDebug = { origin: _origin.clone(), dir: _dir.clone(), chest: f.chest.clone() };
      applyShotDamage(shot, def, _dir, attacker);
      this.cb.onShot(shot);
      this.volley.push(shot);
    }
    this.cb.onVolley?.(this.volley);

    this.cb.onFire(f.muzzle.clone(), def);
    // 볼트액션 저격총: 발사 직후 ADS 해제. ADS로 쐈고 탄창이 남았으면(마지막 탄 → 자동 재장전) 볼트 후 재조준 예약
    if (def.aim?.releaseAfterShot) {
      const wasAiming = this.aim.isAiming;
      this.aim.reset('boltAction');
      this.reaimFor = wasAiming && this.weapon.magazine > 0 ? this.weapon : null;
    }
    const r = def.recoil;
    const m = this.aim.recoilMultiplier;
    // ADS 중 총이 뒤로 밀리는 양은 Game에서 aim.kickScale로 줄인다
    this.cb.onRecoil(
      THREE.MathUtils.degToRad(r.pitchDeg * m),
      THREE.MathUtils.degToRad((Math.random() * 2 - 1) * r.yawJitterDeg * m),
      r.recoveryRatio,
      r.recoverySharpness,
    );
    this.kick = Math.min(r.visualKick * 1.6, this.kick + r.visualKick);
  }

  /**
   * 탄퍼짐 없이 지금 쏘면 어디에 맞는지 예측 (HUD 표시용, 실제 사격과 같은 판정 경로).
   * blocked = 화면 중앙 조준점보다 앞에서 총구 경로가 장애물에 막힘.
   */
  predict(f: WeaponFrame): ShotPrediction {
    const def = this.weapon.def;
    if (def.melee) {
      // 근접: 지금 휘두르면 맞을 대상 (조준선 빨강). 판정 방향 = 몸 정면 (휘두르기 연출과 같은 기준)
      const fwd = f.bodyForward ? _fwd.copy(f.bodyForward) : f.camera.getWorldDirection(_fwd);
      const r = meleeAttack(this.physics, def.melee, def.damage, f.chest, fwd, this.shooter, this.attacker(), false);
      const h = r.hits[0];
      const none: ShotResult = { from: f.chest.clone(), aimPoint: f.chest.clone(), aimHit: null, stage: 'clear', hit: null, end: f.chest.clone(), damage: 0, headshot: false, killed: false };
      return { blocked: false, shot: none, impact: f.chest.clone(), cameraHit: null, enemy: h ? { name: h.target.name ?? 'target', part: h.part } : null };
    }
    const fwd = f.camera.getWorldDirection(_pFwd);
    const t0 = Math.max(0, _tmp.subVectors(f.pivot, f.camera.position).dot(fwd));
    const origin = _pOrigin.copy(f.camera.position).addScaledVector(fwd, t0);
    const camHit = this.physics.raycast(origin, fwd, def.range, undefined, this.shooter);
    // traceFromMuzzle은 조준점을 복사해 씀 → 맞은 곳이 없을 때 조준점은 임시 벡터로 충분
    const aimPoint = camHit ? camHit.point : _pAim.copy(origin).addScaledVector(fwd, def.range);
    const shot = traceFromMuzzle(this.physics, f.chest, f.muzzle, aimPoint, camHit, this.shooter);
    if (this.traceDebug) shot.aimDebug = { origin: origin.clone(), dir: fwd.clone(), chest: f.chest.clone() };
    const blocked = shot.end.distanceTo(aimPoint) > 0.3;
    // 적 판정은 카메라가 아니라 실제 탄이 맞는 대상 기준 (총구가 벽에 막히면 적이 보여도 아님)
    const hb = shot.hit?.hitbox;
    const enemy = hb && hb.target.alive && canDamage(this.attacker(), hb.target) ? { name: hb.target.name ?? 'target', part: hb.part } : null;
    return { blocked, shot, impact: shot.end, cameraHit: camHit, enemy };
  }

  /** 근접: 시간 기반 휘두르기, hitTime에 한 번만 판정 (프레임 속도와 무관) */
  private updateMelee(f: WeaponFrame): void {
    const def = this.weapon.def;
    const m = def.melee!;
    this.lastSpreadDeg = 0;
    this.meleeCooldown = Math.max(0, this.meleeCooldown - f.dt);
    if (this.swingTime >= 0) {
      this.swingTime += f.dt;
      if (!this.swingHit && this.swingTime >= m.hitTime) {
        this.swingHit = true;
        // 판정 방향 = 몸 정면 (마우스 조준과 무관, 휘두르기 연출과 같은 기준). 사거리·각도·데미지는 MeleeProfile 그대로
        const fwd = f.bodyForward ? _fwd.copy(f.bodyForward) : f.camera.getWorldDirection(_fwd);
        const result = meleeAttack(this.physics, m, def.damage, f.chest, fwd, this.shooter, this.attacker(), true, def.id);
        this.cb.onMelee?.(result, def);
      }
      if (this.swingTime >= m.swingDuration) this.swingTime = -1;
    }
    const trigger = f.canAct && this.ready && f.triggerHeld;
    if (trigger && this.meleeCooldown <= 0 && this.swingTime < 0) {
      this.swingTime = 0;
      this.swingHit = false;
      this.meleeCooldown = 60 / def.rpm;
      this.timeSinceShot = 0;
      this.cb.onMeleeSwing?.(def);
    }
  }

  /** 자동 재조준: ADS 불가 행동이 생기면 취소, 볼트가 끝났고 같은 무기를 들고 있고 ADS 가능하면 복귀 */
  private updateReaim(): void {
    const w = this.reaimFor;
    if (!w) return;
    if (w !== this.weapon || w.reloading || this.aim.activeBlockers.size > 0) {
      this.reaimFor = null;
      return;
    }
    if (w.recovering(this.clock)) return;
    this.reaimFor = null;
    if (this.aim.canAim && !this.aim.isAiming) this.aim.set(true);
  }
}

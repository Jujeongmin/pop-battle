import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BotBrain, type BotIntent, type BotPerception, type BotWorld } from '../ai/BotBrain';
import { CharacterHitboxes } from '../combat/CharacterHitboxes';
import type { Combatant } from '../combat/Combatant';
import { Health } from '../combat/Health';
import { applyShotDamage, pelletInCone, traceFromMuzzle, type ShotResult } from '../combat/hitscan';
import { areHostile } from '../combat/teams';
import { Weapon } from '../combat/Weapon';
import { BOT, type BotDifficulty } from '../config/bots';
import { TEAMS } from '../config/combat';
import { CHARACTER } from '../config/gameConfig';
import type { WeaponDef } from '../config/weapons';
import type { AttackerInfo, HitInfo, HitPart, Physics } from '../physics/Physics';
import type { PlayerAvatar } from '../player/PlayerAvatar';
import { PlayerController } from '../player/PlayerController';

export interface BotCallbacks {
  /** 방아쇠 1회 (총구 화염·발사음) */
  onFire(bot: Bot, muzzle: THREE.Vector3): void;
  /** 탄 1발 판정 결과 */
  onShot(bot: Bot, result: ShotResult): void;
  onReload?(bot: Bot, phase: 'start' | 'end'): void;
  /** 이 봇이 피해를 받음 */
  onDamaged?(bot: Bot, hit: HitInfo, applied: number): void;
  /** 이 봇이 쓰러짐 (한 번의 사망에 한 번). killer = 마지막 피해를 준 공격자 (없으면 null) */
  onDeath?(bot: Bot, killer: AttackerInfo | null, hit: HitInfo): void;
  /** 부활함 */
  onRespawn?(bot: Bot): void;
}

/** 감지 단계에서 봇이 보는 세계 (BotManager가 제공) */
export interface BotContext {
  combatants: readonly Combatant[];
  findById(id: string): Combatant | undefined;
}

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _shotDir = new THREE.Vector3();
/** 매치 대기·카운트다운·종료 중 (전투 정지): 이동·조준·사격 없음 */
const HOLD_INTENT: BotIntent = { state: 'idle', moveTo: null, sprint: false, lookAt: null, fire: false, reload: false, moveTargetChanged: false };

function dampAngle(current: number, target: number, sharpness: number, dt: number): number {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + diff * (1 - Math.exp(-sharpness * dt));
}

/** a를 b 쪽으로 최대 maxAngle(라디안) 회전 (정규화 벡터) */
function rotateTowards(a: THREE.Vector3, b: THREE.Vector3, maxAngle: number): void {
  const angle = a.angleTo(b);
  if (angle <= maxAngle || angle < 1e-5) {
    a.copy(b);
    return;
  }
  const axis = _v3.crossVectors(a, b);
  if (axis.lengthSq() < 1e-10) axis.copy(UP);
  axis.normalize();
  a.applyQuaternion(_q.setFromAxisAngle(axis, maxAngle)).normalize();
}

/**
 * 전투 봇 1개: 이동(플레이어와 같은 Rapier 캐릭터 컨트롤러) + 무기(같은 Weapon 규칙) + 체력·판정 영역 + 결정(BotBrain).
 * 결정·감지는 일정 간격, 이동은 고정 스텝, 애니메이션·조준 회전은 렌더 프레임.
 */
export class Bot implements Combatant {
  readonly team = TEAMS.bots;
  readonly controller: PlayerController;
  readonly hitboxes: CharacterHitboxes;
  /** 체력: 캐릭터 능력치 최대 체력 (BOT.maxHp는 쓰지 않음) */
  readonly health: Health;
  readonly weapon: Weapon;
  readonly brain: BotBrain;
  readonly perception: BotPerception = {
    visible: false,
    targetPos: new THREE.Vector3(),
    targetVelocity: new THREE.Vector3(),
    lastSeenAge: 99,
    hasTarget: false,
    distance: 0,
    canShoot: false,
  };
  target: Combatant | null = null;
  /** 현재 경로 (다듬은 웨이포인트) */
  path: THREE.Vector3[] = [];
  pathIndex = 0;
  timeSinceShot = 99;
  deathTimer = 0;
  /** 디버그: 실제로 방아쇠를 당기는 중 (조준 각도·경로 조건 통과) */
  firing = false;
  /** 디버그: 경로 탐색 실패 횟수 */
  pathFailures = 0;

  private bodyYaw = 0;
  readonly aimDir = new THREE.Vector3(0, 0, 1);
  readonly renderFeet = new THREE.Vector3();
  /** 총구 월드 위치 (총구 화염이 따라감) */
  readonly muzzle = new THREE.Vector3();
  private readonly chest = new THREE.Vector3();
  private perceptionTimer: number;
  private decisionTimer: number;
  private decisionElapsed = 0;
  private repathTimer = 0;
  private needsRepath = false;
  private stuckTimer = 0;
  private stuckCount = 0;
  private readonly stuckFrom = new THREE.Vector3();
  private kick = 0;
  /** 조준 오차: 표적 주변 오프셋 (월드), 주기적으로 새로 뽑아 부드럽게 따라감 */
  private readonly aimError = new THREE.Vector3();
  private readonly aimErrorTarget = new THREE.Vector3();
  private aimErrorTimer = 0;
  private aimPart: HitPart = 'body';
  private readonly attackerInfo: { id: string; name: string; team: string; position: THREE.Vector3 };

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly physics: Physics,
    /** 캐릭터 아바타 (개발용 캐릭터 교체 시 setAvatar로 바뀜) */
    public avatar: PlayerAvatar,
    def: WeaponDef,
    private readonly world: BotWorld,
    difficulty: BotDifficulty,
    spawnFeet: THREE.Vector3,
    private readonly cb: BotCallbacks,
    index: number,
  ) {
    const center = spawnFeet.clone();
    this.controller = new PlayerController(physics, center);
    // 캐릭터 능력치: 플레이어와 같은 규칙 (체력·이동 속도 배율, 판정은 아바타 실측)
    this.health = new Health(avatar.character.stats.maxHp);
    this.controller.speedScale = avatar.character.stats.speed;
    center.y += this.controller.footOffset;
    this.controller.teleport(center);
    this.hitboxes = new CharacterHitboxes(physics, this.controller.body, this, avatar.headRadius);
    this.weapon = new Weapon(def);
    this.brain = new BotBrain(world, difficulty);
    this.attackerInfo = { id, name, team: this.team, position: new THREE.Vector3() };
    // 봇마다 감지·결정 시점을 어긋나게 (한 프레임에 몰리지 않게)
    this.perceptionTimer = (index * BOT.ai.perceptionInterval) / 3;
    this.decisionTimer = (index * BOT.ai.decisionInterval) / 3;
    this.renderFeet.copy(spawnFeet);
    this.bodyYaw = Math.atan2(-spawnFeet.x, -spawnFeet.z);
    this.aimDir.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw));
    this.health.reset(BOT.spawnProtection);
  }

  get rigidBody(): RAPIER.RigidBody {
    return this.controller.body;
  }

  get alive(): boolean {
    return this.health.alive;
  }

  get targetable(): boolean {
    return this.health.alive;
  }

  get isProtected(): boolean {
    return this.health.protected;
  }

  get velocity(): THREE.Vector3 {
    return this.controller.velocity;
  }

  get state(): string {
    return this.brain.state;
  }

  getFeet(out: THREE.Vector3): THREE.Vector3 {
    const p = this.controller.position;
    return out.set(p.x, p.y - this.controller.footOffset, p.z);
  }

  getAimPoint(part: HitPart, out: THREE.Vector3): THREE.Vector3 {
    const t = (part === 'head' ? this.hitboxes.head : this.hitboxes.body).translation();
    return out.set(t.x, t.y, t.z);
  }

  getEye(out: THREE.Vector3): THREE.Vector3 {
    return this.getAimPoint('head', out);
  }

  applyHit(hit: HitInfo): number {
    const applied = this.health.applyDamage(hit.damage);
    if (applied <= 0) return 0;
    this.brain.onDamaged();
    this.cb.onDamaged?.(this, hit, applied);
    if (!this.health.alive) {
      this.die();
      this.cb.onDeath?.(this, hit.attacker ?? null, hit);
    }
    return applied;
  }

  /** 피격 → 공격자를 인지 (안 보여도 그 방향을 추적) */
  noticeAttacker(attacker: Combatant | undefined, from: THREE.Vector3): void {
    if (!attacker || !attacker.targetable || !areHostile(this, attacker)) return;
    if (this.target && this.target !== attacker && this.perception.visible) return;
    this.target = attacker;
    this.perception.hasTarget = true;
    if (!this.perception.visible) {
      this.perception.targetPos.copy(from).setY(0);
      this.perception.lastSeenAge = 0;
    }
  }

  private die(): void {
    this.health.kill();
    this.deathTimer = BOT.respawnDelay;
    this.weapon.cancelReload();
    // 시체는 다른 캐릭터·사격 판정에서 제외
    this.controller.setCollisionEnabled(false);
    this.hitboxes.setEnabled(false);
    this.brain.reset(true);
    this.target = null;
    this.perception.hasTarget = false;
    this.path = [];
    this.firing = false;
  }

  /** 지정 위치(발)에서 부활: 체력·탄약·결정 초기화 + 리스폰 보호 */
  respawn(feet: THREE.Vector3, faceToward: THREE.Vector3): void {
    const center = _v1.copy(feet);
    center.y += this.controller.footOffset;
    this.controller.teleport(center);
    this.controller.setCollisionEnabled(true);
    this.hitboxes.setEnabled(true);
    this.health.reset(BOT.spawnProtection);
    this.weapon.refill();
    this.brain.reset(false);
    this.target = null;
    this.perception.hasTarget = false;
    this.perception.visible = false;
    this.perception.lastSeenAge = 99;
    this.path = [];
    this.pathIndex = 0;
    this.kick = 0;
    this.renderFeet.copy(feet);
    this.bodyYaw = Math.atan2(faceToward.x - feet.x, faceToward.z - feet.z);
    this.aimDir.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw));
    this.deathTimer = 0;
    this.firing = false;
    this.cb.onRespawn?.(this);
  }

  /**
   * 개발용 캐릭터 교체: 이전 아바타 해제, 새 아바타의 능력치(최대 체력·속도)·판정(머리·몸통 실측) 적용.
   * AI·난이도·무기는 그대로. 체력은 새 최대 체력으로 가득
   */
  setAvatar(avatar: PlayerAvatar): void {
    if (avatar === this.avatar) return;
    this.avatar.dispose();
    this.avatar = avatar;
    this.health.setMaxHp(avatar.character.stats.maxHp);
    this.controller.speedScale = avatar.character.stats.speed;
  }

  // ---------------- 감지 ----------------

  private perceive(dt: number, ctx: BotContext): void {
    const det = BOT.detection;
    const p = this.perception;
    const eye = this.getEye(_v1);
    const myFeet = this.getFeet(_v2);
    const halfFov = THREE.MathUtils.degToRad(det.fovDeg / 2);
    const facingYaw = Math.atan2(this.aimDir.x, this.aimDir.z);
    const tracking = p.hasTarget && p.lastSeenAge < det.loseSightTime;

    let best: Combatant | null = null;
    let bestScore = Infinity;
    let heard: Combatant | null = null;
    for (const c of ctx.combatants) {
      if (c === this || !c.targetable || !areHostile(this, c)) continue;
      const feet = c.getFeet(_v3);
      const dist = Math.hypot(feet.x - myFeet.x, feet.z - myFeet.z);
      if (c.timeSinceShot < 0.25 && dist < det.hearRange) heard = c;
      if (dist > det.range) continue;
      // 이미 쫓는 표적은 시야각 무시 (몸을 돌려 확인)
      const rel = Math.atan2(feet.x - myFeet.x, feet.z - myFeet.z) - facingYaw;
      const angle = Math.abs(Math.atan2(Math.sin(rel), Math.cos(rel)));
      if (angle > halfFov && !(tracking && c === this.target)) continue;
      if (!this.canSee(eye, c)) continue;
      // 현재 표적 우선 (자꾸 바꾸지 않게)
      const score = dist - (c === this.target ? 5 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best) {
      if (best !== this.target) p.lastSeenAge = 99; // 새 표적 → 반응 시간 다시
      this.target = best;
      p.hasTarget = true;
      p.visible = true;
      best.getFeet(p.targetPos);
      p.targetVelocity.copy(best.velocity);
      p.lastSeenAge = 0;
    } else {
      p.visible = false;
      p.lastSeenAge += dt;
      if (this.target && !this.target.targetable) {
        this.target = null;
        p.hasTarget = false;
      }
      // 총소리: 안 보여도 그 위치를 추적
      if (heard && (!p.hasTarget || p.lastSeenAge > 0.5)) {
        this.target = heard;
        p.hasTarget = true;
        heard.getFeet(p.targetPos);
        p.lastSeenAge = Math.min(p.lastSeenAge, 0.5);
      }
      if (p.hasTarget && p.lastSeenAge > det.loseSightTime + det.searchTime + 2) {
        this.target = null;
        p.hasTarget = false;
      }
    }
    if (p.hasTarget) p.distance = Math.hypot(p.targetPos.x - myFeet.x, p.targetPos.z - myFeet.z);
    p.canShoot = p.visible && this.target !== null && this.shotPathClear(this.target);
  }

  /** 눈 → 표적 머리/몸통 중 하나라도 장애물 없이 닿는지 */
  private canSee(eye: THREE.Vector3, c: Combatant): boolean {
    for (const part of ['head', 'body'] as const) {
      const to = c.getAimPoint(part, _v3);
      const d = _shotDir.subVectors(to, eye);
      const len = d.length();
      if (len < 1e-3) return true;
      const hit = this.physics.raycast(eye, d.divideScalar(len), len + 0.5, undefined, this.controller.body);
      if (!hit || hit.hitbox?.target === c) return true;
    }
    return false;
  }

  /** 지금 총구에서 표적 몸통까지 실제 탄 경로가 열려 있는지 (사격과 같은 판정) */
  private shotPathClear(c: Combatant): boolean {
    const to = c.getAimPoint('body', _v3);
    const shot = traceFromMuzzle(this.physics, this.chest, this.muzzle, to, null, this.controller.body);
    if (!shot.hit) return true;
    return shot.hit.hitbox?.target === c;
  }

  // ---------------- 프레임 ----------------

  /** 고정 스텝: 경로를 따라 이동 (physics.step 직전). hold = 전투 정지 (제자리, 중력만) */
  fixedStep(dt: number, intent: BotIntent, hold = false): void {
    if (!this.alive) return;
    if (hold) intent = HOLD_INTENT;
    const c = this.controller;
    const feet = this.getFeet(_v1);
    let moveY = 0;
    let yaw = 0;
    const m = BOT.movement;
    if (intent.moveTo && this.pathIndex < this.path.length) {
      let wp = this.path[this.pathIndex]!;
      let dx = wp.x - feet.x;
      let dz = wp.z - feet.z;
      let dist = Math.hypot(dx, dz);
      while (dist < m.arriveRadius && this.pathIndex < this.path.length - 1) {
        this.pathIndex++;
        wp = this.path[this.pathIndex]!;
        dx = wp.x - feet.x;
        dz = wp.z - feet.z;
        dist = Math.hypot(dx, dz);
      }
      const last = this.pathIndex === this.path.length - 1;
      if (last && dist < m.arriveRadius) {
        this.pathIndex = this.path.length;
      } else {
        // 카메라 기준 입력으로 변환: 정면(-sin, -cos) = 이동 방향
        yaw = Math.atan2(-dx, -dz);
        moveY = last ? THREE.MathUtils.clamp(dist / 0.8, 0.35, 1) : 1;
      }
    }
    const moving = moveY > 0;
    c.step(dt, {
      moveX: 0,
      moveY,
      cameraYaw: yaw,
      sprint: moving && intent.sprint && !intent.lookAt,
      speedMultiplier: intent.lookAt && !intent.sprint ? 0.85 : 1,
    });

    // 막힘 감지: 움직이려는데 거의 제자리 → 재탐색, 반복되면 목표 포기
    if (moving) {
      this.stuckTimer += dt;
      if (this.stuckTimer >= m.stuckTime) {
        const moved = Math.hypot(c.position.x - this.stuckFrom.x, c.position.z - this.stuckFrom.z);
        if (moved < m.stuckDistance) {
          this.stuckCount++;
          this.needsRepath = true;
          if (this.stuckCount >= 3) {
            this.stuckCount = 0;
            this.path = [];
            this.brain.onMoveFailed();
          }
        } else {
          this.stuckCount = 0;
        }
        this.stuckTimer = 0;
        this.stuckFrom.copy(c.position);
      }
    } else {
      this.stuckTimer = 0;
      this.stuckFrom.copy(c.position);
    }
  }

  /**
   * 렌더 프레임: 감지·결정(간격), 조준 회전, 애니메이션, 사격.
   * hold = 매치 대기·카운트다운·종료 (전투 정지): 감지·결정·경로·조준·사격 없이 제자리 대기 애니메이션만
   */
  update(dt: number, alpha: number, ctx: BotContext, difficulty: BotDifficulty, hold = false): void {
    this.health.update(dt);
    this.timeSinceShot += dt;
    this.kick = Math.max(0, this.kick - dt * 0.6);
    const ctrl = this.controller;

    if (this.alive) {
      this.renderFeet.lerpVectors(ctrl.prevPosition, ctrl.position, alpha);
      this.renderFeet.y -= ctrl.footOffset;
    } else {
      this.deathTimer -= dt;
    }

    if (this.alive && !hold) {
      this.perceptionTimer -= dt;
      if (this.perceptionTimer <= 0) {
        this.perceive(BOT.ai.perceptionInterval - this.perceptionTimer, ctx);
        this.perceptionTimer += BOT.ai.perceptionInterval;
      }
    }

    this.decisionElapsed += dt;
    this.decisionTimer -= dt;
    if (hold) {
      // 정지 중에는 결정 타이머가 밀리지 않게 (재개 직후 매 프레임 몰아서 결정하지 않도록)
      this.decisionTimer = Math.max(this.decisionTimer, 0);
      this.decisionElapsed = 0;
    } else if (this.decisionTimer <= 0) {
      this.brain.difficulty = difficulty;
      this.brain.think(this.decisionElapsed, this.selfState(), this.perception);
      this.decisionElapsed = 0;
      this.decisionTimer += BOT.ai.decisionInterval;
      if (this.brain.intent.moveTargetChanged) this.needsRepath = true;
    }
    const intent = hold ? HOLD_INTENT : this.brain.intent;
    if (hold) this.firing = false;

    // 경로 (재)계산: 목표 변경·막힘 시, 최소 간격 유지
    this.repathTimer -= dt;
    if (this.alive && intent.moveTo && (this.needsRepath || this.path.length === 0) && this.repathTimer <= 0) {
      const feet = this.getFeet(_v1);
      const path = this.world.nav.findPath(feet, intent.moveTo);
      this.repathTimer = BOT.ai.repathInterval;
      this.needsRepath = false;
      if (path) {
        this.path = path;
        this.pathIndex = 0;
      } else {
        this.path = [];
        this.pathFailures++;
        this.brain.onMoveFailed();
      }
    }
    if (!intent.moveTo) this.path.length = 0;

    if (this.alive) this.updateAim(dt, intent, difficulty);

    // --- 아바타 ---
    const vel = ctrl.velocity;
    const speed = Math.hypot(vel.x, vel.z);
    if (this.alive) {
      let targetYaw = this.bodyYaw;
      if (intent.lookAt) {
        targetYaw = Math.atan2(this.aimDir.x, this.aimDir.z) - THREE.MathUtils.degToRad(CHARACTER.anim.combatYawOffsetDeg);
      } else if (speed > 0.3) {
        targetYaw = Math.atan2(vel.x, vel.z);
      }
      this.bodyYaw = dampAngle(this.bodyYaw, targetYaw, BOT.movement.turnSharpness * (intent.lookAt ? 1.6 : 1), dt);
    }
    this.avatar.update({
      dt,
      feet: this.renderFeet,
      bodyYaw: this.bodyYaw,
      aimDir: this.aimDir,
      pitch: intent.lookAt ? Math.asin(THREE.MathUtils.clamp(this.aimDir.y, -1, 1)) : 0,
      mode: ctrl.mode,
      grounded: ctrl.grounded,
      sprinting: ctrl.sprinting && ctrl.grounded,
      velocity: vel,
      justJumped: ctrl.justJumped,
      justLanded: ctrl.justLanded,
      landedAirTime: ctrl.landedAirTime,
      dead: !this.alive,
      strafing: intent.lookAt !== null,
      weaponKick: this.kick,
      weaponRaise: 1,
      reloadProgress: this.weapon.reloadProgress,
    });
    this.avatar.getMuzzle(this.muzzle);
    this.avatar.getChestPosition(this.chest);
    if (this.alive) this.hitboxes.update(this.avatar, this.renderFeet, ctrl.footOffset);

    if (this.alive && !hold) this.updateWeapon(dt, intent, difficulty, speed > 0.5);
  }

  private selfState() {
    return {
      position: this.getFeet(new THREE.Vector3()),
      magazine: this.weapon.magazine,
      reloading: this.weapon.reloading,
      canReload: this.weapon.canReload,
      alive: this.alive,
    };
  }

  /** 조준 방향 회전: 표적 + 조준 오차 쪽으로 최대 회전 속도 제한 */
  private updateAim(dt: number, intent: BotIntent, d: BotDifficulty): void {
    const desired = _v2;
    const t = this.target;
    if (intent.lookAt && t && this.perception.visible) {
      // 오차 오프셋은 주기적으로 새로 뽑아 부드럽게 이동 (손떨림처럼)
      this.aimErrorTimer -= dt;
      const dist = Math.max(1, this.chest.distanceTo(t.getAimPoint('body', _v1)));
      if (this.aimErrorTimer <= 0) {
        this.aimErrorTimer = 0.3 + Math.random() * 0.3;
        const tSpeed = Math.hypot(t.velocity.x, t.velocity.z);
        const selfMoving = Math.hypot(this.velocity.x, this.velocity.z) > 0.5;
        const deg = d.aimErrorDeg + tSpeed * d.aimErrorPerTargetSpeed + (selfMoving ? d.aimErrorMovingAdd : 0);
        const r = Math.tan(THREE.MathUtils.degToRad(deg)) * dist;
        // 원판 안 무작위 (가우스 비슷하게 중앙 쪽)
        const a = Math.random() * Math.PI * 2;
        const m = r * Math.sqrt(Math.random()) * (0.5 + Math.random() * 0.5);
        this.aimErrorTarget.set(Math.cos(a) * m, Math.sin(a) * m * 0.7, Math.sin(a + 1.3) * m);
        this.aimPart = Math.random() < d.headshotChance ? 'head' : 'body';
      }
      this.aimError.lerp(this.aimErrorTarget, 1 - Math.exp(-8 * dt));
      t.getAimPoint(this.aimPart, desired).add(this.aimError).sub(this.chest);
    } else if (intent.lookAt) {
      // 마지막 위치 쪽 (가슴 높이)
      desired.copy(intent.lookAt).setY(intent.lookAt.y + 0.7).sub(this.chest);
    } else {
      const v = this.velocity;
      if (Math.hypot(v.x, v.z) > 0.3) desired.set(v.x, 0, v.z);
      else desired.set(this.aimDir.x, 0, this.aimDir.z);
    }
    if (desired.lengthSq() < 1e-6) return;
    desired.normalize();
    rotateTowards(this.aimDir, desired, THREE.MathUtils.degToRad(d.turnSpeedDeg) * dt);
  }

  private updateWeapon(dt: number, intent: BotIntent, d: BotDifficulty, moving: boolean): void {
    const w = this.weapon;
    if (intent.reload && w.startReload()) this.cb.onReload?.(this, 'start');
    // 발사 조건: 결정이 사격 + 조준 각도 안 + 실제 탄 경로 열림 + 표적이 보호 중 아님
    let trigger = false;
    const t = this.target;
    if (intent.fire && t && t.targetable && !t.isProtected && !w.reloading) {
      const toT = _v1.copy(t.getAimPoint('body', _v1)).sub(this.chest).normalize();
      const within = this.aimDir.angleTo(toT) <= THREE.MathUtils.degToRad(BOT.combat.fireConeDeg + d.aimErrorDeg);
      trigger = within && this.shotPathClear(t);
    }
    this.firing = trigger;
    const result = w.update(dt, trigger);
    if (result.reloadFinished) this.cb.onReload?.(this, 'end');
    const spread = w.spreadDeg({ moving, airborne: !this.controller.grounded, sliding: false, aimMultiplier: 1 });
    for (let i = 0; i < result.shots; i++) this.fireOne(spread);
    if ((result.shots > 0 && w.magazine === 0) || result.dryFire) {
      if (w.startReload()) this.cb.onReload?.(this, 'start');
    }
    // 봇 전용: 예비 탄약이 떨어지면 채움 (리스폰 전에 무기가 비어 멈추지 않게)
    if (w.reserve === 0 && w.magazine === 0 && !w.reloading) w.reserve = w.def.reserveAmmo;
  }

  private fireOne(spreadDeg: number): void {
    const def = this.weapon.def;
    this.attackerInfo.position.copy(this.muzzle);
    // 펠릿 무기(샷건)도 같은 경로로 펠릿마다 판정 (지금 봇은 라이플 = 1발)
    const rotation = Math.random() * Math.PI * 2;
    for (let p = 0; p < def.pellets; p++) {
      pelletInCone(this.aimDir, spreadDeg, p, def.pellets, rotation, _shotDir);
      const aimHit = this.physics.raycast(this.chest, _shotDir, def.range, undefined, this.controller.body);
      const aimPoint = aimHit ? aimHit.point : this.chest.clone().addScaledVector(_shotDir, def.range);
      const shot = traceFromMuzzle(this.physics, this.chest, this.muzzle, aimPoint, aimHit, this.controller.body);
      applyShotDamage(shot, def, _shotDir, this.attackerInfo as AttackerInfo);
      this.cb.onShot(this, shot);
    }
    this.cb.onFire(this, this.muzzle);
    this.health.breakProtection();
    this.timeSinceShot = 0;
    this.kick = Math.min(def.recoil.visualKick * 1.6, this.kick + def.recoil.visualKick);
  }

  dispose(): void {
    this.hitboxes.dispose();
    this.physics.world.removeRigidBody(this.controller.body);
    this.avatar.dispose();
  }
}


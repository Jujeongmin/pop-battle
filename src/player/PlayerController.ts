import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { MOVEMENT } from '../config/gameConfig';
import type { Physics } from '../physics/Physics';

export type MoveMode = 'ground' | 'air' | 'slide';

/** 고정 스텝마다 컨트롤러가 받는 입력 */
export interface MoveCommand {
  /** 카메라 기준 입력 (-1..1, +Y = 앞) */
  moveX: number;
  moveY: number;
  /** 카메라 수평 회전 (라디안) */
  cameraYaw: number;
  sprint: boolean;
  /** ADS 등에 의한 이동 속도 배율 */
  speedMultiplier: number;
}

const UP = new THREE.Vector3(0, 1, 0);
/** Rapier 캐릭터 컨트롤러가 장애물과 유지하는 간격. 캡슐은 지면에서 이만큼 떠 있다. */
export const CONTROLLER_OFFSET = 0.02;
const STAND_HALF = MOVEMENT.capsuleHalfHeight;
const SLIDE_HALF = MOVEMENT.slide.capsuleHalfHeight;
const _wish = new THREE.Vector3();
const _horiz = new THREE.Vector3();

function moveTowards(current: THREE.Vector3, target: THREE.Vector3, maxDelta: number): void {
  const dx = target.x - current.x;
  const dz = target.z - current.z;
  const len = Math.hypot(dx, dz);
  if (len <= maxDelta || len < 1e-6) {
    current.x = target.x;
    current.z = target.z;
  } else {
    current.x += (dx / len) * maxDelta;
    current.z += (dz / len) * maxDelta;
  }
}

/**
 * Rapier KinematicCharacterController 기반 이동.
 * 수평 가감속, 중력, 점프(코요테·버퍼, 이중 점프 불가), 슬라이딩을 처리한다.
 */
export class PlayerController {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;

  readonly velocity = new THREE.Vector3();
  /** 렌더 보간용 캡슐 중심 위치 */
  readonly prevPosition = new THREE.Vector3();
  readonly position = new THREE.Vector3();

  mode: MoveMode = 'ground';
  grounded = false;
  /** 이번 스텝에 달리기 속도를 목표로 했는지 (Shift + 아무 방향 이동 입력). 애니메이션은 이 상태를 따른다. */
  sprinting = false;
  /** 마지막으로 지면을 떠난 뒤 경과 시간 */
  airTime = 0;
  /** 이번 스텝에 일어난 일 (애니메이션·이펙트용) */
  justJumped = false;
  justLanded = false;
  landedAirTime = 0;

  slideTime = 0;
  /**
   * 캐릭터 이동 속도 배율 (능력치). 걷기·달리기·슬라이딩·공중 상한의 기본값에만 한 번 곱한다.
   * MoveCommand.speedMultiplier(ADS·무기별 배율)는 그 위에 따로 곱해짐 → 두 번 적용되지 않음
   */
  speedScale = 1;
  private slideDir = new THREE.Vector3(0, 0, 1);
  private slideSpeed = 0;
  private slideCooldown = 0;
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private slideQueued = false;
  private jumpConsumed = false;
  /** 현재 캡슐 원통부 절반 높이 (슬라이드 중 낮아짐) */
  private halfHeight: number = STAND_HALF;
  private readonly standShape = new RAPIER.Capsule(STAND_HALF, MOVEMENT.capsuleRadius);

  constructor(private readonly physics: Physics, spawn: THREE.Vector3) {
    const world = physics.world;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(MOVEMENT.capsuleHalfHeight, MOVEMENT.capsuleRadius),
      this.body,
    );
    this.controller = world.createCharacterController(CONTROLLER_OFFSET);
    // 착지 때 보호 간격 안으로 파고들면 기본값(1e-4 m/스텝)으로는 복원이 수 초 걸리고
    // 그동안 이동량 0 스텝이 섞여 달리기가 끊긴다 → 빠르게 밀어냄
    this.controller.setNormalNudgeFactor(0.004);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(MOVEMENT.maxSlopeDeg));
    this.controller.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(MOVEMENT.maxSlopeDeg + 4));
    this.controller.enableAutostep(MOVEMENT.autostepHeight, 0.15, false);
    this.controller.enableSnapToGround(MOVEMENT.snapToGround);
    this.controller.setSlideEnabled(true);
    this.position.copy(spawn);
    this.prevPosition.copy(spawn);
    // 맞는 것은 히트박스(CharacterHitboxes). 이동 캡슐은 사격·카메라 쿼리에서 제외
    physics.ignoreForQueries(this.collider);
  }

  /** 제거 (봇을 지울 때): 이동 캡슐·강체와 캐릭터 컨트롤러(wasm 메모리)를 해제 */
  dispose(): void {
    this.physics.removeCollider(this.collider);
    this.physics.world.removeRigidBody(this.body);
    this.physics.world.removeCharacterController(this.controller);
  }

  /** 사망 등: 이동 캡슐 충돌을 끄거나 켠다 (다른 캐릭터가 통과 가능) */
  setCollisionEnabled(enabled: boolean): void {
    this.collider.setEnabled(enabled);
  }

  /** 캡슐 중심 → 실제 지면 거리 (캡슐 절반 높이 + 반지름 + 컨트롤러 간격) */
  get footOffset(): number {
    return this.halfHeight + MOVEMENT.capsuleRadius + CONTROLLER_OFFSET;
  }

  /** 낮은 캡슐 상태 (슬라이드 중이거나, 장애물 아래라 아직 못 일어남) */
  get isLowCollider(): boolean {
    return this.halfHeight < STAND_HALF;
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get isSliding(): boolean {
    return this.mode === 'slide';
  }

  queueJump(): void {
    this.jumpBufferTimer = MOVEMENT.jumpBuffer;
  }

  queueSlide(): void {
    this.slideQueued = true;
  }

  teleport(p: THREE.Vector3): void {
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
    this.position.copy(p);
    this.prevPosition.copy(p);
    this.velocity.set(0, 0, 0);
    this.mode = 'air';
    this.slideTime = 0;
    this.slideQueued = false;
    this.jumpBufferTimer = 0;
    if (this.halfHeight !== STAND_HALF) {
      this.halfHeight = STAND_HALF;
      this.collider.setHalfHeight(STAND_HALF);
    }
  }

  /** 캡슐 높이 변경. 바닥 위치는 그대로 두고 중심만 옮긴다. */
  private resizeCapsule(half: number): void {
    const delta = half - this.halfHeight;
    if (Math.abs(delta) < 1e-6) return;
    const t = this.body.translation();
    const next = { x: t.x, y: t.y + delta, z: t.z };
    this.collider.setHalfHeight(half);
    this.body.setTranslation(next, true);
    this.position.y += delta;
    this.prevPosition.y += delta;
    this.halfHeight = half;
  }

  /** 서 있는 캡슐이 들어갈 공간이 있는지 (장애물 아래에서 일어나지 않게) */
  canStand(): boolean {
    if (this.halfHeight >= STAND_HALF) return true;
    const t = this.body.translation();
    const y = t.y + (STAND_HALF - this.halfHeight) + 0.01;
    const hit = this.physics.world.intersectionWithShape(
      { x: t.x, y, z: t.z },
      { x: 0, y: 0, z: 0, w: 1 },
      this.standShape,
      undefined,
      undefined,
      this.collider,
      undefined,
      this.physics.movementFilter,
    );
    return hit === null;
  }

  private tryStand(): boolean {
    if (!this.canStand()) return false;
    this.resizeCapsule(STAND_HALF);
    return true;
  }

  /** 고정 스텝 1회. physics.step() 직전에 호출한다. */
  step(dt: number, cmd: MoveCommand): void {
    this.justJumped = false;
    this.justLanded = false;
    this.prevPosition.copy(this.position);
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    this.coyoteTimer = this.grounded ? MOVEMENT.coyoteTime : Math.max(0, this.coyoteTimer - dt);

    // 카메라 기준 원하는 이동 방향
    const sin = Math.sin(cmd.cameraYaw);
    const cos = Math.cos(cmd.cameraYaw);
    const ix = cmd.moveX;
    const iy = cmd.moveY;
    const inputLen = Math.min(1, Math.hypot(ix, iy));
    // 카메라 forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    _wish.set(-sin * iy + cos * ix, 0, -cos * iy - sin * ix);
    if (_wish.lengthSq() > 1e-6) _wish.normalize();

    this.tryStartSlide(cmd, inputLen);

    if (this.mode === 'slide') {
      this.sprinting = false;
      this.updateSlide(dt, inputLen);
    } else {
      // 달리기는 이동 입력 벡터 기준 (W뿐 아니라 A/S/D·대각선 모두). 방향은 _wish가 이미 담당
      this.sprinting = cmd.sprint && inputLen > 0.1;
      const speed = (this.sprinting ? MOVEMENT.sprintSpeed : MOVEMENT.walkSpeed) * this.speedScale * cmd.speedMultiplier;
      _horiz.copy(_wish).multiplyScalar(speed * inputLen);
      if (this.grounded) {
        const accel = inputLen > 0.01 ? MOVEMENT.groundAccel : MOVEMENT.groundDecel;
        moveTowards(this.velocity, _horiz, accel * dt);
      } else {
        this.updateAirHorizontal(dt, _horiz, inputLen);
      }
    }

    // 점프: 지면(또는 코요테 타임) + 버퍼 입력. 공중 재점프 불가. 장애물 아래(일어설 공간 없음)에서는 불가.
    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0 && !this.jumpConsumed && this.canStand()) {
      this.jump();
    }

    // 중력
    if (!this.grounded || this.velocity.y > 0) {
      this.velocity.y = Math.max(this.velocity.y - MOVEMENT.gravity * dt, -MOVEMENT.maxFallSpeed);
    } else {
      // 지면에서는 아래로 밀지 않는다. 내리막·계단은 snapToGround가 붙여 준다.
      // (매 스텝 아래로 밀면 캡슐이 보호 간격 안으로 파고들었다 밀려나며 높이가 ±1cm 출렁임)
      this.velocity.y = 0;
    }

    this.move(dt);
  }

  private jump(): void {
    this.tryStand();
    if (this.mode === 'slide') {
      // 슬라이드 점프: 수평 속도 일부 유지, 상한 적용
      const carry = this.slideSpeed * MOVEMENT.slide.jumpCarry;
      const s = Math.min(carry, MOVEMENT.airMaxSpeed * this.speedScale);
      this.velocity.x = this.slideDir.x * s;
      this.velocity.z = this.slideDir.z * s;
      this.endSlide(true);
    }
    this.velocity.y = MOVEMENT.jumpSpeed;
    this.jumpBufferTimer = 0;
    this.coyoteTimer = 0;
    this.jumpConsumed = true;
    this.grounded = false;
    this.mode = 'air';
    this.justJumped = true;
  }

  private tryStartSlide(cmd: MoveCommand, inputLen: number): void {
    if (!this.slideQueued) return;
    this.slideQueued = false;
    // 공중에서는 새로 시작 불가
    if (!this.grounded || this.mode === 'slide' || this.slideCooldown > 0) return;

    const cur = this.horizontalSpeed;
    if (inputLen > 0.01) this.slideDir.copy(_wish);
    else if (cur > 0.5) this.slideDir.set(this.velocity.x, 0, this.velocity.z).normalize();
    else this.slideDir.set(-Math.sin(cmd.cameraYaw), 0, -Math.cos(cmd.cameraYaw));

    const sl = MOVEMENT.slide;
    // 정지·걷기·달리기 모두 시작 가능. 현재 속도에 부스트를 더하되 상한으로 무한 가속 방지
    const k = this.speedScale;
    this.slideSpeed = THREE.MathUtils.clamp(cur + sl.boost * k, sl.minSpeed * k, sl.maxSpeed * k);
    this.slideTime = 0;
    this.mode = 'slide';
    this.resizeCapsule(SLIDE_HALF);
  }

  private updateSlide(dt: number, inputLen: number): void {
    const sl = MOVEMENT.slide;
    this.slideTime += dt;
    // 입력 방향으로 약간 조향
    if (inputLen > 0.01) {
      const target = Math.atan2(_wish.x, _wish.z);
      const current = Math.atan2(this.slideDir.x, this.slideDir.z);
      let diff = target - current;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const step = THREE.MathUtils.clamp(diff, -sl.steerRate * dt, sl.steerRate * dt);
      this.slideDir.applyAxisAngle(UP, step);
    }
    // 장애물 아래에 끼어 못 일어나면 최소 속도로 계속 미끄러져 빠져나간다 (앉기 상태 없음)
    const k = this.speedScale;
    const endSpeed = sl.endSpeed * k;
    const minSpeed = this.slideTime >= sl.duration || this.slideSpeed <= endSpeed ? sl.underObstacleSpeed * k : 0;
    // 마찰도 같은 배율 → 슬라이딩 시간·거리 비율은 캐릭터와 무관하게 같음 (거리만 속도 배율만큼)
    this.slideSpeed = Math.max(minSpeed, this.slideSpeed - sl.friction * k * dt);
    this.velocity.x = this.slideDir.x * this.slideSpeed;
    this.velocity.z = this.slideDir.z * this.slideSpeed;
    // 캡슐 크기를 바꾼 직후 한 스텝은 지면 판정이 비는 경우가 있어 잠깐의 공중 상태는 무시
    if (this.slideTime >= sl.duration || this.slideSpeed <= endSpeed || this.airTime > 0.1) {
      this.endSlide();
    }
  }

  /** 일어설 공간이 있으면 슬라이드 종료. force(점프)면 이미 일어난 상태. */
  private endSlide(force = false): void {
    if (this.mode !== 'slide') return;
    if (!force && !this.tryStand()) return;
    this.mode = this.grounded ? 'ground' : 'air';
    this.slideCooldown = MOVEMENT.slide.cooldown;
  }

  private updateAirHorizontal(dt: number, target: THREE.Vector3, inputLen: number): void {
    const v = this.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (inputLen > 0.01) {
      // 공중 조작: 목표 방향으로 가속하되 현재 속도가 목표보다 빠르면 그 속도를 넘지 않음
      const cap = Math.min(Math.max(speed, target.length()), MOVEMENT.airMaxSpeed * this.speedScale);
      v.x += _wish.x * MOVEMENT.airAccel * dt;
      v.z += _wish.z * MOVEMENT.airAccel * dt;
      const ns = Math.hypot(v.x, v.z);
      if (ns > cap) {
        v.x *= cap / ns;
        v.z *= cap / ns;
      }
    }
    // 공기 저항은 지상 이동 속도보다 빠른 부분에만
    const ns = Math.hypot(v.x, v.z);
    const walk = MOVEMENT.walkSpeed * this.speedScale;
    if (ns > walk) {
      const reduced = Math.max(walk, ns - MOVEMENT.airDrag * dt);
      v.x *= reduced / ns;
      v.z *= reduced / ns;
    }
  }

  private move(dt: number): void {
    const desired = { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt };
    // 판정 전용 히트박스(자기 머리 포함)는 이동 장애물이 아니다
    this.controller.computeColliderMovement(this.collider, desired, undefined, undefined, this.physics.movementFilter);
    const m = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    const groundedNow = this.controller.computedGrounded();

    // 천장에 머리를 박으면 상승 속도 제거
    if (this.velocity.y > 0 && m.y < desired.y * 0.5) this.velocity.y = 0;
    // 벽 방향 속도 성분만 제거 (벽에 붙어 가속이 쌓이지 않게).
    // 실제 이동량으로 속도 전체를 깎으면 이동량 0 스텝 하나에 달리기가 멈췄다가 다시 가속한다.
    const n = this.controller.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const c = this.controller.computedCollision(i);
      if (!c) continue;
      const nx = c.normal1.x;
      const ny = c.normal1.y;
      const nz = c.normal1.z;
      if (Math.abs(ny) > 0.7) continue; // 바닥·천장
      const into = this.velocity.x * nx + this.velocity.z * nz;
      if (into < 0) {
        this.velocity.x -= nx * into;
        this.velocity.z -= nz * into;
      }
    }

    const t = this.body.translation();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    this.body.setNextKinematicTranslation(next);
    this.position.set(next.x, next.y, next.z);

    this.grounded = groundedNow && this.velocity.y <= 0.01;
    if (this.grounded) {
      if (!wasGrounded) {
        this.justLanded = true;
        this.landedAirTime = this.airTime;
        this.velocity.y = 0;
        if (this.mode === 'air') this.mode = 'ground';
      }
      this.airTime = 0;
      this.jumpConsumed = false;
    } else {
      this.airTime += dt;
      if (this.mode === 'ground') this.mode = 'air';
      // 공중에서는 낮은 캡슐을 유지할 이유가 없다 (공간이 있으면 복구)
      if (this.mode !== 'slide' && this.isLowCollider) this.tryStand();
    }
  }
}

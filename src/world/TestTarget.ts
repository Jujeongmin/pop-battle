import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Damageable, HitInfo, Physics } from '../physics/Physics';

export interface TargetOptions {
  position: THREE.Vector3;
  color: number;
  maxHp?: number;
  name?: string;
  /** 좌우 왕복 이동 (진폭 m, 주기 s) */
  patrol?: { amplitude: number; period: number };
}

const BODY_RADIUS = 0.32;
const BODY_HALF = 0.28;
const HEAD_RADIUS = 0.26;
const HEAD_Y = 1.18;
const RESPAWN_TIME = 2.5;
const WOBBLE_MAX_VEL = 6;
const WOBBLE_MAX = 0.6;

/**
 * 테스트용 임시 표적 (기본 도형). 몸통·머리 히트박스, 피격 반응, 쓰러짐/부활.
 * 실제 적 캐릭터 에셋이 오면 교체한다.
 */
export class TestTarget implements Damageable {
  readonly group = new THREE.Group();
  private readonly visual = new THREE.Group();
  private readonly body: RAPIER.RigidBody;
  private readonly bodyCollider: RAPIER.Collider;
  private readonly headCollider: RAPIER.Collider;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly base: THREE.Vector3;
  readonly maxHp: number;
  /** 디버그 표시용 이름 */
  readonly name: string;
  hp: number;
  private flash = 0;
  private wobble = new THREE.Vector2();
  private wobbleVel = new THREE.Vector2();
  private squash = 0;
  private squashVel = 0;
  private downTimer = 0;
  private fall = 0;
  private time = Math.random() * 10;

  constructor(
    private readonly physics: Physics,
    scene: THREE.Scene,
    private readonly opts: TargetOptions,
  ) {
    this.base = opts.position.clone();
    this.name = opts.name ?? 'target';
    this.maxHp = opts.maxHp ?? 100;
    this.hp = this.maxHp;

    const mat = (color: number) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0 });
      this.materials.push(m);
      return m;
    };
    const geo = <T extends THREE.BufferGeometry>(g: T) => {
      this.geometries.push(g);
      return g;
    };
    const bodyMesh = new THREE.Mesh(geo(new THREE.CapsuleGeometry(BODY_RADIUS, BODY_HALF * 2, 6, 16)), mat(opts.color));
    bodyMesh.position.y = BODY_RADIUS + BODY_HALF;
    const headMesh = new THREE.Mesh(geo(new THREE.SphereGeometry(HEAD_RADIUS, 24, 16)), mat(0xfff1e0));
    headMesh.position.y = HEAD_Y;
    const ring = new THREE.Mesh(geo(new THREE.TorusGeometry(0.2, 0.05, 8, 24)), mat(0xff6b6b));
    ring.position.set(0, BODY_RADIUS + BODY_HALF, BODY_RADIUS - 0.02);
    const stand = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.3, 0.38, 0.08, 20)), mat(0xb8c0d8));
    stand.position.y = 0.04;
    for (const m of [bodyMesh, headMesh, ring, stand]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    this.visual.add(bodyMesh, headMesh, ring);
    this.group.add(this.visual, stand);
    this.group.position.copy(this.base);
    scene.add(this.group);

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.base.x, this.base.y, this.base.z),
    );
    this.bodyCollider = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(BODY_HALF, BODY_RADIUS).setTranslation(0, BODY_RADIUS + BODY_HALF, 0),
      this.body,
    );
    this.headCollider = physics.world.createCollider(
      RAPIER.ColliderDesc.ball(HEAD_RADIUS).setTranslation(0, HEAD_Y, 0),
      this.body,
    );
    physics.registerHitbox(this.bodyCollider, { target: this, part: 'body' });
    physics.registerHitbox(this.headCollider, { target: this, part: 'head' });
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  /** 화면 표시용 머리 위 위치 */
  getLabelPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.group.position).setY(this.group.position.y + HEAD_Y + 0.45);
  }

  applyHit(hit: HitInfo): number {
    if (!this.alive) return 0;
    const before = this.hp;
    this.hp = Math.max(0, this.hp - hit.damage);
    this.flash = hit.part === 'head' ? 1 : 0.8;
    // 맞은 방향으로 흔들림 + 살짝 찌그러짐 (화면 모델만, 콜라이더는 그대로). 연사해도 누적되지 않게 상한
    const local = hit.direction.clone();
    this.wobbleVel.x += local.z * 4;
    this.wobbleVel.y -= local.x * 4;
    if (this.wobbleVel.length() > WOBBLE_MAX_VEL) this.wobbleVel.setLength(WOBBLE_MAX_VEL);
    this.squashVel = Math.min(this.squashVel + 2.2, 3);
    const killed = this.hp <= 0;
    if (killed) {
      this.downTimer = RESPAWN_TIME;
      this.bodyCollider.setEnabled(false);
      this.headCollider.setEnabled(false);
    }
    return before - this.hp;
  }

  update(dt: number): void {
    this.time += dt;
    // 이동 표적: 다음 물리 스텝 목표만 지정하고, 화면 모델은 실제 콜라이더 위치를 따른다
    // (모델을 먼저 움직이면 콜라이더보다 최대 약 8cm 앞서 보여 가장자리 조준이 빗나감)
    const p = this.opts.patrol;
    if (p && this.alive) {
      const x = this.base.x + Math.sin((this.time / p.period) * Math.PI * 2) * p.amplitude;
      this.body.setNextKinematicTranslation({ x, y: this.base.y, z: this.base.z });
    }
    const t = this.body.translation();
    this.group.position.set(t.x, t.y, t.z);

    // 흔들림 스프링
    const k = 90;
    const c = 9;
    this.wobbleVel.x += (-k * this.wobble.x - c * this.wobbleVel.x) * dt;
    this.wobbleVel.y += (-k * this.wobble.y - c * this.wobbleVel.y) * dt;
    this.wobble.addScaledVector(this.wobbleVel, dt);
    if (this.wobble.length() > WOBBLE_MAX) this.wobble.setLength(WOBBLE_MAX);
    // 찌그러짐 스프링 (맞으면 순간 납작해졌다 복귀)
    this.squashVel += (-220 * this.squash - 14 * this.squashVel) * dt;
    this.squash = THREE.MathUtils.clamp(this.squash + this.squashVel * dt, -0.12, 0.12);
    this.visual.scale.set(1 + this.squash * 0.6, 1 - this.squash, 1 + this.squash * 0.6);

    if (!this.alive) {
      this.downTimer -= dt;
      this.fall = Math.min(1, this.fall + dt * 4);
      if (this.downTimer <= 0) this.revive();
    } else {
      this.fall = Math.max(0, this.fall - dt * 3);
    }
    this.visual.rotation.set(this.wobble.x * 0.15 - this.fall * (Math.PI / 2) * 0.95, 0, this.wobble.y * 0.15);

    this.flash = Math.max(0, this.flash - dt * 8);
    for (const m of this.materials) m.emissive.setRGB(this.flash, this.flash * 0.9, this.flash * 0.9);
  }

  private revive(): void {
    this.hp = this.maxHp;
    this.bodyCollider.setEnabled(true);
    this.headCollider.setEnabled(true);
  }

  dispose(): void {
    this.physics.unregisterHitbox(this.bodyCollider);
    this.physics.unregisterHitbox(this.headCollider);
    this.physics.world.removeRigidBody(this.body);
    this.group.removeFromParent();
    this.materials.forEach((m) => m.dispose());
    this.geometries.forEach((g) => g.dispose());
  }
}

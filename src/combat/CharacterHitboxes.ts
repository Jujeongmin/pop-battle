import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CHARACTER_HITBOX } from '../config/combat';
import type { Damageable, Physics } from '../physics/Physics';
import type { PlayerAvatar } from '../player/PlayerAvatar';

const _hips = new THREE.Vector3();

/**
 * 캐릭터 판정 영역: 머리 구 + 몸통 캡슐 (판정 전용, 이동 충돌 없음).
 * 캐릭터 이동 강체에 붙어 함께 움직이고, 매 프레임 아바타 포즈(머리 정점 중심·골반)에 맞춰 상대 위치를 갱신한다.
 * 쏜 캐릭터 자신은 강체 단위로 판정에서 제외된다 (Physics.raycast excludeBody).
 * 참고: Rapier는 콜라이더 위치 변경을 다음 물리 스텝에 반영 → 판정은 화면보다 최대 1스텝 늦다.
 */
export class CharacterHitboxes {
  readonly head: RAPIER.Collider;
  readonly body: RAPIER.Collider;
  private enabled = true;
  private headRadius: number;
  private bodyRadius: number = CHARACTER_HITBOX.bodyRadius;

  constructor(
    private readonly physics: Physics,
    rigidBody: RAPIER.RigidBody,
    target: Damageable,
    headRadius: number,
  ) {
    this.headRadius = headRadius;
    const world = physics.world;
    this.head = world.createCollider(RAPIER.ColliderDesc.ball(headRadius).setTranslation(0, 0.3, 0), rigidBody);
    this.body = world.createCollider(RAPIER.ColliderDesc.capsule(0.2, CHARACTER_HITBOX.bodyRadius), rigidBody);
    physics.registerHitbox(this.head, { target, part: 'head' }, true);
    physics.registerHitbox(this.body, { target, part: 'body' }, true);
  }

  /**
   * 아바타 포즈에 맞춰 갱신. renderFeet = 아바타를 그린 발 위치 (보간),
   * 강체 기준 상대 위치는 화면 포즈 오프셋을 그대로 쓴다.
   */
  update(avatar: PlayerAvatar, renderFeet: THREE.Vector3, bodyCenterAboveFeet: number): void {
    if (!this.enabled) return;
    const r = avatar.headRadius;
    if (Math.abs(r - this.headRadius) > 1e-4) {
      this.head.setRadius(r);
      this.headRadius = r;
    }
    // 강체 위치 = 발 + bodyCenterAboveFeet (이동 캡슐 중심)
    const hc = avatar.headCenter;
    this.head.setTranslationWrtParent({
      x: hc.x - renderFeet.x,
      y: hc.y - renderFeet.y - bodyCenterAboveFeet,
      z: hc.z - renderFeet.z,
    });
    // 몸통 반지름: 캐릭터 체형 실측 (PlayerAvatar.bodyRadius)
    const bodyR = avatar.bodyRadius;
    if (Math.abs(bodyR - this.bodyRadius) > 1e-4) {
      this.body.setRadius(bodyR);
      this.bodyRadius = bodyR;
    }
    const bottom = Math.max(avatar.bodyBounds.min.y, renderFeet.y) + 0.04;
    const top = Math.max(bottom + bodyR * 2, hc.y - r * (1 - CHARACTER_HITBOX.bodyTopIntoHead));
    const half = Math.max(0.01, (top - bottom) / 2 - bodyR);
    this.body.setHalfHeight(half);
    avatar.getHipsPosition(_hips);
    this.body.setTranslationWrtParent({
      x: _hips.x - renderFeet.x,
      y: (top + bottom) / 2 - renderFeet.y - bodyCenterAboveFeet,
      z: _hips.z - renderFeet.z,
    });
  }

  /** 디버그: 현재 판정 크기 (머리 구 반지름, 몸통 캡슐 반지름·원통부 절반 높이, m) */
  get dimensions(): { headRadius: number; bodyRadius: number; bodyHalfHeight: number } {
    return { headRadius: this.headRadius, bodyRadius: this.bodyRadius, bodyHalfHeight: this.body.halfHeight() };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.head.setEnabled(enabled);
    this.body.setEnabled(enabled);
  }

  dispose(): void {
    this.physics.unregisterHitbox(this.head);
    this.physics.unregisterHitbox(this.body);
    this.physics.world.removeCollider(this.head, false);
    this.physics.world.removeCollider(this.body, false);
  }
}

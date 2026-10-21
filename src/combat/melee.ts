import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { MeleeProfile } from '../config/weapons';
import type { AttackerInfo, Damageable, HitPart, Physics, RayHit } from '../physics/Physics';
import { canDamage } from './teams';

/** 근접 공격 1회에 맞은 대상 (대상당 1개) */
export interface MeleeHit {
  target: Damageable;
  part: HitPart;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  damage: number;
  killed: boolean;
}

export interface MeleeResult {
  hits: MeleeHit[];
  /** 대상이 없을 때 정면 사거리 안 벽 (타격 연출용) */
  wall: RayHit | null;
}

interface Candidate {
  target: Damageable;
  part: HitPart;
  /** 판정 영역 표면까지 거리 */
  distance: number;
  /** 판정 영역 축 위 가장 가까운 점 (시야 레이 목표) */
  aim: THREE.Vector3;
}

const _found: Array<{ collider: RAPIER.Collider; hitbox: { target: Damageable; part: HitPart } }> = [];
const _best = new Map<Damageable, Candidate>();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
/** 히트박스 최대 반지름 여유 (후보 수집 구를 이만큼 크게) */
const HITBOX_MARGIN = 0.5;

/** 판정 영역(구·세로 캡슐)에서 from에 가장 가까운 축 위 점과 반지름 */
function closestOnShape(c: RAPIER.Collider, from: THREE.Vector3, out: THREE.Vector3): number {
  const t = c.translation();
  out.set(t.x, t.y, t.z);
  const shape = c.shape as unknown as { radius?: number; halfHeight?: number };
  const half = shape.halfHeight ?? 0;
  if (half > 0) out.y = THREE.MathUtils.clamp(from.y, t.y - half, t.y + half);
  return shape.radius ?? 0;
}

/**
 * 근접 판정: 가슴에서 짧은 거리 + 정면 각도 안의 판정 영역만, 가슴→대상 레이가 벽에 막히지 않아야 명중.
 * 공격 1회당 같은 대상은 한 번만 (머리·몸통 중 가까운 쪽). 헤드샷 배율 없음.
 * @param apply false면 판정만 (조준선 표시용)
 */
export function meleeAttack(
  physics: Physics,
  m: MeleeProfile,
  damage: number,
  chest: THREE.Vector3,
  forward: THREE.Vector3,
  shooter: RAPIER.RigidBody,
  attacker: AttackerInfo | undefined,
  apply: boolean,
  /** 킬로그 원인 무기 id (판정과 무관) */
  weaponId?: string,
): MeleeResult {
  const cosMax = Math.cos(THREE.MathUtils.degToRad(m.halfAngleDeg));
  physics.hitboxesInSphere(chest, m.range + HITBOX_MARGIN, shooter, _found);
  _best.clear();
  for (const { collider, hitbox } of _found) {
    const target = hitbox.target;
    if (!target.alive || !canDamage(attacker, target)) continue;
    const r = closestOnShape(collider, chest, _c);
    const toC = _d.subVectors(_c, chest);
    const centerDist = toC.length();
    const dist = Math.max(0, centerDist - r);
    if (dist > m.range) continue;
    // 바로 붙어 있으면 각도 무시 (몸 안쪽)
    if (centerDist > r + 0.05 && toC.divideScalar(centerDist).dot(forward) < cosMax) continue;
    const prev = _best.get(target);
    if (prev && prev.distance <= dist) continue;
    _best.set(target, { target, part: hitbox.part, distance: dist, aim: _c.clone() });
  }

  const hits: MeleeHit[] = [];
  for (const cand of _best.values()) {
    // 벽 너머 금지: 가슴 → 대상 첫 충돌이 그 대상이어야 함
    const dir = _d.subVectors(cand.aim, chest);
    const len = dir.length();
    if (len < 1e-4) dir.copy(forward);
    else dir.divideScalar(len);
    const ray = physics.raycast(chest, dir.clone(), Math.max(len, 0.05) + 0.5, undefined, shooter);
    if (!ray || ray.hitbox?.target !== cand.target) continue;
    let applied = 0;
    if (apply) {
      applied = cand.target.applyHit({ damage, part: cand.part, point: ray.point, direction: forward.clone(), attacker, weaponId, headshot: false });
      if (applied <= 0) continue;
    }
    hits.push({
      target: cand.target,
      part: cand.part,
      point: ray.point,
      normal: ray.normal,
      damage: applied,
      killed: apply && !cand.target.alive,
    });
  }

  let wall: RayHit | null = null;
  if (hits.length === 0) {
    const ray = physics.raycast(chest, forward, m.range, undefined, shooter);
    if (ray && !ray.hitbox) wall = ray;
  }
  return { hits, wall };
}

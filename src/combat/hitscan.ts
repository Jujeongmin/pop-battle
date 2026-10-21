import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { WeaponDef } from '../config/weapons';
import type { AttackerInfo, Physics, RayHit } from '../physics/Physics';
import { canDamage } from './teams';

/**
 * 실제 탄이 어디서 멈췄는지 (사격 경로 디버그·테스트용):
 * - clear: 총구 → 조준점 경로가 열려 조준점(카메라가 정한 목표)에 맞음
 * - muzzle: 가슴 → 총구 사이에 장애물 (총구가 벽·엄폐물 안이나 뒤에 있음)
 * - path: 총구 → 조준점 사이 장애물 (카메라엔 보여도 총구에서는 가려짐)
 */
export type ShotStage = 'clear' | 'muzzle' | 'path';

/** 카메라 조준 레이 정보 (사격 경로 디버그가 켜졌을 때만 채움) */
export interface ShotAimDebug {
  /** 카메라 레이 시작 (카메라 중앙선에서 캐릭터 옆) */
  origin: THREE.Vector3;
  /** 탄퍼짐 적용한 카메라 레이 방향 */
  dir: THREE.Vector3;
  /** 가슴 (총구 관통 검사 시작점) */
  chest: THREE.Vector3;
}

/** 탄 1발의 판정 결과 (시각 효과·사운드·HUD는 이 결과만 보고 따로 처리, 멀티플레이 판정과도 공유 가능) */
export interface ShotResult {
  /** 총구 위치 (궤적 시작) */
  from: THREE.Vector3;
  /** 카메라가 정한 조준 목표 (카메라 레이가 처음 닿은 곳, 없으면 사거리 끝) */
  aimPoint: THREE.Vector3;
  /** 조준 레이가 aimPoint에서 닿은 것 */
  aimHit: RayHit | null;
  stage: ShotStage;
  aimDebug?: ShotAimDebug;
  hit: RayHit | null;
  /** 실제 탄착 지점 (아무것도 안 맞으면 사거리 끝) */
  end: THREE.Vector3;
  damage: number;
  headshot: boolean;
  killed: boolean;
  /** 쏜 쪽 (플레이어·봇 구분) */
  attacker?: AttackerInfo;
  /** 쏜 무기 (연출 배율) */
  weapon?: WeaponDef;
}

/** 거리별 피해 배율 (falloff 없으면 1) */
export function falloffMultiplier(def: WeaponDef, distance: number): number {
  const f = def.falloff;
  if (!f) return 1;
  if (distance <= f.startDistance) return 1;
  if (distance >= f.endDistance) {
    if (f.farDistance === undefined || f.farMultiplier === undefined || f.farDistance <= f.endDistance) return f.minMultiplier;
    const t = Math.min(1, (distance - f.endDistance) / (f.farDistance - f.endDistance));
    return f.minMultiplier + (f.farMultiplier - f.minMultiplier) * t;
  }
  const t = (distance - f.startDistance) / (f.endDistance - f.startDistance);
  return 1 + (f.minMultiplier - 1) * t;
}

const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _w = new THREE.Vector3();

/** 원뿔 안의 무작위 방향 (반각 deg) */
export function randomInCone(forward: THREE.Vector3, halfAngleDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const half = THREE.MathUtils.degToRad(halfAngleDeg);
  if (half <= 0) return out.copy(forward);
  const r = Math.sqrt(Math.random()) * Math.tan(half);
  const a = Math.random() * Math.PI * 2;
  _u.set(0, 1, 0);
  if (Math.abs(forward.y) > 0.95) _u.set(1, 0, 0);
  _w.crossVectors(forward, _u).normalize();
  _u.crossVectors(_w, forward).normalize();
  return out.copy(forward).addScaledVector(_w, Math.cos(a) * r).addScaledVector(_u, Math.sin(a) * r).normalize();
}

/**
 * 펠릿 무기(샷건) 탄 방향: 매 발 무작위지만 한쪽으로 몰리지 않게 층화 분포.
 * - 0번 펠릿: 중앙 근처 (반지름 20% 안)
 * - 나머지: 원을 (count-1)개 부채꼴로 나눠 부채꼴마다 1발, 각도·반지름은 부채꼴 안에서 무작위
 *   (반지름은 면적 기준 35~100% → 가운데 구멍 없이 고르게)
 * - rotation: 발사마다 무작위로 돌려 패턴이 고정되지 않게
 * 펠릿 1개인 무기는 기존 randomInCone과 같다.
 */
export function pelletInCone(
  forward: THREE.Vector3,
  halfAngleDeg: number,
  index: number,
  count: number,
  rotation: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  if (count <= 1) return randomInCone(forward, halfAngleDeg, out);
  const half = THREE.MathUtils.degToRad(halfAngleDeg);
  if (half <= 0) return out.copy(forward);
  let frac: number;
  let a: number;
  if (index === 0) {
    frac = 0.2 * Math.sqrt(Math.random());
    a = Math.random() * Math.PI * 2;
  } else {
    const sector = (Math.PI * 2) / (count - 1);
    a = rotation + (index - 1 + 0.15 + 0.7 * Math.random()) * sector;
    frac = Math.sqrt(0.12 + 0.88 * Math.random());
  }
  const r = frac * Math.tan(half);
  _u.set(0, 1, 0);
  if (Math.abs(forward.y) > 0.95) _u.set(1, 0, 0);
  _w.crossVectors(forward, _u).normalize();
  _u.crossVectors(_w, forward).normalize();
  return out.copy(forward).addScaledVector(_w, Math.cos(a) * r).addScaledVector(_u, Math.sin(a) * r).normalize();
}

/** from → to 구간에서 처음 닿는 것 (쏜 캐릭터 자신 제외) */
export function segmentHit(physics: Physics, from: THREE.Vector3, to: THREE.Vector3, shooter: RAPIER.RigidBody): RayHit | null {
  const d = _d.subVectors(to, from);
  const len = d.length();
  if (len < 1e-3) return null;
  return physics.raycast(from, d.divideScalar(len).clone(), len - 0.02, undefined, shooter);
}

/**
 * 실제 탄 경로 (플레이어·봇 공통, 무기 4종 공통):
 * 1) 조준점은 호출하는 쪽이 정함 (플레이어 = 카메라 중앙 레이 + 탄퍼짐, 봇 = 가슴에서 조준 방향 레이)
 * 2) 가슴 → 총구: 총구가 벽·엄폐물 안이나 뒤로 넘어가 있으면 그 면에 맞음 (벽 너머로 총만 내밀어 쏘기 방지)
 * 3) 총구 → 조준점: 사이에 장애물(또는 다른 캐릭터)이 있으면 그곳에 맞음
 * 4) 열려 있으면 조준점의 대상에 맞음
 * 탄 방향 = 총구 → 조준점 (총구 위치는 실제 무기 모델의 총구, 임의로 올리거나 옮기지 않음).
 * 쏜 캐릭터 자신의 이동 캡슐·판정 영역은 모든 구간에서 제외.
 * @param aimHit 조준 레이가 aimPoint에서 닿은 것 (없으면 null)
 */
export function traceFromMuzzle(
  physics: Physics,
  chest: THREE.Vector3,
  muzzle: THREE.Vector3,
  aimPoint: THREE.Vector3,
  aimHit: RayHit | null,
  shooter: RAPIER.RigidBody,
): ShotResult {
  const from = muzzle.clone();
  const target = aimPoint.clone();
  const result = (hit: RayHit | null, end: THREE.Vector3, stage: ShotStage): ShotResult => ({
    from, aimPoint: target, aimHit, stage, hit, end, damage: 0, headshot: false, killed: false,
  });
  const blockedAtMuzzle = segmentHit(physics, chest, muzzle, shooter);
  if (blockedAtMuzzle) return result(blockedAtMuzzle, blockedAtMuzzle.point, 'muzzle');
  const blocked = segmentHit(physics, muzzle, aimPoint, shooter);
  if (blocked) return result(blocked, blocked.point, 'path');
  return result(aimHit, target.clone(), 'clear');
}

/** 판정 결과에 피해 적용 (적대 규칙·무적 반영). 결과의 damage/headshot/killed를 채운다 */
export function applyShotDamage(shot: ShotResult, def: WeaponDef, dir: THREE.Vector3, attacker?: AttackerInfo): void {
  shot.attacker = attacker;
  shot.weapon = def;
  const hb = shot.hit?.hitbox;
  if (!shot.hit || !hb || !hb.target.alive) return;
  if (!canDamage(attacker, hb.target)) return;
  const headshot = hb.part === 'head';
  // 거리 = 실제 탄 시작(총구) → 탄착
  const falloff = falloffMultiplier(def, shot.from.distanceTo(shot.hit.point));
  const damage = def.damage * (headshot ? def.headshotMultiplier : 1) * falloff;
  const applied = hb.target.applyHit({ damage, part: hb.part, point: shot.hit.point, direction: dir.clone(), attacker, weaponId: def.id, headshot });
  shot.damage = applied;
  shot.headshot = headshot && applied > 0;
  shot.killed = applied > 0 && !hb.target.alive;
}

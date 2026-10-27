import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

/** 레이 원점·방향을 제자리에서 바꿈 (쿼리마다 새 객체를 만들지 않음 — Rapier는 호출 순간 값만 읽음) */
function setXyz(v: RAPIER.Vector, x: number, y: number, z: number): void {
  v.x = x;
  v.y = y;
  v.z = z;
}

export type HitPart = 'head' | 'body';

/** 피해 1회 정보 */
export interface HitInfo {
  damage: number;
  part: HitPart;
  point: THREE.Vector3;
  /** 탄 진행 방향 (정규화) */
  direction: THREE.Vector3;
  /** 쏜 쪽 (없으면 환경/테스트) */
  attacker?: AttackerInfo;
  /** 피해를 준 무기 id (킬로그 원인 아이콘). 판정·피해 계산에는 쓰지 않음 */
  weaponId?: string;
  /** 헤드샷 배율이 적용된 사격 (킬로그 헤드샷 표시). 근접은 헤드샷 없음 → false */
  headshot?: boolean;
}

/** 공격자 정보 (피해 방향 표시·적대 판정용) */
export interface AttackerInfo {
  /** 같은 대상인지 비교용 식별자 */
  readonly id: string;
  readonly name: string;
  readonly team: string;
  /** 쏜 순간 위치 (총구) */
  readonly position: THREE.Vector3;
}

/** 사격으로 피해를 받을 수 있는 대상 */
export interface Damageable {
  readonly alive: boolean;
  /** 디버그 표시용 이름 */
  readonly name?: string;
  /** 진영. 없으면 누구에게나 피해를 받는 중립 대상 (테스트 표적) */
  readonly team?: string;
  /** 식별자 (자기 자신 판정). 없으면 중립 */
  readonly id?: string;
  /** @returns 실제로 들어간 피해 (무적·사망이면 0) */
  applyHit(hit: HitInfo): number;
}

export interface Hitbox {
  target: Damageable;
  part: HitPart;
}

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  collider: RAPIER.Collider;
  hitbox: Hitbox | null;
}

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

/** Rapier 월드 래퍼. 레이캐스트 결과를 three.js 타입으로 돌려주고 히트박스를 관리한다. */
export class Physics {
  readonly world: RAPIER.World;
  private readonly hitboxes = new Map<number, Hitbox>();
  /** 판정 전용 히트박스 (캐릭터 이동 충돌에서 제외) */
  private readonly hitboxOnly = new Set<number>();
  /** 사격·카메라 쿼리에서 제외하는 콜라이더 (캐릭터 이동 캡슐: 맞는 건 히트박스) */
  private readonly queryIgnored = new Set<number>();
  /** 디버그 표시용 콜라이더 이름 (낮은 엄폐물·바깥 벽 등). 판정에는 쓰지 않음 */
  private readonly labels = new Map<number, string>();
  /** 캐릭터 이동·일어서기 검사용 필터: 판정 전용 히트박스는 장애물이 아님 */
  readonly movementFilter = (c: RAPIER.Collider): boolean => c.isEnabled() && !c.isSensor() && !this.hitboxOnly.has(c.handle);
  private readonly staticFilter = (c: RAPIER.Collider): boolean =>
    c.isEnabled() && !c.isSensor() && !this.queryIgnored.has(c.handle) && !this.hitboxes.has(c.handle);
  private readonly shotFilter = (c: RAPIER.Collider): boolean =>
    c.isEnabled() && !c.isSensor() && !this.queryIgnored.has(c.handle);
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private castBall: RAPIER.Ball | null = null;
  private queryBall: RAPIER.Ball | null = null;

  constructor(fixedStep: number) {
    // 캐릭터는 키네마틱 컨트롤러가 중력을 직접 처리하므로 월드 중력은 동적 물체용
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = fixedStep;
  }

  step(): void {
    this.world.step();
  }


  addFixedBox(center: THREE.Vector3, halfExtents: THREE.Vector3, rotation?: THREE.Quaternion): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setTranslation(center.x, center.y, center.z);
    if (rotation) desc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
    return this.world.createCollider(desc);
  }

  /** 고정 볼록 충돌체 (경사로·계단 쐐기). points = 월드 좌표 xyz 나열 */
  addFixedConvex(points: Float32Array): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.convexHull(points);
    if (!desc) throw new Error('볼록 충돌체를 만들 수 없음 (점이 부족하거나 한 평면 위)');
    return this.world.createCollider(desc);
  }

  /** 고정 충돌체 제거 (로비 공간을 매치 시작 때 치울 때). 붙인 이름·쿼리 제외 표시도 함께 지움 */
  removeCollider(collider: RAPIER.Collider): void {
    this.labels.delete(collider.handle);
    this.queryIgnored.delete(collider.handle);
    this.world.removeCollider(collider, false);
  }

  /** @param hitboxOnly true면 이동 충돌에는 쓰지 않는 판정 전용 콜라이더 */
  registerHitbox(collider: RAPIER.Collider, hitbox: Hitbox, hitboxOnly = false): void {
    this.hitboxes.set(collider.handle, hitbox);
    if (hitboxOnly) this.hitboxOnly.add(collider.handle);
  }

  unregisterHitbox(collider: RAPIER.Collider): void {
    this.hitboxes.delete(collider.handle);
    this.hitboxOnly.delete(collider.handle);
  }

  /** 디버그 표시용 이름 붙이기 (사격 경로 디버그에서 충돌한 물체 이름) */
  setLabel(collider: RAPIER.Collider, label: string): void {
    this.labels.set(collider.handle, label);
  }

  /** 충돌체 이름: 판정 영역이면 대상 이름·부위, 아니면 붙인 이름 (없으면 '장애물') */
  labelOf(collider: RAPIER.Collider): string {
    const hb = this.hitboxes.get(collider.handle);
    if (hb) return `${hb.target.name ?? '대상'} ${hb.part === 'head' ? '머리' : '몸'}`;
    return this.labels.get(collider.handle) ?? '장애물';
  }

  /** 사격·시야·카메라 쿼리에서 이 콜라이더를 무시 (캐릭터 이동 캡슐) */
  ignoreForQueries(collider: RAPIER.Collider): void {
    this.queryIgnored.add(collider.handle);
  }

  /** ignoreForQueries 해제 (콜라이더를 지울 때) */
  unignoreForQueries(collider: RAPIER.Collider): void {
    this.queryIgnored.delete(collider.handle);
  }

  isQueryIgnored(collider: RAPIER.Collider): boolean {
    return this.queryIgnored.has(collider.handle);
  }

  isHitboxOnly(collider: RAPIER.Collider): boolean {
    return this.hitboxOnly.has(collider.handle);
  }

  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDistance: number,
    exclude?: RAPIER.Collider,
    /** 쏜 캐릭터 자신 (이동 캡슐·히트박스가 붙은 강체) */
    excludeBody?: RAPIER.RigidBody,
  ): RayHit | null {
    setXyz(this.ray.origin, origin.x, origin.y, origin.z);
    setXyz(this.ray.dir, dir.x, dir.y, dir.z);
    const hit = this.world.castRayAndGetNormal(
      this.ray, maxDistance, true, undefined, undefined, exclude, excludeBody, this.shotFilter,
    );
    if (!hit) return null;
    return {
      point: origin.clone().addScaledVector(dir, hit.timeOfImpact),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: hit.timeOfImpact,
      collider: hit.collider,
      hitbox: this.hitboxes.get(hit.collider.handle) ?? null,
    };
  }

  /**
   * 구 안에 겹치는 활성 히트박스 수집 (근접 공격 후보). 쏜 캐릭터 강체는 제외.
   * 결과 배열은 호출자가 재사용 (매 공격 1회라 비용 작음)
   */
  hitboxesInSphere(center: THREE.Vector3, radius: number, excludeBody: RAPIER.RigidBody, out: Array<{ collider: RAPIER.Collider; hitbox: Hitbox }>): void {
    out.length = 0;
    if (!this.queryBall || this.queryBall.radius !== radius) this.queryBall = new RAPIER.Ball(radius);
    this.world.intersectionsWithShape(
      { x: center.x, y: center.y, z: center.z },
      { x: 0, y: 0, z: 0, w: 1 },
      this.queryBall,
      (c) => {
        const hitbox = this.hitboxes.get(c.handle);
        if (hitbox) out.push({ collider: c, hitbox });
        return true;
      },
      undefined,
      undefined,
      undefined,
      excludeBody,
      (c) => c.isEnabled() && this.hitboxes.has(c.handle),
    );
  }

  /** 맵 구조물만 기준으로 두 점 사이가 트여 있는지 (캐릭터·히트박스 무시. AI 위치 평가용) */
  lineClear(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return true;
    setXyz(this.ray.origin, from.x, from.y, from.z);
    setXyz(this.ray.dir, dx / len, dy / len, dz / len);
    const hit = this.world.castRay(this.ray, len, true, undefined, undefined, undefined, undefined, this.staticFilter);
    return hit === null;
  }

  /** 구를 쓸어 첫 충돌까지 거리를 구한다 (카메라 충돌용). 없으면 maxDistance. */
  sphereCast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
    maxDistance: number,
    exclude?: RAPIER.Collider,
  ): number {
    if (!this.castBall || this.castBall.radius !== radius) this.castBall = new RAPIER.Ball(radius);
    const shape = this.castBall;
    const hit = this.world.castShape(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: dir.x, y: dir.y, z: dir.z },
      shape, 0, maxDistance, true, undefined, undefined, exclude, undefined,
      (c) => !c.isSensor() && !this.hitboxes.has(c.handle) && !this.queryIgnored.has(c.handle),
    );
    return hit ? hit.time_of_impact : maxDistance;
  }

  dispose(): void {
    this.hitboxes.clear();
    this.hitboxOnly.clear();
    this.queryIgnored.clear();
    try {
      this.world.free();
    } catch (err) {
      // Rapier가 내부 참조가 남았다고 거부하는 경우가 있음 (페이지 새로 고침 때 어차피 해제됨)
      console.warn('[physics] world.free 실패', err);
    }
  }
}

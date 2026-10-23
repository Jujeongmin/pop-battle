import * as THREE from 'three';
import { BULLET_VFX, bulletVfxIdOf, type BulletVfxId } from '../config/bulletVfx';

/**
 * 총알 궤적 (발광 줄): 총구 → 실제 탄착 지점(벽·엄폐물에 막히면 그 지점)까지 한 번에 그리고, 짧은 시간 동안
 * 꼬리(총구 쪽)가 탄착 쪽으로 걷히며 가늘어지고 흐려짐 → 쏜 방향이 한눈에 보임. 날아가는 캡슐 탄환(ToyBullets)과 함께 씀.
 * 시각 전용 — 판정·피해와 무관 (끝점은 이미 끝난 히트스캔 결과 그대로).
 *
 * 색: 탄환 색(팀·캐릭터)을 살짝 밝힌 장난감 색 그대로 (더하기 혼합은 밝은 하늘·바닥에서 하얗게 날아가서 일반 혼합),
 * 사라질 때는 투명도 대신 굵기가 0으로 줄어듦 (인스턴스별 투명도 없이 부드럽게).
 * 성능: InstancedMesh 하나(6각 원통, 그리기 호출 1번), 깊이 기록 없음.
 * 동시 표시 상한 MAX(넘치면 가장 오래된 줄 재사용), 매 프레임 할당 없음, 수명이 끝난 줄은 크기 0으로 숨김.
 * 샷건은 펠릿마다가 아니라 tracerEvery발마다 하나(대표 궤적)만.
 */

const MAX = 40;

interface Tracer {
  active: boolean;
  from: THREE.Vector3;
  dir: THREE.Vector3;
  dist: number;
  t: number;
  life: number;
  width: number;
  /** 밝기를 곱하기 전 색 (탄환 색을 흰색 쪽으로 밝힘) */
  base: THREE.Color;
  serial: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _c = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

export class Tracers {
  private readonly mesh: THREE.InstancedMesh;
  private readonly geometry: THREE.CylinderGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly list: Tracer[] = [];
  private serial = 0;
  /** 샷건 대표 궤적: 무기별 발사 수 */
  private readonly counter = new Map<BulletVfxId, number>();
  /** 품질 낮음(모바일): 궤적 수명·굵기 줄임 */
  low = false;

  constructor(private readonly scene: THREE.Scene) {
    // 길이 1(+Z 0..1), 총구 쪽 끝은 가늘고(0.25) 탄착 쪽은 굵게(0.5) → 날아간 방향
    this.geometry = new THREE.CylinderGeometry(0.5, 0.25, 1, 6, 1, true);
    this.geometry.translate(0, 0.5, 0);
    this.geometry.rotateX(Math.PI / 2);
    this.material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) {
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
      this.list.push({ active: false, from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, t: 0, life: 0, width: 0, base: new THREE.Color(), serial: 0 });
    }
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  /** 궤적 1줄 (펠릿마다 불러도 됨 — 샷건은 tracerEvery발마다 하나만 그림) */
  add(weaponId: string | undefined, from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation): void {
    const id = bulletVfxIdOf(weaponId);
    const p = BULLET_VFX[id].tracer;
    if (!p) return;
    const n = (this.counter.get(id) ?? 0) + 1;
    this.counter.set(id, n);
    if (p.every > 1 && n % p.every !== 1) return;
    const dist = from.distanceTo(to);
    if (dist < 0.3) return;
    let pick = this.list[0]!;
    for (const t of this.list) {
      if (!t.active) {
        pick = t;
        break;
      }
      if (t.serial < pick.serial) pick = t;
    }
    pick.active = true;
    pick.from.copy(from);
    pick.dir.subVectors(to, from).divideScalar(dist);
    pick.dist = dist;
    pick.t = 0;
    pick.life = p.life * (this.low ? 0.8 : 1);
    pick.width = p.width * (this.low ? 0.85 : 1);
    pick.base.set(color).lerp(WHITE, p.whiten).multiplyScalar(p.glow);
    pick.serial = ++this.serial;
    this.mesh.setColorAt(this.list.indexOf(pick), pick.base);
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < MAX; i++) {
      const t = this.list[i]!;
      if (!t.active) continue;
      dirty = true;
      t.t += dt;
      if (t.t >= t.life) {
        t.active = false;
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      const k = t.t / t.life;
      // 꼬리(총구 쪽)가 탄착 쪽으로 걷힘 (처음엔 빠르게), 굵기는 0까지 부드럽게 (= 사라짐)
      const tail = (1 - (1 - k) * (1 - k)) * 0.9;
      const len = t.dist * (1 - tail);
      _p.copy(t.from).addScaledVector(t.dir, t.dist * tail);
      _q.setFromUnitVectors(_z, t.dir);
      const w = t.width * (1 - k) ** 0.8;
      _s.set(w, w, len);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** 화면 전환·사망·리스폰: 남은 궤적 모두 지움 */
  clear(): void {
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) {
      this.list[i]!.active = false;
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

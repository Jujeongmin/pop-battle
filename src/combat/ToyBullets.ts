import * as THREE from 'three';
import { BULLET_POOL, BULLET_VFX, bulletVfxIdOf, DEFAULT_VFX_QUALITY, VFX_QUALITY, type BulletVfxId, type BulletVfxProfile, type VfxQuality } from '../config/bulletVfx';

/**
 * 시각용 장난감 탄환과 고무·클레이 POP 연출: 캡슐 탄환 + 짧은 꼬리, 탄착 때 납작해졌다 사라지는 방울(splat),
 * 사방으로 튀었다 오그라드는 작은 방울(droplets — 총구 POP·명중 터짐·벽 스플래시 공용).
 * 사격은 히트스캔이라 판정·피해는 발사 순간 이미 끝남 — 이 탄환은 총구 → 실제 탄착 지점까지 날아가는 연출만 하고
 * 도착하면 onArrive(탄착 효과)를 부른다. 장애물을 지나가지 않음 (끝점 = 실제 탄 경로가 멈춘 곳).
 *
 * 성능: 탄환·꼬리·납작 방울·튀는 방울을 각각 InstancedMesh 하나로 그림 (색은 인스턴스 색) → 연사해도 그리기 호출 4번.
 * 튀는 방울 수는 품질 설정(VFX_QUALITY, 모바일 기본 low)으로 줄이고 상한을 넘으면 가장 오래된 것부터 재사용.
 * 칸은 미리 만들어 둔 풀에서 재사용, 넘치면 가장 오래된 탄환을 덮어씀. 그림자 없음, 매 프레임 할당 없음.
 */

interface Bullet {
  active: boolean;
  profile: BulletVfxProfile;
  color: THREE.Color;
  from: THREE.Vector3;
  dir: THREE.Vector3;
  dist: number;
  duration: number;
  t: number;
  onArrive: (() => void) | null;
  /** 이 탄환의 꼬리·몸통 칸 번호 */
  slot: number;
  /** 풀에서 오래된 순서 (덮어쓸 때) */
  serial: number;
}

interface Droplet {
  life: number;
  t: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  size: number;
  gravity: number;
}

interface Splat {
  t: number;
  life: number;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  size: number;
}

const SPLAT_POOL = 48;
const DROPLET_POOL = VFX_QUALITY.high.maxDroplets;
const SPLAT_LIFE = 0.2;
const SPAWN_GROW = 0.035;
/** 캡슐 기본 모양: 지름 1, 전체 길이 1.6 (인스턴스 크기로 무기별 길이·지름) */
const CAPSULE_LEN = 1.6;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _y = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/** 꼬리: 인스턴스 색 + 인스턴스 불투명도, 탄환 쪽 진하고 끝으로 갈수록 투명 */
const TRAIL_VERT = /* glsl */ `
attribute float aOpacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = instanceColor;
  // ConeGeometry: uv.y 0 = 밑면(탄환 쪽), 1 = 끝(꼬리 끝)
  vAlpha = aOpacity * (1.0 - uv.y);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const TRAIL_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
  #include <colorspace_fragment>
}`;

/** 클레이·고무 재질: 거칠고 금속성 0, 그늘에서도 색이 죽지 않게 자기 색으로 약하게 밝힘 (흰빛·네온 없이) */
function clayMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * 0.22;',
    );
  };
  mat.customProgramCacheKey = () => 'pop-clay-v1';
  return mat;
}

export class ToyBullets {
  private readonly bodies: THREE.InstancedMesh;
  private readonly trails: THREE.InstancedMesh;
  private readonly splats: THREE.InstancedMesh;
  private readonly drops: THREE.InstancedMesh;
  private readonly dropList: Droplet[] = [];
  private dropCursor = 0;
  /** 품질: 방울 수 배율·동시 상한 */
  quality: VfxQuality = DEFAULT_VFX_QUALITY;
  private readonly trailOpacity: THREE.InstancedBufferAttribute;
  private readonly bullets: Bullet[] = [];
  /** 무기 종류별 칸 범위 (종류마다 상한 따로 → 샷건 펠릿이 라이플 탄환을 밀어내지 않음) */
  private readonly ranges = new Map<BulletVfxId, { start: number; count: number }>();
  private readonly splatList: Splat[] = [];
  private splatCursor = 0;
  private serial = 0;
  /** 디버그: 지금 날아가는 탄환 수 */
  activeCount = 0;

  constructor(private readonly scene: THREE.Scene) {
    let total = 0;
    for (const id of Object.keys(BULLET_POOL) as BulletVfxId[]) {
      this.ranges.set(id, { start: total, count: BULLET_POOL[id] });
      total += BULLET_POOL[id];
    }
    // 저폴리곤 캡슐 (+Z가 진행 방향)
    const capsule = new THREE.CapsuleGeometry(0.5, CAPSULE_LEN - 1, 3, 10).rotateX(Math.PI / 2);
    this.bodies = new THREE.InstancedMesh(capsule, clayMaterial(), total);
    // 꼬리: 밑면이 탄환 뒤, 끝이 뒤쪽 (-Z)
    const cone = new THREE.ConeGeometry(0.5, 1, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5);
    const trailMat = new THREE.ShaderMaterial({ vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG, transparent: true, depthWrite: false });
    this.trails = new THREE.InstancedMesh(cone, trailMat, total);
    this.trailOpacity = new THREE.InstancedBufferAttribute(new Float32Array(total), 1);
    this.trails.geometry.setAttribute('aOpacity', this.trailOpacity);
    // 탄착 방울: 납작해졌다 사라지는 구
    const blob = new THREE.SphereGeometry(0.5, 12, 8);
    this.splats = new THREE.InstancedMesh(blob, clayMaterial(), SPLAT_POOL);
    // 튀는 방울 (저폴리곤 구)
    this.drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 1), clayMaterial(), DROPLET_POOL);

    const white = new THREE.Color(1, 1, 1);
    for (const mesh of [this.bodies, this.trails, this.splats, this.drops]) {
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < mesh.count; i++) {
        mesh.setMatrixAt(i, _zero);
        mesh.setColorAt(i, white);
      }
      scene.add(mesh);
    }
    this.trails.renderOrder = 19;
    for (let i = 0; i < total; i++) {
      this.bullets.push({ active: false, profile: BULLET_VFX.rifle, color: new THREE.Color(), from: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, duration: 0, t: 0, onArrive: null, slot: i, serial: 0 });
    }
    for (let i = 0; i < SPLAT_POOL; i++) this.splatList.push({ t: 0, life: 0, pos: new THREE.Vector3(), normal: new THREE.Vector3(), size: 0 });
    for (let i = 0; i < DROPLET_POOL; i++) this.dropList.push({ life: 0, t: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 0, gravity: 0 });
  }

  /**
   * 탄환 1발 (펠릿마다 1발). from = 실제 탄 경로 시작(총구), to = 실제 탄착(또는 사거리 끝).
   * onArrive = 도착할 때 부를 탄착 효과 (없으면 그냥 사라짐)
   */
  fire(weaponId: string | undefined, from: THREE.Vector3, to: THREE.Vector3, onArrive: (() => void) | null, color?: THREE.ColorRepresentation): void {
    const id = bulletVfxIdOf(weaponId);
    const profile = BULLET_VFX[id];
    const range = this.ranges.get(id)!;
    // 빈 칸, 없으면 이 종류에서 가장 오래된 칸 (그 탄환의 탄착 효과는 바로 실행)
    let pick: Bullet | null = null;
    for (let i = range.start; i < range.start + range.count; i++) {
      const b = this.bullets[i]!;
      if (!b.active) {
        pick = b;
        break;
      }
      if (!pick || b.serial < pick.serial) pick = b;
    }
    const b = pick!;
    if (b.active) this.finish(b);
    const dist = from.distanceTo(to);
    b.active = true;
    b.profile = profile;
    b.color.set(color ?? profile.color);
    b.from.copy(from);
    b.dist = dist;
    if (dist > 1e-4) b.dir.subVectors(to, from).divideScalar(dist);
    else b.dir.set(0, 0, 1);
    b.duration = Math.min(dist / Math.max(1, profile.speed), profile.maxTravelTime);
    b.t = 0;
    b.onArrive = onArrive;
    b.serial = ++this.serial;
    this.bodies.setColorAt(b.slot, b.color);
    this.trails.setColorAt(b.slot, b.color);
  }

  /** 탄착 방울 (탄환 색) — 벽·바닥에서 납작하게 퍼졌다가 사라짐 */
  splat(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.ColorRepresentation, size: number): void {
    const s = this.splatList[this.splatCursor]!;
    const i = this.splatCursor;
    this.splatCursor = (this.splatCursor + 1) % SPLAT_POOL;
    s.t = 0;
    s.life = SPLAT_LIFE;
    s.pos.copy(point);
    s.normal.copy(normal);
    s.size = size;
    this.splats.setColorAt(i, _tmpColor.set(color));
    if (this.splats.instanceColor) this.splats.instanceColor.needsUpdate = true;
  }

  /**
   * 고무 방울 터짐: count개가 dir(정규화) 쪽 반구로 speed m/s 안팎으로 튀고, 잠깐 커졌다 오그라들며 사라짐.
   * spread 0 = dir 방향으로 몰림, 1 = 반구 전체. 방울 수는 품질 배율 적용
   */
  burst(point: THREE.Vector3, dir: THREE.Vector3, color: THREE.ColorRepresentation, count: number, size: number, speed: number, spread = 1, life = 0.32): void {
    const q = VFX_QUALITY[this.quality];
    const n = Math.max(count > 0 ? 1 : 0, Math.round(count * q.dropletMul));
    const cap = q.maxDroplets;
    _tmpColor.set(color);
    for (let k = 0; k < n; k++) {
      const i = this.dropCursor;
      this.dropCursor = (this.dropCursor + 1) % cap;
      const d = this.dropList[i]!;
      // 반구 안 무작위 방향
      _p.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (_p.lengthSq() < 1e-4) _p.set(0, 1, 0);
      _p.normalize().multiplyScalar(spread);
      _p.add(dir);
      if (_p.dot(dir) < 0) _p.addScaledVector(dir, -2 * _p.dot(dir));
      _p.normalize();
      d.pos.copy(point);
      d.vel.copy(_p).multiplyScalar(speed * (0.55 + Math.random() * 0.7));
      d.size = size * (0.6 + Math.random() * 0.6);
      d.life = life * (0.75 + Math.random() * 0.5);
      d.t = 0;
      d.gravity = 7;
      this.drops.setColorAt(i, k % 4 === 3 ? _white : _tmpColor);
    }
    if (this.drops.instanceColor) this.drops.instanceColor.needsUpdate = true;
  }

  private finish(b: Bullet): void {
    b.active = false;
    this.bodies.setMatrixAt(b.slot, _zero);
    this.trails.setMatrixAt(b.slot, _zero);
    const cb = b.onArrive;
    b.onArrive = null;
    cb?.();
  }

  update(dt: number): void {
    let active = 0;
    for (const b of this.bullets) {
      if (!b.active) continue;
      b.t += dt;
      if (b.t >= b.duration) {
        this.finish(b);
        continue;
      }
      active++;
      const pr = b.profile;
      const k = b.duration > 0 ? b.t / b.duration : 1;
      const traveled = b.dist * k;
      // 탄환 앞쪽 끝이 탄착 지점을 넘지 않게 (벽 속으로 들어가 보이지 않게)
      const half = pr.length / 2;
      const along = Math.min(traveled, Math.max(0, b.dist - half));
      if (traveled > pr.maxDistance) {
        this.bodies.setMatrixAt(b.slot, _zero);
        this.trails.setMatrixAt(b.slot, _zero);
        continue;
      }
      _p.copy(b.from).addScaledVector(b.dir, along);
      _q.setFromUnitVectors(_z, b.dir);
      // 말랑한 느낌: 처음 몇 프레임 동안 커지고, 날아가는 동안 살짝 늘었다 줄었다
      const grow = THREE.MathUtils.smoothstep(b.t, 0, SPAWN_GROW) * 0.45 + 0.55;
      const wobble = 1 + 0.07 * Math.sin(b.t * 55);
      _s.set(pr.diameter * grow / wobble, pr.diameter * grow / wobble, (pr.length / CAPSULE_LEN) * grow * wobble);
      this.bodies.setMatrixAt(b.slot, _m.compose(_p, _q, _s));
      // 꼬리: 탄환 뒤쪽 끝에서 시작, 이동한 거리보다 길지 않게
      const trailLen = Math.min(pr.trailLength, Math.max(0, along - half));
      if (trailLen > 0.01) {
        _p.addScaledVector(b.dir, -half * 0.6);
        _s.set(pr.diameter * 0.75, pr.diameter * 0.75, trailLen);
        this.trails.setMatrixAt(b.slot, _m.compose(_p, _q, _s));
        this.trailOpacity.setX(b.slot, pr.trailOpacity);
      } else {
        this.trails.setMatrixAt(b.slot, _zero);
      }
    }
    this.activeCount = active;
    for (let i = 0; i < SPLAT_POOL; i++) {
      const s = this.splatList[i]!;
      if (s.life <= 0) continue;
      s.t += dt;
      if (s.t >= s.life) {
        s.life = 0;
        this.splats.setMatrixAt(i, _zero);
        continue;
      }
      // 부딪힌 순간 납작하게 퍼졌다가(0~35%) 오그라들며 사라짐
      const u = s.t / s.life;
      const spread = u < 0.35 ? THREE.MathUtils.smoothstep(u, 0, 0.35) : 1;
      const shrink = u < 0.35 ? 1 : 1 - THREE.MathUtils.smoothstep(u, 0.35, 1);
      const w = s.size * (0.6 + 0.9 * spread) * shrink;
      const h = s.size * (0.8 - 0.55 * spread) * shrink;
      _q.setFromUnitVectors(_y, s.normal);
      _p.copy(s.pos).addScaledVector(s.normal, h * 0.25);
      this.splats.setMatrixAt(i, _m.compose(_p, _q, _s.set(w, h, w)));
    }
    for (let i = 0; i < DROPLET_POOL; i++) {
      const d = this.dropList[i]!;
      if (d.life <= 0) continue;
      d.t += dt;
      if (d.t >= d.life) {
        d.life = 0;
        this.drops.setMatrixAt(i, _zero);
        continue;
      }
      d.vel.y -= d.gravity * dt;
      d.vel.multiplyScalar(Math.exp(-3 * dt));
      d.pos.addScaledVector(d.vel, dt);
      // 팡: 처음 15%에 1.3배로 부풀었다가 끝으로 갈수록 오그라듦, 진행 방향으로 살짝 늘어남
      const u = d.t / d.life;
      const pop = u < 0.15 ? 0.6 + 0.7 * (u / 0.15) : 1.3 * (1 - THREE.MathUtils.smoothstep(u, 0.15, 1));
      const sp = d.vel.length();
      const stretch = 1 + Math.min(0.6, sp * 0.06);
      if (sp > 1e-3) _q.setFromUnitVectors(_y, _s.copy(d.vel).divideScalar(sp));
      else _q.identity();
      const r = d.size * pop;
      this.drops.setMatrixAt(i, _m.compose(d.pos, _q, _s.set(r / Math.sqrt(stretch), r * stretch, r / Math.sqrt(stretch))));
    }
    this.drops.instanceMatrix.needsUpdate = true;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.trails.instanceMatrix.needsUpdate = true;
    this.splats.instanceMatrix.needsUpdate = true;
    this.trailOpacity.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.trails.instanceColor) this.trails.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.bodies, this.trails, this.splats, this.drops]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}

const _tmpColor = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);

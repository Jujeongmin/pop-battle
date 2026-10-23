import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CAMERA, CAMERA_MOBILE } from '../config/gameConfig';
import { adsFov, aimProfileFov, type AimProfile } from '../config/weapons';
import type { Physics } from '../physics/Physics';

export interface CameraFrame {
  dt: number;
  /** 보간된 캐릭터 발 위치 */
  target: THREE.Vector3;
  /** 0..1 조준 블렌드 (AimController) */
  aimBlend: number;
  aimProfile: AimProfile | null;
  slideBlend: number;
  sprinting: boolean;
}

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _shoulder = new THREE.Vector3();

/** 충돌 지점 앞 여유 (m) */
const CAMERA_SKIN = 0.02;

function damp(a: number, b: number, sharpness: number, dt: number): number {
  return THREE.MathUtils.lerp(a, b, 1 - Math.exp(-sharpness * dt));
}

/** 오른쪽 어깨 뒤 고정 TPS 카메라. 벽 충돌 시 앞으로 당겨지고, ADS에서 FOV/거리가 부드럽게 바뀐다. */
export class TpsCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw = Math.PI;
  pitch = -0.1;
  private readonly pivot = new THREE.Vector3();
  private pivotInit = false;
  private currentDistance: number = CAMERA.distance;
  /** 어깨 오프셋 적용 비율 (옆 벽에 막히면 줄어듦) */
  private shoulderFrac = 1;
  private recoilRecover = { pitch: 0, yaw: 0 };
  private recoilRecoverSharpness = 7;
  private shake = 0;
  /** 0..1 달리기 FOV 보간 (즉시 바꾸면 화면이 튐) */
  private sprintT = 0;
  /**
   * 캐릭터 키 배율 (기준 1.25m 대비). 피벗 높이·슬라이딩 낮춤에 곱함 → 작은 캐릭터가 몸보다 높은 시점으로
   * 엄폐물 위를 넘겨보는 이점이 없게, 큰 캐릭터는 머리 뒤 시점 유지
   */
  heightScale = 1;
  /** 모바일(터치 모드): 일반 시점 = CAMERA_MOBILE, ADS = 무기별 설정 + PC와 같은 확대 비율 (Game이 매 프레임 설정) */
  mobile = false;

  constructor(
    aspect: number,
    private readonly physics: Physics,
    private readonly ignore: RAPIER.Collider,
  ) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, CAMERA.near, CAMERA.far);
  }

  get distanceToPivot(): number {
    return this.camera.position.distanceTo(this.pivot);
  }

  applyLook(dx: number, dy: number, sensitivityMultiplier: number): void {
    const s = CAMERA.sensitivity * sensitivityMultiplier;
    this.yaw -= dx * s;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - dy * s,
      THREE.MathUtils.degToRad(CAMERA.minPitchDeg),
      THREE.MathUtils.degToRad(CAMERA.maxPitchDeg),
    );
  }

  /** 사격 반동: 조준점을 실제로 올리고, 일부는 자동 복귀시킨다. */
  addRecoil(pitchRad: number, yawRad: number, recoveryRatio: number, recoverySharpness: number): void {
    this.pitch = Math.min(this.pitch + pitchRad, THREE.MathUtils.degToRad(CAMERA.maxPitchDeg));
    this.yaw += yawRad;
    this.recoilRecover.pitch += pitchRad * recoveryRatio;
    this.recoilRecover.yaw += yawRad * recoveryRatio;
    this.recoilRecoverSharpness = recoverySharpness;
    this.shake = Math.min(1, this.shake + 0.35);
  }

  snapBehind(yaw: number, target: THREE.Vector3): void {
    this.shoulderFrac = 1;
    this.yaw = yaw + Math.PI;
    this.pitch = -0.1;
    this.recoilRecover.pitch = 0;
    this.recoilRecover.yaw = 0;
    this.pivotInit = false;
    this.pivot.copy(target);
  }

  update(f: CameraFrame): void {
    const { dt } = f;
    // 반동 복귀
    const k = 1 - Math.exp(-this.recoilRecoverSharpness * dt);
    const rp = this.recoilRecover.pitch * k;
    const ry = this.recoilRecover.yaw * k;
    this.pitch -= rp;
    this.yaw -= ry;
    this.recoilRecover.pitch -= rp;
    this.recoilRecover.yaw -= ry;

    // TPS형 ADS: 모든 무기가 오른쪽 어깨 카메라를 당기며 확대 (스코프 정렬 없음)
    const p = f.aimProfile;
    const blend = f.aimBlend;
    // 일반 시점 값 (모바일만 따로). ADS 끝값(거리·어깨·높이)은 무기별 설정 그대로 → 사이는 부드럽게 보간.
    // ADS FOV: PC에서의 '일반 대비 확대 비율'(배율, 또는 직접 지정 FOV를 PC 기본 FOV와 비교한 비율)을 모바일 일반 FOV에 적용
    // → 낮은 배율 무기(샷건·권총)가 모바일 ADS에서 오히려 넓어지지 않음. PC는 기존 계산 그대로
    const hip = this.mobile ? CAMERA_MOBILE : CAMERA;
    const shoulder = THREE.MathUtils.lerp(hip.shoulderOffset, p?.shoulderOffset ?? hip.shoulderOffset, blend);
    const height = THREE.MathUtils.lerp(hip.heightOffset, p?.heightOffset ?? hip.heightOffset, blend);
    const distance = THREE.MathUtils.lerp(hip.distance, p?.cameraDistance ?? hip.distance, blend);
    this.sprintT = damp(this.sprintT, f.sprinting ? 1 : 0, 6, dt);
    const fov =
      THREE.MathUtils.lerp(hip.fov, p ? this.adsFovFor(p) : hip.fov, blend) +
      CAMERA.sprintFovAdd * this.sprintT * (1 - f.aimBlend);

    // 피벗(머리 뒤 회전 중심) 보간
    _desired.copy(f.target);
    _desired.y += (CAMERA.pivotHeight - CAMERA.slideDrop * f.slideBlend) * this.heightScale;
    if (!this.pivotInit) {
      this.pivot.copy(_desired);
      this.pivotInit = true;
    } else {
      const t = 1 - Math.exp(-CAMERA.pivotSharpness * dt);
      this.pivot.lerp(_desired, t);
    }

    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
    _forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);

    // 카메라 충돌: 구를 쓸어 장애물 바로 앞(구 반지름만큼 떨어진 곳)까지만 이동.
    // 장애물에 다가가면 즉시 당기고, 멀어지면 천천히 복귀 (벽 근처 떨림 방지). 플레이어 콜라이더는 제외.
    // 1) 피벗(머리 중심) → 어깨 지점
    _shoulder.copy(this.pivot).addScaledVector(_right, shoulder);
    _shoulder.y += height;
    _dir.subVectors(_shoulder, this.pivot);
    const sideLen = _dir.length();
    if (sideLen > 1e-4) {
      _dir.divideScalar(sideLen);
      const frac = this.castSafe(this.pivot, _dir, sideLen) / sideLen;
      this.shoulderFrac = frac < this.shoulderFrac ? frac : damp(this.shoulderFrac, frac, CAMERA.pushOutSharpness, dt);
      _shoulder.copy(this.pivot).addScaledVector(_dir, sideLen * this.shoulderFrac);
    }
    // 2) 어깨 → 뒤쪽
    _dir.copy(_forward).negate();
    const allowed = this.castSafe(_shoulder, _dir, distance);
    if (allowed < this.currentDistance) this.currentDistance = allowed;
    else this.currentDistance = damp(this.currentDistance, allowed, CAMERA.pushOutSharpness, dt);

    this.camera.position.copy(_shoulder).addScaledVector(_dir, this.currentDistance);

    // 사격 흔들림 (아주 작게, 스코프 중에는 없음)
    this.shake = Math.max(0, this.shake - dt * 6);
    if (this.shake > 0 && f.aimBlend < 0.01) {
      const a = this.shake * 0.006;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
    }

    this.setFov(fov);
    this.camera.updateMatrixWorld();
  }

  /** 무기 ADS FOV (도). PC = 무기 설정 그대로, 모바일 = 같은 확대 비율을 모바일 일반 FOV에 */
  private adsFovFor(p: AimProfile): number {
    const pc = aimProfileFov(CAMERA.fov, p);
    if (!this.mobile) return pc;
    const half = (deg: number) => Math.tan(THREE.MathUtils.degToRad(deg / 2));
    return adsFov(CAMERA_MOBILE.fov, half(CAMERA.fov) / half(pc));
  }

  /** 시작 구가 이미 벽과 겹치면(toi 0) 작은 구로 다시 검사 */
  private castSafe(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number): number {
    const d = this.physics.sphereCast(origin, dir, CAMERA.collisionRadius, maxDistance, this.ignore);
    // 닿은 지점에서 조금 띄워 둬야 다음 검사(어깨 → 뒤)가 벽과 겹친 채 시작하지 않는다
    if (d >= maxDistance) return maxDistance;
    if (d > 1e-3) return Math.max(0, d - CAMERA_SKIN);
    return Math.max(0, this.physics.sphereCast(origin, dir, CAMERA.near * 1.5, maxDistance, this.ignore) - CAMERA.near);
  }

  private setFov(fov: number): void {
    if (Math.abs(this.camera.fov - fov) > 0.001) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}

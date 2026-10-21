import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();

/** 본의 월드 회전을 지정한다 (부모 회전을 역으로 적용해 로컬 값으로 변환). */
export function setWorldQuaternion(bone: THREE.Object3D, worldQ: THREE.Quaternion): void {
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qParent).invert();
    bone.quaternion.copy(_qParent).multiply(worldQ);
  } else {
    bone.quaternion.copy(worldQ);
  }
  bone.updateMatrixWorld(true);
}

/** bone을 회전시켜 (childPos - bonePos) 방향이 (targetPos - bonePos)를 향하게 한다. weight로 부분 적용. */
export function rotateBoneToward(
  bone: THREE.Object3D,
  bonePos: THREE.Vector3,
  childPos: THREE.Vector3,
  targetPos: THREE.Vector3,
  weight = 1,
  maxAngle = Math.PI,
): void {
  _from.subVectors(childPos, bonePos);
  _to.subVectors(targetPos, bonePos);
  if (_from.lengthSq() < 1e-10 || _to.lengthSq() < 1e-10) return;
  _from.normalize();
  _to.normalize();
  _q.setFromUnitVectors(_from, _to);
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(_q.w, -1, 1));
  const limit = Math.min(1, maxAngle / Math.max(angle, 1e-6));
  const w = weight * limit;
  if (w < 1) _q.slerp(new THREE.Quaternion(), 1 - w);
  bone.getWorldQuaternion(_qWorld);
  _qWorld.premultiply(_q);
  setWorldQuaternion(bone, _qWorld);
}

/**
 * 해석적 2본 IK. upper→lower→end 체인의 end가 target에 닿도록 upper/lower를 회전한다.
 * pole은 팔꿈치가 굽는 쪽을 가리키는 월드 위치. 닿지 않으면 팔을 쭉 뻗어 target을 향한다.
 * @returns 남은 거리 오차 (0이면 도달)
 */
export function solveTwoBoneIk(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  pole: THREE.Vector3,
): number {
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  const lab = _a.distanceTo(_b);
  const lbc = _b.distanceTo(_c);
  _dir.subVectors(target, _a);
  const rawDist = _dir.length();
  if (rawDist < 1e-6) return 0;
  _dir.divideScalar(rawDist);
  const maxReach = (lab + lbc) * 0.999;
  const minReach = Math.abs(lab - lbc) * 1.001;
  const d = THREE.MathUtils.clamp(rawDist, minReach, maxReach);

  // 굽힘 평면: target 방향에 수직인 pole 성분
  _bend.subVectors(pole, _a);
  _bend.addScaledVector(_dir, -_bend.dot(_dir));
  if (_bend.lengthSq() < 1e-10) _bend.set(0, -1, 0).addScaledVector(_dir, -_dir.y);
  _bend.normalize();

  const cosA = THREE.MathUtils.clamp((lab * lab + d * d - lbc * lbc) / (2 * lab * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _desired.copy(_a).addScaledVector(_dir, cosA * lab).addScaledVector(_bend, sinA * lab);

  rotateBoneToward(upper, _a, _b, _desired);
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  _desired.copy(_a).addScaledVector(_dir, d);
  rotateBoneToward(lower, _b, _c, _desired);
  return Math.max(0, rawDist - d);
}

/**
 * 본 로컬 축 두 개가 지정한 월드 방향을 향하는 회전을 만든다.
 * primaryAxis(로컬) → primaryDir(월드), secondaryAxis(로컬) → secondaryDir(월드, 직교화).
 */
export function quaternionFromAxes(
  primaryAxis: THREE.Vector3,
  primaryDir: THREE.Vector3,
  secondaryAxis: THREE.Vector3,
  secondaryDir: THREE.Vector3,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const basis = (x: THREE.Vector3, y: THREE.Vector3): THREE.Matrix4 => {
    const p = x.clone().normalize();
    const s = y.clone().addScaledVector(p, -y.dot(p)).normalize();
    const t = new THREE.Vector3().crossVectors(p, s);
    return new THREE.Matrix4().makeBasis(p, s, t);
  };
  const local = basis(primaryAxis, secondaryAxis);
  const world = basis(primaryDir, secondaryDir);
  // world = R * local  →  R = world * local^T
  const r = world.multiply(local.transpose());
  return out.setFromRotationMatrix(r);
}

// 모바일(터치) 전용 약한 에임 보정 — 카메라 회전 입력만 바꾼다 (탄 방향·명중 판정·서버 검증은 그대로).
// - Aim Slowdown: 조준선이 적 몸통 근처에 있으면 손가락 회전을 살짝 느리게
// - Aim Magnetism: 손가락으로 끄는 중일 때만, 끈 양에 비례해 몸통 쪽으로 아주 조금 더 돌림 (입력이 없으면 아무것도 안 함)
// 대상은 몸통 중심만 (머리 자동 조준 없음), 맵 구조물에 가린 적은 제외. 강도는 AIM_ASSIST 상수로 조정.
import * as THREE from 'three';

export const AIM_ASSIST = {
  /** 감속 반경 (도): 조준선과 적 몸통 중심 사이 각도가 이 안이면 감속 */
  slowRadiusDeg: 5,
  /** 최대 감속 비율 (0.3 = 몸통 정중앙에서 회전 30% 느리게, 반경 끝으로 갈수록 0) */
  slowdown: 0.3,
  /** 끌림 반경 (도) */
  magnetRadiusDeg: 3.5,
  /** 끌림 세기: 이번 프레임 손가락 회전량(rad) 대비 몸통 쪽 추가 회전 비율 */
  magnetism: 0.15,
  /** 적 쪽과 반대로 끌 때는 끌림 없음 (끄는 방향과 적 방향 코사인이 이보다 작으면) */
  magnetMinCos: -0.2,
  /** 이 거리(m)보다 먼 적은 보정 없음 */
  maxRange: 70,
} as const;

export interface AssistTarget {
  /** 몸통 중심 (월드) */
  point: THREE.Vector3;
}

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();

/**
 * 터치 회전 입력(dx, dy: 화면 px × 감도, TpsCamera.applyLook 단위) 보정.
 * @param radPerUnit applyLook이 입력 1당 돌리는 각도 (rad) — 끌림을 입력 단위로 바꿀 때
 * @param clear 카메라 → 대상 사이가 맵 구조물에 막히지 않았는지
 * @returns 보정한 입력 (대상이 없거나 입력이 0이면 그대로)
 */
export function assistTouchLook(
  dx: number,
  dy: number,
  camera: THREE.Camera,
  targets: readonly AssistTarget[],
  radPerUnit: number,
  clear: (from: THREE.Vector3, to: THREE.Vector3) => boolean,
): { dx: number; dy: number; target: number } {
  if ((dx === 0 && dy === 0) || targets.length === 0 || radPerUnit <= 0) return { dx, dy, target: -1 };
  const m = camera.matrixWorld;
  camera.getWorldPosition(_p);
  _r.setFromMatrixColumn(m, 0).normalize();
  _u.setFromMatrixColumn(m, 1).normalize();
  _f.setFromMatrixColumn(m, 2).normalize().negate();
  const slowRad = THREE.MathUtils.degToRad(AIM_ASSIST.slowRadiusDeg);
  // 조준선 가까운 순 → 처음으로 가리지 않은 대상 하나
  const near: Array<{ i: number; ex: number; ey: number; ang: number }> = [];
  targets.forEach((t, i) => {
    _v.subVectors(t.point, _p);
    const ahead = _v.dot(_f);
    if (ahead <= 0.5 || _v.length() > AIM_ASSIST.maxRange) return;
    const ex = Math.atan2(_v.dot(_r), ahead);
    const ey = Math.atan2(_v.dot(_u), ahead);
    const ang = Math.hypot(ex, ey);
    if (ang < slowRad) near.push({ i, ex, ey, ang });
  });
  near.sort((a, b) => a.ang - b.ang);
  const hit = near.find((n) => clear(_p, targets[n.i]!.point));
  if (!hit) return { dx, dy, target: -1 };
  // 감속: 가운데일수록 크게
  const k = 1 - AIM_ASSIST.slowdown * (1 - hit.ang / slowRad);
  let ox = dx * k;
  let oy = dy * k;
  // 끌림: 끄는 중 + 반경 안 + 적 반대쪽으로 끄는 게 아닐 때만. 조준선 이동 방향 = (dx, -dy)
  if (hit.ang < THREE.MathUtils.degToRad(AIM_ASSIST.magnetRadiusDeg) && hit.ang > 1e-5) {
    const drag = Math.hypot(dx, dy);
    const cos = (dx * hit.ex - dy * hit.ey) / (drag * hit.ang);
    if (cos >= AIM_ASSIST.magnetMinCos) {
      const nudge = Math.min(AIM_ASSIST.magnetism * drag * radPerUnit, hit.ang);
      // yaw는 dx > 0이면 오른쪽, pitch는 dy < 0이면 위 (TpsCamera.applyLook)
      ox += ((hit.ex / hit.ang) * nudge) / radPerUnit;
      oy -= ((hit.ey / hit.ang) * nudge) / radPerUnit;
    }
  }
  return { dx: ox, dy: oy, target: hit.i };
}

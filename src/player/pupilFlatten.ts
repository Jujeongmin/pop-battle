import * as THREE from 'three';

/**
 * 사망 표정용 "눈동자 평탄화" 모프 (런타임 생성, GLB는 그대로).
 *
 * 원인: 6종 모두 눈동자가 흰자 위에 따로 솟은 볼록면(흰자 구면보다 1.3~2.3cm 앞, 2026-10-21 실측)이라,
 * 사망 때 눈동자 텍셀을 흰자색 + X로 바꾸면 그 볼록면이 흰 혹처럼 튀어나와 보임.
 * 처리: 눈마다 흰자 정점(밝고 채도 낮은 텍셀)으로 구를 맞추고, 눈 타원 안 + 사망 눈 텍스처가 바꾸는 텍셀(눈동자·흰자 안쪽)에서 그 구보다 앞으로 나온 정점만
 * 구 표면으로 당기는 상대 모프 + 법선(구의 방향)을 만든다. 흰자·눈 윤곽·얼굴은 움직이지 않음.
 * 눈 조각(side 1·2)마다 모프 하나 → 한쪽 눈 디버그 표정도 그대로 동작.
 * 같은 지오메트리(같은 캐릭터 GLB 사본)는 한 번만 만든다.
 */

export interface PupilFlattenEye {
  /** 모델 공간 눈(흰자) 타원 중심·반지름: x = 좌우, z = 높이 (tools/blender/dead_eyes.py 정면 투영) */
  cx: number;
  cz: number;
  rx: number;
  rz: number;
}

export interface PupilFlattenInput {
  rects: ReadonlyArray<{ uv: readonly [number, number, number, number]; atlas: readonly [number, number, number, number]; side?: number }>;
  eyes: readonly PupilFlattenEye[];
  /** 사망 눈 아틀라스 (알파 > 0 = dead_eyes.py가 바꾼 텍셀 = 눈동자 + 흰자 안쪽. 머리카락·피부·비니는 0) */
  texture: THREE.Texture;
}

/** 모프 이름: side 1 / 2 */
export const PUPIL_MORPH = (side: number) => `DeadPupil${side}`;

/** 결과 (디버그): 눈 조각별 흰자 구 반지름·맞춤 오차·옮긴 정점 수·최대 이동 (모델 단위) */
export interface PupilFlattenReport {
  side: number;
  whites: number;
  radius: number;
  rms: number;
  moved: number;
  maxShift: number;
}

const WHITE_LUM = 180;
const WHITE_SAT = 40;
/**
 * 옮길 수 있는 정점: 사망 눈 아틀라스 알파가 이 값 이상(dead_eyes.py가 다루는 눈 영역) + 원본 텍셀 채도가 낮음(눈동자·흰자·반사광).
 * 아틀라스 조각 안에도 원본 색을 복사한 비니·피부 가장자리가 있어 채도도 함께 본다. 앞머리(검정)는 아틀라스 밖
 */
const PATCH_ALPHA = 128;
const EYE_SAT = 70;
/** 이만큼(모델 단위) 이상 구 밖에 있는 정점만 옮김 */
const MIN_OUT = 0.001;
/** 눈 타원 여유 (눈동자 볼록면이 흰자 윤곽에 걸친 정점까지) */
const ELLIPSE_MARGIN = 1.05;

function fitSphere(pts: ReadonlyArray<THREE.Vector3>): { c: THREE.Vector3; r: number; rms: number } | null {
  if (pts.length < 8) return null;
  // x²+y²+z² = 2ax + 2by + 2cz + d (최소제곱, 4×4 정규방정식)
  const m = Array.from({ length: 4 }, () => new Array<number>(5).fill(0));
  for (const p of pts) {
    const row = [2 * p.x, 2 * p.y, 2 * p.z, 1];
    const rhs = p.lengthSq();
    for (let i = 0; i < 4; i++) {
      m[i]![4]! += row[i]! * rhs;
      for (let j = 0; j < 4; j++) m[i]![j]! += row[i]! * row[j]!;
    }
  }
  for (let i = 0; i < 4; i++) {
    let piv = i;
    for (let r = i + 1; r < 4; r++) if (Math.abs(m[r]![i]!) > Math.abs(m[piv]![i]!)) piv = r;
    [m[i], m[piv]] = [m[piv]!, m[i]!];
    if (Math.abs(m[i]![i]!) < 1e-12) return null;
    for (let r = 0; r < 4; r++) {
      if (r === i) continue;
      const f = m[r]![i]! / m[i]![i]!;
      for (let c = i; c < 5; c++) m[r]![c]! -= f * m[i]![c]!;
    }
  }
  const s = m.map((row, i) => row[4]! / row[i]!);
  const c = new THREE.Vector3(s[0], s[1], s[2]);
  const r = Math.sqrt(s[3]! + c.lengthSq());
  if (!Number.isFinite(r)) return null;
  let e = 0;
  for (const p of pts) e += (p.distanceTo(c) - r) ** 2;
  return { c, r, rms: Math.sqrt(e / pts.length) };
}

/** 흰자 구 맞춤: 한 번 맞춘 뒤 오차가 큰 점(눈꺼풀·머리카락 경계)을 빼고 다시 */
function robustSphere(pts: THREE.Vector3[]): { c: THREE.Vector3; r: number; rms: number } | null {
  const first = fitSphere(pts);
  if (!first) return null;
  const keep = pts.filter((p) => Math.abs(p.distanceTo(first.c) - first.r) <= Math.max(2.5 * first.rms, 0.002));
  return keep.length >= 8 ? fitSphere(keep) ?? first : first;
}

/** 텍스처에서 UV 영역만 읽기 (2048² 전체를 읽지 않음) */
function readRegion(map: THREE.Texture, u0: number, v0: number, u1: number, v1: number) {
  const img = map.image as CanvasImageSource & { width: number; height: number };
  if (!img?.width) return null;
  const W = img.width;
  const H = img.height;
  const fy = (v: number) => (map.flipY ? 1 - v : v);
  const x0 = Math.max(0, Math.floor(u0 * W) - 1);
  const x1 = Math.min(W, Math.ceil(u1 * W) + 1);
  const y0 = Math.max(0, Math.floor(Math.min(fy(v0), fy(v1)) * H) - 1);
  const y1 = Math.min(H, Math.ceil(Math.max(fy(v0), fy(v1)) * H) + 1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  if (!cx) return null;
  cx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
  const data = cx.getImageData(0, 0, w, h).data;
  return (u: number, v: number): [number, number] => {
    const px = Math.min(w - 1, Math.max(0, Math.floor(u * W) - x0));
    const py = Math.min(h - 1, Math.max(0, Math.floor(fy(v) * H) - y0));
    const k = (py * w + px) * 4;
    const r = data[k]!, g = data[k + 1]!, b = data[k + 2]!;
    return [(r + g + b) / 3, Math.max(r, g, b) - Math.min(r, g, b)];
  };
}

/** 사망 눈 아틀라스 알파 (원본 UV → 조각 사각형 → 아틀라스 좌표, 셰이더와 같은 계산). 조각 밖이면 0 */
function readPatchAlpha(input: PupilFlattenInput) {
  const img = input.texture.image as CanvasImageSource & { width: number; height: number };
  if (!img?.width) return null;
  const W = img.width;
  const H = img.height;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  if (!cx) return null;
  cx.drawImage(img, 0, 0);
  const data = cx.getImageData(0, 0, W, H).data;
  return (u: number, v: number): number => {
    for (const r of input.rects) {
      const tu = (u - r.uv[0]) / r.uv[2];
      const tv = (v - r.uv[1]) / r.uv[3];
      if (tu < 0 || tu > 1 || tv < 0 || tv > 1) continue;
      const ax = r.atlas[0] + tu * r.atlas[2];
      const ay = r.atlas[1] + tv * r.atlas[3];
      const k = (Math.min(H - 1, Math.floor(ay * H)) * W + Math.min(W - 1, Math.floor(ax * W))) * 4;
      const a = data[k + 3]!;
      if (a > 0) return a;
    }
    return 0;
  };
}

/**
 * 메시 지오메트리에 눈동자 평탄화 모프를 붙이고(처음 한 번) 메시의 모프 영향도 배열을 만든다.
 * @returns 눈 조각별 결과 (만들지 못하면 빈 배열 — 그때는 기존처럼 텍스처 X만)
 */
export function addPupilFlattenMorph(mesh: THREE.Mesh, input: PupilFlattenInput): PupilFlattenReport[] {
  const geo = mesh.geometry as THREE.BufferGeometry & { userData: { pupilFlatten?: PupilFlattenReport[] } };
  const done = geo.userData.pupilFlatten;
  if (done) {
    mesh.updateMorphTargets();
    return done;
  }
  const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
  const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
  const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
  const nrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
  // 이미 다른 모프가 있는 GLB는 건드리지 않음 (모프 개수·순서가 섞이지 않게)
  if (!pos || !uv || !nrm || !mat?.map || geo.morphAttributes.position?.length || input.eyes.length === 0) {
    geo.userData.pupilFlatten = [];
    return [];
  }
  const sides = [...new Set(input.rects.map((r) => r.side ?? 0).filter((s) => s > 0))];
  const u0 = Math.min(...input.rects.map((r) => r.uv[0]));
  const v0 = Math.min(...input.rects.map((r) => r.uv[1]));
  const u1 = Math.max(...input.rects.map((r) => r.uv[0] + r.uv[2]));
  const v1 = Math.max(...input.rects.map((r) => r.uv[1] + r.uv[3]));
  const texel = readRegion(mat.map, u0, v0, u1, v1);
  const patch = readPatchAlpha(input);
  if (!texel || !patch || sides.length === 0) {
    geo.userData.pupilFlatten = [];
    return [];
  }

  const reports: PupilFlattenReport[] = [];
  const posMorphs: THREE.BufferAttribute[] = [];
  const nrmMorphs: THREE.BufferAttribute[] = [];
  const p = new THREE.Vector3();
  for (const side of sides) {
    const rects = input.rects.filter((r) => r.side === side);
    // 이 조각의 정점 (UV가 조각 사각형 안 + 가장 가까운 눈 타원 안)
    const idx: number[] = [];
    let eye: PupilFlattenEye | null = null;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      if (!rects.some((r) => u >= r.uv[0] && u <= r.uv[0] + r.uv[2] && v >= r.uv[1] && v <= r.uv[1] + r.uv[3])) continue;
      const x = pos.getX(i);
      const y = pos.getY(i);
      const e = input.eyes.reduce((a, b) => (Math.abs(b.cx - x) < Math.abs(a.cx - x) ? b : a));
      if (((x - e.cx) / e.rx) ** 2 + ((y - e.cz) / e.rz) ** 2 > ELLIPSE_MARGIN ** 2) continue;
      eye ??= e;
      idx.push(i);
    }
    const whites = idx
      .filter((i) => {
        const [lum, sat] = texel(uv.getX(i), uv.getY(i));
        return lum > WHITE_LUM && sat < WHITE_SAT;
      })
      .map((i) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    const sphere = robustSphere(whites);
    const dp = new Float32Array(pos.count * 3);
    const dn = new Float32Array(pos.count * 3);
    let moved = 0;
    let maxShift = 0;
    // 흰자 구가 눈 크기와 맞지 않으면(맞춤 실패) 이 눈은 옮기지 않음
    if (sphere && eye && sphere.r < Math.max(eye.rx, eye.rz) * 4 && sphere.rms < 0.006) {
      for (const i of idx) {
        p.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        const d = p.distanceTo(sphere.c);
        const out = d - sphere.r;
        // 흰자 구보다 앞(바깥)으로 나온 정점만, 앞쪽 면만 (구 중심보다 앞)
        if (out <= MIN_OUT || p.z <= sphere.c.z) continue;
        // 눈 영역 텍셀만 (앞머리·비니·피부 정점은 눈 타원 안에 있어도 그대로)
        const u = uv.getX(i);
        const v = uv.getY(i);
        if (patch(u, v) < PATCH_ALPHA || texel(u, v)[1] >= EYE_SAT) continue;
        const dir = p.clone().sub(sphere.c).divideScalar(d);
        const target = sphere.c.clone().addScaledVector(dir, sphere.r);
        dp[i * 3] = target.x - p.x;
        dp[i * 3 + 1] = target.y - p.y;
        dp[i * 3 + 2] = target.z - p.z;
        dn[i * 3] = dir.x - nrm.getX(i);
        dn[i * 3 + 1] = dir.y - nrm.getY(i);
        dn[i * 3 + 2] = dir.z - nrm.getZ(i);
        moved++;
        maxShift = Math.max(maxShift, out);
      }
    }
    const pa = new THREE.BufferAttribute(dp, 3);
    pa.name = PUPIL_MORPH(side);
    const na = new THREE.BufferAttribute(dn, 3);
    na.name = PUPIL_MORPH(side);
    posMorphs.push(pa);
    nrmMorphs.push(na);
    reports.push({ side, whites: whites.length, radius: sphere?.r ?? 0, rms: sphere?.rms ?? 0, moved, maxShift });
  }
  if (reports.every((r) => r.moved === 0)) {
    geo.userData.pupilFlatten = [];
    return [];
  }
  geo.morphAttributes.position = posMorphs;
  geo.morphAttributes.normal = nrmMorphs;
  geo.morphTargetsRelative = true;
  geo.userData.pupilFlatten = reports;
  mesh.updateMorphTargets();
  return reports;
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ArenaModelKey } from '../../config/maps';

/** 키트 모델 한 개: 메시마다 지오메트리 + GLB 원래 머티리얼 + 모델 루트 기준 행렬 */
export interface KitPart {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  local: THREE.Matrix4;
}
export interface KitModel {
  parts: KitPart[];
}
export type KitModels = Record<ArenaModelKey, KitModel>;

/**
 * 브릭 키트 팔레트 텍스처에서 브릭이 쓰는 칸: u 고정, v 0.775(위, 흰색) → 0.975(아래, 연한 회보라).
 * 기본 도형(구름 제외)도 이 칸을 쓰면 브릭과 같은 플라스틱 그라데이션이 생긴다.
 */
export const BRICK_SWATCH = { u: 0.594, vTop: 0.775, vBottom: 0.975 };

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/**
 * 정적 장식을 지오메트리 하나로 합치기 (그리기 호출 1회).
 * 위치·법선·UV + 정점 색(조각 색)만 남기고, 브릭 팔레트 텍스처 머티리얼 하나로 그린다.
 * 충돌 없음 (배경·장식 전용).
 */
export class KitMerger {
  private readonly geos: THREE.BufferGeometry[] = [];
  triangles = 0;

  /**
   * 키트 모델을 행렬·색으로 추가.
   * @param swatch true면 원래 UV 대신 브릭 칸 그라데이션 (Prototype Kit 모델: 팔레트 텍스처가 브릭 키트와 다름)
   */
  addKit(model: KitModel, matrix: THREE.Matrix4, color: number, swatch = false): void {
    for (const part of model.parts) {
      this.push(part.geometry, _m.multiplyMatrices(matrix, part.local), color, swatch);
    }
  }

  /** 기본 도형 추가. UV는 브릭 칸의 세로 그라데이션 (위 밝고 아래 조금 어두움) */
  addBasic(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, color: number): void {
    this.push(geometry, matrix, color, true);
  }

  private push(src: THREE.BufferGeometry, matrix: THREE.Matrix4, color: number, basic: boolean): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.getAttribute('position').clone());
    g.setAttribute('normal', src.getAttribute('normal').clone());
    const n = g.getAttribute('position').count;
    if (basic) {
      // 도형 높이 기준 그라데이션 UV
      src.computeBoundingBox();
      const bb = src.boundingBox!;
      const h = Math.max(1e-6, bb.max.y - bb.min.y);
      const pos = g.getAttribute('position');
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const t = (pos.getY(i) - bb.min.y) / h;
        uv[i * 2] = BRICK_SWATCH.u;
        uv[i * 2 + 1] = BRICK_SWATCH.vTop + (1 - t) * (BRICK_SWATCH.vBottom - BRICK_SWATCH.vTop) * 0.7;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    } else {
      g.setAttribute('uv', src.getAttribute('uv').clone());
    }
    const index = src.getIndex();
    if (index) g.setIndex(index.clone());
    else g.setIndex([...Array(n).keys()]);
    g.applyMatrix4(matrix);
    // three.js 색은 선형 작업 공간 값 (setHex가 sRGB → 선형 변환)
    _c.setHex(color);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.triangles += g.getIndex()!.count / 3;
    this.geos.push(g);
  }

  get count(): number {
    return this.geos.length;
  }

  /** 합친 지오메트리 (조각이 없으면 null). 중간 지오메트리는 정리 */
  build(): THREE.BufferGeometry | null {
    if (this.geos.length === 0) return null;
    const merged = mergeGeometries(this.geos, false);
    this.geos.forEach((g) => g.dispose());
    this.geos.length = 0;
    if (!merged) throw new Error('장식 지오메트리 합치기 실패 (속성 불일치)');
    merged.computeBoundingSphere();
    return merged;
  }
}

/** 시드 고정 난수 (배치가 매번 같게) */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 색을 흰색 쪽으로 t만큼 밝게 (파스텔) */
export function lighten(color: number, t: number): number {
  return _c.setHex(color).lerp(new THREE.Color(0xffffff), t).getHex();
}

/** 행렬 만들기: 위치, y축 회전(rad), 배율(수 하나 또는 xyz) */
export function trs(x: number, y: number, z: number, rotY: number, scale: number | [number, number, number]): THREE.Matrix4 {
  const s = typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : new THREE.Vector3(...scale);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), s);
}

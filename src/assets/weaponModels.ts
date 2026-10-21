import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { WeaponDef, WeaponModelDef } from '../config/weapons';

/**
 * 무기 모델 공급. GLB가 있으면 GLB 장면, 없으면 임시 도형(기능 테스트용, 최종 에셋 아님).
 * 임시 도형은 "정렬 공간"(+Z 총구, +Y 위, 라이플 GLB와 같은 단위: 길이 약 1.0)으로 만들어 장착값의 modelFixDeg = 0.
 * 무기당 한 번만 만들고 계속 재사용 (교체 때마다 새로 만들지 않음).
 */
export class WeaponModelLibrary {
  private readonly models = new Map<string, THREE.Object3D>();
  private readonly disposables: Array<{ dispose(): void }> = [];

  /** @param glbScenes 미리 불러온 GLB 장면 (무기 id → 장면) */
  constructor(private readonly glbScenes: ReadonlyMap<string, THREE.Object3D>) {}

  get(def: WeaponDef): THREE.Object3D {
    let m = this.models.get(def.id);
    if (!m) {
      m = this.glbScenes.get(def.id) ?? this.buildPlaceholder(def.model, def.id);
      this.models.set(def.id, m);
    }
    return m;
  }

  /** 임시 도형인지 (보고·디버그용) */
  isPlaceholder(def: WeaponDef): boolean {
    return !this.glbScenes.has(def.id);
  }

  private buildPlaceholder(model: WeaponModelDef, id: string): THREE.Object3D {
    const kind = model.placeholder;
    if (!kind) throw new Error(`무기 모델 없음: ${id} (GLB 경로도 임시 도형 종류도 없음)`);
    const g = new THREE.Group();
    g.name = `placeholder_${kind}`;
    const mat = (color: number) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0 });
      this.disposables.push(m);
      return m;
    };
    const box = (w: number, h: number, d: number, color: number, pos: [number, number, number], rotX = 0) => {
      const geo = new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.3);
      this.disposables.push(geo);
      const mesh = new THREE.Mesh(geo, mat(color));
      mesh.position.set(...pos);
      mesh.rotation.x = rotX;
      g.add(mesh);
      return mesh;
    };
    /** 원기둥: axis 'z' = 총열 방향, 'y' = 세로, 'x' = 가로 */
    const cyl = (r: number, len: number, color: number, pos: [number, number, number], axis: 'x' | 'y' | 'z' = 'z') => {
      const geo = new THREE.CylinderGeometry(r, r, len, 16);
      this.disposables.push(geo);
      const mesh = new THREE.Mesh(geo, mat(color));
      mesh.position.set(...pos);
      if (axis === 'z') mesh.rotation.x = Math.PI / 2;
      else if (axis === 'x') mesh.rotation.z = Math.PI / 2;
      g.add(mesh);
      return mesh;
    };
    const C = { blue: 0x6fa8ff, yellow: 0xffd45e, orange: 0xff9c5b, pink: 0xff9ec7, mint: 0x8fe3c8, white: 0xfaf7f2 };

    switch (kind) {
      case 'shotgun':
        // 굵은 몸통 + 두 줄 총열 + 펌프 손잡이 + 개머리판 (총구 z 0.58)
        box(0.13, 0.16, 0.36, C.blue, [0, 0, -0.02]);
        cyl(0.036, 0.5, C.yellow, [0.036, 0.04, 0.33]);
        cyl(0.036, 0.5, C.yellow, [-0.036, 0.04, 0.33]);
        cyl(0.058, 0.18, C.orange, [0, -0.03, 0.3]);
        box(0.08, 0.16, 0.08, C.pink, [0, -0.12, -0.14], 0.35);
        box(0.1, 0.14, 0.28, C.orange, [0, -0.04, -0.36]);
        break;
      case 'sniper':
        // 긴 총열 + 스코프 + 탄창 (총구 z 0.86)
        box(0.1, 0.14, 0.42, C.mint, [0, 0, -0.04]);
        cyl(0.026, 0.72, C.blue, [0, 0.02, 0.48]);
        cyl(0.042, 0.07, C.pink, [0, 0.02, 0.83]);
        cyl(0.048, 0.3, C.pink, [0, 0.13, 0.0]);
        cyl(0.056, 0.04, C.yellow, [0, 0.13, 0.16]);
        cyl(0.056, 0.04, C.yellow, [0, 0.13, -0.16]);
        box(0.06, 0.12, 0.1, C.yellow, [0, -0.11, 0.04]);
        box(0.07, 0.15, 0.08, C.pink, [0, -0.12, -0.18], 0.35);
        box(0.09, 0.15, 0.26, C.mint, [0, -0.05, -0.4]);
        break;
      case 'pistol':
        // 슬라이드 + 손잡이 (총구 z 0.24)
        box(0.08, 0.09, 0.32, C.yellow, [0, 0.02, 0.08]);
        cyl(0.022, 0.03, C.blue, [0, 0.02, 0.245]);
        box(0.07, 0.17, 0.09, C.pink, [0, -0.08, -0.04], 0.25);
        box(0.05, 0.04, 0.08, C.blue, [0, -0.04, 0.05]);
        break;
      case 'melee':
        // 장난감 뿅망치: 손잡이가 +Z, 머리는 세로 원기둥 (내려칠 때 납작한 면으로 맞음)
        cyl(0.03, 0.66, C.yellow, [0, 0, 0.18]);
        cyl(0.038, 0.18, C.blue, [0, 0, -0.06]);
        cyl(0.1, 0.26, C.pink, [0, 0, 0.56], 'y');
        cyl(0.106, 0.04, C.white, [0, 0.13, 0.56], 'y');
        cyl(0.106, 0.04, C.white, [0, -0.13, 0.56], 'y');
        break;
    }
    return g;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.models.clear();
  }
}

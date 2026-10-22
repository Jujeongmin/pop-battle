// 무기 그림: 실제 무기 모델(WeaponModelLibrary의 GLB)을 게임 렌더러로 한 번 그려 이미지로 씀 (새 로더·모델 없음).
// - silhouette: 옆모습 실루엣 (흰색 알파 마스크) → 킬로그 아이콘 (CSS mask + currentColor라 기존 색 규칙 그대로)
// - image: 옆모습 컬러 이미지 → 상점 카드·정비소 카드
// - turntable: 한 바퀴 돌린 컬러 프레임 → 정비소 3D 미리보기 (매 프레임 렌더 대신 처음 한 번만 그림)
// 모델은 복제해서 그림 (원본은 플레이어 손에 붙어 있을 수 있음). 그림은 무기 id별로 캐시.
import * as THREE from 'three';
import type { WeaponDef } from '../config/weapons';
import type { WeaponModelLibrary } from './weaponModels';

/** 옆모습 기본 방향: 총은 총구(-Z)가 화면 오른쪽, 뿅망치는 머리(+Z)가 오른쪽이 되도록 Y축 회전 */
const BASE_YAW: Record<string, number> = { melee: Math.PI };

interface Shot {
  w: number;
  h: number;
  /** 모델 Y축 회전 (기본 방향 기준 추가) */
  yaw: number;
  /** 카메라를 위에서 내려다보는 각도 (rad) */
  pitch: number;
  silhouette: boolean;
  /** true = 회전해도 잘리지 않게 바운딩 구 기준, false = 옆모습 상자에 꽉 차게 */
  sphereFit: boolean;
  /** 가장자리 여백 비율 */
  pad: number;
}

export class WeaponArt {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
  private readonly pivot = new THREE.Group();
  private readonly flat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private readonly clones = new Map<string, THREE.Object3D>();
  private readonly silhouettes = new Map<string, string>();
  private readonly images = new Map<string, string>();
  private readonly turntables = new Map<string, HTMLCanvasElement[]>();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly library: WeaponModelLibrary,
    private readonly defs: Readonly<Record<string, WeaponDef>>,
  ) {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8d96bd, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 4, 2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xfff1dc, 0.9);
    rim.position.set(-2, 1, -3);
    this.scene.add(rim);
    this.scene.add(this.pivot);
  }

  /** 킬로그용 실루엣 (흰색 PNG data URL, 가로:세로 = 48:20). 모르는 무기면 null */
  silhouette(id: string): string | null {
    if (!this.defs[id]) return null;
    let url = this.silhouettes.get(id);
    if (!url) {
      url = this.render(id, { w: 192, h: 80, yaw: 0, pitch: 0, silhouette: true, sphereFit: false, pad: 0.04 }).toDataURL('image/png');
      this.silhouettes.set(id, url);
    }
    return url;
  }

  /** 옆모습 컬러 이미지 (PNG data URL, 가로:세로 = 12:5) */
  image(id: string): string | null {
    if (!this.defs[id]) return null;
    let url = this.images.get(id);
    if (!url) {
      url = this.render(id, { w: 480, h: 200, yaw: -0.32, pitch: 0.18, silhouette: false, sphereFit: false, pad: 0.06 }).toDataURL('image/png');
      this.images.set(id, url);
    }
    return url;
  }

  /** 한 바퀴 돌린 프레임 (frames장, 첫 장 = 옆모습). 정비소 미리보기에서 돌려 보여 줌 */
  turntable(id: string, frames = 36): HTMLCanvasElement[] {
    if (!this.defs[id]) return [];
    let list = this.turntables.get(id);
    if (!list) {
      list = [];
      for (let i = 0; i < frames; i++) {
        list.push(this.render(id, { w: 400, h: 220, yaw: -(i / frames) * Math.PI * 2, pitch: 0.22, silhouette: false, sphereFit: true, pad: 0.04 }));
      }
      this.turntables.set(id, list);
    }
    return list;
  }

  dispose(): void {
    this.flat.dispose();
    this.clones.clear();
    this.silhouettes.clear();
    this.images.clear();
    this.turntables.clear();
  }

  // ---------------- 렌더 ----------------

  private model(id: string): THREE.Object3D {
    let m = this.clones.get(id);
    if (!m) {
      m = this.library.get(this.defs[id]!).clone(true);
      m.position.set(0, 0, 0);
      m.rotation.set(0, 0, 0);
      m.scale.set(1, 1, 1);
      m.visible = true;
      // 원본에 붙어 있던 숨은 자식(아바타의 장착 표시점 등)은 빼고 그림
      const hidden: THREE.Object3D[] = [];
      m.traverse((o) => {
        if (o !== m && !o.visible) hidden.push(o);
      });
      for (const o of hidden) o.removeFromParent();
      this.clones.set(id, m);
    }
    return m;
  }

  /** 무기 한 장 그리기 → 캔버스 (2배 크기로 그려 줄여서 가장자리를 부드럽게) */
  private render(id: string, s: Shot): HTMLCanvasElement {
    const model = this.model(id);
    this.pivot.clear();
    // 모델 중심을 원점에 (회전 중심, 이전 장면의 부모 변환이 섞이지 않게 떼어 내고 잼)
    model.removeFromParent();
    model.position.set(0, 0, 0);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const holder = new THREE.Group();
    holder.add(model);
    holder.rotation.y = (BASE_YAW[id] ?? 0) + s.yaw;
    this.pivot.add(holder);
    this.pivot.updateMatrixWorld(true);

    // 카메라: +X 쪽에서 원점을 봄 (화면 오른쪽 = -Z = 총구), pitch만큼 위에서
    const aspect = s.w / s.h;
    const dist = 5;
    this.camera.position.set(Math.cos(s.pitch) * dist, Math.sin(s.pitch) * dist, 0);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld(true);
    let halfW: number;
    let halfH: number;
    if (s.sphereFit) {
      // Y축으로 돌 때 가로로 가장 멀리 가는 거리 = 바닥 평면 반지름, 세로 = 높이 + 내려다보는 각도만큼
      const size = box.getSize(new THREE.Vector3());
      const r = Math.hypot(size.x, size.z) / 2;
      halfW = r;
      halfH = Math.max(size.y / 2 + r * Math.sin(s.pitch), halfW / aspect);
      halfW = Math.max(halfW, halfH * aspect);
    } else {
      // 카메라 공간으로 옮긴 상자 크기에 꽉 차게
      const view = new THREE.Box3().setFromObject(this.pivot).applyMatrix4(this.camera.matrixWorldInverse);
      const size = view.getSize(new THREE.Vector3());
      halfW = Math.max(size.x / 2, (size.y / 2) * aspect);
      halfH = halfW / aspect;
    }
    halfW *= 1 + s.pad * 2;
    halfH *= 1 + s.pad * 2;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();

    const W = s.w * 2;
    const H = s.h * 2;
    const rt = new THREE.WebGLRenderTarget(W, H);
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevShadow = r.shadowMap.enabled;
    this.scene.overrideMaterial = s.silhouette ? this.flat : null;
    r.shadowMap.enabled = false;
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, this.camera);
    const px = new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(rt, 0, 0, W, H, px);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColor, prevAlpha);
    r.shadowMap.enabled = prevShadow;
    rt.dispose();
    this.pivot.clear();

    // 아래위 뒤집어 2배 캔버스에 → 원래 크기로 줄임
    const big = document.createElement('canvas');
    big.width = W;
    big.height = H;
    const bctx = big.getContext('2d')!;
    const img = bctx.createImageData(W, H);
    const row = W * 4;
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    bctx.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = s.w;
    out.height = s.h;
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(big, 0, 0, s.w, s.h);
    return out;
  }
}

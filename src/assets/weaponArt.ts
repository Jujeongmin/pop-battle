// 무기 그림: 실제 무기 모델(WeaponModelLibrary의 GLB)을 게임 렌더러로 한 번 그려 이미지로 씀 (새 로더·모델 없음).
// - silhouette: 옆모습 실루엣 (흰색 알파 마스크) → 킬로그 아이콘 (CSS mask + currentColor라 기존 색 규칙 그대로)
// - image: 옆모습 컬러 이미지 → 상점 카드·정비소 카드
// - drawLive: 정비소 3D 미리보기 (게임 렌더러로 실시간, 각도가 바뀐 프레임에만)
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

  /**
   * 실시간 미리보기 한 장 (정비소 3D 미리보기): 게임 렌더러의 화면 버퍼 한쪽에 무기를 그리고 바로 2D 캔버스로 옮김
   * (같은 프레임의 메인 장면 렌더가 화면 전체를 다시 지움 → 화면에는 남지 않음). 렌더 대상·픽셀 읽기 없이 GPU 복사만.
   * yaw = 회전(rad, 0 = 옆모습), bg = 미리보기 바탕색 (화면 버퍼는 불투명이라 바탕을 같은 색으로 칠함).
   * 메인 장면을 그리기 직전에만 불러야 함 (Game.render)
   */
  drawLive(id: string, yaw: number, canvas: HTMLCanvasElement, bg: THREE.ColorRepresentation): void {
    const def = this.defs[id];
    const ctx = canvas.getContext('2d');
    if (!def || !ctx || canvas.width < 2 || canvas.height < 2) return;
    const model = this.model(id);
    this.pivot.clear();
    model.removeFromParent();
    model.position.set(0, 0, 0);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    model.position.sub(box.getCenter(new THREE.Vector3()));
    const holder = new THREE.Group();
    holder.add(model);
    holder.rotation.y = (BASE_YAW[id] ?? 0) + yaw;
    this.pivot.add(holder);
    this.pivot.updateMatrixWorld(true);

    // 구도: 옆모습일 때 무기 길이가 가로의 약 86% (돌아도 반지름 안이라 잘리지 않음), 세로는 높이 + 내려다보는 각도만큼
    const pitch = 0.12;
    const size = box.getSize(new THREE.Vector3());
    const r = Math.hypot(size.x, size.z) / 2;
    const aspect = canvas.width / canvas.height;
    let halfW = r / 0.86;
    let halfH = halfW / aspect;
    const needH = (size.y / 2 + r * Math.sin(pitch)) * 1.12;
    if (halfH < needH) {
      halfH = needH;
      halfW = halfH * aspect;
    }
    const dist = 5;
    this.camera.position.set(Math.cos(pitch) * dist, Math.sin(pitch) * dist, 0);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    // 화면 버퍼 왼쪽 아래 구석에 캔버스 크기만큼 그림 (실제 픽셀 = CSS 크기 × 렌더러 픽셀 비율)
    const r3 = this.renderer;
    const pr = r3.getPixelRatio();
    const dom = r3.domElement;
    const w = Math.min(canvas.width / pr, dom.width / pr);
    const h = Math.min(canvas.height / pr, dom.height / pr);
    const prevColor = r3.getClearColor(new THREE.Color());
    const prevAlpha = r3.getClearAlpha();
    r3.setRenderTarget(null);
    r3.setViewport(0, 0, w, h);
    r3.setScissor(0, 0, w, h);
    r3.setScissorTest(true);
    r3.setClearColor(bg, 1);
    r3.clear();
    r3.render(this.scene, this.camera);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(dom, 0, dom.height - h * pr, w * pr, h * pr, 0, 0, canvas.width, canvas.height);
    r3.setScissorTest(false);
    r3.setViewport(0, 0, dom.width / pr, dom.height / pr);
    r3.setClearColor(prevColor, prevAlpha);
    this.pivot.clear();
  }

  dispose(): void {
    this.flat.dispose();
    this.clones.clear();
    this.silhouettes.clear();
    this.images.clear();
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

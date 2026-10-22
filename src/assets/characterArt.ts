// 캐릭터 초상: 실제 캐릭터 모델(게임이 이미 불러온 GLB 캐시)을 대기 자세로 한 번 그려 이미지로 씀 (정비소·대기실 카드).
// 새 로더 없음: Game.loadCharacter가 준 장면을 복제 → 대기 애니메이션 첫 프레임 자세 → 게임 렌더러로 그림 → PNG data URL 캐시.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CHARACTER } from '../config/gameConfig';
import type { LoadedModel } from './loadAssets';

const SIZE = 256;

export class CharacterArt {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(24, 1, 0.05, 50);
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    /** 캐릭터 모델 (게임의 GLB 캐시, 같은 id면 같은 Promise) */
    private readonly load: (id: string) => Promise<LoadedModel>,
  ) {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa3c8, 2.3));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(1.5, 3, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xfff1dc, 0.8);
    rim.position.set(-2, 2, -3);
    this.scene.add(rim);
  }

  /** 얼굴·상반신 초상 (정사각 PNG data URL, 투명 배경, 정면에서 살짝 비스듬히) */
  portrait(id: string): Promise<string> {
    let p = this.cache.get(id);
    if (!p) {
      p = this.load(id).then((model) => this.render(model));
      p.catch(() => this.cache.delete(id));
      this.cache.set(id, p);
    }
    return p;
  }

  private render(model: LoadedModel): string {
    const root = SkeletonUtils.clone(model.scene);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      // 공유 지오메트리에 사망 눈 모프가 있으면 복제 메시에도 영향도 배열 필요
      if (mesh.isMesh && !mesh.morphTargetInfluences && mesh.geometry.morphAttributes.position?.length) mesh.updateMorphTargets();
      mesh.frustumCulled = false;
    });
    // 대기 자세 (기본 자세가 T자라 팔이 벌어지지 않게)
    const idle = model.clips.find((c) => c.name === CHARACTER.clips.idle);
    let mixer: THREE.AnimationMixer | null = null;
    if (idle) {
      mixer = new THREE.AnimationMixer(root);
      mixer.clipAction(idle).play();
      mixer.update(0.4);
    }
    this.scene.add(root);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root, true);
    const size = box.getSize(new THREE.Vector3());
    // 머리부터 몸 절반쯤까지 (2~2.5등신이라 얼굴이 크게)
    const top = box.max.y + size.y * 0.1;
    const bottom = box.max.y - size.y * 0.68;
    const cy = (top + bottom) / 2;
    const half = (top - bottom) / 2;
    const center = box.getCenter(new THREE.Vector3());
    const dist = half / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const yaw = THREE.MathUtils.degToRad(18);
    this.camera.position.set(center.x + Math.sin(yaw) * dist, cy + half * 0.08, center.z + Math.cos(yaw) * dist);
    this.camera.lookAt(center.x, cy, center.z);
    this.camera.updateMatrixWorld(true);

    const W = SIZE * 2;
    const rt = new THREE.WebGLRenderTarget(W, W);
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevShadow = r.shadowMap.enabled;
    r.shadowMap.enabled = false;
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, this.camera);
    const px = new Uint8Array(W * W * 4);
    r.readRenderTargetPixels(rt, 0, 0, W, W, px);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColor, prevAlpha);
    r.shadowMap.enabled = prevShadow;
    rt.dispose();
    this.scene.remove(root);
    mixer?.stopAllAction();

    const big = document.createElement('canvas');
    big.width = W;
    big.height = W;
    const bctx = big.getContext('2d')!;
    const img = bctx.createImageData(W, W);
    const row = W * 4;
    for (let y = 0; y < W; y++) img.data.set(px.subarray((W - 1 - y) * row, (W - y) * row), y * row);
    bctx.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = SIZE;
    out.height = SIZE;
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(big, 0, 0, SIZE, SIZE);
    return out.toDataURL('image/png');
  }
}

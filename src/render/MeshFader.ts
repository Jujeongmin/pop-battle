import * as THREE from 'three';

interface FadeEntry {
  mesh: THREE.Mesh;
  material: THREE.Material;
  original: {
    transparent: boolean;
    opacity: number;
    depthWrite: boolean;
    depthFunc: THREE.DepthModes;
    colorWrite: boolean;
    renderOrder: number;
  };
  /** 깊이만 쓰는 사전 패스 메시 (같은 지오메트리·스켈레톤 공유) */
  prepass: THREE.Mesh;
}

const PREPASS_ORDER = 10;
const COLOR_ORDER = 11;

/**
 * 메시 표시 제어 (로컬 플레이어 전용).
 * - setVisible(false): 메시 자체를 그리지 않음. 위치·애니메이션·판정은 그대로 갱신된다.
 * - setOpacity: 점무늬(alphaHash) 없이 부드러운 알파. 먼저 깊이만 그려 가장 앞 표면 한 겹만 보이게 한다
 *   (팔·몸통 안쪽 면이 겹쳐 비치지 않음). 0이면 색은 그리지 않고 그림자는 유지. 1이면 원래 머티리얼 상태로 복원.
 * 머티리얼은 호출자가 이 메시 전용으로 복제해 넘겨야 한다 (GLB 원본 머티리얼 공유 금지).
 */
export class MeshFader {
  private readonly entries: FadeEntry[] = [];
  private readonly prepassMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    transparent: true,
  });
  private current = 1;
  private shown = true;

  constructor(meshes: THREE.Mesh[]) {
    for (const mesh of meshes) {
      const material = mesh.material as THREE.Material;
      let prepass: THREE.Mesh;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        const sk = mesh as THREE.SkinnedMesh;
        const p = new THREE.SkinnedMesh(sk.geometry, this.prepassMaterial);
        p.bindMode = sk.bindMode;
        p.bind(sk.skeleton, sk.bindMatrix);
        // 모프 타깃(사망 셰이프 키 등)은 원본 메시와 같은 영향도 배열을 공유 → 깊이 사전 패스도 같은 형태
        if (sk.morphTargetInfluences) {
          p.morphTargetInfluences = sk.morphTargetInfluences;
          p.morphTargetDictionary = sk.morphTargetDictionary;
        }
        prepass = p;
      } else {
        prepass = new THREE.Mesh(mesh.geometry, this.prepassMaterial);
      }
      prepass.name = `${mesh.name}__fadePrepass`;
      prepass.position.copy(mesh.position);
      prepass.quaternion.copy(mesh.quaternion);
      prepass.scale.copy(mesh.scale);
      prepass.frustumCulled = mesh.frustumCulled;
      prepass.castShadow = false;
      prepass.receiveShadow = false;
      prepass.renderOrder = PREPASS_ORDER;
      prepass.visible = false;
      mesh.parent?.add(prepass);
      this.entries.push({
        mesh,
        material,
        original: {
          transparent: material.transparent,
          opacity: material.opacity,
          depthWrite: material.depthWrite,
          depthFunc: material.depthFunc,
          colorWrite: material.colorWrite,
          renderOrder: mesh.renderOrder,
        },
        prepass,
      });
    }
  }

  get opacity(): number {
    return this.current;
  }

  get visible(): boolean {
    return this.shown;
  }

  /** 메시 표시 여부 (투명도와 별개). 숨겨도 위치·애니메이션 갱신은 계속된다 */
  setVisible(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    for (const e of this.entries) {
      e.mesh.visible = visible;
      e.prepass.visible = visible && this.current > 0 && this.current < 1;
    }
  }

  setOpacity(value: number): void {
    const o = value > 0.995 ? 1 : value < 0.005 ? 0 : value;
    if (o === this.current) return;
    this.current = o;
    for (const e of this.entries) {
      const m = e.material;
      const wasTransparent = m.transparent;
      if (o === 1) {
        // 원래 상태 복원
        m.transparent = e.original.transparent;
        m.opacity = e.original.opacity;
        m.depthWrite = e.original.depthWrite;
        m.depthFunc = e.original.depthFunc;
        m.colorWrite = e.original.colorWrite;
        e.mesh.renderOrder = e.original.renderOrder;
        e.prepass.visible = false;
      } else if (o === 0) {
        // 색은 그리지 않음, 그림자 패스는 그대로 (castShadow 유지)
        m.transparent = e.original.transparent;
        m.opacity = e.original.opacity;
        m.depthWrite = false;
        m.colorWrite = false;
        e.prepass.visible = false;
      } else {
        m.transparent = true;
        m.opacity = e.original.opacity * o;
        m.depthWrite = false;
        m.depthFunc = THREE.LessEqualDepth;
        m.colorWrite = true;
        e.mesh.renderOrder = COLOR_ORDER;
        e.prepass.visible = this.shown;
      }
      if (m.transparent !== wasTransparent) m.needsUpdate = true;
    }
  }

  dispose(): void {
    this.setVisible(true);
    this.setOpacity(1);
    for (const e of this.entries) e.prepass.removeFromParent();
    this.prepassMaterial.dispose();
  }
}

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BOT_CHARACTERS, CHARACTERS, PLAYER_CHARACTER, type CharacterId } from '../config/characters';
import { ASSETS } from '../config/gameConfig';
import { WEAPONS } from '../config/weapons';

export interface LoadedModel {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

export interface GameAssets {
  character: LoadedModel;
  /** 플레이어와 다른 봇 캐릭터 (캐릭터 id → 모델). 플레이어와 같은 캐릭터는 character를 복제해 씀 */
  otherCharacters: Map<CharacterId, LoadedModel>;
  rifle: LoadedModel;
  /** 라이플 외 무기 GLB (무기 id → 장면). 경로가 설정된 무기만, 없는 무기는 임시 도형 */
  weapons: Map<string, THREE.Object3D>;
}

/** GLB 로드. 파일이 없거나 손상되면 대체 모델을 만들지 않고 오류를 그대로 올린다. */
async function loadGlb(loader: GLTFLoader, url: string, label: string): Promise<GLTF> {
  try {
    return await loader.loadAsync(url);
  } catch (err) {
    throw new Error(`${label} GLB 로드 실패 (${url}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 캐릭터 GLB 1개 로드 (개발용 캐릭터 교체). 호출자가 id별로 캐시하고 SkeletonUtils.clone으로 복제해서 씀
 * (원본 씬·지오메트리·텍스처는 공유, 머티리얼은 아바타가 인스턴스별로 복제)
 */
export async function loadCharacterModel(renderer: THREE.WebGLRenderer, id: CharacterId): Promise<LoadedModel> {
  const gltf = await loadGlb(new GLTFLoader(), CHARACTERS[id].file, `캐릭터 ${CHARACTERS[id].name}`);
  if (!gltf.scene.getObjectByProperty('type', 'SkinnedMesh')) throw new Error('캐릭터 GLB에 SkinnedMesh가 없습니다.');
  const aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.anisotropy = aniso;
    }
  });
  return { scene: gltf.scene, clips: gltf.animations };
}

export async function loadGameAssets(renderer: THREE.WebGLRenderer): Promise<GameAssets> {
  const loader = new GLTFLoader();
  const extra = Object.values(WEAPONS).filter((w) => w.model.glb && w.model.glb !== ASSETS.rifle);
  // 봇 캐릭터 중 플레이어와 다른 것만 따로 로드 (같은 캐릭터는 복제)
  const otherIds = [...new Set(BOT_CHARACTERS)].filter((id) => id !== PLAYER_CHARACTER);
  const [character, rifle, ...rest] = await Promise.all([
    loadGlb(loader, ASSETS.character, '캐릭터'),
    loadGlb(loader, ASSETS.rifle, '라이플'),
    ...otherIds.map((id) => loadGlb(loader, CHARACTERS[id].file, `캐릭터 ${CHARACTERS[id].name}`)),
    ...extra.map((w) => loadGlb(loader, w.model.glb!, w.name)),
  ]);
  const otherGltfs = rest.slice(0, otherIds.length);
  const weaponGltfs = rest.slice(otherIds.length);
  const aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  for (const gltf of [character, rifle, ...otherGltfs, ...weaponGltfs]) {
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.anisotropy = aniso;
      }
    });
  }
  for (const g of [character, ...otherGltfs]) {
    if (!g.scene.getObjectByProperty('type', 'SkinnedMesh')) throw new Error('캐릭터 GLB에 SkinnedMesh가 없습니다.');
  }
  return {
    character: { scene: character.scene, clips: character.animations },
    otherCharacters: new Map(otherIds.map((id, i) => [id, { scene: otherGltfs[i]!.scene, clips: otherGltfs[i]!.animations }])),
    rifle: { scene: rifle.scene, clips: rifle.animations },
    weapons: new Map(extra.map((w, i) => [w.id, weaponGltfs[i]!.scene])),
  };
}

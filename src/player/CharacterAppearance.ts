import * as THREE from 'three';
import { CHARACTERS, TEAM_COLORS, TEAM_SHADE, type CharacterDef, type CharacterId, type GameModeId, type TeamId } from '../config/characters';
import { addPupilFlattenMorph, PUPIL_MORPH, type PupilFlattenEye, type PupilFlattenReport } from './pupilFlatten';

/** 외형을 정하는 값 (네트워크로는 이 셋만 보내면 된다, 색 자체는 보내지 않음) */
export interface AppearanceSpec {
  characterId: CharacterId;
  mode: GameModeId;
  team: TeamId;
}

/** 표정: 평소 / 사망(X X 눈) / 디버그용 한쪽 눈만 X (left = 화면 정면에서 볼 때 왼쪽 눈) */
export type Expression = 'normal' | 'dead' | 'deadLeft' | 'deadRight';

/** 이 조합에서 입힐 팀 색 (원래 색이면 null): FFA·팀 없음 = 원본, TDM = 팀 색 */
export function teamColorFor(spec: AppearanceSpec): string | null {
  if (spec.mode !== 'TDM' || spec.team === 'NONE') return null;
  return TEAM_COLORS[spec.team];
}

const maskCache = new Map<string, THREE.Texture>();
const maskLoader = new THREE.TextureLoader();

/** 캐릭터별 팀 마스크 (같은 캐릭터는 한 장 공유). glTF 텍스처처럼 뒤집지 않고, 색 데이터가 아니라 선형 그대로 */
export function loadTeamMask(def: CharacterDef): Promise<THREE.Texture> {
  const cached = maskCache.get(def.teamMask);
  if (cached) return Promise.resolve(cached);
  return maskLoader.loadAsync(def.teamMask).then((tex) => {
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    maskCache.set(def.teamMask, tex);
    return tex;
  });
}

/** 사망 눈 셰이더가 검사하는 사각형 최대 수 (UV 조각 수, tools/blender/dead_eyes.py MAX_RECTS와 같게) */
const DEAD_RECTS = 16;

/** 사망 표정 데이터: 눈 영역 아틀라스 + 원본 UV 사각형 ↔ 아틀라스 사각형 (glTF UV 기준 x, y, w, h) */
export interface DeadEyes {
  texture: THREE.Texture;
  /** side: 1 = 정면에서 왼쪽 눈, 2 = 오른쪽 눈, 0 = 두 눈 조각이 한 사각형에 섞임 */
  rects: Array<{ uv: [number, number, number, number]; atlas: [number, number, number, number]; side?: number }>;
  /** 눈(흰자) 타원 (모델 공간, 정면 투영) — 눈동자 평탄화 모프 범위 */
  eyes: PupilFlattenEye[];
}

const deadCache = new Map<string, Promise<DeadEyes>>();

/** 캐릭터별 사망 눈 데이터 (같은 캐릭터는 공유, 읽기 전용) */
export function loadDeadEyes(def: CharacterDef): Promise<DeadEyes> {
  let p = deadCache.get(def.deadEyes);
  if (!p) {
    p = Promise.all([
      fetch(`${def.deadEyes}.json`).then((r) => {
        if (!r.ok) throw new Error(`사망 눈 데이터 없음: ${def.deadEyes}.json`);
        return r.json() as Promise<{ rects: DeadEyes['rects']; eyes?: PupilFlattenEye[] }>;
      }),
      maskLoader.loadAsync(`${def.deadEyes}.png`),
    ]).then(([info, tex]) => {
      if (info.rects.length > DEAD_RECTS) throw new Error(`사망 눈 사각형 ${info.rects.length}개 > ${DEAD_RECTS}`);
      tex.flipY = false;
      // 색 데이터 (sRGB) → 셰이더에서 선형으로 읽힘. 조각 경계 밖은 쓰지 않도록 가장자리 고정
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      // 미리 곱한 알파: UV 조각 경계의 투명 텍셀 색이 밉맵·선형 보간에 검게 섞이지 않게 (셰이더는 덮기 합성)
      tex.premultiplyAlpha = true;
      tex.needsUpdate = true;
      return { texture: tex, rects: info.rects, eyes: info.eyes ?? [] };
    });
    p.catch(() => deadCache.delete(def.deadEyes));
    deadCache.set(def.deadEyes, p);
  }
  return p;
}

/* 맵 색을 읽은 직후: 마스크 영역(R 비니, G 상의)만 팀 색 × 원래 명암 비율로 바꿈. 조명·그림자·질감 계산은 그대로 */
const TEAM_GLSL = /* glsl */ `
#ifdef USE_MAP
  if (uTeamMix > 0.0) {
    vec2 teamMask = texture2D(uTeamMask, vMapUv).rg;
    float teamAmount = max(teamMask.r, teamMask.g);
    if (teamAmount > 0.001) {
      float teamLum = dot(sampledDiffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      float teamRef = teamMask.r >= teamMask.g ? uTeamRef.x : uTeamRef.y;
      float teamRatio = clamp(teamLum / max(teamRef, 1e-4), uTeamShade.x, uTeamShade.y);
      teamRatio = 1.0 + (teamRatio - 1.0) * uTeamShade.z;
      vec3 teamCol = diffuse * uTeamColor * teamRatio;
      diffuseColor.rgb = mix(diffuseColor.rgb, teamCol, teamAmount * uTeamMix);
    }
  }
  // 사망 표정: 눈 영역(원본 UV 사각형들)만 아틀라스 색으로 교체 (알파 1 = 원래 눈을 완전히 덮음, 0 = 원래 그대로)
  if (uDeadMix > 0.0) {
    // 원본 UV가 들어가는 사각형을 순서대로 검사, 아틀라스 텍셀이 있는(알파 > 0) 첫 사각형 사용
    // (서로 다른 눈 조각 사각형이 UV에서 겹칠 수 있어 첫 사각형에서 멈추지 않음)
    vec4 deadTexel = vec4(0.0);
    float deadIn = 0.0;
    for (int i = 0; i < ${DEAD_RECTS}; i++) {
      if (i >= uDeadCount) break;
      vec2 t = (vMapUv - uDeadRect[i].xy) / uDeadRect[i].zw;
      if (t.x >= 0.0 && t.x <= 1.0 && t.y >= 0.0 && t.y <= 1.0) {
        vec4 c = texture2D(uDeadEyes, uDeadAtlas[i].xy + t * uDeadAtlas[i].zw); // 미리 곱한 알파
        if (c.a > 0.002) {
          deadTexel = c;
          // 디버그 한쪽 눈 테스트: uDeadSides 0 = 양쪽, 1·2 = 그 눈 조각만
          deadIn = (uDeadSides == 0 || uDeadSide[i] == 0 || uDeadSide[i] == uDeadSides) ? 1.0 : 0.0;
          break;
        }
      }
    }
    float deadK = deadIn * uDeadMix;
    diffuseColor.rgb = diffuseColor.rgb * (1.0 - deadTexel.a * deadK) + diffuse * deadTexel.rgb * deadK;
  }
#endif
`;

const DEAD_UNIFORMS = `uniform sampler2D uDeadEyes;\nuniform float uDeadMix;\nuniform int uDeadCount;\nuniform vec4 uDeadRect[${DEAD_RECTS}];\nuniform vec4 uDeadAtlas[${DEAD_RECTS}];\nuniform int uDeadSide[${DEAD_RECTS}];\nuniform int uDeadSides;\n`;

/** 사망 눈 데이터가 아직 없을 때 쓰는 빈 텍스처 (투명) */
const EMPTY = new THREE.DataTexture(new Uint8Array(4), 1, 1);
EMPTY.needsUpdate = true;

/**
 * 캐릭터 1명의 외형: 팀 컬러 + 표정 (인스턴스별). 아바타가 이미 메시마다 복제해 둔 머티리얼에 셰이더 조각과 유니폼만 붙인다
 * → 다른 캐릭터·같은 캐릭터의 다른 인스턴스에 영향 없음 (한 명이 쓰러져도 다른 캐릭터 눈은 그대로),
 * 원래 머티리얼 객체를 바꾸지 않아 가림(페이드) 처리도 그대로.
 * 원본 복원 = 섞는 양 0 (셰이더 결과가 원래와 같음).
 */
export class CharacterAppearance {
  readonly def: CharacterDef;
  private readonly uniforms = {
    uTeamMask: { value: null as THREE.Texture | null },
    uTeamColor: { value: new THREE.Color() },
    uTeamMix: { value: 0 },
    uTeamRef: { value: new THREE.Vector2() },
    uTeamShade: { value: new THREE.Vector3(TEAM_SHADE.min, TEAM_SHADE.max, TEAM_SHADE.strength) },
    uDeadEyes: { value: EMPTY as THREE.Texture },
    uDeadMix: { value: 0 },
    uDeadCount: { value: 0 },
    uDeadRect: { value: Array.from({ length: DEAD_RECTS }, () => new THREE.Vector4(0, 0, 1, 1)) },
    uDeadAtlas: { value: Array.from({ length: DEAD_RECTS }, () => new THREE.Vector4(0, 0, 1, 1)) },
    uDeadSide: { value: new Array<number>(DEAD_RECTS).fill(0) },
    uDeadSides: { value: 0 },
  };
  /** 사망 눈 데이터 (디버그 정보) */
  private readonly deadInfo: DeadEyes | undefined;
  private spec: AppearanceSpec;
  /** 실제 생사 (사망 확정 ~ 리스폰) */
  private dead = false;
  /** 개발용 표정 고정 (CHARACTER DEBUG). null = 생사를 따름 */
  private override: Expression | null = null;
  /**
   * 선택: 사망 셰이프 키 'Dead'가 있는 GLB면 사망 때 영향도 1 (tools/blender/dead_eyes.py --shape-key + tools/add-morph-target.mjs).
   * 지금 게임 GLB에는 넣지 않음 — 사망 표정은 흰자를 그대로 두고 눈동자만 X로 바꾸므로 눈 형태를 바꾸지 않음. 없으면 비어 있음
   */
  private readonly deadMorphs: Array<[number[], number]> = [];
  /**
   * 눈동자 평탄화 모프 (런타임 생성, pupilFlatten.ts): 볼록한 눈동자를 흰자 구면으로 당겨 X가 흰 혹 위에 뜨지 않게.
   * [영향도 배열, 모프 번호, 눈 조각 side]
   */
  private readonly pupilMorphs: Array<[number[], number, number]> = [];
  /** 디버그: 눈동자 평탄화 결과 (눈 조각별) */
  pupilFlatten: PupilFlattenReport[] = [];

  constructor(meshes: readonly THREE.Mesh[], characterId: CharacterId, mask: THREE.Texture, deadEyes?: DeadEyes) {
    this.def = CHARACTERS[characterId];
    this.spec = { characterId, mode: 'FFA', team: 'NONE' };
    this.uniforms.uTeamMask.value = mask;
    this.uniforms.uTeamRef.value.set(this.def.refLuminance[0], this.def.refLuminance[1]);
    this.deadInfo = deadEyes;
    if (deadEyes) {
      this.uniforms.uDeadEyes.value = deadEyes.texture;
      this.uniforms.uDeadCount.value = deadEyes.rects.length;
      deadEyes.rects.forEach((r, i) => {
        this.uniforms.uDeadRect.value[i]!.set(...r.uv);
        this.uniforms.uDeadAtlas.value[i]!.set(...r.atlas);
        this.uniforms.uDeadSide.value[i] = r.side ?? 0;
      });
    }
    for (const mesh of meshes) {
      if (deadEyes?.eyes.length) {
        const rep = addPupilFlattenMorph(mesh, deadEyes);
        if (rep.length) this.pupilFlatten = rep;
        for (const r of rep) {
          const i = mesh.morphTargetDictionary?.[PUPIL_MORPH(r.side)];
          if (i !== undefined && mesh.morphTargetInfluences) this.pupilMorphs.push([mesh.morphTargetInfluences, i, r.side]);
        }
      }
      const i = mesh.morphTargetDictionary?.['Dead'];
      if (i !== undefined && mesh.morphTargetInfluences) this.deadMorphs.push([mesh.morphTargetInfluences, i]);
    }
    const u = this.uniforms;
    for (const mesh of meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        if (!std.isMeshStandardMaterial || !std.map) continue;
        std.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, u);
          shader.fragmentShader =
            'uniform sampler2D uTeamMask;\nuniform vec3 uTeamColor;\nuniform float uTeamMix;\nuniform vec2 uTeamRef;\nuniform vec3 uTeamShade;\n' +
            DEAD_UNIFORMS +
            shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n${TEAM_GLSL}`);
        };
        // 같은 셰이더 코드끼리 프로그램 공유 (유니폼 값만 인스턴스별)
        std.customProgramCacheKey = () => 'pop-team-color-v3';
        std.needsUpdate = true;
      }
    }
  }

  get current(): Readonly<AppearanceSpec> {
    return this.spec;
  }

  /** 모드·팀에 맞게 외형 적용 (매치 시작·생성·리스폰·팀 변경 때 호출, 같은 값이면 아무 일 없음) */
  apply(spec: Omit<AppearanceSpec, 'characterId'>): void {
    this.spec = { characterId: this.def.id, mode: spec.mode, team: spec.team };
    const color = teamColorFor(this.spec);
    if (color) {
      this.uniforms.uTeamColor.value.set(color);
      this.uniforms.uTeamMix.value = 1;
    } else {
      this.uniforms.uTeamMix.value = 0;
    }
  }

  /** 원래 캐릭터 색으로 */
  restoreOriginal(): void {
    this.apply({ mode: 'FFA', team: 'NONE' });
  }

  /** 생사 → 표정 (사망 확정 순간 true, 리스폰 때 false). 쓰러져 있는 동안 X X 유지 */
  setDead(dead: boolean): void {
    this.dead = dead;
    this.updateExpression();
  }

  /** 개발용 표정 고정 (CHARACTER DEBUG Normal / Dead), null = 생사를 따름 (Reset). HP·판정·킬로그와 무관 */
  setExpressionOverride(e: Expression | null): void {
    this.override = e;
    this.updateExpression();
  }

  /** 지금 보이는 표정 */
  get expression(): Expression {
    return this.override ?? (this.dead ? 'dead' : 'normal');
  }

  /** 디버그: 사망 눈 렌더 구성 (메시가 아니라 텍스처 교체 → 메시·머티리얼·본은 원래 그대로) */
  get expressionDebug(): { method: string; rects: number; sides: string; atlas: string; mix: number; morph: boolean } {
    const t = this.uniforms.uDeadEyes.value as THREE.Texture & { image?: { width: number; height: number } };
    return {
      method: this.deadInfo ? '텍스처 영역 교체 (머티리얼 셰이더, 인스턴스별 유니폼)' : '사망 눈 데이터 없음',
      rects: this.uniforms.uDeadCount.value,
      sides: this.uniforms.uDeadSide.value.slice(0, this.uniforms.uDeadCount.value).join(''),
      atlas: t.image ? `${t.image.width}×${t.image.height}` : '-',
      mix: this.uniforms.uDeadMix.value,
      morph: this.deadMorphs.length > 0 || this.pupilMorphs.length > 0,
    };
  }

  get expressionOverride(): Expression | null {
    return this.override;
  }

  private updateExpression(): void {
    const e = this.expression;
    const v = e === 'normal' ? 0 : 1;
    this.uniforms.uDeadMix.value = v;
    this.uniforms.uDeadSides.value = e === 'deadLeft' ? 1 : e === 'deadRight' ? 2 : 0;
    for (const [influences, i] of this.deadMorphs) influences[i] = v;
    const sides = this.uniforms.uDeadSides.value;
    for (const [influences, i, side] of this.pupilMorphs) influences[i] = v && (sides === 0 || side === sides) ? 1 : 0;
  }

  /** 사망 셰이프 키가 있는지 (디버그) */
  get hasDeadShape(): boolean {
    return this.deadMorphs.length > 0;
  }
}

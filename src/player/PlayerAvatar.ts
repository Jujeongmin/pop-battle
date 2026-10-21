import * as THREE from 'three';
import { CHARACTERS, weaponFitFor, type CharacterDef, type CharacterId, type WeaponFit } from '../config/characters';
import { CHARACTER_HITBOX } from '../config/combat';
import { CHARACTER } from '../config/gameConfig';
import { WEAPONS, type WeaponMount } from '../config/weapons';
import type { MoveMode } from './PlayerController';
import { quaternionFromAxes, rotateBoneToward, setWorldQuaternion, solveTwoBoneIk } from './ik';

type ClipKey = keyof typeof CHARACTER.clips;
type AnimState = ClipKey;
type BoneKey = keyof typeof CHARACTER.bones;
type MarkerKey = 'rightGrip' | 'supportGrip' | 'muzzle';

export interface AvatarFrame {
  dt: number;
  /** 발 위치 (월드) */
  feet: THREE.Vector3;
  bodyYaw: number;
  /** 총이 향할 월드 방향 (정규화) */
  aimDir: THREE.Vector3;
  /** 카메라 피치 (+ = 위) */
  pitch: number;
  mode: MoveMode;
  grounded: boolean;
  /** 컨트롤러의 현재 달리기 상태 (Shift 해제 즉시 false) */
  sprinting: boolean;
  velocity: THREE.Vector3;
  justJumped: boolean;
  justLanded: boolean;
  landedAirTime: number;
  dead: boolean;
  /** 조준 중이면 골반 비틀기·뒤로 걷기 사용 */
  strafing: boolean;
  /** 서 있는 중: 몸(루트)이 돌아도 다리는 남겨 골반만 비틀고, 많이 비틀리면 발걸음으로 따라감 (로컬 플레이어만) */
  turnInPlace?: boolean;
  /** 총 반동으로 뒤로 밀린 거리(m) */
  weaponKick: number;
  /** 무기 꺼내는 중(0..1, 1 = 완전히 듦) */
  weaponRaise: number;
  /** 재장전 진행도 0..1 (재장전 중이 아니면 0) */
  reloadProgress: number;
  /** ADS 블렌드 0..1 (장착값 adsHoldOffset이 있는 무기만 자세에 사용) */
  adsBlend?: number;
  /** 근접 휘두르기 진행도 0..1 (0 = 안 휘두름). 장착값 swing 자세가 있는 무기만 */
  meleeSwing?: number;
  /** 볼트액션 진행도 0..1 (0 = 아님). 장착값 bolt가 있는 무기만 */
  boltProgress?: number;
}

const UP = new THREE.Vector3(0, 1, 0);
// 손 본 로컬 축 기본값 (블루 GLB 분석: Y = 손가락 방향, -Z = 손바닥). 캐릭터마다 바인드 포즈에서 다시 잼 (measureHands)
const HAND_FINGER_AXIS = new THREE.Vector3(0, 1, 0);
const HAND_PALM_AXIS = new THREE.Vector3(0, 0, -1);

interface HandCalib {
  /** 손 본 로컬 손가락 축 (T포즈에서 팔 바깥 방향) */
  finger: THREE.Vector3;
  /** 손 본 로컬 손바닥 축 (T포즈에서 아래) */
  palm: THREE.Vector3;
  /** 블루 기준 대비 손 본을 손가락 방향으로 더 보낼 거리 (월드 m) */
  shift: number;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function damp(current: number, target: number, sharpness: number, dt: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-sharpness * dt));
}

const _vo = new THREE.Vector3();
/** 몸 기준 오프셋 (오른쪽, 위, 앞 m) 더하기. 오른쪽 = 로컬 -X */
function addBodyOffset(target: THREE.Vector3, o: readonly [number, number, number], bodyQ: THREE.Quaternion): void {
  if (o[0] === 0 && o[1] === 0 && o[2] === 0) return;
  target.add(_vo.set(-o[0], o[1], o[2]).applyQuaternion(bodyQ));
}

/** 장착값 → 무기 id (캐릭터별 장착 보정 조회용) */
function weaponIdOf(mount: WeaponMount): string | undefined {
  return Object.values(WEAPONS).find((w) => w.mount === mount)?.id;
}

/** 스킨 메시 바인드 포즈 최고점 높이 (GLB 단위, 발 = 0) */
function measureBindHeight(scene: THREE.Object3D): number {
  let top = 0;
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    const sk = o as THREE.SkinnedMesh;
    if (!sk.isSkinnedMesh) return;
    const pos = sk.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) top = Math.max(top, v.fromBufferAttribute(pos, i).applyMatrix4(sk.bindMatrix).y);
  });
  return top > 0.1 ? top : 1;
}

/**
 * 캐릭터 GLB 표시, 애니메이션 상태 전환, 총기 자세(팔 IK)와 라이플 장착을 담당.
 * 하체·몸통은 이동 애니메이션, 팔은 IK로 덮어써서 이동하면서 총을 든 자세를 만든다.
 */
export class PlayerAvatar {
  readonly root = new THREE.Group();
  /** 접지 보정용 피벗 (발 기준 수직 오프셋만) */
  private readonly pivot = new THREE.Group();
  /** 접지 보정: 정점 샘플 (본 로컬 좌표) */
  private readonly contactBones: THREE.Bone[] = [];
  private contactPoints = new Float32Array(0);
  /** 아래다리 본 로컬에서 발끝(바인드 포즈 +Z)을 가리키는 축 */
  private readonly toeAxis = new Map<THREE.Bone, THREE.Vector3>();
  private groundOffset = 0;
  /** 이번 프레임 측정한 지면 대비 최저점 간격 (보정 전, 디버그) */
  groundGapBefore = 0;
  private readonly model: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<AnimState, THREE.AnimationAction>();
  private readonly bones = {} as Record<BoneKey, THREE.Bone>;
  /** 애니메이션 트랙이 없는 제어 본의 기본 회전 (누적 방지용) */
  private readonly restPose: Array<[THREE.Bone, THREE.Quaternion]> = [];
  private readonly materials: THREE.Material[] = [];
  /** 팔 늘림용 기본 로컬 위치 (위치 트랙이 없는 본) */
  private readonly restOffsets = new Map<THREE.Bone, THREE.Vector3>();

  /** 현재 손에 든 무기 모델 (setWeapon으로 교체) */
  rifle: THREE.Object3D;
  private readonly rifleFix = new THREE.Quaternion();
  private readonly rifleFixInv = new THREE.Quaternion();
  private readonly rightHandInRifle = new THREE.Quaternion();
  private readonly leftHandInRifle = new THREE.Quaternion();
  private readonly leftHandOnMag = new THREE.Quaternion();
  /** 캐릭터별 손 본 축·위치 보정 (블루 = 기본 축, 이동 0) */
  readonly hands: { right: HandCalib; left: HandCalib } = {
    right: { finger: HAND_FINGER_AXIS.clone(), palm: HAND_PALM_AXIS.clone(), shift: 0 },
    left: { finger: HAND_FINGER_AXIS.clone(), palm: HAND_PALM_AXIS.clone(), shift: 0 },
  };
  /** 정렬 공간(월드) — 이번 프레임 총의 목표 변환 */
  private readonly alignedTarget = new THREE.Matrix4();

  private state: AnimState = 'idle';
  private stateTime = 0;
  private jumpStartTimer = 0;
  private landTimer = 0;
  private hipTwist = 0;
  /** 제자리 회전: 다리(골반 아래) 월드 yaw, 발걸음으로 따라가는 중인지 */
  private legYaw: number | null = null;
  private turnStepping = false;
  private standTwist = 0;
  /** 이번 프레임 근접 공격 상체 비틀림 (위 축 회전, 라디안). 내려찍기 면도 같이 돌림 */
  private swingTorsoYaw = 0;
  private slideWeight = 0;
  /** 캐릭터 스킨 메시 (로컬 플레이어 가림 처리는 LocalPlayerOcclusion이 따로 만든다. 봇 아바타는 쓰지 않음) */
  readonly bodyMeshes: THREE.Mesh[] = [];
  /** 현재 무기 모델의 메시 (교체하면 바뀜) */
  rifleMeshes: THREE.Mesh[] = [];
  /** 한 번 손에 들었던 무기 모델의 메시 (재질은 처음 들 때 한 번만 복제) */
  private readonly weaponMeshes = new Map<THREE.Object3D, THREE.Mesh[]>();
  /** 이번 프레임 캐릭터 스킨 경계 상자 (최저점 계산과 같은 샘플) */
  readonly bodyBounds = new THREE.Box3();
  /** 판정용 머리 구: 머리 정점 샘플의 현재 포즈 중심 (월드) + 반지름 (바인드 포즈 측정값) */
  readonly headCenter = new THREE.Vector3();
  headRadius = 0.3;
  /** 머리 중심 − 발 위치 (직전 프레임). 이번 프레임 발 위치에 더해 머리 위치를 예측 (점프 등 빠른 이동에도 지연 없음) */
  private readonly headFromFeet = new THREE.Vector3(0, 0.9, 0);
  private headMask = new Uint8Array(0);
  /** 디버그: 정렬 공간 기준 그립/지지점/총구 마커 */
  private readonly markers = new THREE.Group();
  private readonly markerMeshes: Record<MarkerKey, THREE.Mesh>;
  /** IK 결과 손이 목표에 못 닿은 거리 (디버그 표시) */
  reachError = { right: 0, left: 0 };

  readonly character: CharacterDef;
  /** GLB 바인드 포즈 전체 높이 (GLB 단위, 정규화 기준) */
  readonly modelHeight: number;
  /**
   * 모델 크기 (GLB 단위 → m) = 기준 크기 1.25 × 키 배율 ÷ GLB 높이.
   * 무기는 이 값과 무관하게 항상 같은 월드 크기 (CHARACTER.scale × 장착 크기)
   */
  readonly bodyScale: number;
  /** 몸통 판정 캡슐 반지름 (m): 바인드 포즈 몸통 정점 실측 */
  bodyRadius: number = CHARACTER_HITBOX.bodyRadius;
  /** 체형 실측 (m, 바인드 포즈 × bodyScale): 키, 어깨 폭(위팔 본 사이), 몸통 폭·앞뒤 두께 (팔·다리 제외 몸통 정점) */
  readonly measure = { height: 0, shoulderWidth: 0, torsoWidth: 0, torsoDepth: 0 };
  /** 현재 무기의 캐릭터별 장착 보정 (공통 기본 + 캐릭터 값) */
  private fit: Required<WeaponFit>;

  constructor(
    characterScene: THREE.Object3D,
    clips: THREE.AnimationClip[],
    rifleScene: THREE.Object3D,
    public mount: WeaponMount,
    characterId: CharacterId = 'blue',
  ) {
    this.character = CHARACTERS[characterId];
    this.fit = weaponFitFor(characterId, weaponIdOf(mount));
    this.model = characterScene;
    this.modelHeight = measureBindHeight(characterScene);
    this.bodyScale = (CHARACTER.scale * this.character.body.height) / this.modelHeight;
    this.model.scale.setScalar(this.bodyScale);
    this.model.rotation.y = CHARACTER.modelYawOffset;
    this.pivot.add(this.model);
    this.root.add(this.pivot);

    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // 스킨드 메시는 바인드 포즈 기준 경계로 컬링되어 깜빡일 수 있다
        mesh.frustumCulled = false;
        const mat = (mesh.material as THREE.Material).clone();
        mesh.material = mat;
        this.materials.push(mat);
      }
    });

    for (const [key, name] of Object.entries(CHARACTER.bones) as Array<[BoneKey, string]>) {
      const bone = this.model.getObjectByName(name);
      if (!(bone as THREE.Bone | undefined)?.isBone) throw new Error(`캐릭터 본 없음: ${name}`);
      this.bones[key] = bone as THREE.Bone;
    }

    this.mixer = new THREE.AnimationMixer(this.model);
    const animated = new Set<string>();
    for (const [key, clipName] of Object.entries(CHARACTER.clips) as Array<[ClipKey, string]>) {
      const clip = clips.find((c) => c.name === clipName);
      if (!clip) throw new Error(`애니메이션 클립 없음: ${clipName}`);
      clip.tracks.forEach((t) => animated.add(t.name));
      const action = this.mixer.clipAction(clip);
      const once = key === 'jumpStart' || key === 'land' || key === 'death';
      action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = once;
      this.actions.set(key, action);
    }
    for (const bone of Object.values(this.bones)) {
      if (!animated.has(`${bone.name}.quaternion`)) this.restPose.push([bone, bone.quaternion.clone()]);
    }
    for (const bone of [this.bones.lowerArmR, this.bones.handR, this.bones.lowerArmL, this.bones.handL]) {
      if (animated.has(`${bone.name}.position`)) throw new Error(`팔 본 위치 트랙은 팔 늘림과 충돌: ${bone.name}`);
      this.restOffsets.set(bone, bone.position.clone());
    }
    this.model.updateMatrixWorld(true);
    for (const bone of [this.bones.lowerLegL, this.bones.lowerLegR]) {
      // 바인드 포즈에서 모델 정면(+Z) = 발끝 방향
      const q = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
      this.toeAxis.set(bone, new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize());
    }
    this.actions.get('idle')?.play();
    this.buildContactSamples();
    this.measureHands();

    this.rifle = rifleScene;
    this.rifleMeshes = this.prepareWeapon(rifleScene);
    this.bones.handR.add(this.rifle);
    const marker = (color: number) => {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.025, 12, 8),
        new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }),
      );
      mesh.renderOrder = 10;
      this.markers.add(mesh);
      return mesh;
    };
    this.markerMeshes = {
      rightGrip: marker(0xff3355),
      supportGrip: marker(0x33dd66),
      muzzle: marker(0xffdd00),
    };
    this.markers.visible = false;
    this.rifle.add(this.markers);
    this.applyMount();

    this.model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) this.bodyMeshes.push(o as THREE.Mesh);
    });
  }

  /** 무기 모델 첫 장착 준비: 그림자, 재질 복제(GLB 원본 재질을 바꾸지 않게). 두 번째부터는 캐시 */
  private prepareWeapon(model: THREE.Object3D): THREE.Mesh[] {
    let meshes = this.weaponMeshes.get(model);
    if (meshes) return meshes;
    meshes = [];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !mesh.name.endsWith('__fadePrepass')) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mat = (mesh.material as THREE.Material).clone();
        mesh.material = mat;
        this.materials.push(mat);
        meshes.push(mesh);
      }
    });
    this.weaponMeshes.set(model, meshes);
    return meshes;
  }

  /**
   * 손에 든 무기 교체 (런타임). 같은 손 본에 붙이고 장착값으로 그립·총구를 다시 계산.
   * 손 IK는 매 프레임 새 장착값 기준이라 교체 직후에도 손 위치가 맞는다.
   */
  setWeapon(model: THREE.Object3D, mount: WeaponMount): void {
    if (model === this.rifle && mount === this.mount) return;
    this.rifle.removeFromParent();
    this.markers.removeFromParent();
    this.rifle = model;
    this.mount = mount;
    this.fit = weaponFitFor(this.character.id, weaponIdOf(mount));
    this.rifleMeshes = this.prepareWeapon(model);
    model.visible = true;
    this.bones.handR.add(model);
    model.add(this.markers);
    this.applyMount();
  }

  /** 디버그: 오른손·왼손 본(손목) 월드 위치 */
  getHandPositions(outRight: THREE.Vector3, outLeft: THREE.Vector3): void {
    this.bones.handR.getWorldPosition(outRight);
    this.bones.handL.getWorldPosition(outLeft);
  }

  /** 디버그: 본 구조 표시용 (모델 루트) */
  get debugModel(): THREE.Object3D {
    return this.model;
  }

  /** 골반 본 월드 위치 */
  getHipsPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.bones.hips.getWorldPosition(out);
  }

  /** 0..1 슬라이딩 포즈 가중치 (카메라 높이 등에 사용) */
  get slideBlend(): number {
    return this.slideWeight;
  }

  /** 정점마다 가장 큰 가중치의 본 기준 로컬 좌표를 저장 (매 프레임 최저점 계산용) */
  private buildContactSamples(): void {
    let mesh: THREE.SkinnedMesh | null = null;
    this.model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
    });
    if (!mesh) return;
    const sk = mesh as THREE.SkinnedMesh;
    const pos = sk.geometry.getAttribute('position');
    const idx = sk.geometry.getAttribute('skinIndex');
    const wgt = sk.geometry.getAttribute('skinWeight');
    const stride = Math.max(1, CHARACTER.anim.grounding.sampleStride);
    const pts: number[] = [];
    const head: number[] = [];
    const v = new THREE.Vector3();
    const bind = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const headBox = new THREE.Box3();
    const headFrom = CHARACTER_HITBOX.headFromRatio * this.modelHeight;
    // 몸통 실측: 몸통 높이 구간 정점 중 팔·손(손가락) 본이 주 본인 것 제외
    // (옆구리·가방은 Shoulder 본, 골반 아래쪽은 다리 본에 가중된 모델이 있어 몸통 본만 고르면 폭이 작게 잡힘)
    const armBone = /^(UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/;
    const torsoLo = CHARACTER_HITBOX.torsoBand[0] * this.modelHeight;
    const torsoHi = CHARACTER_HITBOX.torsoBand[1] * this.modelHeight;
    const torsoX: number[] = [];
    const torsoFront: number[] = [];
    for (let i = 0; i < pos.count; i += stride) {
      let best = 0;
      let bestW = -1;
      for (let k = 0; k < 4; k++) {
        const w = wgt.getComponent(i, k);
        if (w > bestW) {
          bestW = w;
          best = idx.getComponent(i, k);
        }
      }
      // 로컬 = boneInverse · bindMatrix · v   (월드 = bone.matrixWorld · 로컬)
      m.multiplyMatrices(sk.skeleton.boneInverses[best]!, sk.bindMatrix);
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      pts.push(v.x, v.y, v.z);
      this.contactBones.push(sk.skeleton.bones[best]!);
      // 머리 판정: 바인드 포즈(모델 공간, 원본 높이 1.0) 높이로 구분
      bind.fromBufferAttribute(pos, i).applyMatrix4(sk.bindMatrix);
      const isHead = bind.y >= headFrom;
      head.push(isHead ? 1 : 0);
      if (isHead) headBox.expandByPoint(bind);
      if (bind.y >= torsoLo && bind.y <= torsoHi && !armBone.test(sk.skeleton.bones[best]!.name)) {
        torsoX.push(Math.abs(bind.x));
        if (bind.z >= 0) torsoFront.push(bind.z);
      }
    }
    this.contactPoints = new Float32Array(pts);
    this.headMask = Uint8Array.from(head);
    const s = this.bodyScale;
    if (!headBox.isEmpty()) {
      const size = headBox.getSize(v);
      this.headRadius = ((size.x + size.y + size.z) / 6) * s * CHARACTER_HITBOX.headRadiusScale;
    }
    // 백분위수: 머리카락(땋은 머리)·가방끈 같은 튀어나온 장식 몇 개에 판정이 끌려가지 않게
    const pct = (a: number[], q: number) => {
      if (a.length === 0) return 0;
      const sorted = [...a].sort((x, y) => x - y);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
    };
    const q = CHARACTER_HITBOX.torsoPercentile;
    const halfWidth = pct(torsoX, q);
    if (halfWidth > 0) this.bodyRadius = halfWidth * s * CHARACTER_HITBOX.bodyWidthScale;
    this.measure.height = this.modelHeight * s;
    this.measure.torsoWidth = halfWidth * 2 * s;
    // 앞뒤 두께: 등 쪽은 가방이 있어 앞쪽 × 2 (배 크기 비교용)
    this.measure.torsoDepth = pct(torsoFront, q) * 2 * s;
    const ua = (name: string) => {
      const i = sk.skeleton.bones.findIndex((b) => b.name === name);
      return i < 0 ? null : new THREE.Vector3().setFromMatrixPosition(m.copy(sk.skeleton.boneInverses[i]!).invert());
    };
    const l = ua(CHARACTER.bones.upperArmL);
    const r = ua(CHARACTER.bones.upperArmR);
    if (l && r) this.measure.shoulderWidth = l.distanceTo(r) * s;
  }

  /**
   * 바인드 포즈(T포즈)에서 손 본 축과 손 덩어리 위치를 잰다.
   * - 손 축: T포즈 팔 바깥·아래 방향을 본 로컬로 재서 블루 실측(CHARACTER.handBindAxes)과의 회전 차이만큼 기본 축을 돌림 (블루는 그대로)
   * - 손 덩어리 = 손 본에서 바깥으로 가장 먼 정점부터 0.075 안쪽까지, 그 중심의 손가락 방향 거리
   * - 블루 기준(CHARACTER.handCenterFromBone)과의 차이만큼 IK 목표·무기 부착점을 손가락 방향으로 옮김
   */
  private measureHands(): void {
    let mesh: THREE.SkinnedMesh | null = null;
    this.model.traverse((o) => {
      if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
    });
    if (!mesh) return;
    const sk = mesh as THREE.SkinnedMesh;
    const pos = sk.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const bp = new THREE.Vector3();
    const bq = new THREE.Quaternion();
    const bs = new THREE.Vector3();
    for (const [side, bone, sign] of [['right', this.bones.handR, -1], ['left', this.bones.handL, 1]] as const) {
      const i = sk.skeleton.bones.indexOf(bone);
      if (i < 0) continue;
      m.copy(sk.skeleton.boneInverses[i]!).invert().decompose(bp, bq, bs);
      const outward = new THREE.Vector3(sign, 0, 0);
      const inv = bq.clone().invert();
      const calib = this.hands[side];
      // 이 캐릭터 손 본 로컬에서 본 T포즈 팔 바깥·아래 방향 → 블루 실측 축과의 회전 차이를 기본 손 축에 적용
      const ref = CHARACTER.handBindAxes[side];
      const out = outward.clone().applyQuaternion(inv);
      const down = new THREE.Vector3(0, -1, 0).applyQuaternion(inv);
      const qc = quaternionFromAxes(new THREE.Vector3(...ref.outward), out, new THREE.Vector3(...ref.down), down, new THREE.Quaternion());
      calib.finger.copy(HAND_FINGER_AXIS).applyQuaternion(qc);
      calib.palm.copy(HAND_PALM_AXIS).applyQuaternion(qc);
      // 팔 선 근처(가로 0.1 안) 정점의 바깥쪽 투영
      let tip = -Infinity;
      const proj: number[] = [];
      for (let k = 0; k < pos.count; k++) {
        v.fromBufferAttribute(pos, k).applyMatrix4(sk.bindMatrix).sub(bp);
        const t = v.dot(outward);
        if (t < 0) continue;
        if (Math.hypot(v.y, v.z) > 0.1) continue;
        proj.push(t);
        if (t > tip) tip = t;
      }
      const hand = proj.filter((t) => t > tip - 0.075);
      if (hand.length === 0) continue;
      const center = hand.reduce((a, b) => a + b, 0) / hand.length;
      // 블루 기준(원래 크기 1.25)의 손 덩어리 중심 거리와 이 캐릭터(현재 크기) 차이 (월드 m)
      calib.shift = CHARACTER.handCenterFromBone[side] * CHARACTER.scale - center * this.bodyScale;
    }
  }

  /** 현재 포즈의 스킨 최저점 월드 y (근사: 정점별 주 본만 사용). 경계 상자(bodyBounds)도 함께 갱신. */
  private lowestPointY(): number {
    const p = this.contactPoints;
    const hm = this.headMask;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let hx0 = Infinity, hy0 = Infinity, hz0 = Infinity, hx1 = -Infinity, hy1 = -Infinity, hz1 = -Infinity;
    for (let i = 0, j = 0; i < this.contactBones.length; i++, j += 3) {
      const e = this.contactBones[i]!.matrixWorld.elements;
      const px = p[j]!, py = p[j + 1]!, pz = p[j + 2]!;
      const x = e[0]! * px + e[4]! * py + e[8]! * pz + e[12]!;
      const y = e[1]! * px + e[5]! * py + e[9]! * pz + e[13]!;
      const z = e[2]! * px + e[6]! * py + e[10]! * pz + e[14]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
      if (hm[i]) {
        if (x < hx0) hx0 = x;
        if (x > hx1) hx1 = x;
        if (y < hy0) hy0 = y;
        if (y > hy1) hy1 = y;
        if (z < hz0) hz0 = z;
        if (z > hz1) hz1 = z;
      }
    }
    this.bodyBounds.min.set(x0, y0, z0);
    this.bodyBounds.max.set(x1, y1, z1);
    this.headCenter.set((hx0 + hx1) / 2, (hy0 + hy1) / 2, (hz0 + hz1) / 2);
    return y0;
  }

  /** 무기 경계 상자 (월드) */
  getWeaponBounds(out: THREE.Box3): THREE.Box3 {
    out.makeEmpty();
    // 디버그 마커·페이드 사전 패스 메시는 제외하고 실제 총 메시만
    for (const mesh of this.rifleMeshes) out.expandByObject(mesh);
    return out;
  }

  /**
   * 개발용(디버그 패널 "손목 자동 맞춤"): 지금 프레임의 오른팔 아래팔 방향에 맞춰 한 손 무기의 손 방향·손목 위치를 다시 계산.
   * 손가락 = 아래팔 방향을 손잡이(+Z)에 수직으로 투영, 손바닥 = 몸 안쪽(손잡이가 손바닥과 몸 사이),
   * 손목 = 쥔 점(gripCenter, 정렬 공간) − 손바닥 × 3.7cm − 손가락 × 2.8cm (손잡이 반지름+손바닥 두께, 손 길이 절반; 월드 크기를 무기 공간으로 환산).
   * 결과가 다시 팔 자세를 바꾸므로 몇 프레임에 걸쳐 반복 호출한다.
   */
  solveRightGripToForearm(gripCenter: readonly [number, number, number]): boolean {
    const m = this.mount;
    const forearm = this.bones.handR.getWorldPosition(new THREE.Vector3()).sub(this.bones.lowerArmR.getWorldPosition(new THREE.Vector3()));
    // 정렬 공간 = 총 월드 · R(fix)⁻¹
    const alignedQ = this.rifle.getWorldQuaternion(new THREE.Quaternion()).multiply(this.rifleFixInv);
    const f = forearm.applyQuaternion(alignedQ.invert());
    f.z = 0;
    if (f.lengthSq() < 1e-6) return false;
    f.normalize();
    // 손바닥은 몸 안쪽(오른손이면 몸 왼쪽 = 로컬 +X)을 향하게: 손잡이가 손바닥 안쪽, 손등이 바깥
    const palm = new THREE.Vector3(f.y, -f.x, 0);
    const medial = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()));
    const alignedToWorld = alignedQ.clone().invert();
    if (palm.clone().applyQuaternion(alignedToWorld).dot(medial) < 0) palm.negate();
    const unit = 1 / this.weaponWorldScale;
    const wrist = new THREE.Vector3().fromArray(gripCenter).addScaledVector(palm, -0.037 * unit).addScaledVector(f, -0.028 * unit);
    const r = (v: number) => Number(v.toFixed(3));
    m.rightFingerDir = [r(f.x), r(f.y), 0];
    m.rightPalmDir = [r(palm.x), r(palm.y), 0];
    m.rightGrip = [r(wrist.x), r(wrist.y), r(gripCenter[2])];
    this.applyMount();
    return true;
  }

  /** 장착 설정이 바뀌면 호출 (디버그 패널) */
  applyMount(): void {
    const m = this.mount;
    const d = THREE.MathUtils.degToRad;
    this.rifleFix.setFromEuler(new THREE.Euler(d(m.modelFixDeg[0]), d(m.modelFixDeg[1]), d(m.modelFixDeg[2])));
    this.rifleFixInv.copy(this.rifleFix).invert();
    const hr = this.hands.right;
    const hl = this.hands.left;
    quaternionFromAxes(hr.finger, _v1.fromArray(m.rightFingerDir), hr.palm, _v2.fromArray(m.rightPalmDir), this.rightHandInRifle);
    quaternionFromAxes(hl.finger, _v1.fromArray(m.leftFingerDir), hl.palm, _v2.fromArray(m.leftPalmDir), this.leftHandInRifle);
    quaternionFromAxes(hl.finger, _v1.fromArray(m.reload.magazineFingerDir), hl.palm, _v2.fromArray(m.reload.magazinePalmDir), this.leftHandOnMag);
    // 손 → 총 로컬 변환: M = S(s) · R(handInRifle)⁻¹ · T(-grip) · R(fix)
    // grip = 손 본이 놓일 총 공간 점: 블루 기준 손목 + 손가락 방향 × 캐릭터 손 보정 (총 공간 단위 = 월드 / (캐릭터 크기 × 총 크기))
    const ws = this.weaponWorldScale;
    const gs = hr.shift / ws;
    const fd = _v3.fromArray(m.rightFingerDir).normalize();
    // 손 본 로컬 크기 = 무기 월드 크기 ÷ 캐릭터 크기 → 캐릭터 키와 무관하게 무기는 같은 크기
    const ls = ws / this.bodyScale;
    _m1.makeScale(ls, ls, ls);
    _m1.multiply(_m2.makeRotationFromQuaternion(_q1.copy(this.rightHandInRifle).invert()));
    _m1.multiply(_m2.makeTranslation(-(m.rightGrip[0] + fd.x * gs), -(m.rightGrip[1] + fd.y * gs), -(m.rightGrip[2] + fd.z * gs)));
    _m1.multiply(_m2.makeRotationFromQuaternion(this.rifleFix));
    _m1.decompose(this.rifle.position, this.rifle.quaternion, this.rifle.scale);
    // 마커: 총 모델 공간 → 정렬 공간 (fix⁻¹), 총 크기와 무관하게 같은 화면 크기
    this.markers.quaternion.copy(this.rifleFixInv);
    for (const key of ['rightGrip', 'supportGrip', 'muzzle'] as const) {
      const mesh = this.markerMeshes[key];
      mesh.position.fromArray(m[key]);
      mesh.scale.setScalar(1 / Math.max(0.05, ws));
    }
    this.markerMeshes.muzzle.position.add(_v3.fromArray(this.fit.muzzleOffset));
  }

  /** 무기 월드 크기 배율 (GLB 단위 → m): 기준 캐릭터 크기 × 장착 크기 × 캐릭터별 무기 크기 보정 */
  get weaponWorldScale(): number {
    return CHARACTER.scale * this.mount.scale * this.fit.weaponScale;
  }

  /** 현재 무기의 캐릭터별 장착 보정 (디버그 패널에서 직접 고친 뒤 applyMount) */
  get weaponFit(): Required<WeaponFit> {
    return this.fit;
  }

  /** 장착 보정 다시 읽기 (설정 값을 런타임에 바꾼 뒤) */
  reloadWeaponFit(): void {
    this.fit = weaponFitFor(this.character.id, weaponIdOf(this.mount));
    this.applyMount();
  }

  /** 몸 크기 비율 (기준 1.25m 대비): 그립 위치(holdOffset)·걸음 재생 속도에 사용 */
  get sizeRatio(): number {
    return this.bodyScale / CHARACTER.scale;
  }

  set showMarkers(v: boolean) {
    this.markers.visible = v;
  }

  get showMarkers(): boolean {
    return this.markers.visible;
  }

  /** 디버그: 캐릭터 메시 숨김 (총만 확인) */
  set hideBody(v: boolean) {
    this.model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.visible = !v;
    });
  }

  /** 총구 월드 위치/방향 */
  getMuzzle(outPos: THREE.Vector3, outDir?: THREE.Vector3): void {
    this.rifle.updateWorldMatrix(true, false);
    // 정렬 공간 = 총 월드 · R(fix)⁻¹
    _m1.copy(this.rifle.matrixWorld).multiply(_m2.makeRotationFromQuaternion(this.rifleFixInv));
    outPos.fromArray(this.mount.muzzle).add(_v3.fromArray(this.fit.muzzleOffset)).applyMatrix4(_m1);
    if (outDir) outDir.set(0, 0, 1).transformDirection(_m1);
  }

  /** 가슴 본 월드 위치 (사격 시 장애물 관통 검사의 기준점) */
  getChestPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.bones.chest.getWorldPosition(out);
  }

  update(f: AvatarFrame): void {
    this.updateTurnInPlace(f);
    this.updateStateMachine(f);
    for (const [bone, q] of this.restPose) bone.quaternion.copy(q);
    this.mixer.update(f.dt);
    for (const [bone, p] of this.restOffsets) bone.position.copy(p);

    const sl = CHARACTER.anim.slide;
    const sliding = f.mode === 'slide' && !f.dead;
    this.slideWeight = damp(this.slideWeight, sliding ? 1 : 0, sliding ? sl.blendIn : sl.blendOut, f.dt);

    this.root.position.copy(f.feet);
    this.root.rotation.set(0, f.bodyYaw, 0);
    this.pivot.position.y = 0;
    this.root.updateMatrixWorld(true);

    if (!f.dead) {
      this.applyHipTwist(f);
      if (this.slideWeight > 0.001) this.applySlidePose(f.bodyYaw, this.slideWeight);
      this.applySpinePitch(f);
      if (this.mount.swing?.torso) this.applySwingTorso(this.mount.swing, f);
      if (this.mount.ikEnabled) this.applyWeaponPose(f);
    }
    this.applyGrounding(f);
  }

  /** 스킨 최저점이 지면(발 위치)에 닿도록 수직 보정. 공중에서는 0으로 복귀. */
  private applyGrounding(f: AvatarFrame): void {
    const g = CHARACTER.anim.grounding;
    let target = 0;
    const gap = this.lowestPointY() - f.feet.y;
    this.groundGapBefore = gap;
    if (g.enabled && (f.grounded || f.dead)) target = THREE.MathUtils.clamp(-gap, -g.maxOffset, g.maxOffset);
    // 파고드는 쪽(올려야 함)은 빠르게, 내리는 쪽은 조금 느리게
    const sharp = target > this.groundOffset ? g.raiseSharpness : g.lowerSharpness;
    this.groundOffset = f.dt > 0 ? damp(this.groundOffset, target, f.grounded || f.dead ? sharp : 8, f.dt) : target;
    this.pivot.position.y = this.groundOffset;
    this.root.updateMatrixWorld(true);
    // 경계 상자는 보정 전 포즈로 계산됐으므로 같은 만큼 이동
    this.bodyBounds.translate(_v1.set(0, this.groundOffset, 0));
    this.headCenter.y += this.groundOffset;
    // 무기 자세(IK)는 접지 보정 전 공간에서 계산되므로 보정량을 뺀 값으로 저장
    this.headFromFeet.subVectors(this.headCenter, f.feet);
    this.headFromFeet.y -= this.groundOffset;
  }

  /**
   * 절차적 슬라이딩 포즈. 애니메이션 결과 위에 본 회전 목표를 weight로 블렌딩한다.
   * 골반을 뒤로 젖히고, 척추는 조금 되돌려 조준 가능하게, 두 다리는 앞으로 뻗는다.
   */
  private applySlidePose(bodyYaw: number, w: number): void {
    const sl = CHARACTER.anim.slide;
    const b = this.bones;
    const bodyQ = new THREE.Quaternion().setFromAxisAngle(UP, bodyYaw);
    const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(bodyQ);
    const toWorld = (d: readonly [number, number, number]) =>
      new THREE.Vector3(-d[0], d[1], d[2]).normalize().applyQuaternion(bodyQ);
    const blend = (bone: THREE.Bone, apply: () => void) => {
      const from = bone.quaternion.clone();
      apply();
      bone.quaternion.slerpQuaternions(from, bone.quaternion.clone(), w);
      bone.updateMatrixWorld(true);
    };
    const d = THREE.MathUtils.degToRad;
    blend(b.hips, () => this.rotateBoneWorld(b.hips, right, d(sl.hipsLeanBackDeg)));
    blend(b.spine, () => this.rotateBoneWorld(b.spine, right, -d(sl.spineForwardDeg)));
    const aimLimb = (
      upper: THREE.Bone,
      lower: THREE.Bone,
      thigh: THREE.Vector3,
      shin: THREE.Vector3,
      toe: THREE.Vector3,
    ) => {
      blend(upper, () => {
        const a = upper.getWorldPosition(new THREE.Vector3());
        const k = lower.getWorldPosition(new THREE.Vector3());
        rotateBoneToward(upper, a, k, a.clone().add(thigh));
      });
      // 아래다리: 본 +Y(정강이) 방향과 발끝 방향을 함께 지정해 비틀림까지 고정
      blend(lower, () => {
        const q = quaternionFromAxes(UP, shin, this.toeAxis.get(lower)!, toe, new THREE.Quaternion());
        setWorldQuaternion(lower, q);
      });
    };
    aimLimb(b.upperLegL, b.lowerLegL, toWorld(sl.leadThighDir), toWorld(sl.leadShinDir), toWorld(sl.leadToeDir));
    aimLimb(b.upperLegR, b.lowerLegR, toWorld(sl.trailThighDir), toWorld(sl.trailShinDir), toWorld(sl.trailToeDir));
  }

  private play(next: AnimState, fade: number = CHARACTER.anim.fade): void {
    if (next === this.state) return;
    const prev = this.actions.get(this.state);
    const action = this.actions.get(next);
    if (!action) return;
    const prevTime = prev ? prev.time / prev.getClip().duration : 0;
    action.reset();
    action.enabled = true;
    // 걷기↔조깅: 발 위상을 맞춰 블렌딩 (반복 전환해도 처음부터 다시 시작하지 않게)
    if ((next === 'walk' || next === 'run') && (this.state === 'walk' || this.state === 'run')) {
      action.time = prevTime * action.getClip().duration;
    }
    action.setEffectiveWeight(1);
    if (next === 'jumpStart') {
      action.time = CHARACTER.anim.jumpStartOffset;
      action.timeScale = CHARACTER.anim.jumpStartTimeScale;
    } else if (next === 'land') {
      action.timeScale = CHARACTER.anim.landTimeScale;
    } else if (next !== 'walk' && next !== 'run') {
      action.timeScale = 1;
    }
    action.play();
    if (prev) action.crossFadeFrom(prev, fade, false);
    this.state = next;
    this.stateTime = 0;
  }

  private updateStateMachine(f: AvatarFrame): void {
    const a = CHARACTER.anim;
    this.stateTime += f.dt;
    this.jumpStartTimer = Math.max(0, this.jumpStartTimer - f.dt);
    this.landTimer = Math.max(0, this.landTimer - f.dt);
    if (f.justJumped) this.jumpStartTimer = a.jumpStartHold;
    if (f.justLanded && f.landedAirTime > a.landMinAirTime) this.landTimer = a.landHold;

    const speed = Math.hypot(f.velocity.x, f.velocity.z);
    if (f.dead) {
      this.play('death', 0.12);
      return;
    }
    if (f.mode === 'slide') {
      // 하체는 절차 포즈가 덮어쓰므로 기반은 안정적인 대기 클립
      this.play('idle', 0.12);
      return;
    }
    if (!f.grounded) {
      this.play(this.jumpStartTimer > 0 ? 'jumpStart' : 'air', this.state === 'jumpStart' ? 0.25 : 0.15);
      return;
    }
    if (this.landTimer > 0 && speed < 1.5) {
      this.play('land', 0.08);
      return;
    }
    if (speed < 0.3) {
      if (this.turnStepping) {
        // 제자리 회전 발걸음: 전용 클립이 없어 걷기 클립을 제자리에서 재생
        this.play('walk', a.locomotionFade);
        const walk = this.actions.get('walk');
        if (walk) walk.timeScale = a.turnInPlace.stepTimeScale * Math.sign(this.standTwist || 1);
        return;
      }
      this.play('idle');
      return;
    }
    // 달리기 여부는 속도 경계가 아니라 현재 이동 상태로 결정 (Shift를 놓으면 감속 중에도 즉시 걷기)
    const run = f.sprinting;
    this.play(run ? 'run' : 'walk', a.locomotionFade);
    const action = this.actions.get(run ? 'run' : 'walk');
    if (action) {
      // 걸음 길이는 몸 크기에 비례 → 작은 캐릭터는 같은 속도에서 발을 더 빨리 움직임 (발 미끄러짐 방지)
      const ref = (run ? a.runRefSpeed : a.walkRefSpeed) * this.sizeRatio;
      const scale = THREE.MathUtils.clamp(speed / ref, a.minTimeScale, a.maxTimeScale);
      action.timeScale = this.movingBackward(f) ? -scale : scale;
    }
  }

  /** 조준 이동 중 몸 기준 이동 방향 (라디안, 0 = 정면) */
  private relativeMoveAngle(f: AvatarFrame): number {
    return wrapAngle(Math.atan2(f.velocity.x, f.velocity.z) - f.bodyYaw);
  }

  private movingBackward(f: AvatarFrame): boolean {
    return f.strafing && Math.abs(this.relativeMoveAngle(f)) > THREE.MathUtils.degToRad(100);
  }

  /**
   * 제자리 회전 상태 갱신. 루트는 마우스 방향(bodyYaw)으로 바로 돌고, 다리 yaw는 서 있는 동안 그대로 남는다.
   * standTwist = 다리 - 루트 (골반에 적용). startDeg를 넘으면 발걸음 시작, doneDeg 이하에서 멈춤.
   */
  private updateTurnInPlace(f: AvatarFrame): void {
    const t = CHARACTER.anim.turnInPlace;
    const d = THREE.MathUtils.degToRad;
    if (!f.turnInPlace || f.dead || this.legYaw === null) {
      // 이동·점프·슬라이딩 중엔 다리가 몸을 따름 (이동 방향 표현은 기존 골반 비틀기)
      this.legYaw = f.bodyYaw;
      this.turnStepping = false;
      this.standTwist = damp(this.standTwist, 0, 14, f.dt);
      return;
    }
    let diff = wrapAngle(this.legYaw - f.bodyYaw);
    if (!this.turnStepping && Math.abs(diff) > d(t.startDeg)) this.turnStepping = true;
    if (this.turnStepping) {
      diff *= Math.exp(-t.catchUpSharpness * f.dt);
      if (Math.abs(diff) < d(t.doneDeg)) this.turnStepping = false;
    }
    diff = THREE.MathUtils.clamp(diff, -d(t.maxDeg), d(t.maxDeg));
    this.legYaw = f.bodyYaw + diff;
    this.standTwist = diff;
  }

  private applyHipTwist(f: AvatarFrame): void {
    const speed = Math.hypot(f.velocity.x, f.velocity.z);
    let target = 0;
    if (f.strafing && f.grounded && f.mode !== 'slide' && speed > 0.5) {
      const rel = this.relativeMoveAngle(f);
      const twist = this.movingBackward(f) ? wrapAngle(rel - Math.PI) : rel;
      const max = THREE.MathUtils.degToRad(CHARACTER.anim.hipTwistMaxDeg);
      target = THREE.MathUtils.clamp(twist, -max, max);
    }
    this.hipTwist = damp(this.hipTwist, target, 10, f.dt);
    // 제자리 회전의 다리 남김은 감쇠 없이 그대로 (발이 미끄러지지 않게)
    const twist = this.hipTwist + this.standTwist;
    if (Math.abs(twist) < 1e-3) return;
    // 골반을 이동 방향(또는 남아 있는 다리 방향)으로 돌리고 척추에서 되돌려 상체는 조준 방향 유지
    this.rotateBoneWorld(this.bones.hips, UP, twist);
    this.rotateBoneWorld(this.bones.spine, UP, -twist);
  }

  private applySpinePitch(f: AvatarFrame): void {
    const a = CHARACTER.anim;
    // 몸의 오른쪽 축(-X 로컬)을 기준으로 위를 보면 상체를 뒤로 젖힘
    const right = _v3.set(-1, 0, 0).applyAxisAngle(UP, f.bodyYaw);
    const pitch = THREE.MathUtils.clamp(f.pitch, -1.0, 1.0);
    this.rotateBoneWorld(this.bones.spine, right, pitch * a.spinePitchShare);
    this.rotateBoneWorld(this.bones.chest, right, pitch * a.chestPitchShare);
  }

  private rotateBoneWorld(bone: THREE.Bone, axis: THREE.Vector3, angle: number): void {
    bone.getWorldQuaternion(_q1);
    _q2.setFromAxisAngle(axis, angle);
    _q1.premultiply(_q2);
    setWorldQuaternion(bone, _q1);
  }

  private applyWeaponPose(f: AvatarFrame): void {
    const m = this.mount;
    const b = this.bones;
    const s = this.weaponWorldScale;
    const fit = this.fit;
    const bodyQ = _q1.setFromAxisAngle(UP, f.bodyYaw);

    // 오른손 그립 목표 위치: 가슴 본 + 몸 기준 오프셋 (오른쪽 = 로컬 -X)
    const hold = b.chest.getWorldPosition(new THREE.Vector3());
    const raise = THREE.MathUtils.clamp(f.weaponRaise, 0, 1);
    // 재장전: 시작·끝 0.15 구간은 부드럽게 들어가고 나옴, 왼손은 중간(0.2~0.8)에 탄창으로
    const rp = THREE.MathUtils.clamp(f.reloadProgress, 0, 1);
    const reload = rp > 0 ? THREE.MathUtils.smoothstep(rp, 0, 0.15) * (1 - THREE.MathUtils.smoothstep(rp, 0.85, 1)) : 0;
    const magHand = rp > 0 ? THREE.MathUtils.smoothstep(rp, 0.15, 0.3) * (1 - THREE.MathUtils.smoothstep(rp, 0.7, 0.85)) : 0;
    const rl = m.reload;
    // 볼트액션: 후딜레이 앞부분(반동 뒤)부터 기울였다가 끝나기 전에 복귀. 재장전 중에는 재장전 자세 우선
    const bp = THREE.MathUtils.clamp(f.boltProgress ?? 0, 0, 1);
    const bolt = m.bolt && bp > 0 && reload === 0 ? THREE.MathUtils.smoothstep(bp, 0.1, 0.3) * (1 - THREE.MathUtils.smoothstep(bp, 0.7, 0.95)) : 0;
    // ADS 전용 그립 위치가 있는 무기(권총 오버숄더)만 ADS 블렌드로 보간
    const ads = m.adsHoldOffset ? THREE.MathUtils.clamp(f.adsBlend ?? 0, 0, 1) : 0;
    const ho = m.holdOffset;
    const ah = m.adsHoldOffset ?? ho;
    // 그립 위치는 몸 크기에 비례 (가슴 본 기준, 팔 길이·어깨 폭이 크기에 따라 달라짐) + 캐릭터별 보정
    const k = this.sizeRatio;
    const po = fit.weaponPositionOffset;
    const ro = fit.reloadPositionOffset;
    const offset = _v1
      .set(
        -(THREE.MathUtils.lerp(ho[0], ah[0], ads) * k + po[0] + ro[0] * reload),
        THREE.MathUtils.lerp(ho[1], ah[1], ads) * k + po[1] + ro[1] * reload - (1 - raise) * 0.25 - rl.drop * reload,
        THREE.MathUtils.lerp(ho[2], ah[2], ads) * k + po[2] + ro[2] * reload - rl.pull * reload - (m.bolt?.pull ?? 0) * bolt * fit.recoilPullScale,
      )
      .applyQuaternion(bodyQ);
    hold.add(offset).addScaledVector(f.aimDir, -f.weaponKick * fit.recoilPullScale);

    // 총 방향: aimDir을 +Z로, 위는 월드 위 (꺼내는 중에는 아래로 숙임)
    const dir = _v2.copy(f.aimDir);
    const swingRoll = m.swing ? this.applySwingPose(m.swing, f, hold, bodyQ, dir) : 0;
    if (raise < 1) dir.y -= (1 - raise) * 1.2;
    dir.normalize();
    _m1.lookAt(dir, _v3.set(0, 0, 0), UP);
    const aimQ = new THREE.Quaternion().setFromRotationMatrix(_m1);
    if (m.swing?.style === 'overhead') this.applyOverheadSwing(m.swing, f, aimQ);
    if (swingRoll !== 0) aimQ.multiply(_q2.setFromAxisAngle(_v3.set(0, 0, 1), swingRoll));
    if (reload > 0) {
      // 총을 아래로 숙이고 탄창이 왼손 쪽으로 오게 기울임 (총 로컬 X축 = 피치, Z축 = 롤)
      const d = THREE.MathUtils.degToRad;
      aimQ.multiply(_q2.setFromAxisAngle(_v3.set(1, 0, 0), d(rl.pitchDownDeg) * reload));
      aimQ.multiply(_q2.setFromAxisAngle(_v3.set(0, 0, 1), -d(rl.rollDeg) * reload));
    }
    const rot = fit.weaponRotationOffset;
    if (rot[0] !== 0 || rot[1] !== 0 || rot[2] !== 0) {
      const d = THREE.MathUtils.degToRad;
      aimQ.multiply(_q2.setFromEuler(new THREE.Euler(d(rot[0]), d(rot[1]), d(rot[2]))));
    }
    if (bolt > 0 && m.bolt) {
      // 볼트를 당기듯 총을 오른쪽으로 눕히고 살짝 숙임
      const d = THREE.MathUtils.degToRad;
      aimQ.multiply(_q2.setFromAxisAngle(_v3.set(1, 0, 0), d(m.bolt.pitchDownDeg) * bolt));
      aimQ.multiply(_q2.setFromAxisAngle(_v3.set(0, 0, 1), d(m.bolt.rollDeg) * bolt));
    }

    // 근접무기: 이동 클립(조깅·점프)이 몸·머리를 앞으로 숙이면 망치 머리가 얼굴로 들어감 → 겹친 만큼 손을 몸 바깥쪽으로 밀어 냄
    if (m.swing?.headPoint) this.avoidHeadOverlap(m, aimQ, hold, bodyQ, s, _v4.addVectors(f.feet, this.headFromFeet));

    // 정렬 공간 목표 변환 (오른손 그립을 회전 중심으로)
    const gripOffset = _v3.fromArray(m.rightGrip).multiplyScalar(s).applyQuaternion(aimQ);
    const alignedPos = hold.clone().sub(gripOffset);
    this.alignedTarget.compose(alignedPos, aimQ, new THREE.Vector3(s, s, s));

    // 오른팔
    const rightRot = aimQ.clone().multiply(this.rightHandInRifle);
    // 캐릭터 손 보정: 손 본 목표를 손가락 방향으로 (블루 0)
    const rightTarget = hold.clone().addScaledVector(_v3.copy(this.hands.right.finger).applyQuaternion(rightRot), this.hands.right.shift);
    addBodyOffset(rightTarget, fit.rightHandIKOffset, bodyQ);
    this.reachError.right = this.solveArm(b.shoulderR, b.upperArmR, b.lowerArmR, b.handR, rightTarget, rightRot, bodyQ, -1);
    // 왼팔 (총열 아래 지지점)
    // 한 손 ADS(권총): 왼팔을 ADS 블렌드만큼 애니메이션 자세로 되돌림 (IK 결과와 애니메이션 회전을 섞어 튀지 않게)
    const oneHand = m.adsOneHanded ? ads : 0;
    if (m.leftHandIk && oneHand < 0.999) {
      const leftBones = [b.shoulderL, b.upperArmL, b.lowerArmL, b.handL];
      const animQ = oneHand > 0 ? leftBones.map((bone) => bone.quaternion.clone()) : null;
      const animP = oneHand > 0 ? leftBones.map((bone) => bone.position.clone()) : null;
      const support = new THREE.Vector3().fromArray(m.supportGrip).applyMatrix4(this.alignedTarget);
      const leftRot = aimQ.clone().multiply(this.leftHandInRifle);
      if (magHand > 0) {
        support.lerp(new THREE.Vector3().fromArray(rl.magazineGrip).applyMatrix4(this.alignedTarget), magHand);
        leftRot.slerp(aimQ.clone().multiply(this.leftHandOnMag), magHand);
      }
      support.addScaledVector(_v3.copy(this.hands.left.finger).applyQuaternion(leftRot), this.hands.left.shift);
      addBodyOffset(support, fit.leftHandIKOffset, bodyQ);
      this.reachError.left = this.solveArm(b.shoulderL, b.upperArmL, b.lowerArmL, b.handL, support, leftRot, bodyQ, 1);
      if (animQ && animP) {
        leftBones.forEach((bone, i) => {
          bone.quaternion.slerp(animQ[i]!, oneHand);
          bone.position.lerp(animP[i]!, oneHand);
        });
        b.shoulderL.updateMatrixWorld(true);
        this.reachError.left *= 1 - oneHand;
      }
    } else {
      // 완전히 한 손이거나 왼손 IK를 안 쓰는 무기: 왼팔은 애니메이션 그대로 (지지 손 오차 없음, 이전 무기 값이 남지 않게)
      this.reachError.left = 0;
    }
  }

  /**
   * 근접무기 자세 (전용 클립 없음 → 절차 연출): 평소엔 세워 들고, 휘두르면 뒤로 젖혔다가(windup) 앞·왼쪽 아래로 내려침(strike) 후 복귀.
   * 각도는 조준 방향 기준 (yaw +는 몸 오른쪽, pitch +는 위). hold(손 목표)와 dir(무기 방향)을 직접 바꾼다.
   * @returns 손잡이 축 회전 (라디안, swingRollDeg × 휘두름 가중치)
   */
  private applySwingPose(sw: NonNullable<WeaponMount['swing']>, f: AvatarFrame, hold: THREE.Vector3, bodyQ: THREE.Quaternion, dir: THREE.Vector3): number {
    const p = THREE.MathUtils.clamp(f.meleeSwing ?? 0, 0, 1);
    const ease = (a: number, b: number) => THREE.MathUtils.smoothstep(p, a, b);
    // 구간별 가중치: 0→windup, windup→strike, strike→1(복귀)
    let pitch = sw.restPitchDeg;
    let yaw = sw.restYawDeg;
    let reach = 0;
    // 수직 내려찍기는 무기 방향을 applyOverheadSwing에서 따로 정함 (여기서는 평소 방향 + 손 이동만)
    const overhead = sw.style === 'overhead';
    if (p > 0) {
      if (p < sw.windupAt) {
        const t = ease(0, sw.windupAt);
        if (!overhead) {
          pitch = THREE.MathUtils.lerp(sw.restPitchDeg, sw.windupPitchDeg, t);
          yaw = THREE.MathUtils.lerp(sw.restYawDeg, sw.windupYawDeg, t);
        }
      } else if (p < sw.strikeAt) {
        // 수직 내려찍기: 손이 망치보다 조금 먼저 내려가 망치가 뒤따라 휘어 들어오게 (어깨 → 손 → 망치 순)
        const t = overhead ? ease(sw.windupAt, sw.strikeAt - (sw.handLead ?? 0)) : ease(sw.windupAt, sw.strikeAt);
        if (!overhead) {
          pitch = THREE.MathUtils.lerp(sw.windupPitchDeg, sw.strikePitchDeg, t);
          yaw = THREE.MathUtils.lerp(sw.windupYawDeg, sw.strikeYawDeg, t);
        }
        reach = t;
      } else {
        // 수직 내려찍기는 관성 구간(followAt)까지 손을 아래에 두었다가 복귀
        const t = overhead ? ease(sw.overheadFollowAt ?? sw.strikeAt, 1) : ease(sw.strikeAt, 1);
        if (!overhead) {
          pitch = THREE.MathUtils.lerp(sw.strikePitchDeg, sw.restPitchDeg, t);
          yaw = THREE.MathUtils.lerp(sw.strikeYawDeg, sw.restYawDeg, t);
        }
        reach = 1 - t;
      }
    }
    const d = THREE.MathUtils.degToRad;
    const baseYaw = Math.atan2(f.aimDir.x, f.aimDir.z);
    const basePitch = Math.asin(THREE.MathUtils.clamp(f.aimDir.y, -1, 1)) * 0.5;
    // 오른쪽 = 로컬 -X → yaw +는 시계 방향(위에서 볼 때)으로 빼 준다
    const y = baseYaw - d(yaw);
    const pt = THREE.MathUtils.clamp(basePitch + d(pitch), -1.4, 1.5);
    dir.set(Math.sin(y) * Math.cos(pt), Math.sin(pt), Math.cos(y) * Math.cos(pt));
    // 뒤로 젖힐 때 손도 어깨 쪽으로 올려 아래팔이 망치를 따라감 (손목만 꺾이지 않게)
    const lift = p > 0 && p < sw.strikeAt ? ease(0, sw.windupAt) * (1 - ease(sw.windupAt, sw.strikeAt)) : 0;
    if (lift > 0 && sw.windupLift) {
      hold.y += sw.windupLift[1] * lift;
      hold.addScaledVector(_v3.set(-1, 0, 0).applyQuaternion(bodyQ), sw.windupLift[0] * lift);
      hold.addScaledVector(_v3.set(0, 0, 1).applyQuaternion(bodyQ), sw.windupLift[2] * lift);
    }
    // 내려칠 때 손 이동: strikeOffset(오른쪽, 위, 앞 m)이 있으면 그 값, 없으면 앞으로 strikeReach + 가운데로 0.08
    if (reach > 0) {
      const so = sw.strikeOffset;
      if (so) {
        hold.addScaledVector(_v3.set(-1, 0, 0).applyQuaternion(bodyQ), so[0] * reach);
        hold.y += so[1] * reach;
        hold.addScaledVector(_v3.set(0, 0, 1).applyQuaternion(bodyQ), so[2] * reach);
      } else {
        hold.addScaledVector(_v3.set(0, 0, 1).applyQuaternion(bodyQ), sw.strikeReach * reach);
        hold.addScaledVector(_v3.set(1, 0, 0).applyQuaternion(bodyQ), 0.08 * reach);
      }
    }
    if (!sw.swingRollDeg || p <= 0) return 0;
    const roll = p < sw.windupAt ? ease(0, sw.windupAt) : p < sw.strikeAt ? 1 : 1 - ease(sw.strikeAt, 1);
    return d(sw.swingRollDeg) * roll;
  }

  /**
   * 수직 내려찍기 (swing.style 'overhead'): 조준 방향 정면 세로면(위쪽을 바깥으로 overheadPlaneOutDeg 기울인 면) 안에서
   * 손잡이 각도 a(정면 수평 0, 위 90, 머리 위 뒤 >90)를 돌린다. 면에 수직인 축을 무기 X축으로 고정해 수직을 지나도 뒤집히지 않음.
   * 0→windupAt: 평소 방향 → 들어 올림(windup 각) 회전 보간, windupAt→strikeAt: 각도를 내려찍기 각까지, strikeAt→1: 평소 방향으로 복귀.
   * restQ(평소 방향 회전)를 직접 바꾼다.
   */
  private applyOverheadSwing(sw: NonNullable<WeaponMount['swing']>, f: AvatarFrame, restQ: THREE.Quaternion): void {
    const p = THREE.MathUtils.clamp(f.meleeSwing ?? 0, 0, 1);
    if (p <= 0) return;
    const d = THREE.MathUtils.degToRad;
    const baseYaw = Math.atan2(f.aimDir.x, f.aimDir.z) + this.swingTorsoYaw;
    const basePitch = Math.asin(THREE.MathUtils.clamp(f.aimDir.y, -1, 1)) * 0.5;
    const fwd = new THREE.Vector3(Math.sin(baseYaw), 0, Math.cos(baseYaw));
    const right = new THREE.Vector3(-Math.cos(baseYaw), 0, Math.sin(baseYaw));
    const out = d(sw.overheadPlaneOutDeg ?? 0);
    const up = new THREE.Vector3().copy(UP).multiplyScalar(Math.cos(out)).addScaledVector(right, Math.sin(out));
    // 면에 수직인 축 (평소 자세의 무기 X축과 같은 쪽으로)
    const side = new THREE.Vector3().crossVectors(up, fwd).normalize();
    if (side.dot(_v3.set(1, 0, 0).applyQuaternion(restQ)) < 0) side.negate();
    const planeQ = (deg: number, outQ: THREE.Quaternion): THREE.Quaternion => {
      const a = d(deg) + basePitch;
      const z = new THREE.Vector3().copy(fwd).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
      const y = new THREE.Vector3().crossVectors(z, side);
      return outQ.setFromRotationMatrix(_m2.makeBasis(side, y, z));
    };
    const windupDeg = sw.overheadWindupDeg ?? 150;
    const strikeDeg = sw.overheadStrikeDeg ?? -30;
    const ease = (a: number, b: number) => THREE.MathUtils.smoothstep(p, a, b);
    const q = new THREE.Quaternion();
    if (p < sw.windupAt) {
      planeQ(windupDeg, q);
      restQ.slerp(q, ease(0, sw.windupAt));
    } else if (p < sw.strikeAt) {
      // 내려찍기는 끝으로 갈수록 빨라지게 (가속)
      const t = (p - sw.windupAt) / (sw.strikeAt - sw.windupAt);
      restQ.copy(planeQ(THREE.MathUtils.lerp(windupDeg, strikeDeg, t * t), q));
    } else {
      // 관성: 찍은 각에서 followDeg만큼 더 내려가며 감속(ease-out) → 그 뒤 평소 방향으로 부드럽게 복귀
      const followAt = Math.max(sw.strikeAt, sw.overheadFollowAt ?? sw.strikeAt);
      const followDeg = sw.overheadFollowDeg ?? 0;
      if (p < followAt) {
        const t = (p - sw.strikeAt) / Math.max(1e-3, followAt - sw.strikeAt);
        restQ.copy(planeQ(strikeDeg - followDeg * (1 - (1 - t) * (1 - t)), q));
      } else {
        planeQ(strikeDeg - followDeg, q);
        restQ.copy(q.slerp(restQ.clone(), ease(followAt, 1)));
      }
    }
  }

  /**
   * 근접 공격 상체 연출 (swing.torso): 척추·가슴을 몸 기준으로 비틀고(위 축) 숙임(오른쪽 축).
   * 상체 곡선은 망치보다 조금 앞서 간다: 들어 올림 최대 0.8×windupAt, 내려찍기 최대 strikeAt−0.06, 관성 구간 끝까지 유지 후 1에서 0.
   * 진행도 0과 1에서 정확히 0 → 평소·이동 애니메이션과 끊김 없이 이어짐. 하체(골반·다리)는 건드리지 않음.
   */
  private applySwingTorso(sw: NonNullable<WeaponMount['swing']>, f: AvatarFrame): void {
    const p = THREE.MathUtils.clamp(f.meleeSwing ?? 0, 0, 1);
    const tr = sw.torso;
    this.swingTorsoYaw = 0;
    if (!tr || p <= 0 || p >= 1) return;
    const k1 = sw.windupAt * 0.8;
    const k2 = Math.max(k1 + 0.02, sw.strikeAt - 0.06);
    const k3 = Math.max(k2 + 0.02, sw.overheadFollowAt ?? sw.strikeAt + 0.1);
    const ss = (a: number, b: number) => THREE.MathUtils.smoothstep(p, a, b);
    let yaw: number;
    let pitch: number;
    if (p < k1) {
      const t = ss(0, k1);
      yaw = tr.windupYawDeg * t;
      pitch = tr.windupPitchDeg * t;
    } else if (p < k2) {
      const t = ss(k1, k2);
      yaw = THREE.MathUtils.lerp(tr.windupYawDeg, tr.strikeYawDeg, t);
      pitch = THREE.MathUtils.lerp(tr.windupPitchDeg, tr.strikePitchDeg, t);
    } else if (p < k3) {
      yaw = tr.strikeYawDeg;
      pitch = tr.strikePitchDeg;
    } else {
      const t = 1 - ss(k3, 1);
      yaw = tr.strikeYawDeg * t;
      pitch = tr.strikePitchDeg * t;
    }
    const d = THREE.MathUtils.degToRad;
    // yaw +: 오른쪽으로 비틂(위에서 볼 때 시계 방향 = 위 축 음의 회전), pitch +: 앞으로 숙임(오른쪽 축 음의 회전)
    const right = _v3.set(-1, 0, 0).applyAxisAngle(UP, f.bodyYaw);
    const rightAxis = right.clone();
    // 내려찍기 면도 상체와 같이 돈다 (어깨 → 팔 → 망치가 한 덩어리로)
    this.swingTorsoYaw = -d(yaw);
    this.rotateBoneWorld(this.bones.spine, UP, -d(yaw) * 0.4);
    this.rotateBoneWorld(this.bones.chest, UP, -d(yaw) * 0.6);
    this.rotateBoneWorld(this.bones.spine, rightAxis, -d(pitch) * 0.4);
    this.rotateBoneWorld(this.bones.chest, rightAxis, -d(pitch) * 0.6);
  }

  /**
   * 무기 머리(장착값 swing.headPoint, 반지름 headRadius, 정렬 공간)가 캐릭터 머리 구(직전 프레임 headCenter·headRadius)와 겹치면
   * 1) 손잡이 쥔 점을 축으로 무기를 몸 바깥쪽으로 기울이고 (최대 35°, 손 위치 그대로 → 팔 도달 한계와 무관)
   * 2) 그래도 겹치면 남은 만큼 손 목표를 머리에서 멀어지는 쪽(몸 안쪽 제외)으로 민다.
   * 조깅·점프 클립이 몸과 머리를 앞으로 숙일 때 망치 머리가 얼굴에 들어가지 않게.
   */
  private avoidHeadOverlap(
    m: WeaponMount,
    aimQ: THREE.Quaternion,
    hold: THREE.Vector3,
    bodyQ: THREE.Quaternion,
    s: number,
    headCenter: THREE.Vector3,
  ): void {
    const sw = m.swing!;
    const need = this.headRadius + (sw.headRadius ?? 0) * s + (sw.headClearance ?? 0);
    const local = _v2.fromArray(sw.headPoint!).sub(_v1.fromArray(m.rightGrip)).multiplyScalar(s);
    const len = local.length();
    const headPos = (out: THREE.Vector3) => out.copy(local).applyQuaternion(aimQ).add(hold);
    const head = headPos(_v3);
    let d = head.distanceTo(headCenter);
    if (d >= need) return;
    const fwd = _v1.set(0, 0, 1).applyQuaternion(bodyQ);
    // 몸 정면 축으로 양(+)회전 = 위쪽이 몸 오른쪽으로 기움
    const tilt = Math.min(THREE.MathUtils.degToRad(35), (need - d) / Math.max(0.05, len));
    aimQ.premultiply(_q2.setFromAxisAngle(fwd, tilt));
    headPos(head);
    d = head.distanceTo(headCenter);
    if (d >= need) return;
    const away = head.sub(headCenter);
    if (d > 1e-4) away.divideScalar(d);
    const right = _v1.set(-1, 0, 0).applyQuaternion(bodyQ);
    const inward = away.dot(right);
    if (inward < 0) away.addScaledVector(right, -inward).normalize();
    hold.addScaledVector(away, need - d);
  }

  /** side: -1 = 오른쪽(로컬 -X), +1 = 왼쪽 */
  private solveArm(
    shoulder: THREE.Bone,
    upper: THREE.Bone,
    lower: THREE.Bone,
    hand: THREE.Bone,
    target: THREE.Vector3,
    handRot: THREE.Quaternion,
    bodyQ: THREE.Quaternion,
    side: number,
  ): number {
    // 짧은 팔 보조: 쇄골을 목표 쪽으로 일부 회전
    if (this.mount.shoulderAssist > 0) {
      const sp = shoulder.getWorldPosition(new THREE.Vector3());
      const up = upper.getWorldPosition(new THREE.Vector3());
      rotateBoneToward(shoulder, sp, up, target, this.mount.shoulderAssist, THREE.MathUtils.degToRad(70));
    }
    // 팔꿈치는 아래·바깥·약간 뒤로
    const upperPos = upper.getWorldPosition(new THREE.Vector3());
    // 짧은 팔 보조: 목표가 도달 거리 밖이면 팔 본 길이를 제한적으로 늘림
    const restLower = this.restOffsets.get(lower)!;
    const restHand = this.restOffsets.get(hand)!;
    const worldScale = upper.getWorldScale(new THREE.Vector3()).x;
    const reach = (restLower.length() + restHand.length()) * worldScale;
    const k = THREE.MathUtils.clamp(upperPos.distanceTo(target) / (reach * 0.98), 1, this.mount.armStretchMax);
    lower.position.copy(restLower).multiplyScalar(k);
    hand.position.copy(restHand).multiplyScalar(k);
    upper.updateMatrixWorld(true);
    // 팔꿈치가 향할 방향 (몸 기준). 장착값 rightElbowPole(오른쪽, 위, 앞)이 있으면 오른팔에 사용 (근접무기: 팔꿈치를 몸에서 띄움)
    const custom = side < 0 ? this.mount.rightElbowPole : undefined;
    const pole = (custom ? new THREE.Vector3(-custom[0], custom[1], custom[2]) : new THREE.Vector3(side * 0.6, -1, -0.35))
      .applyQuaternion(bodyQ)
      .add(upperPos);
    const err = solveTwoBoneIk(upper, lower, hand, target, pole);
    setWorldQuaternion(hand, handRot);
    return err;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    // 무기 모델(플레이어는 공용 무기 라이브러리)은 다음 아바타가 다시 잡음 → 손에서 떼고 디버그 마커만 정리
    this.markers.removeFromParent();
    this.rifle.removeFromParent();
    // 복제된 스켈레톤의 본 텍스처 (GPU). 지오메트리·색 텍스처는 GLB 원본과 공유라 해제하지 않음
    this.model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).skeleton.dispose();
    });
    for (const mat of this.materials) mat.dispose();
    for (const mesh of Object.values(this.markerMeshes)) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.root.removeFromParent();
  }
}

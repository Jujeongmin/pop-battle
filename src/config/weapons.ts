// 무기 정의 (라이플·샷건·스나이퍼·권총·근접). 성능·모델·장착값·이펙트를 전부 여기서 관리한다.
// 새 무기 수치는 초기 테스트용 → 밸런싱은 이 파일 숫자만 바꾸면 된다.
import * as THREE from 'three';
import { ASSETS } from './gameConfig';

/**
 * ADS 방식 (무기별). 모든 방식이 우클릭 토글 + 공통 AimController(자동 해제 규칙 포함)를 쓴다.
 * - 'shoulder': TPS형 ADS. 오른쪽 어깨 카메라를 당기며 magnification만큼 확대, 무기는 화면 아래, 화면 중앙 조준선.
 *   라이플 1.3~1.5배, 샷건 1.1~1.2배 (샷건 추가 시 같은 방식, 값만 다르게)
 * - 'scopeOverlay': 같은 어깨 확대 + 총을 숨기고 원형 스코프 화면 (스나이퍼 예정)
 */
export type AdsStyle = 'shoulder' | 'scopeOverlay';

/** 우클릭 토글 조준(ADS) 설정. */
export interface AimProfile {
  style: AdsStyle;
  /** 확대 배율 (기본 FOV 대비 화면상 크기). FOV는 이 값으로 계산 */
  magnification: number;
  /** ADS 어깨 카메라: 캐릭터 뒤 거리, 오른쪽 오프셋, 높이 오프셋 (m) */
  cameraDistance: number;
  shoulderOffset: number;
  heightOffset: number;
  /** 일반 ↔ 조준 전환 시간(s) */
  transitionTime: number;
  moveSpeedMultiplier: number;
  spreadMultiplier: number;
  recoilMultiplier: number;
  lookSensitivityMultiplier: number;
  /** true면 재장전 중에도 ADS 유지, false면 재장전 시작 시 해제되고 재장전 중 진입 불가 */
  keepAimWhileReloading: boolean;
  /** ADS 중 총이 뒤로 밀리는 반동 비율 (조준 중 무기 흔들림 억제) */
  kickScale: number;
  /** scopeOverlay: 블렌드가 이 값을 넘으면 원형 스코프 화면 표시 */
  overlayFrom: number;
  /** 발사 직후 ADS 자동 해제 (볼트액션 저격총). 다시 조준하려면 우클릭 */
  releaseAfterShot?: boolean;
  /**
   * ADS 중 로컬 캐릭터 몸을 숨길지 (없으면 CAMERA.occlusion.hideBodyInAds = 숨김).
   * 주무기는 숨김(카메라가 캐릭터 뒤 거의 중앙), 권총은 표시(오른쪽 어깨 너머 오버숄더 구도).
   * 숨기지 않아도 카메라가 몸에 너무 가까우면 기존 거리 기반 가림 처리는 그대로 동작
   */
  hideBodyInAds?: boolean;
  /** ADS 수직 FOV(도)를 직접 지정 (없으면 magnification으로 계산) */
  fovDeg?: number;
  /**
   * ADS 중 몸을 조준 방향보다 오른쪽으로 돌리는 각도 (없으면 0 = 기존: 전투 비틀기 40°가 ADS 블렌드로 0이 됨).
   * 오버숄더 ADS(권총)에서 총이 머리 뒤에 가려지지 않게 유지
   */
  adsBodyYawDeg?: number;
}

/** ADS 수직 FOV(도): fovDeg 지정값 우선, 없으면 배율로 계산 */
export function aimProfileFov(baseFovDeg: number, p: AimProfile): number {
  return p.fovDeg ?? adsFov(baseFovDeg, p.magnification);
}

/** 배율 → 수직 FOV(도) */
export function adsFov(baseFovDeg: number, magnification: number): number {
  const half = THREE.MathUtils.degToRad(baseFovDeg / 2);
  return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) / Math.max(1, magnification)));
}

export interface SpreadProfile {
  /** 기본 탄퍼짐 반각(도) */
  baseDeg: number;
  movingAddDeg: number;
  airAddDeg: number;
  slideAddDeg: number;
  bloomPerShotDeg: number;
  bloomMaxDeg: number;
  bloomRecoveryDegPerSec: number;
  /**
   * 조준(ADS) 중에도 남기는 이동·점프·슬라이딩 가산 비율 (0~1). 없으면 ADS 배율 그대로 (기존 무기).
   * 스나이퍼: 스코프만 열면 뛰면서도 거의 정확하던 것을 막음 (멈춰 서서 조준하면 기본 퍼짐 × ADS 배율 그대로 정밀)
   */
  adsMovementKeep?: number;
}

export interface RecoilProfile {
  pitchDeg: number;
  yawJitterDeg: number;
  /** 반동 중 자동 복귀 비율 (0~1) */
  recoveryRatio: number;
  recoverySharpness: number;
  /** 총 모델이 뒤로 밀리는 거리(m) */
  visualKick: number;
}

/** 슬롯: 1 주무기(로드아웃에서 하나 선택) / 2 보조무기(권총 고정) / 3 근접무기(고정) */
export type WeaponSlot = 'primary' | 'secondary' | 'melee';

/** 거리별 피해 감소: start까지 100%, end에서 minMultiplier, 그 사이 선형 */
export interface DamageFalloff {
  startDistance: number;
  endDistance: number;
  minMultiplier: number;
  /** 2단계 감소: endDistance → farDistance 사이 minMultiplier → farMultiplier, 그 뒤 farMultiplier 유지 */
  farDistance?: number;
  farMultiplier?: number;
}

/** 근접 공격 판정 */
export interface MeleeProfile {
  /** 가슴에서 대상 판정 영역 표면까지 최대 거리 (m) */
  range: number;
  /** 정면 기준 허용 각도 (반각, 도) */
  halfAngleDeg: number;
  /** 휘두르기 연출 전체 시간 (s) */
  swingDuration: number;
  /** 휘두르기 시작 후 판정 시점 (s). 공격 1회당 한 번만 판정 */
  hitTime: number;
}

/** 무기별 연출 배율 (기존 이펙트·사운드 재사용) */
export interface WeaponEffectProfile {
  flashScale: number;
  /** 발사음 높이·음량 배율 (합성음은 주파수, 파일은 재생 속도) */
  firePitch: number;
  fireGain: number;
}

/**
 * 조준선 모양 (디자인만. 크기는 실제 탄 퍼짐 WeaponSystem.lastSpreadDeg를 화면 px로 바꿔 씀).
 * - 'cross': 중앙 점 + 상하좌우 선. 선 안쪽 끝 = 탄 퍼짐 반지름
 * - 'ring': 중앙 점 + 원. 원 반지름 = 탄 퍼짐 반각(샷건 펠릿 최대 분산과 같음)
 * - 'dot': 중앙 점만 (근접무기: 공격 범위 안 대상이면 크기·색 변화)
 * 길이·굵기·점 크기는 1080p 기준 px (화면 높이에 비례해 조정)
 */
export interface CrosshairDef {
  style: 'cross' | 'ring' | 'dot';
  lineLength: number;
  lineWidth: number;
  dotSize: number;
  /** 탄 퍼짐이 아주 작아도 유지할 최소 간격(선) / 최소 반지름(원), px */
  minGap: number;
}

/** 무기 모델: GLB가 있으면 GLB, 없으면 임시 도형 (실제 GLB가 오면 glb 경로만 넣고 장착값 조정) */
export interface WeaponModelDef {
  glb: string | null;
  placeholder: 'shotgun' | 'sniper' | 'pistol' | 'melee' | null;
}

export interface WeaponDef {
  id: string;
  name: string;
  kind: 'gun' | 'melee';
  slot: WeaponSlot;
  /**
   * 들고 있을 때 이동속도 배율 (걷기·달리기 수평 속도만, 점프·중력·슬라이딩은 그대로).
   * ADS 이동 감속(aim.moveSpeedMultiplier)과 곱해서 적용, 매 고정 스텝 새로 계산하므로 교체를 반복해도 누적되지 않음
   */
  moveSpeedMultiplier: number;
  damage: number;
  /** 근접무기는 0 (탄약 없음) */
  magazineSize: number;
  reserveAmmo: number;
  rpm: number;
  headshotMultiplier: number;
  automatic: boolean;
  /** 한 번 쏠 때 탄 수 (샷건 펠릿). 탄약은 1발만 소모 */
  pellets: number;
  range: number;
  reloadTime: number;
  spread: SpreadProfile;
  recoil: RecoilProfile;
  /** null = ADS 없음 (근접무기) */
  aim: AimProfile | null;
  falloff?: DamageFalloff;
  melee?: MeleeProfile;
  /**
   * 퀵스왑(스나이퍼 전용): 발사 후딜레이(recovery = 60/rpm)는 다른 무기 장착이 "완료"되면 취소되지만,
   * 마지막 발사로부터 minFireInterval은 무엇을 해도 지나야 다시 쏠 수 있다.
   */
  quickSwap?: { minFireInterval: number };
  effects: WeaponEffectProfile;
  /** 조준선 모양 (없으면 라이플형 십자) */
  crosshair?: CrosshairDef;
  model: WeaponModelDef;
  mount: WeaponMount;
}

/**
 * 무기 교체 시간 (s): 0이면 즉시 교체 (2026-10-20 교체 딜레이 제거).
 * 0보다 크게 하면 그동안 사격·ADS 불가 + 무기 드는 연출, 퀵스왑 취소는 교체 완료 시점에 확정
 */
export const WEAPON_SWITCH_TIME = 0;


/**
 * 무기 장착값. 디버그 패널(` 키)에서 실시간 조절하고 "값 복사"로 여기에 붙여 넣는다.
 * "정렬 공간" = 모델 보정 회전 후, +Z가 총구, +Y가 위, 단위는 GLB 원본 단위(총 길이 1.0).
 */
export interface WeaponMount {
  /** GLB 원본 → 정렬 공간 회전(도, XYZ) */
  modelFixDeg: [number, number, number];
  /** 캐릭터 대비 총 크기 (GLB 길이 1.0 기준) */
  scale: number;
  /** 정렬 공간: 오른손 손목(Hand_R 원점)이 놓일 위치 */
  rightGrip: [number, number, number];
  /** 정렬 공간: 왼손 손목(Hand_L 원점)이 놓일 위치 */
  supportGrip: [number, number, number];
  /** 정렬 공간: 총구 위치 */
  muzzle: [number, number, number];
  /** 정렬 공간: 손가락 방향 / 손바닥 방향 (손 회전 결정) */
  rightFingerDir: [number, number, number];
  rightPalmDir: [number, number, number];
  leftFingerDir: [number, number, number];
  leftPalmDir: [number, number, number];
  /** 오른손 그립 위치: Chest 본 기준 (오른쪽, 위, 앞) m */
  holdOffset: [number, number, number];
  /**
   * ADS 중 오른손 그립 위치 (holdOffset과 같은 기준, ADS 블렌드로 보간). 없으면 ADS에서도 holdOffset.
   * 몸을 숨기지 않는 오버숄더 ADS(권총)에서 팔을 앞으로 뻗어 총이 머리 오른쪽에 보이게 할 때 사용
   */
  adsHoldOffset?: [number, number, number];
  /** ADS 중 한 손 조준: 왼손 IK를 ADS 블렌드만큼 풀어 이동 애니메이션 팔로 되돌림 (짧은 팔로도 오른팔을 옆·앞으로 뻗을 수 있게) */
  adsOneHanded?: boolean;
  /** 재장전 절차 자세 (전용 클립 없음): 총 기울기·당김, 왼손이 탄창을 잡는 위치 */
  reload: {
    rollDeg: number;
    pitchDownDeg: number;
    /** 몸 쪽으로 당기기 / 내리기 (m) */
    pull: number;
    drop: number;
    /** 정렬 공간: 탄창 아래 왼손 손목 위치, 손 방향 */
    magazineGrip: [number, number, number];
    magazineFingerDir: [number, number, number];
    magazinePalmDir: [number, number, number];
    /**
     * 재장전 중 그립 위치 이동 (holdOffset과 같은 기준, 몸 크기 비례). 평소엔 총을 오른쪽 옆구리에 들지만
     * 탄창을 갈 때는 왼손이 닿게 몸 가운데·위로 가져옴. 없으면 0
     */
    holdShift?: [number, number, number];
  };
  /** 팔 IK 사용 여부 (끄면 애니메이션 팔 + 손에 붙은 총만 표시) */
  ikEnabled: boolean;
  leftHandIk: boolean;
  /** 짧은 팔 보조: 쇄골(Shoulder) 본을 목표 쪽으로 돌리는 비율 */
  shoulderAssist: number;
  /** 짧은 팔 보조: 목표가 멀면 팔 본 길이를 최대 이 배율까지 늘림 (1 = 늘리지 않음) */
  armStretchMax: number;
  /** 근접무기: 쥐는 자세·휘두르기 (전용 클립 없음 → 본 IK 절차 연출) */
  swing?: MeleeSwingPose;
  /** 오른팔 팔꿈치가 향할 방향 (몸 기준 오른쪽, 위, 앞). 없으면 기본(아래·바깥·약간 뒤) */
  rightElbowPole?: [number, number, number];
  /** 볼트액션 연출 (전용 클립 없음 → 후딜레이 동안 총을 살짝 기울여 당김) */
  bolt?: { rollDeg: number; pitchDownDeg: number; pull: number };
}

/** 근접 휘두르기 자세 (조준 방향 기준 각도, 도). 진행도 0→windupAt→strikeAt→1 */
export interface MeleeSwingPose {
  /** 평소: 위로 세워 든 각도 / 오른쪽으로 벌린 각도 */
  restPitchDeg: number;
  restYawDeg: number;
  /** 뒤로 젖힌 자세 */
  windupPitchDeg: number;
  windupYawDeg: number;
  /** 내려친 자세 */
  strikePitchDeg: number;
  strikeYawDeg: number;
  /** 각 자세에 도달하는 진행도 (0..1) */
  windupAt: number;
  strikeAt: number;
  /** 내려칠 때 손이 앞으로 나가는 거리 (m) */
  strikeReach: number;
  /** 내려칠 때 손 이동 (오른쪽, 위, 앞 m). 없으면 앞으로 strikeReach */
  strikeOffset?: [number, number, number];
  /** 뒤로 젖힐 때 손 이동 (오른쪽, 위, 앞 m) */
  windupLift?: [number, number, number];
  /** 휘두르는 동안 손잡이 축(+Z) 회전 (도, 손목 돌림). 들어 올리며 들어가고 복귀하며 빠짐. 평소 쥔 방향과 내려칠 때 손 방향이 다를 때 */
  swingRollDeg?: number;
  /** 내려칠 때 손잡이 축 회전 (도). 없으면 swingRollDeg. 들어 올림 → 내려찍기 동안 swingRollDeg에서 이 값으로 넘어가고, 관성 구간 뒤 복귀하며 빠짐 */
  strikeRollDeg?: number;
  /** 무기 머리 중심·반지름 (정렬 공간). 있으면 캐릭터 머리와 겹치지 않게 손을 바깥으로 밀어 냄 */
  headPoint?: [number, number, number];
  headRadius?: number;
  /** 머리와 띄울 여유 (m) */
  headClearance?: number;
  /**
   * 손 목표를 오른쪽 쇄골 시작점에서 (쇄골+위팔+아래팔 길이) × 이 비율 안으로 당김 [평소, 내려칠 때].
   * 캐릭터마다 팔 길이·어깨 폭이 달라 가슴 기준 같은 위치로는 팔이 짧은 캐릭터의 팔이 다 펴지고 늘어남 → 무기는 당긴 손을 그대로 따라감.
   * 없으면 당기지 않음
   */
  maxArmReach?: [number, number];
  /** 손 목표가 쇄골 시작점에서 (쇄골+팔 길이) × 이 비율보다 가까우면 바깥으로 밀어 냄 (아래팔이 짧은 캐릭터가 들어 올릴 때 팔을 완전히 접지 않게) */
  minArmReach?: number;
  /** 손잡이 중심 y (정렬 공간). 디버그 패널 "손목 자동 맞춤"이 쥔 점으로 씀 */
  gripCenterY?: number;
  /**
   * 'overhead' = 수직 내려찍기: 몸 정면 세로면(위쪽을 바깥으로 overheadPlaneOutDeg 기울임)에서
   * 머리 위 뒤(overheadWindupDeg) → 앞 아래(overheadStrikeDeg)로 손잡이를 돌린다 (각도 = 정면 수평 0, 위 90, 뒤 위 >90).
   * windup/strike pitch·yaw는 쓰지 않음. 없으면 기존 pitch/yaw 보간 휘두르기
   */
  style?: 'arc' | 'overhead';
  overheadWindupDeg?: number;
  overheadStrikeDeg?: number;
  overheadPlaneOutDeg?: number;
  /** 내려찍은 뒤 관성으로 더 내려가는 각도(도)와 그 끝 진행도. 그 뒤 평소 자세로 복귀 */
  overheadFollowDeg?: number;
  overheadFollowAt?: number;
  /** 내려찍을 때 손이 망치보다 먼저 도착하는 정도 (진행도). 클수록 망치가 늦게 따라와 휘는 느낌, 손목 꺾임 증가 */
  handLead?: number;
  /**
   * 상체가 먼저 움직이는 연출 (도, 몸 기준): 들어 올릴 때 오른쪽으로 비틀고 살짝 젖힘 → 내려찍을 때 왼쪽으로 돌며 앞으로 숙임 → 0.
   * 척추 40%·가슴 60%로 나눠 적용. 없으면 상체 연출 없음
   */
  torso?: { windupYawDeg: number; windupPitchDeg: number; strikeYawDeg: number; strikePitchDeg: number };
}

export const RIFLE_MOUNT: WeaponMount = {
  // GLB 검증: 원본은 총구가 -Z(개머리판이 +Z) → Y 180° 보정
  modelFixDeg: [0, 180, 0],
  scale: 0.62,
  // 권총 손잡이 뒤쪽(손목) — 실측: 손잡이 중심 ≈ (0, -0.09, -0.15)
  rightGrip: [-0.05, -0.06, -0.2],
  // 2등신 팔 길이(0.19m) 한계로 총열 아래는 닿지 않아 탄창 앞을 받친다 (총을 오른쪽 옆구리에 들어 왼손이 멀어진 만큼 탄창 쪽으로)
  supportGrip: [0.07, -0.08, -0.08],
  // 총구 = 앞 끝 주황 원통 단면 중심 (2026-10-20 장면 실측: 원통 지름 약 0.126, 중심 x −0.055·y 0.039. 이전 [0, 0.02]은 단면 가장자리로 약 4cm 어긋남)
  muzzle: [-0.055, 0.039, 0.5],
  rightFingerDir: [0, -0.45, 0.9],
  rightPalmDir: [1, 0, 0.2],
  leftFingerDir: [-0.5, 0.3, 0.8],
  leftPalmDir: [-0.3, 1, 0],
  // 오른쪽 옆구리 높이에 든다 (2026-10-22). 예전 [0.08, -0.05, 0.15]는 총이 가슴 한가운데라 개머리판(손 뒤 약 23cm)이 몸통을 뚫고
  // 뒤 카메라에서 총이 거의 안 보였음 (6종 측정: 무기 정점 9~31%가 몸통 안, TPS 화면 가시 0~23%) — 2등신 몸통이 개머리판보다 두꺼움
  holdOffset: [0.2, -0.12, 0.17],
  // 탄창 실측: 중심 z ≈ 0.1, 아래끝 y ≈ -0.21 (정렬 공간).
  // 팔이 짧아 탄창 아래끝까지는 닿지 않아(오차 17cm) 탄창 윗부분(삽입구)을 잡는다 (오차 약 8cm)
  reload: {
    rollDeg: 22,
    pitchDownDeg: 14,
    pull: 0.02,
    drop: 0.04,
    magazineGrip: [0.07, -0.11, 0.05],
    magazineFingerDir: [-0.2, -0.4, 0.9],
    magazinePalmDir: [-1, 0, 0],
    // 옆구리 자세 → 예전 가슴 앞 자세 쪽으로 (왼손이 탄창에 닿게)
    holdShift: [-0.12, 0.07, -0.02],
  },
  ikEnabled: true,
  leftHandIk: true,
  shoulderAssist: 0.5,
  armStretchMax: 1.3,
};

export const RIFLE: WeaponDef = {
  id: 'rifle',
  name: 'POP 라이플',
  moveSpeedMultiplier: 1,
  kind: 'gun',
  slot: 'primary',
  damage: 12,
  magazineSize: 30,
  reserveAmmo: 120,
  rpm: 600,
  headshotMultiplier: 1.5,
  automatic: true,
  pellets: 1,
  range: 150,
  reloadTime: 1.8,
  spread: {
    baseDeg: 1.4,
    movingAddDeg: 1.1,
    airAddDeg: 4.5,
    slideAddDeg: 3.0,
    bloomPerShotDeg: 0.32,
    bloomMaxDeg: 2.8,
    bloomRecoveryDegPerSec: 7,
  },
  recoil: {
    pitchDeg: 0.85,
    yawJitterDeg: 0.35,
    recoveryRatio: 0.55,
    recoverySharpness: 7,
    visualKick: 0.05,
  },
  aim: {
    style: 'shoulder',
    // 약 1.4배 (FOV 70° → 약 53°)
    magnification: 1.4,
    // ADS 중에는 로컬 캐릭터·무기를 숨기므로 카메라를 캐릭터 뒤 거의 중앙(머리 높이)으로 → 좌우 엄폐 시야 차이 감소.
    // 오른쪽 0.1m는 총구(몸 오른쪽 앞)와의 시차를 줄이기 위함
    cameraDistance: 0.8,
    shoulderOffset: 0.1,
    heightOffset: -0.12,
    transitionTime: 0.2,
    moveSpeedMultiplier: 0.55,
    spreadMultiplier: 0.2,
    recoilMultiplier: 0.6,
    lookSensitivityMultiplier: 0.75,
    keepAimWhileReloading: false,
    kickScale: 0.4,
    overlayFrom: 0.82,
  },
  effects: { flashScale: 1, firePitch: 1, fireGain: 1 },
  crosshair: { style: 'cross', lineLength: 11, lineWidth: 3.5, dotSize: 4.5, minGap: 4 },
  model: { glb: ASSETS.rifle, placeholder: null },
  mount: RIFLE_MOUNT,
};

/** 새 무기 공통 재장전 자세 기본값 (무기별로 탄창 위치만 덮어씀) */
const PLACEHOLDER_RELOAD: WeaponMount['reload'] = {
  rollDeg: 22,
  pitchDownDeg: 14,
  pull: 0.02,
  drop: 0.04,
  magazineGrip: [0.07, -0.11, 0.05],
  magazineFingerDir: [-0.2, -0.4, 0.9],
  magazinePalmDir: [-1, 0, 0],
};

/**
 * 샷건 GLB (pop_battle_shotgun.glb, 길이 1.0 정규화, 총구 -Z → 라이플과 같은 Y 180° 보정).
 * 정점 실측(정렬 공간): 손잡이 중심 z -0.195 y -0.133, 총구 끝 z 0.5 (위 총열 y 0.03~0.11, 아래 탄창관 y -0.045~0.03).
 * 그립은 라이플과 같은 손잡이 중심 대비 오프셋(+0.085 y, -0.044 z). 라이플(0.62)보다 짧게 0.56
 */
export const SHOTGUN_MOUNT: WeaponMount = {
  modelFixDeg: [0, 180, 0],
  scale: 0.56,
  rightGrip: [-0.05, -0.048, -0.239],
  // 펌프(파란 손잡이) 뒤 끝. 팔이 짧아 총을 오른쪽 옆구리에 들면 펌프 가운데까지는 안 닿음
  supportGrip: [0.07, -0.07, -0.01],
  // 위 총열 중심
  muzzle: [-0.01, 0.06, 0.5],
  rightFingerDir: [0, -0.45, 0.9],
  rightPalmDir: [1, 0, 0.2],
  leftFingerDir: [-0.5, 0.3, 0.8],
  leftPalmDir: [-0.3, 1, 0],
  // 라이플과 같은 오른쪽 옆구리 자세 (개머리판이 몸통을 덜 뚫고 뒤 카메라에서 보이게)
  holdOffset: [0.2, -0.12, 0.12],
  // 탄창관 아래 장전구 쪽
  reload: { ...PLACEHOLDER_RELOAD, magazineGrip: [0.06, -0.1, -0.02], holdShift: [-0.16, 0.08, -0.02] },
  ikEnabled: true,
  leftHandIk: true,
  shoulderAssist: 0.5,
  armStretchMax: 1.3,
};

/**
 * 스나이퍼 GLB (pop_battle_sniper.glb, 길이 1.0 정규화, 총구 -Z → Y 180° 보정).
 * 정점 실측(정렬 공간): 손잡이 중심 z -0.212 y -0.131, 총구(머즐 브레이크) 중심 (-0.005, 0.001, 0.5). 라이플보다 길게 0.72
 */
export const SNIPER_MOUNT: WeaponMount = {
  modelFixDeg: [0, 180, 0],
  scale: 0.72,
  rightGrip: [-0.05, -0.046, -0.256],
  // 손잡이 앞 아래 (옆구리 자세에서 왼손이 닿는 곳)
  supportGrip: [0.06, -0.08, -0.12],
  muzzle: [-0.005, 0.001, 0.5],
  rightFingerDir: [0, -0.45, 0.9],
  rightPalmDir: [1, 0, 0.2],
  leftFingerDir: [-0.5, 0.3, 0.8],
  leftPalmDir: [-0.3, 1, 0],
  // 라이플과 같은 오른쪽 옆구리 자세 (개머리판이 몸통을 덜 뚫고 뒤 카메라에서 보이게)
  holdOffset: [0.2, -0.12, 0.12],
  reload: { ...PLACEHOLDER_RELOAD, magazineGrip: [0.06, -0.12, -0.1], holdShift: [-0.16, 0.08, -0.02] },
  bolt: { rollDeg: 14, pitchDownDeg: 8, pull: 0.03 },
  ikEnabled: true,
  leftHandIk: true,
  shoulderAssist: 0.5,
  armStretchMax: 1.3,
};

/**
 * 권총 GLB (pop_battle_pistol.glb, 길이 1.0 정규화, 총구 -Z → Y 180° 보정).
 * 정점 실측(정렬 공간): 손잡이 중심 z -0.372 y -0.212 (바닥 y -0.307), 총구 중심 (-0.016, 0.16, 0.5)
 */
export const PISTOL_MOUNT: WeaponMount = {
  modelFixDeg: [0, 180, 0],
  // 길이 약 0.35m (장난감 손에 가려지지 않게 실제 권총보다 약간 크게)
  scale: 0.28,
  rightGrip: [-0.14, 0.03, -0.5],
  // 왼손은 오른손 아래·앞을 감싸 받침
  supportGrip: [0.14, -0.15, -0.3],
  muzzle: [-0.016, 0.16, 0.5],
  rightFingerDir: [0, -0.6, 0.8],
  rightPalmDir: [1, 0, 0.1],
  leftFingerDir: [-0.6, 0.2, 0.8],
  leftPalmDir: [-0.4, 1, 0],
  // 몸 오른쪽 앞 (예전 [0.06, -0.02, 0.2]는 몸 가운데라 뒤 카메라에서 가려짐)
  holdOffset: [0.14, -0.06, 0.2],
  // ADS(오버숄더): 한 손으로 오른팔을 오른쪽·앞으로 뻗어 권총이 큰 머리 오른쪽 아래에 보이게
  // (양손이면 팔이 짧아 이 위치까지 못 닿음: 왼손 IK 오차 12cm+)
  adsHoldOffset: [0.3, 0.06, 0.18],
  adsOneHanded: true,
  // 탄창은 손잡이 아래
  reload: { ...PLACEHOLDER_RELOAD, rollDeg: 18, pitchDownDeg: 20, magazineGrip: [0.1, -0.33, -0.36], holdShift: [-0.08, 0.04, 0] },
  ikEnabled: true,
  leftHandIk: true,
  shoulderAssist: 0.5,
  armStretchMax: 1.3,
};

/**
 * 뿅망치 GLB (pop_battle_melee.glb, 길이 1.0 정규화, 머리가 +Z 끝 → 보정 없음).
 * 정점 실측: 머리 z 0.15~0.45 (폭 0.35, 높이 0.5, 세로 원기둥), 손잡이 z -0.4~0.1 (굵기 0.12, 중심 y -0.05), 꼭지 z -0.5
 */
export const MELEE_MOUNT: WeaponMount = {
  modelFixDeg: [0, 0, 0],
  // 전체 길이 약 0.48m, 손잡이 쥔 곳 → 머리 중심 약 0.25m (2026-10-20 사용자 요청으로 0.33 → 0.38).
  // 팔이 짧아(위팔+아래팔 약 0.19m) 더 키우면 머리가 얼굴에 겹쳐 회피 보정이 커짐
  scale: 0.38,
  // 손잡이 중간보다 아래(z -0.22, 손잡이 중심 y -0.05)를 쥠: 손목 = 쥔 점 − 손바닥 방향 × (손잡이 반지름+손바닥 두께) − 손가락 방향 × 손 길이 절반
  rightGrip: [0.008, -0.147, -0.22],
  supportGrip: [0, 0, 0],
  muzzle: [0, 0, 0.45],
  // 손가락은 손잡이(+Z)에 수직, 평소 자세의 실제 IK 아래팔 방향과 일치 (손목 꺾임 약 23°). 손바닥 = 손잡이 축 × 손가락 (엄지가 망치 머리 쪽).
  // 게임 화면에서 아래팔 방향을 측정해 맞춤 (2026-10-21, 이전 값은 손목이 약 68° 꺾였음)
  rightFingerDir: [0.934, -0.358, 0],
  rightPalmDir: [0.358, 0.934, 0],
  leftFingerDir: [-0.5, 0.3, 0.8],
  leftPalmDir: [-0.3, 1, 0],
  // 오른손 위치: 가슴 본 기준 오른쪽 0.24, 아래 0.20, 앞 0.12 m × 몸 크기 (오른쪽 허리 앞 → 팔꿈치 약 110° 굽힘, 아래팔이 앞으로).
  // 이전 값(가슴 높이 0.27, -0.04, 0.07)은 짧은 팔(위팔 약 0.18·아래팔 약 0.07m)을 40°까지 접고 망치 머리가 얼굴 옆에 붙었음 (2026-10-21 화면 확인)
  holdOffset: [0.24, -0.2, 0.12],
  // 팔꿈치를 아래·뒤로 (약간 바깥): 팔이 몸통 옆으로 내려오고 아래팔이 앞으로 나옴
  rightElbowPole: [0.5, -1, -0.6],
  reload: PLACEHOLDER_RELOAD,
  ikEnabled: true,
  // 한 손 무기: 왼팔은 이동 애니메이션 그대로
  leftHandIk: false,
  shoulderAssist: 0.5,
  armStretchMax: 1.3,
  swing: {
    // 평소(한 손 대기 자세): 허리 옆 손에서 손잡이를 위로 45°·몸 바깥(조준 기준 오른쪽 85°)으로 세움.
    // (65°는 달릴 때 몸이 앞으로 숙으며 망치 머리가 턱 앞에 왔음)
    // 망치 머리는 몸 오른쪽 바깥, 가슴 높이 (얼굴에서 떨어져 회피 보정이 거의 안 걸림, TPS 카메라에서 보임)
    restPitchDeg: 45,
    restYawDeg: 85,
    // 공격: 수직 내려찍기 (2026-10-20 사용자 요청). 머리 위 뒤로 들어 올림 → 정면 아래로 내려찍음 → 복귀.
    // 판정 시점(hitTime 0.17s / 0.45s ≈ 0.38)에 맞춰 strikeAt. 큰 머리·모자를 피해 세로면 위쪽을 바깥으로 35° 기울임
    // (20°면 들어 올릴 때 망치가 모자에 묻힘). 들어 올림 115° = 수직에서 25° 뒤, 내려찍기 30° = 낮은 손에서 정면 위쪽 (상대 몸통 높이, 2026-10-21: −20°는 아래팔과 손잡이가 같은 쪽으로 누워 손목이 100° 넘게 꺾였음)
    style: 'overhead',
    overheadWindupDeg: 115,
    overheadStrikeDeg: 30,
    overheadPlaneOutDeg: 35,
    // 찍은 뒤 8° 더 내려가며 멈춤(0.5) → 평소 자세로 복귀 (무게감)
    overheadFollowDeg: 8,
    overheadFollowAt: 0.5,
    // 상체: 들어 올림 오른쪽 14°·뒤로 6° → 내려찍기 왼쪽 12°·앞으로 10° (SD 캐릭터라 작게). 팔보다 조금 먼저 움직임
    torso: { windupYawDeg: 14, windupPitchDeg: -6, strikeYawDeg: -12, strikePitchDeg: 10 },
    windupPitchDeg: 85,
    windupYawDeg: 95,
    windupLift: [0.04, 0.32, -0.02],
    // 손잡이 축 손목 돌림: 들어 올릴 때 −20°, 내려찍을 때 −90° (2026-10-21 화면·수치 확인: 손목 꺾임 들어 올림 약 10°, 내려찍기 약 27°, 관성 약 35°)
    swingRollDeg: -20,
    strikeRollDeg: -90,
    handLead: 0,
    strikePitchDeg: 20,
    strikeYawDeg: -20,
    // 평소 손이 허리 높이라 내려찍을 때 손은 조금만 내림 (−0.14면 팔이 다 펴지고도 4cm 모자랐음)
    strikeOffset: [-0.04, -0.1, 0.08],
    windupAt: 0.22,
    strikeAt: 0.38,
    strikeReach: 0.12,
    // 손이 (쇄골+팔) 길이의 97% 밖이면 쇄골 쪽으로 당김 (팔이 다 펴지거나 늘어나지 않게 하는 안전장치).
    // 팔이 짧은 RED·BLACK·WHITE·PINK는 당기지 않으면 1.0~1.1까지 가서 팔이 늘어나고 내려칠 때 손이 8~13cm 못 미쳤음.
    // 평소 자세의 팔꿈치 굽힘은 캐릭터별 장착 보정(characters.ts weaponFit.melee)으로 맞춤
    // 내려칠 때는 1.02 (블루처럼 쇄골이 짧은 캐릭터도 팔을 거의 다 뻗음, 1.03부터 WHITE 손이 손잡이에서 0.5cm 떨어짐)
    maxArmReach: [0.97, 1.02],
    // 들어 올릴 때 손이 쇄골 쪽으로 너무 붙지 않게 (RED: 아래팔 6cm라 팔꿈치 22°·손목 82°까지 접혔음 → 80° 이상)
    minArmReach: 0.8,
    // 망치 머리 (실측 z 0.15~0.45, 폭 0.35·높이 0.5): 캐릭터 머리와 겹치면 바깥으로 기울임
    headPoint: [0, 0, 0.3],
    // 손잡이 중심 높이 (실측 손잡이 중심 y −0.05)
    gripCenterY: -0.05,
    headRadius: 0.25,
    // 착지 등 한 프레임에 머리가 빠르게 내려오는 순간을 흡수하는 여유
    headClearance: 0.035,
  },
};

const NO_RECOIL: RecoilProfile = { pitchDeg: 0, yawJitterDeg: 0, recoveryRatio: 0, recoverySharpness: 1, visualKick: 0 };
const NO_SPREAD: SpreadProfile = { baseDeg: 0, movingAddDeg: 0, airAddDeg: 0, slideAddDeg: 0, bloomPerShotDeg: 0, bloomMaxDeg: 0, bloomRecoveryDegPerSec: 1 };

export const SHOTGUN: WeaponDef = {
  id: 'shotgun',
  name: '팡팡 샷건',
  moveSpeedMultiplier: 1,
  kind: 'gun',
  slot: 'primary',
  // 펠릿당 15 × 8 = 120 (2026-10-20 근거리 화력 상향: 8 → 15). 0~3m에서 몸통 중앙 조준 시 7~8발 → 105~120으로 100HP 한 방
  damage: 15,
  magazineSize: 6,
  reserveAmmo: 30,
  rpm: 80,
  headshotMultiplier: 1.5,
  automatic: false,
  pellets: 8,
  range: 60,
  reloadTime: 2.2,
  // 펠릿 원뿔 반각 (도). 이력: 5.5° → 3.3°(이동 가산 0.8 → 0.5) → 2026-10-20 크로스헤어 작업: 기본 3.3° → 2.5° (−24%).
  // 이동·점프·슬라이딩 가산, ADS 배율(0.6)은 그대로. 10m에서 최대 반지름 약 0.44m, ADS 약 0.26m.
  // 분포는 hitscan.pelletInCone (중앙 1발 + 부채꼴 7발, 최대 반지름 = 반각) → 샷건 원형 조준선 반지름도 이 값
  spread: { baseDeg: 2.5, movingAddDeg: 0.5, airAddDeg: 3, slideAddDeg: 2, bloomPerShotDeg: 0, bloomMaxDeg: 0, bloomRecoveryDegPerSec: 10 },
  recoil: { pitchDeg: 4, yawJitterDeg: 1.2, recoveryRatio: 0.6, recoverySharpness: 6, visualKick: 0.12 },
  aim: {
    style: 'shoulder',
    magnification: 1.15,
    cameraDistance: 0.8,
    shoulderOffset: 0.1,
    heightOffset: -0.12,
    transitionTime: 0.18,
    moveSpeedMultiplier: 0.6,
    spreadMultiplier: 0.6,
    recoilMultiplier: 0.75,
    lookSensitivityMultiplier: 0.85,
    keepAimWhileReloading: false,
    kickScale: 0.4,
    overlayFrom: 0.82,
  },
  // 펠릿당: 0~3m 15 → 7m 7.5(50%) → 15m 3(20%), 그 뒤 3 유지
  falloff: { startDistance: 3, endDistance: 7, minMultiplier: 0.5, farDistance: 15, farMultiplier: 0.2 },
  effects: { flashScale: 1.5, firePitch: 0.7, fireGain: 1.15 },
  crosshair: { style: 'ring', lineLength: 0, lineWidth: 3, dotSize: 4.5, minGap: 6 },
  model: { glb: ASSETS.shotgun, placeholder: null },
  mount: SHOTGUN_MOUNT,
};

export const SNIPER: WeaponDef = {
  id: 'sniper',
  name: '뿅뿅 스나이퍼',
  moveSpeedMultiplier: 1,
  kind: 'gun',
  slot: 'primary',
  // 2026-10-23 플레이 테스트 하향 (너무 강함): 몸통 80 → 70 (모든 캐릭터 몸통 2발, 한 발 뒤 라이플 마무리는 1~2발 더),
  // 헤드샷 = 100 (사용자 결정, 배율 100/70): 한 방 처치는 HP 100인 BUBU만, 나머지는 헤드샷 + 1발
  damage: 70,
  magazineSize: 5,
  reserveAmmo: 20,
  // 45 → 40 (발사 간격 1.33 → 1.5초)
  rpm: 40,
  headshotMultiplier: 100 / 70,
  automatic: false,
  pellets: 1,
  range: 300,
  reloadTime: 2.6,
  // 비조준 사격은 부정확 (2026-10-23: 기본 3° → 4°, 이동 +2.5° → +3.5°), 스코프(ADS)에서 멈춰 서면 거의 0.
  // 스코프 중 이동·점프는 가산의 35%를 남김 (이동 1.2° ≈ 50m에서 반지름 1m → 뛰면서 저격은 운에 맡겨야 함)
  spread: { baseDeg: 4, movingAddDeg: 3.5, airAddDeg: 6, slideAddDeg: 4, bloomPerShotDeg: 0, bloomMaxDeg: 0, bloomRecoveryDegPerSec: 10, adsMovementKeep: 0.35 },
  recoil: { pitchDeg: 5, yawJitterDeg: 0.8, recoveryRatio: 0.5, recoverySharpness: 5, visualKick: 0.12 },
  aim: {
    style: 'scopeOverlay',
    // 스코프 배율 (FOV 70° → 약 20°)
    magnification: 4,
    cameraDistance: 0.8,
    shoulderOffset: 0.1,
    heightOffset: -0.12,
    transitionTime: 0.25,
    moveSpeedMultiplier: 0.45,
    spreadMultiplier: 0.02,
    recoilMultiplier: 0.6,
    lookSensitivityMultiplier: 0.3,
    keepAimWhileReloading: false,
    kickScale: 0.3,
    overlayFrom: 0.82,
    // 볼트액션: 쏘면 스코프가 풀리고, 후딜레이(볼트) 동안은 다시 조준해도 발사 불가
    releaseAfterShot: true,
  },
  // 발사 간격 60/40 = 1.5초 (후딜레이). 퀵스왑(쏘고 다른 무기로 바꿔 후딜레이 취소)은 유지, 그래도 최소 0.8초
  quickSwap: { minFireInterval: 0.8 },
  effects: { flashScale: 1.6, firePitch: 0.55, fireGain: 1.2 },
  // 비조준 상태 작은 십자 (ADS는 기존 스코프 화면, 조준선 숨김)
  crosshair: { style: 'cross', lineLength: 7, lineWidth: 3, dotSize: 3.5, minGap: 3 },
  model: { glb: ASSETS.sniper, placeholder: null },
  mount: SNIPER_MOUNT,
};

export const PISTOL: WeaponDef = {
  id: 'pistol',
  name: '뽁뽁 권총',
  moveSpeedMultiplier: 1.2,
  kind: 'gun',
  slot: 'secondary',
  // 2026-10-20 하향 20 → 15 (헤드샷 1.5배 = 22.5)
  damage: 15,
  magazineSize: 12,
  reserveAmmo: 48,
  rpm: 300,
  headshotMultiplier: 1.5,
  automatic: false,
  pellets: 1,
  range: 80,
  reloadTime: 1.4,
  spread: { baseDeg: 1.2, movingAddDeg: 0.8, airAddDeg: 3.5, slideAddDeg: 2.5, bloomPerShotDeg: 0.5, bloomMaxDeg: 2.5, bloomRecoveryDegPerSec: 6 },
  recoil: { pitchDeg: 1.6, yawJitterDeg: 0.5, recoveryRatio: 0.7, recoverySharpness: 8, visualKick: 0.04 },
  aim: {
    style: 'shoulder',
    // 라이플(1.4배 = FOV 53.1°)보다 약한 확대: 전용 FOV 60° (일반 70°, 라이플 ADS보다 약 7° 넓음)
    magnification: 1.2,
    fovDeg: 60,
    // 오버숄더: 캐릭터를 숨기지 않고 오른쪽 어깨 뒤에서 머리·어깨가 화면 왼쪽에 보이는 구도.
    // 일반 TPS(거리 2.6, 오른쪽 0.75, 높이 +0.05)보다 가깝게, 조준점이 머리에 가리지 않게 오른쪽은 유지
    hideBodyInAds: false,
    // 일반 전투 자세와 같은 비틀기 유지 → 총·손이 머리 오른쪽에 보임
    adsBodyYawDeg: 40,
    // 장면 측정으로 고른 값 (1280×720): 큰 머리가 화면 왼쪽, 한 손으로 뻗은 권총·손이 머리 오른쪽 아래에 보이고 조준점은 가리지 않음
    // (머리 윤곽에서 총구 45px, 조준점 153px 떨어짐). 높이 0 = 카메라가 발 위 약 1.0m → 0.8m 엄폐물 위로 지나가 충돌로 튀지 않음
    cameraDistance: 1.6,
    shoulderOffset: 0.8,
    heightOffset: 0,
    transitionTime: 0.15,
    moveSpeedMultiplier: 0.75,
    spreadMultiplier: 0.4,
    recoilMultiplier: 0.7,
    lookSensitivityMultiplier: 0.85,
    keepAimWhileReloading: false,
    kickScale: 0.5,
    overlayFrom: 0.82,
  },
  effects: { flashScale: 0.75, firePitch: 1.25, fireGain: 0.8 },
  crosshair: { style: 'cross', lineLength: 7, lineWidth: 3, dotSize: 4, minGap: 3 },
  model: { glb: ASSETS.pistol, placeholder: null },
  mount: PISTOL_MOUNT,
};

export const MELEE: WeaponDef = {
  id: 'melee',
  name: '뿅망치',
  moveSpeedMultiplier: 1.2,
  kind: 'melee',
  slot: 'melee',
  damage: 40,
  magazineSize: 0,
  reserveAmmo: 0,
  // 공격 간격 0.7초
  rpm: 60 / 0.7,
  // 근접은 헤드샷 배율 없음
  headshotMultiplier: 1,
  // 누르고 있으면 0.7초마다 반복
  automatic: true,
  pellets: 1,
  range: 1.6,
  reloadTime: 0,
  spread: NO_SPREAD,
  recoil: NO_RECOIL,
  aim: null,
  melee: { range: 1.6, halfAngleDeg: 55, swingDuration: 0.45, hitTime: 0.17 },
  effects: { flashScale: 0, firePitch: 1, fireGain: 1 },
  crosshair: { style: 'dot', lineLength: 0, lineWidth: 0, dotSize: 6, minGap: 0 },
  model: { glb: ASSETS.melee, placeholder: null },
  mount: MELEE_MOUNT,
};

/** 로드아웃에서 고를 수 있는 주무기 */
export const PRIMARY_WEAPONS: readonly WeaponDef[] = [RIFLE, SHOTGUN, SNIPER];
export const SECONDARY_WEAPON = PISTOL;
export const MELEE_WEAPON = MELEE;

export const WEAPONS: Record<string, WeaponDef> = Object.fromEntries(
  [RIFLE, SHOTGUN, SNIPER, PISTOL, MELEE].map((w) => [w.id, w]),
);

// 게임 전역 튜닝 값. 숫자를 코드 곳곳에 박지 않고 여기서 관리한다.
import { CHARACTERS, PLAYER_CHARACTER } from './characters';
// 단위: 거리 m, 시간 s, 각도는 이름에 Deg가 붙으면 도(degree), 아니면 라디안.

const base = import.meta.env.BASE_URL;

// 기본은 Blender 최적화 수정본 (tools/blender/optimize_glb.py). 비교용: ?rifle=original 이면 원본
const rifleVariant = new URLSearchParams(location.search).get('rifle') === 'original' ? '' : '_lod0';
// 샷건·스나이퍼도 같은 Blender 최적화본(_lod0)이 기본. 비교용: ?guns=original
const gunVariant = new URLSearchParams(location.search).get('guns') === 'original' ? '' : '_lod0';


export const ASSETS = {
  // 플레이어 캐릭터 GLB: ?char=blue|yellow|pink|red|black|white (6종 목록·팀 컬러는 config/characters.ts). 봇은 ?botchars= (기본 플레이어와 같음)
  character: CHARACTERS[PLAYER_CHARACTER].file,
  rifle: `${base}assets/models/weapon_toy_rifle${rifleVariant}.glb`,
  // Verse8 2D to 3D (Tripo) 생성본 (원본: art-src/glb-originals/static-3d-01a157c7…·01a157cd…, 파일명은 사용자 지정).
  // _lod0 = tools/blender/optimize_glb.py (7000 삼각형, Color·Normal 1024², ORM 512²). 축·원점·크기는 원본과 같아 장착값 공용
  shotgun: `${base}assets/models/pop_battle_shotgun${gunVariant}.glb`,
  sniper: `${base}assets/models/pop_battle_sniper${gunVariant}.glb`,
  // 권총·근접무기 (원본: static-3d-01a157ed… = 권총, 01a157f1… = 뿅망치)
  pistol: `${base}assets/models/pop_battle_pistol${gunVariant}.glb`,
  melee: `${base}assets/models/pop_battle_melee${gunVariant}.glb`,
} as const;

export const CHARACTER = {
  /** GLB 원본 높이는 1.0. 장난감 2등신 비율로 1.25m. */
  scale: 1.25,
  /** 모델 정면 보정(라디안). GLB는 +Z를 바라본다. */
  modelYawOffset: 0,
  /** 실제 GLB 클립 이름 (분석 결과). 없는 클립은 넣지 않는다. */
  clips: {
    idle: 'Idle_Loop_Rig',
    walk: 'Walk_Loop_Rig',
    run: 'Jog_Fwd_Loop_Rig',
    jumpStart: 'Jump_Start_Rig',
    air: 'Jump_Loop_Rig',
    land: 'Jump_Land_Rig',
    death: 'Death01_Rig',
  },
  /**
   * 손 보정 기준 (블루 실측, GLB 단위): Hand 본(손목) → 손 덩어리 중심까지 손가락 방향 거리.
   * 무기 장착값(그립·지지점)은 블루 기준이라, 다른 캐릭터는 바인드 포즈에서 같은 거리를 재서 차이만큼 손 본 목표를 옮긴다
   * (핑크·노랑·빨강은 Hand 본이 손 가운데에 있어 약 0.09 차이)
   */
  handCenterFromBone: { right: 0.089, left: 0.099 },
  /**
   * 블루 바인드 포즈(T포즈)의 손 본 로컬 축 실측: 팔 바깥 방향·아래 방향. 무기 손 방향(Y = 손가락, -Z = 손바닥)은 블루 기준이라
   * 다른 캐릭터는 자기 축과 이 값의 차이만큼 손 축을 돌린다 (블루는 그대로)
   */
  handBindAxes: {
    right: { outward: [-0.165, 0.982, -0.092], down: [-0.092, -0.108, -0.99] },
    left: { outward: [0.176, 0.98, -0.096], down: [0.096, -0.114, -0.989] },
  },
  /** 실제 GLB 본 이름 (분석 결과). 머리 본은 없다(머리·몸통 가중치 대부분이 Spine에 몰려 있음). */
  bones: {
    hips: 'Hips',
    spine: 'Spine',
    chest: 'Chest',
    shoulderR: 'Shoulder_R',
    upperArmR: 'UpperArm_R',
    lowerArmR: 'LowerArm_R',
    handR: 'Hand_R',
    upperLegL: 'UpperLeg_L',
    lowerLegL: 'LowerLeg_L',
    upperLegR: 'UpperLeg_R',
    lowerLegR: 'LowerLeg_R',
    shoulderL: 'Shoulder_L',
    upperArmL: 'UpperArm_L',
    lowerArmL: 'LowerArm_L',
    handL: 'Hand_L',
  },
  anim: {
    fade: 0.18,
    /** 이 속도(m/s)에서 걷기/조깅 클립 timeScale = 1 */
    walkRefSpeed: 2.2,
    runRefSpeed: 4.4,
    minTimeScale: 0.6,
    maxTimeScale: 1.7,
    jumpStartTimeScale: 1.8,
    /** Jump_Start 앞부분(웅크리기)을 건너뛰는 시작 시간 */
    jumpStartOffset: 0.35,
    jumpStartHold: 0.28,
    landTimeScale: 1.5,
    /**
     * 사망 클립(Death01) 재생 속도: 원본 2.38초 중 0~0.6초 휘청·주저앉음 → 0.6~0.96초 뒤로 넘어져 바닥, 이후 누운 자세 유지.
     * 1.37배 = 약 0.7초에 바닥 (짧고 경쾌하게). 판정·리스폰 시간과 무관한 연출 값
     */
    deathTimeScale: 1.37,
    /** 리스폰 등장: 쏙 튀어나오는 길이(s)·처음 크기·넘침 크기·튀어 오르는 높이(키 대비) */
    spawnPop: { time: 0.38, startScale: 0.55, overshoot: 1.1, hop: 0.22 },
    /** 스폰 보호 방울: 파스텔 색·나타남/사라짐 속도·은은한 맥동 */
    shield: { color: 0x9fe6ff, fade: 7, pulseHz: 1.6, alpha: 0.42 },
    landHold: 0.3,
    /** 낙하 시간이 이보다 길 때만 착지 클립 재생 */
    landMinAirTime: 0.28,
    /** 걷기↔조깅 크로스페이드 (s) */
    locomotionFade: 0.15,
    /**
     * 슬라이딩 절차 포즈 (전용 클립 없음). 각도는 몸 기준 오른쪽 축 회전.
     * 골반을 뒤로 젖히고 두 다리를 앞으로 뻗는다(발바닥이 진행 방향). 높이는 접지 보정이 맞춘다.
     */
    slide: {
      hipsLeanBackDeg: 60,
      spineForwardDeg: 25,
      /** 몸 기준 방향 (오른쪽, 위, 앞) */
      leadThighDir: [-0.12, -0.05, 1] as const,
      leadShinDir: [-0.05, 0, 1] as const,
      /** 발끝 방향: 정강이 비틀림 고정 (발 본이 없어 신발이 정강이 회전을 그대로 따름) */
      leadToeDir: [-0.15, 1, 0] as const,
      // 오른다리도 앞다리와 같은 자세 (좌우 대칭: 오른쪽 성분만 부호 반대)
      trailThighDir: [0.12, -0.05, 1] as const,
      trailShinDir: [0.05, 0, 1] as const,
      trailToeDir: [0.15, 1, 0] as const,
      blendIn: 16,
      blendOut: 7,
    },
    /** 접지 보정: 스킨 정점 최저점을 지면에 맞춤 (클립마다 발 높이가 달라 뜨거나 파묻힘) */
    grounding: {
      enabled: true,
      /** 정점 샘플 간격 (1 = 전부) */
      sampleStride: 2,
      maxOffset: 0.35,
      raiseSharpness: 70,
      lowerSharpness: 50,
    },
    /**
     * 전투(조준·사격) 중 몸을 조준 방향보다 오른쪽으로 돌리는 각도.
     * 머리가 커서 정면 자세면 뒤 카메라에서 총이 가려진다 (콘셉트 이미지의 비스듬한 사격 자세).
     */
    combatYawOffsetDeg: 40,
    /** 조준 중 옆/뒤 이동 시 골반만 이동 방향으로 비틀기 */
    hipTwistMaxDeg: 65,
    /**
     * 제자리 회전 (전용 클립 없음 → 골반 비틀기 + 걷기 클립 발걸음). 로컬 플레이어만.
     * 몸(루트)은 마우스 방향을 바로 따라가고, 서 있을 때 다리는 제자리에 남아 골반만 비틀림 →
     * 비틀림이 startDeg를 넘으면 다리가 걷기 클립으로 발을 떼며 몸 방향으로 따라옴 (doneDeg 이하가 되면 멈춤).
     */
    turnInPlace: {
      startDeg: 45,
      /** 다리가 이보다 더 뒤처지지 않음 (빠르게 180° 돌면 이 각도를 넘는 부분은 다리도 같이 돎) */
      maxDeg: 75,
      doneDeg: 4,
      /** 다리 따라오기 속도 (지수 감쇠 계수) */
      catchUpSharpness: 9,
      /** 발걸음에 쓰는 걷기 클립 재생 속도 */
      stepTimeScale: 1.1,
    },
    /** 상체 피치 분배 (Spine, Chest) */
    spinePitchShare: 0.25,
    chestPitchShare: 0.3,
  },
} as const;

export const MOVEMENT = {
  capsuleRadius: 0.3,
  /** 캡슐 원통부 절반 높이. 전체 높이 = 2*(halfHeight+radius) = 1.24 */
  capsuleHalfHeight: 0.32,
  walkSpeed: 3.4,
  sprintSpeed: 5.8,
  /**
   * 달리기 시작 조작 (속도·물리와 무관, 입력만):
   * - PC: W를 뗀 뒤 doubleTapWindow 안에 다시 누르면 달리기, W를 누르고 있는 동안 유지 (A·S·D 더블 탭은 무시)
   * - 모바일: 조이스틱을 전방(카메라 기준) ±enterAngleDeg 안, 세기 enterStrength 이상으로 holdTime 유지하면 달리기.
   *   달리는 중에는 exitAngleDeg·exitStrength까지 유지 (조금 흔들려도 걷기·달리기가 반복 전환되지 않게)
   */
  sprintInput: {
    doubleTapWindow: 0.3,
    joystick: { holdTime: 0.5, enterStrength: 0.85, enterAngleDeg: 30, exitStrength: 0.7, exitAngleDeg: 42 },
  },
  groundAccel: 32,
  groundDecel: 26,
  airAccel: 9,
  /** 공중 수평 속도 상한 (슬라이드 점프 포함, 무한 가속 방지) */
  airMaxSpeed: 7.2,
  airDrag: 1.2,
  gravity: 24,
  jumpSpeed: 7.4,
  maxFallSpeed: 30,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  turnSharpness: 14,
  /** 몸(루트)이 마우스 수평 조준 방향을 따라가는 속도 (지수 감쇠 계수, 클수록 즉각). 22 → 0.1초에 약 89% */
  aimTurnSharpness: 22,
  maxSlopeDeg: 46,
  autostepHeight: 0.28,
  snapToGround: 0.25,
  slide: {
    boost: 2.4,
    minSpeed: 6.2,
    maxSpeed: 8.4,
    friction: 7.5,
    duration: 0.8,
    endSpeed: 2.6,
    /** 슬라이딩 종료 후 다시 시작할 수 있을 때까지 (s) */
    cooldown: 0.1,
    steerRate: 2.2,
    /** 슬라이드 중 점프 시 유지되는 수평 속도 비율 */
    jumpCarry: 0.82,
    /** 슬라이드 중 캡슐 원통부 절반 높이. 전체 높이 = 2*(0.04+0.3) = 0.68 */
    capsuleHalfHeight: 0.04,
    /** 장애물 아래라 일어설 수 없을 때 유지하는 최소 속도 */
    underObstacleSpeed: 2.4,
  },
  respawnDelay: 2.5,
  killPlaneY: -20,
  spawn: { x: 0, y: 1.2, z: -6 },
} as const;

export const CAMERA = {
  fov: 70,
  sprintFovAdd: 4,
  near: 0.05,
  far: 400,
  pivotHeight: 0.98,
  /** 오른쪽 어깨 뒤 고정 (어깨 전환 없음) */
  shoulderOffset: 0.75,
  heightOffset: 0.05,
  distance: 2.6,
  minPitchDeg: -70,
  maxPitchDeg: 65,
  sensitivity: 0.0022,
  collisionRadius: 0.2,
  /** 충돌로 당겨진 거리 복귀 속도 */
  pushOutSharpness: 6,
  pivotSharpness: 22,
  slideDrop: 0.35,
  /** 로컬 플레이어 가림 처리 (최종 카메라 위치 ↔ 메시 경계 상자 거리, m) */
  occlusion: {
    /** ADS 중 로컬 캐릭터 몸 전체를 그리지 않음 (무기는 계속 표시) */
    hideBodyInAds: true,
    /** 몸: hide보다 가까우면 숨김, 숨긴 뒤 reveal 이상 멀어져야 다시 표시 시작, full 이상이면 완전히 불투명 */
    body: { hide: 0.15, reveal: 0.3, full: 0.6 },
    weapon: { hide: 0.04, reveal: 0.08, full: 0.2 },
    /** 다시 나타날 때의 페이드 속도 (숨길 때는 즉시) */
    revealSharpness: 10,
  },

} as const;

/**
 * 모바일(터치 모드) 일반 시점 값. ADS는 무기별 설정(배율·거리·어깨) 그대로 — FOV는 이 일반 FOV에 배율을 적용해
 * '일반 대비 확대 비율'이 PC와 같음 (PC 카메라 CAMERA는 그대로).
 * 작은 가로 화면(667×375)은 같은 FOV에서도 적이 몇 px밖에 안 됨 → FOV를 조금 좁혀 중거리 적을 키우고,
 * 그만큼 커지는 내 캐릭터는 카메라를 조금 뒤·오른쪽·위로 옮겨 조준선과 화면 가운데를 덜 가리게
 */
export const CAMERA_MOBILE = {
  fov: 58,
  distance: 3.3,
  shoulderOffset: 1.1,
  heightOffset: 0.2,
} as const;

export const RENDER = {
  maxPixelRatio: 2,
  shadowMapSize: 2048,
  shadowExtent: 18,
  fixedStep: 1 / 60,
  maxSubSteps: 5,
} as const;

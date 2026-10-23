// 플레이 가능한 캐릭터 6종 (최종, 2026-10-21): 외형(GLB·팀 마스크), 능력치(체력·이동 속도·판정 크기), 키, 캐릭터별 무기 장착 보정.
// 제외된 옛 RED(v2 재생성본, id red_v2)·CHARACTER 7은 RETIRED_CHARACTERS에 데이터·GLB를 그대로 보존 (추후 스킨 후보, 게임·봇·디버그 목록에는 없음).
// 지금 RED(id red)는 옛 character_6 (2026-10-21 이름 변경, GLB character_6.glb 그대로).
// 외형 = characterId(원래 디자인) × teamId(팀 색). 팀은 원래 색과 무관하게 배정한다 (BLUE 캐릭터도 RED 팀 가능).
// 팀 색은 외형만 바꾸고 능력치에는 영향 없음.
// 멀티플레이: 외형은 (characterId, teamId)만으로 결정 → 팀이 바뀔 때 이 두 값만 동기화하면 된다 (색은 각 클라이언트가 이 설정으로 계산).

const base = import.meta.env.BASE_URL;

/** 플레이 가능한 캐릭터 id (GLB 파일 이름과는 별개) */
export type CharacterId = 'blue' | 'white' | 'yellow' | 'red' | 'pink' | 'black';
/** 제외(보존)된 캐릭터 id: 선택·봇·디버그 후보 아님 */
export type RetiredCharacterId = 'red_v2' | 'c7';
export type TeamId = 'BLUE' | 'RED' | 'NONE';
export type GameModeId = 'FFA' | 'TDM';

/** 캐릭터 능력치. 무기 밸런스(데미지·연사·탄창·재장전·반동·명중률·헤드샷 배율)와는 무관 */
export interface CharacterStats {
  /** 최대 체력 (리스폰하면 이 값으로 회복) */
  maxHp: number;
  /**
   * 이동 속도 배율. 걷기·달리기·슬라이딩·공중 속도 상한의 기본값에 한 번만 곱한다
   * (ADS 감속·무기별 이동속도 같은 상대 배율은 그 위에 그대로 곱해짐)
   */
  speed: number;
  /**
   * 목표 판정 크기 (YELLOW = 1). 판정 영역은 모델 실측(머리 정점·몸통 정점)으로 만들고,
   * 이 값은 키 배율(body.height)을 정할 때의 목표치 → 디버그 패널에서 실측 판정 크기와 비교
   */
  hitSize: number;
}

/** 몸 크기·체형 */
export interface CharacterBody {
  /**
   * 키 배율 (YELLOW 1.0 = 1.25m). GLB 바인드 포즈 전체 높이로 먼저 정규화한 뒤 곱한다
   * → 원본 GLB 높이가 달라도 같은 값이면 같은 키. 판정 크기 실측이 stats.hitSize에 맞도록 정한 값
   */
  height: number;
  /**
   * 체형 설명 (디버그 표시). 실제 체형은 Blender에서 메시·레스트 본을 직접 바꿈:
   * tools/blender/shape_character.py + art-src/characters/shape/<id>.json (몸통 폭·배·팔다리 두께·길이·손발 크기)
   */
  shape: string;
}

/**
 * 캐릭터별 무기 장착 보정 (공통 장착값 WeaponMount 위에 더함). 모두 선택, 없으면 0.
 * 위치는 몸 기준 (오른쪽, 위, 앞) m, 총구는 무기 정렬 공간(GLB 단위, +Z = 총구 방향).
 */
export interface WeaponFit {
  /** 오른손 그립(무기 전체) 위치 보정 */
  weaponPositionOffset?: [number, number, number];
  /** 재장전 중에만 더하는 무기 위치 보정 (재장전 진행 가중치만큼). 팔이 짧으면 탄창 쪽 왼손이 닿게 무기를 몸 가운데로 */
  reloadPositionOffset?: [number, number, number];
  /**
   * 시각용 반동 밀림·볼트 당김 배율 (기본 1). 총이 뒤로 밀려 몸을 뚫는 작은 캐릭터만 줄임.
   * 화면의 총 모델 이동만 바뀜 — 실제 반동·카메라 반동·명중률·발사 속도와 무관
   */
  recoilPullScale?: number;
  /** 무기 회전 보정 (도, 무기 정렬 공간 X·Y·Z) */
  weaponRotationOffset?: [number, number, number];
  /** 무기 크기 배율 (기본 1, 꼭 필요할 때만. 캐릭터 키와 무관하게 무기는 항상 같은 크기) */
  weaponScale?: number;
  /** 왼손 IK 목표 보정 */
  leftHandIKOffset?: [number, number, number];
  /**
   * 왼손 지지점 보정 (무기 정렬 공간, GLB 단위, +Z = 총구 방향). 총과 함께 돌아서 몸을 비틀어도 손이 총 위에 있음.
   * 팔이 짧은 캐릭터는 -Z(탄창 쪽)로 당겨 잡음 (leftHandIKOffset은 몸 기준이라 전투 자세에서 손이 총에서 떨어짐)
   */
  supportGripOffset?: [number, number, number];
  /** 오른손 IK 목표 보정 (무기는 그대로, 손만) */
  rightHandIKOffset?: [number, number, number];
  /** 총구 위치 보정 (발사 위치·총구 화염) */
  muzzleOffset?: [number, number, number];
}

export interface CharacterDef<Id extends string = CharacterId> {
  readonly id: Id;
  readonly name: string;
  /** 게임용 GLB (public/assets/models) */
  readonly file: string;
  /**
   * 팀 컬러 마스크 (R = 비니, G = 상의 주요 색). tools/blender/team_mask.py로 만든 1024² PNG, 모델 UV 기준.
   * 피부·눈·머리카락·하의·신발·별/꽃/지퍼 같은 작은 장식은 0 → 원래 색 유지
   */
  readonly teamMask: string;
  /** 마스크 영역의 기준 밝기 (선형 휘도 중앙값, 비니·상의). 팀 색에 원래 명암(주름·그늘)을 이 비율로 입힌다 */
  readonly refLuminance: readonly [beanie: number, top: number];
  /**
   * 사망 표정(X X 눈) 데이터 경로 (확장자 없음): <경로>.png = 눈동자 영역 아틀라스(RGBA), <경로>.json = 원본 UV 사각형 ↔ 아틀라스 사각형.
   * tools/blender/dead_eyes.py로 만듦 (흰자는 그대로, 검은 눈동자 자리만 주변 흰자색으로 메우고 흰자 가운데에 X — 눈동자 지름의 85%)
   */
  readonly deadEyes: string;
  readonly stats: CharacterStats;
  readonly body: CharacterBody;
  /** 캐릭터별 무기 장착 보정: all = 모든 무기, 무기 id = 그 무기만 (all 위에 더함) */
  readonly weaponFit: { readonly all?: WeaponFit } & Readonly<Partial<Record<string, WeaponFit>>>;
}

const def = <Id extends string>(
  id: Id,
  name: string,
  file: string,
  luminance: [number, number],
  stats: CharacterStats,
  body: CharacterBody,
  weaponFit: CharacterDef['weaponFit'] = {},
): CharacterDef<Id> => ({
  id,
  name,
  file: `${base}assets/models/${file}`,
  teamMask: `${base}assets/models/team-masks/${id}_team_mask.png`,
  deadEyes: `${base}assets/models/dead-eyes/${id}_dead_eyes`,
  refLuminance: luminance,
  stats,
  body,
  weaponFit,
});

/**
 * 최종 6종 (표시 순서 = 이 순서). 기준 밝기 값은 art-src/characters/teamcolor/out/<마스크 이름>_team_mask.json, 체형은 art-src/characters/shape/<id>.json.
 * GLB 이력: art-src/characters/REPORT.md (WHITE·BLACK·CHARACTER 6 클립 리타깃·얼굴 가중치, WHITE 팔 비율, 체형)
 * red = 빨간 비니(방울)·빨간 후드·반장갑·갈색 머리 캐릭터 (옛 id character_6, 원본·게임 GLB 파일명 character_6.glb 그대로).
 *   제외된 옛 RED(character-red-adjusted.glb)는 red_v2로 보존. 저장값 'character_6'은 red로 읽음 (ID_ALIASES)
 * BLACK·WHITE는 기획상 상위 해금 캐릭터 → 해금 시스템은 아직 없음 (조건을 임의로 추가하지 않음)
 */
export const CHARACTERS: Record<CharacterId, CharacterDef> = {
  blue: def('blue', 'BUBU', 'character_blue_beanie.glb', [0.22343, 0.14033],
    { maxHp: 100, speed: 1.1, hitSize: 0.85 },
    { height: 0.834, shape: '초소형 스피드형: 가장 작은 키·좁은 어깨·작은 몸통·가는 팔다리' },
    // 장착 보정은 런타임 실측으로 정함 (2026-10-22, docs/ASSET_AUDIT.md "무기 옆구리 자세"): 공통 옆구리 자세 위에서
    // 무기 정점의 몸통 안 개수 최소 + 왼손 미도달 1cm 이하 + 뒤 카메라에서 보이는 비율, 대기·전투(몸 40° 비틂) 둘 다
    // 팔은 모델에서 1.55배 (art-src/characters/shape/blue.json)
    {
      rifle: { weaponPositionOffset: [0.04, 0, -0.04] },
      shotgun: { weaponPositionOffset: [0.03, 0, -0.04] },
      // 스나이퍼는 개머리판이 길어 볼트 당김·반동 밀림 때 등 뒤로 나옴 → 시각용 밀림만 0.6배 (실제 반동·명중률 무관)
      sniper: { weaponPositionOffset: [0.03, 0, -0.04], supportGripOffset: [0, 0, -0.06], recoilPullScale: 0.6 },
      // 뿅망치: 기준 자세 그대로 (팔꿈치 약 118°, 손목 약 11°)
    }),
  white: def('white', 'SHONI', 'character_white.glb', [0.69066, 0.7466],
    { maxHp: 120, speed: 1.15, hitSize: 0.9 },
    { height: 0.885, shape: '최상위 기동형: 날씬한 몸통·긴 팔다리' },
    {
      rifle: { weaponPositionOffset: [0, 0, -0.04], supportGripOffset: [0, 0, -0.06], reloadPositionOffset: [0, 0.04, -0.06] },
      shotgun: { weaponPositionOffset: [0, 0, -0.04], supportGripOffset: [0, 0, -0.06] },
      sniper: { weaponPositionOffset: [0, 0, -0.04], reloadPositionOffset: [0, 0.04, 0] },
      pistol: { reloadPositionOffset: [0, 0.04, 0] },
      // 뿅망치: 보정 없음. 긴 팔·좁은 어깨라 손이 허리 옆에서 팔이 거의 펴진 채(약 156°) 들고 있음 — 위치를 올려도 팔 각도가 거의 안 바뀜 (2026-10-21 화면 확인, 자연스러운 편)
    }),
  yellow: def('yellow', 'MOCHI', 'character-yellow-adjusted.glb', [0.63869, 0.49443],
    { maxHp: 110, speed: 1.0, hitSize: 1.0 },
    { height: 1.0, shape: '밸런스형: 표준 키·체형 (기준)' },
    {
      rifle: { weaponPositionOffset: [0.04, 0, 0] },
      shotgun: { weaponPositionOffset: [0.03, 0, -0.04] },
      sniper: { weaponPositionOffset: [0.03, 0, 0] },
      // 뿅망치: 손 3cm 위 (팔꿈치 약 119°)
      melee: { weaponPositionOffset: [0, 0.03, 0] },
    }),
  red: def('red', 'ROKO', 'character_6.glb', [0.1994, 0.16424],
    { maxHp: 120, speed: 1.05, hitSize: 1.0 },
    { height: 0.98, shape: '전투형: 넓은 어깨·탄탄한 상체·두꺼운 팔·좁은 허리' },
    {
      // 넓은 어깨·짧은 팔: 총을 몸 쪽으로 (라이플 6cm, 샷건·스나이퍼 3cm — 더 오른쪽이면 왼손이 안 닿음)
      // 왼손은 총 축을 따라 탄창 쪽을 잡음 (supportGripOffset)
      rifle: { weaponPositionOffset: [-0.06, 0, 0], supportGripOffset: [0, 0, -0.12], reloadPositionOffset: [0, 0.04, -0.06] },
      shotgun: { weaponPositionOffset: [-0.03, 0, -0.04], supportGripOffset: [0, 0, -0.18], reloadPositionOffset: [-0.04, 0.04, 0] },
      sniper: { weaponPositionOffset: [-0.03, 0, -0.04], supportGripOffset: [0, 0, -0.18], reloadPositionOffset: [0, 0.04, 0] },
      pistol: { supportGripOffset: [0, 0, -0.06], reloadPositionOffset: [0, 0.04, 0] },
      // 뿅망치: 짧은 팔(위팔+아래팔 약 0.19m)·넓은 어깨 → 손 6cm 위·4cm 뒤 (팔꿈치 155° → 114°)
      melee: { weaponPositionOffset: [0, 0.06, -0.04] },
    }),
  pink: def('pink', 'POPI', 'character-pink-adjusted.glb', [0.29128, 0.23691],
    { maxHp: 115, speed: 0.95, hitSize: 1.05 },
    { height: 1.015, shape: '생존형: 둥근 몸통·통통한 배, 짧고 두꺼운 팔다리' },
    {
      rifle: { weaponPositionOffset: [0.04, 0, -0.04], supportGripOffset: [0, 0, -0.06], reloadPositionOffset: [-0.04, 0.04, -0.06] },
      shotgun: { weaponPositionOffset: [0.03, 0, -0.04], supportGripOffset: [0, 0, -0.12] },
      sniper: { weaponPositionOffset: [0.03, 0, 0], supportGripOffset: [0, 0, -0.06] },
      // 뿅망치: 짧고 두꺼운 팔 → 손 9cm 위·2cm 안쪽·4cm 뒤 (팔꿈치 157° → 130°)
      melee: { weaponPositionOffset: [-0.02, 0.09, -0.04] },
    }),
  black: def('black', 'BAM', 'character_black.glb', [0.03574, 0.03084],
    { maxHp: 130, speed: 1.0, hitSize: 1.1 },
    { height: 1.1, shape: '최상위 탱커형: 가장 큰 체형·넓은 몸통·큰 배·두꺼운 팔다리' },
    // 넓은 몸통·짧은 팔: 왼손이 앞으로 덜 나감 → 총을 몸 쪽으로 6cm. 샷건·스나이퍼는 이래도 개머리판 일부가 몸통 안
    // (더 오른쪽이면 왼손이 3~4cm 뜸 — 모델 비율 한계, docs/ASSET_AUDIT.md)
    {
      rifle: { weaponPositionOffset: [-0.06, 0, 0], supportGripOffset: [0, 0, -0.18], reloadPositionOffset: [-0.04, 0.04, -0.06] },
      shotgun: { weaponPositionOffset: [-0.06, 0, -0.04], supportGripOffset: [0, 0, -0.18], reloadPositionOffset: [-0.04, 0.04, 0] },
      sniper: { weaponPositionOffset: [-0.06, 0, -0.04], supportGripOffset: [0, 0, -0.12], reloadPositionOffset: [-0.04, 0.04, 0] },
      pistol: { weaponPositionOffset: [-0.06, 0, 0], supportGripOffset: [0, 0, -0.12], reloadPositionOffset: [-0.04, 0.08, 0] },
      // 뿅망치: 큰 몸통·짧은 팔 → 손 9cm 위·5cm 안쪽·4cm 뒤 (팔꿈치 175°(팔이 늘어남) → 약 130°)
      melee: { weaponPositionOffset: [-0.05, 0.09, -0.04] },
    }),
};

/**
 * 제외된 캐릭터 (보존용 데이터, 게임에서 참조하지 않음). GLB·팀 마스크·체형 설정 파일도 삭제하지 않고 그대로 둠.
 * 능력치는 제외 직전 값 (스킨으로 되살리면 외형만 쓰게 될 가능성이 큼)
 */
export const RETIRED_CHARACTERS: Record<RetiredCharacterId, CharacterDef<RetiredCharacterId>> = {
  red_v2: def('red_v2', 'RED (v2, 제외)', 'character-red-adjusted.glb', [0.18328, 0.13736],
    { maxHp: 120, speed: 1.05, hitSize: 0.95 },
    { height: 0.97, shape: '날렵한 체형: 좁은 허리·가벼운 팔다리' }),
  c7: def('c7', 'CHARACTER 7', 'character_c7.glb', [0.64712, 0.56582],
    { maxHp: 125, speed: 1.15, hitSize: 0.95 },
    { height: 0.96, shape: '소형 민첩형: 작은 몸통·좁은 어깨·가는 팔다리' }),
};

export const CHARACTER_IDS = Object.keys(CHARACTERS) as CharacterId[];

/**
 * 캐릭터 선택 화면 카드 순서 (UI 표시 순서만, id·저장값·서버 검증과 무관). 잠긴 SHONI(white)·BAM(black)은 맨 뒤
 * 표시 이름은 CHARACTERS[id].name (BUBU·MOCHI·ROKO·POPI·SHONI·BAM), 내부 id는 그대로
 */
export const CHARACTER_DISPLAY_ORDER: readonly CharacterId[] = ['blue', 'yellow', 'red', 'pink', 'white', 'black'];

/** 시작 화면 캐릭터 카드 정보 (표시 순서 = CHARACTER_IDS) */
export interface CharacterSelectInfo {
  /** 유형 (카드 부제) */
  role: string;
  /** 카드 강조 색 (캐릭터 원래 비니 색) */
  color: string;
  /**
   * 유료(VXShop) 캐릭터: 구매 전에는 잠김(미리보기만), 서버 보유 기록이 있으면 선택 가능.
   * 상품 = net/shared/shop.ts (SHONI = white → character-shoni, BAM = black → character-bam)
   */
  locked: boolean;
}

export const CHARACTER_SELECT: Record<CharacterId, CharacterSelectInfo> = {
  blue: { role: '민첩형', color: '#4f86ff', locked: false },
  white: { role: '최상위 기동형', color: '#d9d2c8', locked: true },
  yellow: { role: '밸런스형', color: '#f2c230', locked: false },
  red: { role: '전투형', color: '#e8442e', locked: false },
  pink: { role: '생존형', color: '#ff7fae', locked: false },
  black: { role: '최상위 탱커형', color: '#2b2b33', locked: true },
};

/** 유료 캐릭터 보유 확인 (Game이 서버 보유 목록으로 설정, 그전에는 없음) */
let ownsPaid: (id: CharacterId) => boolean = () => false;

export function setCharacterOwnership(check: (id: CharacterId) => boolean): void {
  ownsPaid = check;
}

/** 개발 서버 확인용: ?char=<id> 또는 ?unlockall 이면 잠금 무시 (배포 빌드는 서버 보유 기록만, 서버도 따로 검사) */
const DEV_UNLOCK = import.meta.env.DEV && typeof location !== 'undefined' && /[?&](char|unlockall)(=|&|$)/.test(location.search);

/** 지금 고를 수 있는지: 무료 캐릭터 또는 구매(서버 보유)한 유료 캐릭터 */
export function isCharacterSelectable(id: CharacterId): boolean {
  return !CHARACTER_SELECT[id].locked || ownsPaid(id) || DEV_UNLOCK;
}

/** 선택한 캐릭터 저장 키 (브라우저 저장소, 이 기기·브라우저에만) */
const SAVE_KEY = 'popbattle.character';

/**
 * 저장된 캐릭터. 옛 id는 새 id로 (character_6 → red). 없거나, 제외된 캐릭터·모르는 값·잠긴 캐릭터면 null → BLUE.
 * 저장소를 못 쓰는 환경(사생활 보호 창 등)도 null. 저장값을 지우거나 덮어쓰지 않음
 */
export function loadSavedCharacter(): CharacterId | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const id = asCharacterId(raw);
    // 옛 id로 저장돼 있으면 새 id로 다시 저장 (다른 저장 데이터는 건드리지 않음)
    if (id && raw !== id) localStorage.setItem(SAVE_KEY, id);
    return id && isCharacterSelectable(id) ? id : null;
  } catch {
    return null;
  }
}

/** 저장된 캐릭터 id (잠금 검사 전) — 유료 캐릭터는 서버 보유 확인 뒤 다시 적용할 때 */
export function loadSavedCharacterId(): CharacterId | null {
  try {
    return asCharacterId(localStorage.getItem(SAVE_KEY));
  } catch {
    return null;
  }
}

export function saveCharacter(id: CharacterId): void {
  try {
    localStorage.setItem(SAVE_KEY, id);
  } catch {
    // 저장 실패해도 이번 접속에서는 그대로 적용
  }
}

/** 공통 장착 보정 기본값 (모든 캐릭터·무기). 캐릭터별 값은 CHARACTERS[id].weaponFit */
export const DEFAULT_WEAPON_FIT: Required<WeaponFit> = {
  weaponPositionOffset: [0, 0, 0],
  reloadPositionOffset: [0, 0, 0],
  recoilPullScale: 1,
  weaponRotationOffset: [0, 0, 0],
  weaponScale: 1,
  leftHandIKOffset: [0, 0, 0],
  supportGripOffset: [0, 0, 0],
  rightHandIKOffset: [0, 0, 0],
  muzzleOffset: [0, 0, 0],
};

const addV = (a: readonly number[], b?: readonly number[]): [number, number, number] =>
  b ? [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!] : [a[0]!, a[1]!, a[2]!];

/** 캐릭터 × 무기 최종 장착 보정 = 공통 기본 + 캐릭터 all + 캐릭터 무기별 (벡터는 더하고 크기는 곱함) */
export function weaponFitFor(id: CharacterId, weaponId: string | undefined): Required<WeaponFit> {
  const fit = CHARACTERS[id].weaponFit;
  // 배열은 복사 (디버그에서 결과를 직접 고쳐도 공통 기본값이 바뀌지 않게)
  const d = DEFAULT_WEAPON_FIT;
  let r: Required<WeaponFit> = {
    weaponPositionOffset: addV(d.weaponPositionOffset),
    reloadPositionOffset: addV(d.reloadPositionOffset),
    recoilPullScale: d.recoilPullScale,
    weaponRotationOffset: addV(d.weaponRotationOffset),
    weaponScale: d.weaponScale,
    leftHandIKOffset: addV(d.leftHandIKOffset),
    supportGripOffset: addV(d.supportGripOffset),
    rightHandIKOffset: addV(d.rightHandIKOffset),
    muzzleOffset: addV(d.muzzleOffset),
  };
  for (const f of [fit.all, weaponId ? fit[weaponId] : undefined]) {
    if (!f) continue;
    r = {
      weaponPositionOffset: addV(r.weaponPositionOffset, f.weaponPositionOffset),
      reloadPositionOffset: addV(r.reloadPositionOffset, f.reloadPositionOffset),
      recoilPullScale: r.recoilPullScale * (f.recoilPullScale ?? 1),
      weaponRotationOffset: addV(r.weaponRotationOffset, f.weaponRotationOffset),
      weaponScale: r.weaponScale * (f.weaponScale ?? 1),
      leftHandIKOffset: addV(r.leftHandIKOffset, f.leftHandIKOffset),
      supportGripOffset: addV(r.supportGripOffset, f.supportGripOffset),
      rightHandIKOffset: addV(r.rightHandIKOffset, f.rightHandIKOffset),
      muzzleOffset: addV(r.muzzleOffset, f.muzzleOffset),
    };
  }
  return r;
}

/** 팀 색 (sRGB). 임시 기본값 — 여기만 바꾸면 모든 캐릭터에 반영 */
export const TEAM_COLORS: Record<Exclude<TeamId, 'NONE'>, string> = {
  BLUE: '#2878FF',
  RED: '#FF4545',
};

/**
 * 팀 색 명암: 원래 텍셀 밝기 / 기준 밝기 비율을 [min, max]로 자르고 strength만큼 반영.
 * (주름·그늘은 남기고, 아주 어두운/밝은 원래 색 때문에 팀 색이 너무 바래거나 타지 않게)
 */
export const TEAM_SHADE = { min: 0.55, max: 1.5, strength: 0.85 };

/**
 * 킬로그 이름 색. 개인전 = 캐릭터 고유 색 (어두운 반투명 배경에서 읽히게 밝게, BLACK·WHITE는 밝은 회색·흰색).
 * TDM = 팀 색 (캐릭터와 무관)
 */
export const KILL_FEED_COLORS: Record<CharacterId, string> = {
  blue: '#7fb0ff',
  white: '#ffffff',
  yellow: '#ffd75e',
  red: '#ff7a5c',
  pink: '#ff9cc8',
  black: '#c9cbd6',
};
export const KILL_FEED_TEAM_COLORS: Record<Exclude<TeamId, 'NONE'>, string> = { BLUE: '#6aa5ff', RED: '#ff6464' };

/** 이름표 색 (TDM): 아군 블루, 적군 레드 */
export const TEAM_LABEL = { ally: '#2878FF', enemy: '#e2445c' };

const params = new URLSearchParams(location.search);
/** 옛 캐릭터 id → 지금 id (저장값·URL 호환). character_6은 2026-10-21에 red로 이름 변경 */
const ID_ALIASES: Readonly<Record<string, CharacterId>> = { character_6: 'red' };

/** 문자열 → 플레이 가능한 캐릭터 id. 옛 id는 바꿔서, 제외된 캐릭터(red_v2·c7)·모르는 값은 null (호출자가 BLUE로 대체) */
export const asCharacterId = (v: string | null | undefined): CharacterId | null => {
  if (!v) return null;
  const id = ID_ALIASES[v] ?? v;
  return Object.prototype.hasOwnProperty.call(CHARACTERS, id) ? (id as CharacterId) : null;
};

/**
 * 처음 불러올 플레이어 캐릭터: ?char= (개발 서버만) → 시작 화면에서 마지막으로 고른 캐릭터(저장값) → BLUE.
 * ?char=blue|white|yellow|red|pink|black 은 배포 빌드에서는 무시 → URL로 캐릭터를 바꿀 수 없음.
 * 제외된 id(red_v2·c7)·모르는 값·잠긴 캐릭터 저장값은 BLUE. 시작 화면 선택은 Game.selectCharacter
 */
export const PLAYER_CHARACTER: CharacterId = (import.meta.env.DEV ? asCharacterId(params.get('char')) : null) ?? loadSavedCharacter() ?? 'blue';

/**
 * 봇 캐릭터 (봇 순서대로). 기본은 이전과 같이 플레이어와 같은 캐릭터.
 * 확인용(개발 서버만): ?botchars=pink,black,white (모자라면 플레이어 캐릭터)
 */
export const BOT_CHARACTERS: CharacterId[] = (import.meta.env.DEV ? params.get('botchars') ?? '' : '')
  .split(',')
  .map((s) => asCharacterId(s.trim()))
  .filter((v): v is CharacterId => v !== null);

/**
 * 팀 컬러 미리보기 (TDM 규칙은 아직 없음 → 외형·이름표만): ?teams=tdm
 * 플레이어·BOT 1 = BLUE, BOT 2·3 = RED. 적대 규칙·점수는 그대로 개인전.
 */
export const TEAM_PREVIEW = params.get('teams') === 'tdm';

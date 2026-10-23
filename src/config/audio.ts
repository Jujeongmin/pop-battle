// 사운드 설정: 효과음 종류·음량·동시 재생 제한, 배경음, 거리 감쇠, 버스 음량.
// 소리는 전부 코드로 합성 (audio/sfxBank.ts · audio/musicTracks.ts) → 오디오 파일·외부 에셋 없음.
// 오디오가 처음 켜질 때(첫 사용자 입력) 한 번 버퍼로 만들어 두고 재생 때는 버퍼만 재사용한다.

export type SoundId =
  // 무기
  | 'fireRifle'
  | 'fireShotgun'
  | 'fireSniper'
  | 'firePistol'
  | 'swing'
  | 'meleeHit'
  | 'reloadStart'
  | 'reloadEnd'
  | 'dryFire'
  | 'weaponSwitch'
  | 'impact'
  // 명중·처치 (헤드샷 전용 소리 없음: 헤드샷도 hit)
  | 'hit'
  | 'kill'
  | 'hurt'
  | 'death'
  | 'respawn'
  // 이동
  | 'stepWalk'
  | 'stepRun'
  | 'slide'
  | 'jump'
  | 'land'
  // UI·매치
  | 'uiClick'
  | 'uiOpen'
  | 'uiClose'
  | 'uiSelect'
  | 'uiEquip'
  | 'uiShopSelect'
  | 'buyOk'
  | 'buyFail'
  | 'matchEnter'
  | 'countTick'
  | 'countGo'
  | 'win'
  | 'lose'
  | 'resultShow';

export type MusicId = 'lobby' | 'battle' | 'victory' | 'defeat';

export interface SoundSpec {
  /** 같은 채널 동시 재생 수 (넘치면 새 소리를 건너뜀) */
  voices: number;
  /** 같은 채널 최소 재생 간격 (s) */
  minInterval: number;
  /** 음량 (합성 버퍼는 최고점 0.9로 맞춰 둠 → 여기서 종류별 크기) */
  gain: number;
  /** 미리 만들어 둘 변형 수 (발소리·발사음이 기계적으로 반복되지 않게) */
  variants: number;
  /** 재생할 때마다 음 높이 ±비율 */
  jitter: number;
}

const s = (voices: number, minInterval: number, gain: number, variants = 1, jitter = 0): SoundSpec => ({ voices, minInterval, gain, variants, jitter });

export const SOUNDS: Record<SoundId, SoundSpec> = {
  fireRifle: s(4, 0.03, 0.34, 3, 0.04),
  fireShotgun: s(2, 0.08, 0.42, 2, 0.03),
  fireSniper: s(2, 0.1, 0.44, 2, 0.02),
  firePistol: s(3, 0.04, 0.3, 3, 0.05),
  swing: s(2, 0.08, 0.3, 2, 0.06),
  meleeHit: s(2, 0.06, 0.4, 2, 0.04),
  reloadStart: s(1, 0.15, 0.28),
  reloadEnd: s(1, 0.15, 0.3),
  dryFire: s(1, 0.12, 0.3, 1, 0.03),
  weaponSwitch: s(1, 0.08, 0.26),
  impact: s(4, 0.04, 0.2, 3, 0.08),
  hit: s(3, 0.04, 0.3, 2, 0.02),
  kill: s(2, 0.12, 0.34),
  hurt: s(1, 0.12, 0.32, 2, 0.04),
  death: s(1, 0.5, 0.38),
  respawn: s(1, 0.5, 0.3),
  stepWalk: s(3, 0.08, 0.16, 4, 0.06),
  stepRun: s(3, 0.07, 0.2, 4, 0.06),
  slide: s(2, 0.25, 0.26),
  jump: s(2, 0.15, 0.2, 2, 0.04),
  land: s(2, 0.12, 0.24, 2, 0.05),
  uiClick: s(2, 0.04, 0.16, 2, 0.02),
  uiOpen: s(1, 0.1, 0.2),
  uiClose: s(1, 0.1, 0.18),
  uiSelect: s(1, 0.08, 0.22),
  uiEquip: s(1, 0.08, 0.24),
  uiShopSelect: s(1, 0.06, 0.2),
  buyOk: s(1, 0.2, 0.28),
  buyFail: s(1, 0.2, 0.24),
  matchEnter: s(1, 0.5, 0.3),
  countTick: s(1, 0.3, 0.3),
  countGo: s(1, 0.5, 0.36),
  win: s(1, 1, 0.4),
  lose: s(1, 1, 0.36),
  resultShow: s(1, 0.5, 0.26),
};

/** 무기 id → 발사음 (근접은 휘두르기) */
export const FIRE_SOUND: Record<string, SoundId> = {
  rifle: 'fireRifle',
  shotgun: 'fireShotgun',
  sniper: 'fireSniper',
  pistol: 'firePistol',
  melee: 'swing',
};

/** 배경음: 곡별 음량 (전투는 효과음을 가리지 않게 낮게) */
export const MUSIC: Record<MusicId, { gain: number }> = {
  lobby: { gain: 0.5 },
  battle: { gain: 0.32 },
  victory: { gain: 0.5 },
  defeat: { gain: 0.46 },
};

export const MIX = {
  /** 배경음 바꿀 때 페이드 (s) */
  musicFade: 0.8,
  /** 다른 캐릭터(봇·원격) 소리 기본 배율 (내 소리보다 조금 작게) */
  otherGain: 0.8,
  /** 합성 효과음 샘플레이트 (작은 버퍼, 재생 때 자동 변환) */
  sfxRate: 32000,
  /** 배경음: 모노 24kHz (4곡 합계 약 10MB 메모리 — 모바일 고려, 고음은 하이햇 7kHz까지라 충분) */
  musicRate: 24000,
  musicChannels: 1,
};

/** 다른 캐릭터 소리 거리 감쇠·좌우 (카메라 기준) */
export const SPATIAL = {
  /** 이 거리까지는 감쇠 없음 (m) */
  near: 3,
  /** 이 거리부터 안 들림 (m) */
  far: 48,
  /** 좌우 쏠림 최대 (-1..1) */
  pan: 0.75,
};

/**
 * 발소리: 걷기·달리기 클립 한 주기의 발 닿는 위치 (0..1, 두 걸음).
 * 클립을 재서 정함 (발끝이 가장 앞 → 가장 낮은 곳 사이: 걷기 0.00/0.48 → 0.53/0.97, 달리기 0.92/0.42 → 0.15/0.67)
 */
export const FOOTSTEP = {
  walk: [0.04, 0.52],
  run: [0.03, 0.54],
  /** 이보다 오래 떠 있다 내려와야 착지음 (s) */
  landMinAir: 0.25,
  /** 다른 캐릭터 발소리 배율 (전투 중 거슬리지 않게) */
  otherGain: 0.7,
};

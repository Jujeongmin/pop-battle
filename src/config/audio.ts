// 효과음 설정. 실제 사운드 에셋(WAV/OGG)이 생기면 public/assets/audio/에 넣고 경로를 적으면 합성음 대신 재생된다.
// 예: fire: `${import.meta.env.BASE_URL}assets/audio/rifle_fire.ogg`
export type SoundId = 'fire' | 'hit' | 'impact' | 'kill' | 'reloadStart' | 'reloadEnd' | 'swing';

export const SOUND_FILES: Partial<Record<SoundId, string>> = {
  // 아직 없음 → 전부 임시 합성음
};

/** 종류별 동시 재생 수, 최소 재생 간격(s), 음량 */
export const SOUND_LIMITS: Record<SoundId, { voices: number; minInterval: number; gain: number }> = {
  fire: { voices: 4, minInterval: 0.03, gain: 0.32 },
  hit: { voices: 4, minInterval: 0.03, gain: 0.3 },
  impact: { voices: 3, minInterval: 0.05, gain: 0.18 },
  kill: { voices: 2, minInterval: 0.15, gain: 0.32 },
  reloadStart: { voices: 1, minInterval: 0.2, gain: 0.3 },
  reloadEnd: { voices: 1, minInterval: 0.2, gain: 0.3 },
  swing: { voices: 2, minInterval: 0.1, gain: 0.35 },
};

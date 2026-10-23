// 효과음 합성 레시피: 장난감 총·고무 탄·버블 느낌 (무겁고 사실적인 총소리 대신 통통 튀는 소리).
// 레시피마다 길이(len)를 정해 OfflineAudioContext로 한 번 구워 AudioBuffer로 쓴다. r = 변형마다 다른 시드 난수.
import { MIX, type SoundId } from '../config/audio';
import { noise, normalize, rng, tone } from './synth';

type Recipe = (c: BaseAudioContext, o: AudioNode, r: () => number) => void;

/** 버블 "퐁": 짧게 올라가는 사인 (명중·탄착·UI 공용) */
function pop(c: BaseAudioContext, o: AudioNode, t: number, f0: number, f1: number, peak: number, decay = 0.05): void {
  tone(c, o, { t, f0, f1, glide: decay * 0.7, decay, peak, attack: 0.002 });
}

/** 플라스틱 딸깍 */
function click(c: BaseAudioContext, o: AudioNode, t: number, freq: number, peak: number): void {
  noise(c, o, { t, decay: 0.014, peak, filter: 'bandpass', f0: freq, q: 5 });
}

const RECIPES: Record<SoundId, { len: number; make: Recipe }> = {
  // ---- 무기 발사 ----
  // 라이플: 가볍고 빠른 "퓽" (연사에 묻히지 않게 짧게)
  fireRifle: {
    len: 0.16,
    make: (c, o, r) => {
      const k = 1 + (r() - 0.5) * 0.08;
      tone(c, o, { t: 0, type: 'square', f0: 920 * k, f1: 300 * k, glide: 0.06, decay: 0.07, peak: 0.35, lowpass: 2600 });
      pop(c, o, 0.004, 700 * k, 1250 * k, 0.5, 0.04);
      noise(c, o, { t: 0, decay: 0.02, peak: 0.25, filter: 'highpass', f0: 3200 });
      tone(c, o, { t: 0, f0: 150, f1: 80, decay: 0.05, peak: 0.35 });
    },
  },
  // 샷건: 묵직하지만 귀여운 "뽀옹" + 작은 방울 여러 개
  fireShotgun: {
    len: 0.42,
    make: (c, o, r) => {
      tone(c, o, { t: 0, f0: 170, f1: 52, glide: 0.16, decay: 0.2, peak: 0.9 });
      noise(c, o, { t: 0, decay: 0.2, peak: 0.45, filter: 'lowpass', f0: 2200, f1: 380 });
      tone(c, o, { t: 0, type: 'square', f0: 520, f1: 180, decay: 0.09, peak: 0.22, lowpass: 1800 });
      for (let i = 0; i < 4; i++) pop(c, o, 0.03 + i * 0.022 + r() * 0.01, 650 + r() * 500, 1200 + r() * 600, 0.22, 0.04);
    },
  },
  // 스나이퍼: 선명한 단발 "퓨웅~" + 고무줄 튕기는 여운
  fireSniper: {
    len: 0.6,
    make: (c, o, r) => {
      const k = 1 + (r() - 0.5) * 0.04;
      tone(c, o, { t: 0, type: 'triangle', f0: 1900 * k, f1: 230 * k, glide: 0.13, decay: 0.16, peak: 0.6 });
      tone(c, o, { t: 0, f0: 130, f1: 55, decay: 0.18, peak: 0.85 });
      noise(c, o, { t: 0, decay: 0.035, peak: 0.4, filter: 'highpass', f0: 2400 });
      noise(c, o, { t: 0.01, decay: 0.14, peak: 0.22, filter: 'lowpass', f0: 1600, f1: 400 });
      tone(c, o, { t: 0.04, f0: 2350 * k, decay: 0.42, peak: 0.12, vibrato: [11, 18] });
    },
  },
  // 권총: 짧고 가벼운 "핍"
  firePistol: {
    len: 0.11,
    make: (c, o, r) => {
      const k = 1 + (r() - 0.5) * 0.08;
      tone(c, o, { t: 0, type: 'square', f0: 1300 * k, f1: 520 * k, glide: 0.04, decay: 0.05, peak: 0.3, lowpass: 3200 });
      pop(c, o, 0.002, 1100 * k, 1700 * k, 0.45, 0.035);
      tone(c, o, { t: 0, f0: 190, f1: 110, decay: 0.035, peak: 0.25 });
    },
  },
  // 망치 휘두르기 "휙"
  swing: {
    len: 0.26,
    make: (c, o, r) => {
      noise(c, o, { t: 0, attack: 0.06, decay: 0.16, peak: 0.6, filter: 'bandpass', f0: 500 + r() * 100, f1: 2000, q: 1.6 });
      noise(c, o, { t: 0.05, attack: 0.03, decay: 0.12, peak: 0.25, filter: 'bandpass', f0: 1800, f1: 700, q: 2 });
    },
  },
  // 망치 타격 "뿅!": 장난감 뿅망치 삑 소리 + 둥근 퍽
  meleeHit: {
    len: 0.3,
    make: (c, o, r) => {
      tone(c, o, { t: 0, f0: 320, f1: 130, decay: 0.12, peak: 0.8 });
      tone(c, o, { t: 0, type: 'triangle', f0: 950 + r() * 80, f1: 1500, glide: 0.06, decay: 0.16, peak: 0.35, vibrato: [24, 60] });
      noise(c, o, { t: 0, decay: 0.05, peak: 0.35, filter: 'lowpass', f0: 1400 });
    },
  },
  reloadStart: {
    len: 0.2,
    make: (c, o) => {
      click(c, o, 0, 2600, 0.8);
      tone(c, o, { t: 0.01, type: 'triangle', f0: 520, f1: 380, decay: 0.05, peak: 0.25 });
      click(c, o, 0.08, 1900, 0.7);
    },
  },
  // 재장전 완료 "착-띵"
  reloadEnd: {
    len: 0.24,
    make: (c, o) => {
      click(c, o, 0, 2300, 0.8);
      click(c, o, 0.045, 3100, 0.6);
      tone(c, o, { t: 0.06, f0: 1320, decay: 0.15, peak: 0.35 });
      tone(c, o, { t: 0.06, f0: 2640, decay: 0.08, peak: 0.1 });
    },
  },
  // 탄약 없음 "틱" (빈 장난감 방아쇠)
  dryFire: {
    len: 0.09,
    make: (c, o) => {
      click(c, o, 0, 1700, 0.9);
      tone(c, o, { t: 0, type: 'triangle', f0: 420, f1: 300, decay: 0.035, peak: 0.3 });
    },
  },
  // 무기 교체 "착착"
  weaponSwitch: {
    len: 0.2,
    make: (c, o) => {
      click(c, o, 0, 3000, 0.7);
      noise(c, o, { t: 0.02, attack: 0.02, decay: 0.07, peak: 0.25, filter: 'bandpass', f0: 1200, f1: 2600, q: 2 });
      click(c, o, 0.1, 2200, 0.8);
    },
  },
  // 벽·엄폐물 탄착: 젤리 방울 "톡퐁"
  impact: {
    len: 0.16,
    make: (c, o, r) => {
      noise(c, o, { t: 0, decay: 0.07, peak: 0.6, filter: 'lowpass', f0: 1700, f1: 500 });
      tone(c, o, { t: 0, f0: 260 + r() * 40, f1: 120, decay: 0.07, peak: 0.6 });
      pop(c, o, 0.012, 800 + r() * 300, 1400 + r() * 300, 0.3, 0.03);
    },
  },

  // ---- 명중·처치 ----
  // 명중 "톡!" (헤드샷도 같은 소리)
  hit: {
    len: 0.12,
    make: (c, o, r) => {
      const k = 1 + (r() - 0.5) * 0.03;
      tone(c, o, { t: 0, type: 'triangle', f0: 1150 * k, f1: 1650 * k, glide: 0.03, decay: 0.05, peak: 0.7 });
      tone(c, o, { t: 0, f0: 2300 * k, decay: 0.07, peak: 0.25 });
    },
  },
  // 처치 "퐁! 띠링": 방울 터짐 + 올라가는 세 음
  kill: {
    len: 0.55,
    make: (c, o) => {
      pop(c, o, 0, 520, 1300, 0.6, 0.06);
      [1319, 1661, 1976].forEach((f, i) => {
        tone(c, o, { t: 0.05 + i * 0.065, type: 'triangle', f0: f, decay: 0.28, peak: 0.4 });
        tone(c, o, { t: 0.05 + i * 0.065, f0: f * 2, decay: 0.12, peak: 0.1 });
      });
    },
  },
  // 내가 맞음 "뿌": 둔하고 짧게 (경보처럼 들리지 않게)
  hurt: {
    len: 0.2,
    make: (c, o, r) => {
      tone(c, o, { t: 0, type: 'square', f0: 430 + r() * 30, f1: 250, decay: 0.12, peak: 0.4, lowpass: 900 });
      noise(c, o, { t: 0, decay: 0.05, peak: 0.35, filter: 'lowpass', f0: 900 });
      tone(c, o, { t: 0, f0: 160, f1: 90, decay: 0.08, peak: 0.5 });
    },
  },
  // 내 캐릭터 쓰러짐: 풍선 바람 빠지는 "뿌우우~"
  death: {
    len: 0.95,
    make: (c, o) => {
      tone(c, o, { t: 0, type: 'triangle', f0: 760, f1: 140, glide: 0.75, attack: 0.02, hold: 0.1, decay: 0.7, peak: 0.55, vibrato: [9, 35] });
      noise(c, o, { t: 0, attack: 0.05, decay: 0.7, peak: 0.12, filter: 'bandpass', f0: 1500, f1: 500, q: 1.2 });
      pop(c, o, 0.82, 400, 260, 0.35, 0.08);
    },
  },
  // 리스폰 "뽀잉 반짝": 올라가는 음 + 아르페지오
  respawn: {
    len: 0.7,
    make: (c, o) => {
      tone(c, o, { t: 0, f0: 380, f1: 900, glide: 0.14, decay: 0.16, peak: 0.45 });
      [1047, 1319, 1568, 2093].forEach((f, i) => tone(c, o, { t: 0.1 + i * 0.055, type: 'triangle', f0: f, decay: 0.3, peak: 0.28 }));
      noise(c, o, { t: 0.1, attack: 0.05, decay: 0.35, peak: 0.08, filter: 'highpass', f0: 6000 });
    },
  },

  // ---- 이동 ----
  // 걷기: 말랑한 고무 신발 "톱"
  stepWalk: {
    len: 0.08,
    make: (c, o, r) => {
      tone(c, o, { t: 0, f0: 135 + r() * 30, f1: 85, decay: 0.05, peak: 0.8 });
      noise(c, o, { t: 0, decay: 0.03, peak: 0.35, filter: 'lowpass', f0: 800 + r() * 300 });
    },
  },
  // 달리기: 조금 더 또렷한 "탑"
  stepRun: {
    len: 0.08,
    make: (c, o, r) => {
      tone(c, o, { t: 0, f0: 165 + r() * 35, f1: 95, decay: 0.05, peak: 0.8 });
      noise(c, o, { t: 0, decay: 0.035, peak: 0.45, filter: 'lowpass', f0: 1300 + r() * 400 });
      click(c, o, 0, 2400 + r() * 600, 0.08);
    },
  },
  // 슬라이딩 "슈우욱"
  slide: {
    len: 0.5,
    make: (c, o) => {
      noise(c, o, { t: 0, attack: 0.04, hold: 0.12, decay: 0.3, peak: 0.6, filter: 'bandpass', f0: 1100, f1: 420, q: 1.2 });
      tone(c, o, { t: 0, type: 'triangle', f0: 700, f1: 420, attack: 0.02, decay: 0.25, peak: 0.12 });
    },
  },
  // 점프 "뾰잉" (작게)
  jump: {
    len: 0.16,
    make: (c, o, r) => {
      tone(c, o, { t: 0, f0: 300 + r() * 20, f1: 680, glide: 0.09, decay: 0.12, peak: 0.6, vibrato: [18, 20] });
    },
  },
  // 착지 "툭"
  land: {
    len: 0.13,
    make: (c, o, r) => {
      tone(c, o, { t: 0, f0: 125 + r() * 20, f1: 60, decay: 0.08, peak: 0.9 });
      noise(c, o, { t: 0, decay: 0.05, peak: 0.4, filter: 'lowpass', f0: 650 });
    },
  },

  // ---- UI ----
  // 버튼: 아주 짧고 부드러운 "톡" (연타해도 거슬리지 않게 낮은 음량·짧은 길이)
  uiClick: {
    len: 0.06,
    make: (c, o, r) => {
      pop(c, o, 0, 950 + r() * 40, 1350, 0.6, 0.035);
      click(c, o, 0, 3500, 0.12);
    },
  },
  uiOpen: {
    len: 0.2,
    make: (c, o) => {
      tone(c, o, { t: 0, f0: 480, f1: 920, glide: 0.1, decay: 0.13, peak: 0.6 });
      tone(c, o, { t: 0.05, type: 'triangle', f0: 1400, decay: 0.1, peak: 0.15 });
    },
  },
  uiClose: {
    len: 0.18,
    make: (c, o) => {
      tone(c, o, { t: 0, f0: 860, f1: 430, glide: 0.1, decay: 0.12, peak: 0.55 });
    },
  },
  // 캐릭터 선택 "띵동"
  uiSelect: {
    len: 0.32,
    make: (c, o) => {
      tone(c, o, { t: 0, type: 'triangle', f0: 880, decay: 0.16, peak: 0.5 });
      tone(c, o, { t: 0.08, type: 'triangle', f0: 1319, decay: 0.22, peak: 0.5 });
      tone(c, o, { t: 0.08, f0: 2638, decay: 0.08, peak: 0.08 });
    },
  },
  // 무기 장착 "철컥 띵"
  uiEquip: {
    len: 0.28,
    make: (c, o) => {
      click(c, o, 0, 2400, 0.8);
      click(c, o, 0.05, 1600, 0.7);
      tone(c, o, { t: 0.08, f0: 1047, decay: 0.18, peak: 0.4 });
    },
  },
  uiShopSelect: {
    len: 0.14,
    make: (c, o) => {
      tone(c, o, { t: 0, type: 'triangle', f0: 1568, decay: 0.1, peak: 0.5 });
    },
  },
  // 구매 성공 "띠링"
  buyOk: {
    len: 0.5,
    make: (c, o) => {
      tone(c, o, { t: 0, type: 'square', f0: 1319, decay: 0.08, peak: 0.25, lowpass: 3500 });
      tone(c, o, { t: 0.08, type: 'square', f0: 1976, decay: 0.35, peak: 0.25, lowpass: 3500 });
      tone(c, o, { t: 0.08, f0: 3952, decay: 0.15, peak: 0.06 });
    },
  },
  // 구매 실패 "뿡뿡" (내려가는 두 음)
  buyFail: {
    len: 0.34,
    make: (c, o) => {
      tone(c, o, { t: 0, type: 'triangle', f0: 330, decay: 0.12, peak: 0.6, lowpass: 1500 });
      tone(c, o, { t: 0.13, type: 'triangle', f0: 247, decay: 0.18, peak: 0.6, lowpass: 1500 });
    },
  },
  // 매치 입장 "슈웅 퐁"
  matchEnter: {
    len: 0.65,
    make: (c, o) => {
      noise(c, o, { t: 0, attack: 0.25, decay: 0.15, peak: 0.4, filter: 'bandpass', f0: 400, f1: 3200, q: 1.4 });
      tone(c, o, { t: 0.05, f0: 280, f1: 900, glide: 0.3, attack: 0.2, decay: 0.12, peak: 0.3 });
      pop(c, o, 0.38, 700, 1500, 0.6, 0.08);
      tone(c, o, { t: 0.42, type: 'triangle', f0: 1568, decay: 0.2, peak: 0.25 });
    },
  },
  // 카운트다운 "똑" (나무 블록)
  countTick: {
    len: 0.16,
    make: (c, o) => {
      tone(c, o, { t: 0, f0: 1250, decay: 0.08, peak: 0.7 });
      tone(c, o, { t: 0, type: 'triangle', f0: 2500, decay: 0.03, peak: 0.25 });
    },
  },
  // 경기 시작 "GO!": 밝은 화음 한 번
  countGo: {
    len: 0.7,
    make: (c, o) => {
      [1047, 1319, 1568].forEach((f) => {
        tone(c, o, { t: 0, type: 'triangle', f0: f, attack: 0.005, hold: 0.08, decay: 0.45, peak: 0.35 });
        tone(c, o, { t: 0, type: 'square', f0: f / 2, attack: 0.005, decay: 0.2, peak: 0.08, lowpass: 2500 });
      });
      noise(c, o, { t: 0, decay: 0.3, peak: 0.12, filter: 'highpass', f0: 5000 });
    },
  },
  // 승리 징글: 도미솔도 + 반짝
  win: {
    len: 1.7,
    make: (c, o) => {
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => {
        const last = i === notes.length - 1;
        tone(c, o, { t: i * 0.12, type: 'triangle', f0: f, hold: last ? 0.35 : 0.04, decay: last ? 0.8 : 0.12, peak: 0.45 });
        tone(c, o, { t: i * 0.12, type: 'square', f0: f, hold: last ? 0.3 : 0.03, decay: last ? 0.5 : 0.08, peak: 0.1, lowpass: 3000 });
      });
      [2093, 2637, 3136].forEach((f, i) => tone(c, o, { t: 0.5 + i * 0.08, f0: f, decay: 0.3, peak: 0.12 }));
    },
  },
  // 패배 "뿌우우": 내려가는 장난스러운 네 음 (무겁지 않게)
  lose: {
    len: 1.5,
    make: (c, o) => {
      const notes = [392, 370, 349, 330];
      notes.forEach((f, i) => {
        const last = i === notes.length - 1;
        tone(c, o, { t: i * 0.22, type: 'sawtooth', f0: f, hold: last ? 0.35 : 0.1, decay: last ? 0.5 : 0.1, peak: 0.3, lowpass: 900, vibrato: last ? [6, 8] : undefined });
      });
    },
  },
  // 결과 카드 등장 "슉 퐁"
  resultShow: {
    len: 0.4,
    make: (c, o) => {
      noise(c, o, { t: 0, attack: 0.1, decay: 0.1, peak: 0.35, filter: 'bandpass', f0: 600, f1: 2400, q: 1.5 });
      pop(c, o, 0.16, 600, 1300, 0.6, 0.07);
    },
  },
};

/** 효과음 하나의 변형 하나를 굽는다 */
export async function renderSfx(id: SoundId, variant: number): Promise<AudioBuffer> {
  const rec = RECIPES[id];
  const rate = MIX.sfxRate;
  const ctx = new OfflineAudioContext(1, Math.ceil(rec.len * rate), rate);
  const seed = [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) + variant * 977;
  rec.make(ctx, ctx.destination, rng(seed));
  return normalize(await ctx.startRendering());
}

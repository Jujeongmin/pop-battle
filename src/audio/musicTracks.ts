// 배경음 4곡 (코드로 작곡·합성): 로비 · 전투 · 승리 · 패배.
// 곡 = 템포 + 마디별 화음 + 멜로디(직접 쓴 음표) + 반주 패턴. OfflineAudioContext로 한 번 구운 뒤 반복 재생.
// 반복 이음매: 곡 길이 + 여운만큼 구운 뒤, 넘친 여운을 곡 앞부분에 더해 끊김 없이 이어지게.
import { MIX, type MusicId } from '../config/audio';
import { hz, noise, rng, tone } from './synth';

/** [시작 박, 길이(박), MIDI] — 마디 안 박 기준 */
type Note = [number, number, number];
/** 화음: 근음(MIDI, 3옥타브대) + 단조 여부. 마디 중간에 바뀌면 [박, 화음] 목록 */
type Chord = { root: number; minor?: boolean };

interface Track {
  bpm: number;
  /** 마디마다 화음 (한 마디 4박) — 같은 마디 안 변화는 [[0, 화음], [2, 화음]] */
  chords: Array<Chord | Array<[number, Chord]>>;
  /** 마디마다 멜로디 */
  melody: Note[][];
  /** 멜로디 악기 */
  lead: 'pluck' | 'square' | 'soft';
  leadGain: number;
  /** 반주 */
  bass: 'bounce' | 'drive' | 'soft';
  pad: number;
  /** 16칸 드럼 패턴 (k = 킥, s = 스네어/박수, h = 하이햇, o = 열린 햇, p = 버블 팝) */
  drums: { k?: string; s?: string; h?: string; o?: string; p?: string };
  drumGain: number;
  /** 아르페지오 (전투곡 16분음표) */
  arp?: { gain: number; bars?: (bar: number) => boolean };
  /** 반복 재생 (승리·패배도 결과 화면에 머무는 동안 반복) */
  tail: number;
}

const C = (root: number, minor = false): Chord => ({ root, minor });
// 근음 (3옥타브: C3 = 48)
const C3 = 48, D = 50, E = 52, F = 53, G = 55, A = 57, Bb = 58;

// ---------------- 로비: 밝고 경쾌한 캐주얼 (C장조, 116bpm, 16마디) ----------------
const LOBBY_A: Note[][] = [
  [[0, 0.5, 76], [0.5, 0.5, 79], [1, 1, 84], [2, 0.5, 79], [2.5, 0.5, 76], [3, 1, 79]],
  [[0, 0.5, 81], [0.5, 0.5, 84], [1, 1, 88], [2, 1, 84], [3, 1, 81]],
  [[0, 0.5, 77], [0.5, 0.5, 81], [1, 0.5, 84], [1.5, 0.5, 81], [2, 1, 77], [3, 0.5, 81], [3.5, 0.5, 84]],
  [[0, 1, 83], [1, 0.5, 86], [1.5, 0.5, 83], [2, 2, 79]],
];
const LOBBY_A2_END: Note[] = [[0, 0.5, 83], [0.5, 0.5, 81], [1, 0.5, 79], [1.5, 0.5, 77], [2, 0.5, 76], [2.5, 0.5, 74], [3, 1, 79]];
const LOBBY_B: Note[][] = [
  [[0, 1.5, 81], [1.5, 0.5, 79], [2, 1, 77], [3, 1, 84]],
  [[0, 1.5, 83], [1.5, 0.5, 81], [2, 1, 79], [3, 1, 86]],
  [[0, 1, 88], [1, 0.5, 86], [1.5, 0.5, 84], [2, 1, 83], [3, 1, 79]],
  [[0, 2, 81], [2.5, 0.5, 84], [3, 1, 88]],
];
const LOBBY_C: Note[][] = [
  [[0, 0.5, 81], [0.5, 0.5, 84], [1, 1, 89], [2, 0.5, 88], [2.5, 0.5, 86], [3, 1, 84]],
  [[0, 0.5, 86], [0.5, 0.5, 83], [1, 1, 79], [2, 0.5, 81], [2.5, 0.5, 83], [3, 1, 86]],
  [[0, 1, 84], [1, 0.5, 79], [1.5, 0.5, 76], [2, 1, 79], [3, 1, 84]],
  [[0, 1.5, 88], [1.5, 0.5, 86], [2, 0.5, 84], [2.5, 0.5, 83], [3, 1, 79]],
];
const LOBBY: Track = {
  bpm: 116,
  chords: [
    C(C3), C(A, true), C(F), C(G),
    C(C3), C(A, true), C(F), C(G),
    C(F), C(G), C(E, true), C(A, true),
    C(F), C(G), C(C3), [[0, C(C3)], [2, C(G)]],
  ],
  melody: [...LOBBY_A, ...LOBBY_A.slice(0, 3), LOBBY_A2_END, ...LOBBY_B, ...LOBBY_C],
  lead: 'pluck',
  leadGain: 0.42,
  bass: 'bounce',
  pad: 0.06,
  drums: { k: 'x.......x.......', s: '....x.......x...', h: '..x...x...x...x.', p: '.......x.....x..' },
  drumGain: 0.5,
  tail: 1.5,
};

// ---------------- 전투: 빠르고 신나는 (A단조 느낌의 C장조, 148bpm, 16마디) ----------------
const HOOK: Note[][] = [
  [[0, 0.5, 81], [0.5, 0.5, 84], [1, 0.5, 88], [1.5, 0.5, 84], [2, 0.5, 86], [2.5, 0.5, 84], [3, 1, 81]],
  [[0, 0.5, 81], [0.5, 0.5, 84], [1, 0.5, 89], [1.5, 0.5, 88], [2, 1, 84], [3, 1, 81]],
  [[0, 0.5, 79], [0.5, 0.5, 84], [1, 0.5, 88], [1.5, 0.5, 91], [2, 0.5, 88], [2.5, 0.5, 84], [3, 1, 86]],
  [[0, 0.5, 83], [0.5, 0.5, 86], [1, 1, 91], [2, 0.5, 88], [2.5, 0.5, 86], [3, 1, 83]],
];
const HOOK_END: Note[] = [[0, 0.5, 83], [0.5, 0.5, 86], [1, 0.5, 91], [1.5, 0.5, 89], [2, 0.5, 88], [2.5, 0.5, 86], [3, 0.5, 83], [3.5, 0.5, 79]];
const BATTLE: Track = {
  bpm: 148,
  chords: Array.from({ length: 16 }, (_, i) => [C(A, true), C(F), C(C3), C(G)][i % 4]!),
  melody: [[], [], [], [], ...HOOK, [], [], [], [], ...HOOK.slice(0, 3), HOOK_END],
  lead: 'square',
  leadGain: 0.2,
  bass: 'drive',
  pad: 0.04,
  drums: { k: 'x...x...x...x...', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', o: '..x...x...x...x.' },
  drumGain: 0.55,
  arp: { gain: 0.09, bars: (b) => b < 4 || (b >= 8 && b < 12) },
  tail: 1.2,
};

// ---------------- 승리: 밝고 신나는 팡파르 (C장조, 132bpm, 8마디) ----------------
const VICTORY: Track = {
  bpm: 132,
  chords: [C(C3), C(F), C(G), C(C3), C(A, true), C(F), C(G), C(C3)],
  melody: [
    [[0, 0.5, 79], [0.5, 0.5, 84], [1, 1, 88], [2, 0.5, 86], [2.5, 0.5, 84], [3, 1, 88]],
    [[0, 1, 89], [1, 0.5, 88], [1.5, 0.5, 86], [2, 1, 84], [3, 1, 81]],
    [[0, 0.5, 83], [0.5, 0.5, 84], [1, 1, 86], [2, 1, 91], [3, 0.5, 89], [3.5, 0.5, 86]],
    [[0, 2, 88], [2, 1, 84], [3, 1, 79]],
    [[0, 0.5, 81], [0.5, 0.5, 84], [1, 1, 88], [2, 0.5, 86], [2.5, 0.5, 84], [3, 1, 88]],
    [[0, 0.5, 89], [0.5, 0.5, 88], [1, 0.5, 86], [1.5, 0.5, 84], [2, 1, 81], [3, 1, 84]],
    [[0, 1, 86], [1, 0.5, 83], [1.5, 0.5, 86], [2, 1.5, 91], [3.5, 0.5, 89]],
    [[0, 1, 88], [1, 1, 91], [2, 2, 84]],
  ],
  lead: 'square',
  leadGain: 0.3,
  bass: 'bounce',
  pad: 0.07,
  drums: { k: 'x.......x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', p: '...x.......x....' },
  drumGain: 0.5,
  tail: 1.5,
};

// ---------------- 패배: 가볍고 아쉬운 (F장조, 88bpm, 8마디) ----------------
const DEFEAT: Track = {
  bpm: 88,
  chords: [C(F), C(A, true), C(Bb), C(C3), C(D, true), C(Bb), C(F), C(C3)],
  melody: [
    [[0, 1.5, 81], [1.5, 0.5, 79], [2, 2, 77]],
    [[0, 1, 76], [1, 1, 79], [2, 2, 84]],
    [[0, 1.5, 86], [1.5, 0.5, 84], [2, 1, 82], [3, 1, 81]],
    [[0, 3, 79]],
    [[0, 1, 77], [1, 1, 81], [2, 2, 86]],
    [[0, 1, 86], [1, 0.5, 84], [1.5, 0.5, 82], [2, 1, 81], [3, 1, 79]],
    [[0, 1.5, 81], [1.5, 0.5, 79], [2, 1, 77], [3, 1, 76]],
    [[0, 2, 79], [2, 2, 72]],
  ],
  lead: 'soft',
  leadGain: 0.36,
  bass: 'soft',
  pad: 0.08,
  drums: { k: 'x.......x.......', h: '..x...x...x...x.' },
  drumGain: 0.3,
  tail: 2,
};

const TRACKS: Record<MusicId, Track> = { lobby: LOBBY, battle: BATTLE, victory: VICTORY, defeat: DEFEAT };

function chordAt(t: Track, bar: number, beat: number): Chord {
  const c = t.chords[bar % t.chords.length]!;
  if (!Array.isArray(c)) return c;
  let cur = c[0]![1];
  for (const [b, ch] of c) if (beat >= b) cur = ch;
  return cur;
}

function triad(c: Chord): number[] {
  return [0, c.minor ? 3 : 4, 7].map((i) => c.root + i);
}

// ---- 악기 ----

function lead(ctx: BaseAudioContext, out: AudioNode, kind: Track['lead'], t: number, dur: number, midi: number, gain: number): void {
  const f = hz(midi);
  if (kind === 'pluck') {
    // 마림바 느낌: 사인 + 높은 배음, 빠른 감쇠
    tone(ctx, out, { t, f0: f, attack: 0.004, decay: Math.min(0.5, dur * 0.9 + 0.12), peak: gain, pan: -0.15 });
    tone(ctx, out, { t, f0: f * 4, attack: 0.002, decay: 0.06, peak: gain * 0.18, pan: -0.15 });
  } else if (kind === 'square') {
    tone(ctx, out, { t, type: 'square', f0: f, attack: 0.008, hold: dur * 0.55, decay: dur * 0.5 + 0.06, peak: gain, lowpass: 2600, pan: 0.1 });
    tone(ctx, out, { t, type: 'triangle', f0: f * 2, attack: 0.008, decay: dur * 0.5, peak: gain * 0.35, pan: -0.1 });
  } else {
    tone(ctx, out, { t, type: 'triangle', f0: f, attack: 0.03, hold: dur * 0.4, decay: dur * 0.7 + 0.2, peak: gain, vibrato: [5, 3], pan: -0.1 });
  }
}

function kick(ctx: BaseAudioContext, out: AudioNode, t: number, g: number): void {
  tone(ctx, out, { t, f0: 150, f1: 45, glide: 0.12, decay: 0.16, peak: g });
}
function snare(ctx: BaseAudioContext, out: AudioNode, t: number, g: number): void {
  noise(ctx, out, { t, decay: 0.11, peak: g * 0.6, filter: 'bandpass', f0: 1900, q: 0.9 });
  tone(ctx, out, { t, type: 'triangle', f0: 220, f1: 160, decay: 0.06, peak: g * 0.35 });
}
function hat(ctx: BaseAudioContext, out: AudioNode, t: number, g: number, open = false): void {
  noise(ctx, out, { t, decay: open ? 0.12 : 0.03, peak: g * (open ? 0.22 : 0.28), filter: 'highpass', f0: 7000, pan: 0.2 });
}
function bubble(ctx: BaseAudioContext, out: AudioNode, t: number, g: number, r: () => number): void {
  const f = 700 + r() * 600;
  tone(ctx, out, { t, f0: f, f1: f * 1.8, glide: 0.03, decay: 0.05, peak: g * 0.35, pan: r() * 0.8 - 0.4 });
}

/** 곡 하나를 굽는다 (반복 길이에 딱 맞는 버퍼) */
export async function renderMusic(id: MusicId, target: BaseAudioContext): Promise<AudioBuffer> {
  const t = TRACKS[id];
  const rate = MIX.musicRate;
  const beat = 60 / t.bpm;
  const bars = t.chords.length;
  const loopLen = bars * 4 * beat;
  const ch = MIX.musicChannels;
  const ctx = new OfflineAudioContext(ch, Math.ceil((loopLen + t.tail) * rate), rate);
  const out = ctx.createGain();
  out.gain.value = 0.8;
  out.connect(ctx.destination);
  const r = rng(id.length * 7919 + t.bpm);
  const step = beat / 4;

  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * 4 * beat;
    // 멜로디
    for (const [b, len, midi] of t.melody[bar] ?? []) lead(ctx, out, t.lead, t0 + b * beat, len * beat, midi, t.leadGain);
    // 화음 패드 (옥타브 위 세 음, 느린 시작)
    for (const half of [0, 2]) {
      const ch = chordAt(t, bar, half);
      for (const m of triad(ch)) {
        tone(ctx, out, { t: t0 + half * beat, type: 'triangle', f0: hz(m + 12), attack: 0.08, hold: beat * 1.4, decay: beat * 0.8, peak: t.pad, pan: (m % 3) * 0.3 - 0.3 });
      }
    }
    // 베이스
    for (let b = 0; b < 4; b++) {
      const ch = chordAt(t, bar, b);
      const root = hz(ch.root - 12);
      const fifth = hz(ch.root - 12 + 7);
      if (t.bass === 'bounce') {
        tone(ctx, out, { t: t0 + b * beat, type: 'triangle', f0: root, attack: 0.005, hold: beat * 0.25, decay: beat * 0.3, peak: 0.42 });
        tone(ctx, out, { t: t0 + (b + 0.5) * beat, type: 'triangle', f0: b % 2 ? fifth : root * 2, attack: 0.005, decay: beat * 0.25, peak: 0.24 });
      } else if (t.bass === 'drive') {
        for (const e of [0, 0.5]) tone(ctx, out, { t: t0 + (b + e) * beat, type: 'sawtooth', f0: e ? root * 2 : root, attack: 0.004, hold: beat * 0.2, decay: beat * 0.25, peak: 0.2, lowpass: 700 });
      } else if (b % 2 === 0) {
        tone(ctx, out, { t: t0 + b * beat, type: 'triangle', f0: root, attack: 0.02, hold: beat * 0.9, decay: beat * 0.8, peak: 0.36 });
      }
    }
    // 아르페지오 (16분음표 화음 오르내림)
    if (t.arp && (!t.arp.bars || t.arp.bars(bar))) {
      for (let i = 0; i < 16; i++) {
        const ch = chordAt(t, bar, i / 4);
        const notes = triad(ch).map((m) => m + 24);
        const seq = [0, 1, 2, 1];
        tone(ctx, out, { t: t0 + i * step, type: 'square', f0: hz(notes[seq[i % 4]!]! + (i % 8 >= 4 ? 12 : 0)), attack: 0.003, decay: step * 0.9, peak: t.arp.gain, lowpass: 3000, pan: 0.25 });
      }
    }
    // 드럼
    const d = t.drums;
    const g = t.drumGain;
    for (let i = 0; i < 16; i++) {
      const tt = t0 + i * step;
      if (d.k?.[i] === 'x') kick(ctx, out, tt, g);
      if (d.s?.[i] === 'x') snare(ctx, out, tt, g);
      if (d.h?.[i] === 'x') hat(ctx, out, tt, g);
      if (d.o?.[i] === 'x') hat(ctx, out, tt, g, true);
      if (d.p?.[i] === 'x' && r() < 0.8) bubble(ctx, out, tt, g, r);
    }
  }

  const raw = await ctx.startRendering();
  // 넘친 여운을 앞부분에 더해 반복 이음매를 없앰 → 반복 길이만큼 잘라 재생용 버퍼로
  const n = Math.round(loopLen * rate);
  const loop = target.createBuffer(ch, n, rate);
  for (let c = 0; c < ch; c++) {
    const src = raw.getChannelData(c);
    const dst = loop.getChannelData(c);
    dst.set(src.subarray(0, n));
    for (let i = n; i < src.length; i++) dst[i - n] = dst[i - n]! + src[i]!;
  }
  return loop;
}

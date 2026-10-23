// 합성 도구 (효과음·배경음 공용): OfflineAudioContext에 음·잡음을 예약해 버퍼로 굽는다.
// 모든 소리는 이 도구로 코드에서 직접 만든 것 (녹음·외부 샘플 없음).

/** 시드 고정 난수 (같은 시드 = 같은 소리 → 빌드마다 같은 결과) */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a ^= a << 13;
    a ^= a >>> 17;
    a ^= a << 5;
    return (a >>> 0) / 4294967296;
  };
}

/** 음 높이: MIDI 번호 → Hz */
export function hz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export interface Env {
  /** 시작 시각 (s) */
  t: number;
  /** 올라가는 시간 (s) */
  attack?: number;
  /** 최고점 유지 (s) */
  hold?: number;
  /** 줄어드는 시간 (s) */
  decay: number;
  peak: number;
}

/** 감쇠 엔벨로프 게인 (attack 선형 → hold → decay 지수) */
export function envelope(ctx: BaseAudioContext, e: Env): GainNode {
  const g = ctx.createGain();
  const a = Math.max(0.001, e.attack ?? 0.002);
  const h = e.hold ?? 0;
  g.gain.setValueAtTime(0, e.t);
  g.gain.linearRampToValueAtTime(e.peak, e.t + a);
  if (h > 0) g.gain.setValueAtTime(e.peak, e.t + a + h);
  g.gain.exponentialRampToValueAtTime(0.0001, e.t + a + h + e.decay);
  g.gain.setValueAtTime(0, e.t + a + h + e.decay + 0.01);
  return g;
}

export interface ToneOpts extends Env {
  type?: OscillatorType;
  /** 시작 주파수 (Hz) */
  f0: number;
  /** 끝 주파수 (없으면 고정) */
  f1?: number;
  /** f0 → f1 걸리는 시간 (기본 = 전체 길이) */
  glide?: number;
  /** 저역 통과 (부드럽게) */
  lowpass?: number;
  /** 떨림 (속도 Hz, 깊이 Hz) */
  vibrato?: [number, number];
  /** 좌우 (-1..1, 배경음용) */
  pan?: number;
}

/** 음 하나 (끝 시각 반환) */
export function tone(ctx: BaseAudioContext, out: AudioNode, o: ToneOpts): number {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  const end = o.t + (o.attack ?? 0.002) + (o.hold ?? 0) + o.decay;
  osc.frequency.setValueAtTime(o.f0, o.t);
  if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), o.t + (o.glide ?? end - o.t));
  if (o.vibrato) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = o.vibrato[0];
    depth.gain.value = o.vibrato[1];
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(o.t);
    lfo.stop(end + 0.02);
  }
  let node: AudioNode = osc;
  if (o.lowpass) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lowpass;
    f.Q.value = 0.5;
    node = node.connect(f);
  }
  node = node.connect(envelope(ctx, o));
  if (o.pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    node = node.connect(p);
  }
  node.connect(out);
  osc.start(o.t);
  osc.stop(end + 0.02);
  return end;
}

export interface NoiseOpts extends Env {
  filter: BiquadFilterType;
  /** 필터 시작 주파수 */
  f0: number;
  /** 필터 끝 주파수 (없으면 고정) */
  f1?: number;
  q?: number;
  pan?: number;
}

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** 백색 잡음 1초 (컨텍스트마다 한 번) */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    const len = ctx.sampleRate;
    b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    const r = rng(12345);
    for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

/** 걸러 낸 잡음 한 덩이 (끝 시각 반환) */
export function noise(ctx: BaseAudioContext, out: AudioNode, o: NoiseOpts): number {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const end = o.t + (o.attack ?? 0.002) + (o.hold ?? 0) + o.decay;
  const f = ctx.createBiquadFilter();
  f.type = o.filter;
  f.Q.value = o.q ?? 0.8;
  f.frequency.setValueAtTime(o.f0, o.t);
  if (o.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), end);
  let node: AudioNode = src.connect(f).connect(envelope(ctx, o));
  if (o.pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    node = node.connect(p);
  }
  node.connect(out);
  src.start(o.t, Math.random() * 0.5);
  src.stop(end + 0.02);
  return end;
}

/** 최고점을 peak로 맞춤 (소리마다 크기를 설정값으로만 정하게) */
export function normalize(buffer: AudioBuffer, peak = 0.9): AudioBuffer {
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i]!));
  }
  if (max > 1e-6) {
    const k = peak / max;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = d[i]! * k;
    }
  }
  return buffer;
}

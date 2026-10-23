import { SOUND_FILES, SOUND_LIMITS, type SoundId } from '../config/audio';

/**
 * 효과음 관리. 게임 코드는 play(id)만 부른다.
 * - SOUND_FILES에 WAV/OGG 경로가 있으면 그 파일을 재생 (unlock 때 미리 불러옴)
 * - 없거나 불러오기에 실패하면 Web Audio 합성음(임시)으로 재생
 * 동시에 많이 울려도 커지지 않게: 종류별 동시 재생 수·최소 간격 제한 + 마스터 압축기.
 */
/** pitch: 음 높이 배율 (무기별 발사음 차이) */
type Build = (ctx: AudioContext, out: AudioNode, t: number, pitch: number) => number;

const IDS: SoundId[] = ['fire', 'hit', 'impact', 'kill', 'reloadStart', 'reloadEnd', 'swing'];

export class AudioManager {
  private ctx: AudioContext | null = null;
  /** 효과음 버스 (모든 효과음 → 압축기 → 출력) */
  private master: GainNode | null = null;
  /** 배경음 버스 (음악 → 출력, 효과음 압축기와 별개). 아직 음악 에셋이 없어 연결된 소리 없음 */
  private music: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly buffers = new Map<SoundId, AudioBuffer>();
  /** 제한 채널별 (기본 = 소리 id, 봇 소리는 별도 채널이라 플레이어 소리를 밀어내지 않음) */
  private readonly active = new Map<string, number>();
  private readonly last = new Map<string, number>();
  private readonly synths: Record<SoundId, Build> = {
    fire: (c, o, t, p) => this.synthFire(c, o, t, p),
    hit: (c, o, t, p) => this.synthHit(c, o, t, p),
    impact: (c, o, t) => this.synthImpact(c, o, t),
    kill: (c, o, t, p) => this.synthKill(c, o, t, p),
    reloadStart: (c, o, t) => this.synthClick(c, o, t, 700),
    reloadEnd: (c, o, t) => this.synthClick(c, o, t, 1100),
    swing: (c, o, t) => this.synthSwing(c, o, t),
  };
  volume = 0.6;
  musicVolume = 0.5;

  /** 효과음 크기 (설정 화면). 오디오가 아직 시작 전이면 시작할 때 이 값으로 */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  /** 배경음 크기 (설정 화면) */
  setMusicVolume(v: number): void {
    this.musicVolume = Math.min(1, Math.max(0, v));
    if (this.music) this.music.gain.value = this.musicVolume;
  }

  /** 배경음을 연결할 버스 (음악 재생이 생기면 여기에 연결, 오디오 시작 전이면 null) */
  get musicOutput(): AudioNode | null {
    return this.music;
  }

  /** 사용자 입력(클릭) 뒤에 호출해야 브라우저가 소리를 허용한다 */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(comp).connect(this.ctx.destination);
      this.music = this.ctx.createGain();
      this.music.gain.value = this.musicVolume;
      this.music.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.25);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      void this.loadFiles(this.ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** 이 소리가 파일로 재생되는지, 합성음인지 (디버그) */
  source(id: SoundId): 'file' | 'synth' {
    return this.buffers.has(id) ? 'file' : 'synth';
  }

  /**
   * 효과음 재생. 헤드샷은 따로 없고 hit를 높은 음(pitch)으로 쓴다.
   * @param opts.gain 추가 음량 배율 (거리 감쇠 등)
   * @param opts.channel 동시 재생 제한 채널 (기본 = id)
   * @param opts.pitch 음 높이 배율 (합성음은 주파수, 파일은 재생 속도)
   */
  play(id: SoundId, opts?: { gain?: number; channel?: string; pitch?: number }): void {
    const gain = opts?.gain ?? 1;
    if (gain <= 0.01) return;
    const pitch = opts?.pitch ?? 1;
    const buffer = this.buffers.get(id);
    this.voice(id, opts?.channel ?? id, gain, (ctx, out, t) => {
      if (buffer) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = pitch;
        src.connect(out);
        src.start(t);
        return buffer.duration / pitch;
      }
      return this.synths[id](ctx, out, t, pitch);
    });
  }

  /** 설정된 사운드 파일을 불러온다. 실패한 것은 합성음으로 남는다 */
  private async loadFiles(ctx: AudioContext): Promise<void> {
    await Promise.all(
      IDS.map(async (id) => {
        const url = SOUND_FILES[id];
        if (!url) return;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.buffers.set(id, await ctx.decodeAudioData(await res.arrayBuffer()));
        } catch (err) {
          console.warn(`[audio] ${id} 파일을 불러오지 못해 합성음 사용: ${url}`, err);
        }
      }),
    );
  }

  /** 종류별 동시 재생 수·최소 간격 제한 후 재생 */
  private voice(id: SoundId, channel: string, gain: number, build: Build): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const lim = SOUND_LIMITS[id];
    const now = ctx.currentTime;
    const active = this.active.get(channel) ?? 0;
    if (active >= lim.voices || now - (this.last.get(channel) ?? -1) < lim.minInterval) return;
    this.last.set(channel, now);
    this.active.set(channel, active + 1);
    const bus = ctx.createGain();
    bus.gain.value = lim.gain * gain;
    bus.connect(this.master);
    const dur = build(ctx, bus, now, 1);
    window.setTimeout(() => {
      this.active.set(channel, (this.active.get(channel) ?? 1) - 1);
      bus.disconnect();
    }, (dur + 0.05) * 1000);
  }

  // ---- 임시 합성음 (실제 파일이 있으면 쓰이지 않음) ----

  /** 장난감 총 "퓻": 빠르게 내려가는 사각파 + 짧은 잡음 */
  private synthFire(ctx: AudioContext, out: AudioNode, t: number, pitch = 1): number {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime((950 + Math.random() * 80) * pitch, t);
    o.frequency.exponentialRampToValueAtTime(240 * pitch, t + 0.07);
    o.connect(env(ctx, t, 0.002, 0.08, 0.5)).connect(out);
    o.start(t);
    o.stop(t + 0.09);
    this.noiseBurst(ctx, out, t, 0.035, 'highpass', 2500, 0.35);
    return 0.1;
  }

  /** 적 명중 "톡": 맑은 높은 음 */
  private synthHit(ctx: AudioContext, out: AudioNode, t: number, pitch = 1): number {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(1400 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(2200 * pitch, t + 0.04);
    o.connect(env(ctx, t, 0.001, 0.06, 0.8)).connect(out);
    o.start(t);
    o.stop(t + 0.07);
    return 0.07;
  }

  /** 벽·바닥 "퍽": 낮은 잡음 + 짧은 저음 */
  private synthImpact(ctx: AudioContext, out: AudioNode, t: number): number {
    this.noiseBurst(ctx, out, t, 0.06, 'lowpass', 900, 0.9);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.06);
    o.connect(env(ctx, t, 0.001, 0.07, 0.6)).connect(out);
    o.start(t);
    o.stop(t + 0.08);
    return 0.08;
  }

  /** 처치 "띠링": 올라가는 세 음 */
  private synthKill(ctx: AudioContext, out: AudioNode, t: number, pitch = 1): number {
    [880 * pitch, 1320 * pitch, 1760 * pitch].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const st = t + i * 0.07;
      o.frequency.setValueAtTime(f, st);
      o.connect(env(ctx, st, 0.004, 0.16, 0.55)).connect(out);
      o.start(st);
      o.stop(st + 0.18);
    });
    return 0.36;
  }

  /** 재장전 "딸깍": 짧은 클릭 두 번 */
  private synthClick(ctx: AudioContext, out: AudioNode, t: number, freq: number): number {
    for (let i = 0; i < 2; i++) this.noiseBurst(ctx, out, t + i * 0.06, 0.02, 'bandpass', freq * (1 + i * 0.4), 0.8);
    return 0.12;
  }

  /** 근접 휘두르기 "휙": 짧은 대역 잡음 */
  private synthSwing(ctx: AudioContext, out: AudioNode, t: number): number {
    this.noiseBurst(ctx, out, t, 0.12, 'bandpass', 1400, 0.7);
    return 0.15;
  }

  private noiseBurst(ctx: AudioContext, out: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, level: number): void {
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    src.connect(f).connect(env(ctx, t, 0.001, dur, level)).connect(out);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.buffers.clear();
  }
}

/** 짧은 감쇠 엔벨로프 */
function env(ctx: AudioContext, t: number, attack: number, decay: number, peak: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

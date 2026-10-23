import { MIX, MUSIC, SOUNDS, SPATIAL, type MusicId, type SoundId } from '../config/audio';
import { renderMusic } from './musicTracks';
import { renderSfx } from './sfxBank';

/**
 * 소리 관리. 게임 코드는 play(id) · setMusic(id)만 부른다.
 * - 효과음·배경음은 전부 코드로 합성 (sfxBank · musicTracks): 오디오가 켜질 때 버퍼로 한 번 굽고 재생은 버퍼 재사용
 * - 버스: 효과음(압축기) · 배경음 → 마스터(음소거) → 출력
 * - 브라우저 자동 재생 정책: 첫 사용자 입력(클릭·터치·키)에서 attachUnlock이 오디오를 켬. 탭이 숨으면 멈춤
 * - 다른 캐릭터 소리(pos): 카메라(리스너)와의 거리로 줄이고 좌우로 나눔
 * - 종류(채널)별 동시 재생 수·최소 간격 제한 → 연사·봇 여럿이어도 겹쳐 커지지 않음
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayOpts {
  /** 추가 음량 배율 */
  gain?: number;
  /** 소리 난 곳 (없으면 내 소리: 바로·가운데) */
  pos?: Vec3 | null;
  /** 동시 재생 제한 채널 (기본 = 소리 id. 다른 캐릭터 소리는 따로 → 내 소리를 밀어내지 않음) */
  channel?: string;
  /** 음 높이 배율 */
  pitch?: number;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private readonly bank = new Map<SoundId, AudioBuffer[]>();
  private readonly music = new Map<MusicId, Promise<AudioBuffer | null>>();
  private current: { id: MusicId; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wanted: MusicId | null = null;
  private readonly active = new Map<string, number>();
  private readonly last = new Map<string, number>();
  private readonly listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
  private unlockOff: (() => void) | null = null;
  private hidden = false;

  /** 설정값 (UserSettings): 마스터 · 효과음 · 배경음 0..1, 음소거 */
  masterVolume = 0.8;
  volume = 0.6;
  musicVolume = 0.5;
  muted = false;

  /** 오디오가 켜져 소리가 나는 상태 */
  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** 효과음 버퍼가 준비됨 (테스트·디버그) */
  get ready(): boolean {
    return this.bank.size > 0;
  }

  /** 지금 배경음 */
  get currentMusic(): MusicId | null {
    return this.current?.id ?? null;
  }

  setMaster(v: number): void {
    this.masterVolume = clamp01(v);
    this.applyMaster();
  }

  setMuted(on: boolean): void {
    this.muted = on;
    this.applyMaster();
  }

  /** 효과음 크기 */
  setVolume(v: number): void {
    this.volume = clamp01(v);
    if (this.sfxBus) this.sfxBus.gain.value = this.volume;
  }

  /** 배경음 크기 */
  setMusicVolume(v: number): void {
    this.musicVolume = clamp01(v);
    if (this.musicBus) this.musicBus.gain.value = this.musicVolume;
  }

  /**
   * 첫 사용자 입력에서 오디오를 켬 (모바일 자동 재생 제한). 입력마다 멈춘 오디오를 다시 깨움 (iOS 전화·다른 앱 뒤)
   * + 탭이 숨으면 멈추고 돌아오면 다시 켬
   */
  attachUnlock(target: Window): void {
    if (this.unlockOff) return;
    const on = () => this.unlock();
    const opts = { capture: true, passive: true } as const;
    const types = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'] as const;
    for (const t of types) target.addEventListener(t, on, opts);
    const vis = () => {
      this.hidden = document.hidden;
      if (!this.ctx) return;
      if (this.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    };
    document.addEventListener('visibilitychange', vis);
    this.unlockOff = () => {
      for (const t of types) target.removeEventListener(t, on, opts);
      document.removeEventListener('visibilitychange', vis);
    };
  }

  /** 사용자 입력 안에서 호출해야 브라우저가 소리를 허용한다 */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      comp.connect(this.master);
      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = this.volume;
      this.sfxBus.connect(comp);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.musicVolume;
      this.musicBus.connect(this.master);
      this.applyMaster();
      void this.buildBank();
      // 효과음보다 늦게 원하던 곡이 정해졌을 수 있음
      if (this.wanted) this.startMusic(this.wanted);
    }
    if (this.ctx.state === 'suspended' && !this.hidden) void this.ctx.resume();
  }

  /** 리스너 = 카메라 (위치 + 오른쪽 방향, 매 프레임) */
  setListener(pos: Vec3, right: Vec3): void {
    const l = this.listener;
    l.x = pos.x;
    l.y = pos.y;
    l.z = pos.z;
    const len = Math.hypot(right.x, right.z) || 1;
    l.rx = right.x / len;
    l.rz = right.z / len;
  }

  /** 거리 감쇠 (pos 소리 크기 0..1, 너무 멀면 0) */
  falloff(pos: Vec3): number {
    const d = Math.hypot(pos.x - this.listener.x, pos.y - this.listener.y, pos.z - this.listener.z);
    if (d >= SPATIAL.far) return 0;
    if (d <= SPATIAL.near) return 1;
    const k = (d - SPATIAL.near) / (SPATIAL.far - SPATIAL.near);
    return (1 - k) ** 2;
  }

  /** 효과음 재생 */
  play(id: SoundId, opts?: PlayOpts): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    const variants = this.bank.get(id);
    if (!ctx || !bus || !variants || ctx.state !== 'running') return;
    const spec = SOUNDS[id];
    let gain = spec.gain * (opts?.gain ?? 1);
    let pan = 0;
    const pos = opts?.pos;
    if (pos) {
      gain *= this.falloff(pos);
      const dx = pos.x - this.listener.x;
      const dz = pos.z - this.listener.z;
      const len = Math.hypot(dx, dz);
      if (len > 0.5) pan = ((dx * this.listener.rx + dz * this.listener.rz) / len) * SPATIAL.pan;
    }
    if (gain <= 0.004) return;
    const channel = opts?.channel ?? id;
    const now = ctx.currentTime;
    const active = this.active.get(channel) ?? 0;
    if (active >= spec.voices || now - (this.last.get(channel) ?? -1) < spec.minInterval) return;
    this.last.set(channel, now);
    this.active.set(channel, active + 1);

    const src = ctx.createBufferSource();
    src.buffer = variants[Math.floor(Math.random() * variants.length)]!;
    src.playbackRate.value = (opts?.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * spec.jitter);
    const g = ctx.createGain();
    g.gain.value = gain;
    let node: AudioNode = src.connect(g);
    let panner: StereoPannerNode | null = null;
    if (pan !== 0 && ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      node = node.connect(panner);
    }
    node.connect(bus);
    src.onended = () => {
      this.active.set(channel, Math.max(0, (this.active.get(channel) ?? 1) - 1));
      src.disconnect();
      g.disconnect();
      panner?.disconnect();
    };
    src.start(now);
  }

  /**
   * 배경음 바꾸기 (null = 끄기). 같은 곡이면 그대로 이어서. 이전 곡은 페이드아웃, 새 곡은 페이드인 → 겹쳐 두 곡이 계속 나는 일 없음.
   * 곡은 처음 필요할 때 구움 (굽는 동안 다른 곡으로 바뀌면 그 곡은 재생하지 않음)
   */
  setMusic(id: MusicId | null): void {
    if (id === this.wanted) return;
    this.wanted = id;
    this.fadeOutCurrent();
    if (id && this.ctx) this.startMusic(id);
  }

  private startMusic(id: MusicId): void {
    const ctx = this.ctx;
    if (!ctx) return;
    void this.track(id).then((buffer) => {
      if (!buffer || this.wanted !== id || this.current?.id === id || !this.musicBus) return;
      this.fadeOutCurrent();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const gain = ctx.createGain();
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(MUSIC[id].gain, t + MIX.musicFade);
      src.connect(gain).connect(this.musicBus);
      src.start(t);
      this.current = { id, src, gain };
    });
  }

  private fadeOutCurrent(): void {
    const cur = this.current;
    const ctx = this.ctx;
    if (!cur || !ctx) return;
    this.current = null;
    const t = ctx.currentTime;
    cur.gain.gain.cancelScheduledValues(t);
    cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
    cur.gain.gain.linearRampToValueAtTime(0, t + MIX.musicFade);
    cur.src.stop(t + MIX.musicFade + 0.05);
    cur.src.onended = () => {
      cur.src.disconnect();
      cur.gain.disconnect();
    };
  }

  /** 곡 버퍼 (한 번만 굽고 재사용) */
  private track(id: MusicId): Promise<AudioBuffer | null> {
    let p = this.music.get(id);
    if (!p) {
      const ctx = this.ctx!;
      p = renderMusic(id, ctx).catch((err) => {
        console.warn(`[audio] 배경음 ${id}을 만들지 못함`, err);
        return null;
      });
      this.music.set(id, p);
    }
    return p;
  }

  /** 효과음 전부 굽기 (변형 포함, 수십 ms). 끝나면 다른 곡도 미리 구워 둠 (전환 때 기다림 없게) */
  private async buildBank(): Promise<void> {
    const ids = Object.keys(SOUNDS) as SoundId[];
    await Promise.all(
      ids.map(async (id) => {
        try {
          const list = await Promise.all(Array.from({ length: SOUNDS[id].variants }, (_, v) => renderSfx(id, v)));
          this.bank.set(id, list);
        } catch (err) {
          console.warn(`[audio] 효과음 ${id}을 만들지 못함`, err);
        }
      }),
    );
    for (const id of ['lobby', 'battle', 'victory', 'defeat'] as const) {
      await this.track(id);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private applyMaster(): void {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.masterVolume;
  }

  dispose(): void {
    this.unlockOff?.();
    this.unlockOff = null;
    void this.ctx?.close();
    this.ctx = null;
    this.bank.clear();
    this.music.clear();
    this.current = null;
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

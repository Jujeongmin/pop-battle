import * as THREE from 'three';
import { FOOTSTEP, MIX, type MusicId, type SoundId } from '../config/audio';
import type { PlayerAvatar } from '../player/PlayerAvatar';
import type { AudioManager, Vec3 } from './AudioManager';

/** 소리를 내는 캐릭터 (내 캐릭터·봇·원격 플레이어) */
export interface SoundActor {
  key: string;
  avatar: PlayerAvatar;
  pos: Vec3;
  local: boolean;
}

export interface SoundFrame {
  camera: THREE.Camera;
  actors: readonly SoundActor[];
  /** 지금 화면의 배경음 (null = 끔) */
  music: MusicId | null;
  /** 시작 카운트다운 남은 초 (카운트다운이 아니면 null) */
  countdown: number | null;
}

const _right = new THREE.Vector3();
const _pos = new THREE.Vector3();

/**
 * 상태를 보고 정하는 소리 (Game이 매 프레임 update):
 * - 발소리: 걷기·달리기 애니메이션의 발 닿는 위치(FOOTSTEP)를 지날 때 → 이동 속도·애니메이션과 맞고, 멈추면 바로 멈춤
 * - 점프·착지·슬라이딩 시작 (아바타 motion)
 * - 다른 캐릭터 소리는 카메라 기준 거리·좌우
 * - 카운트다운 3·2·1, 화면별 배경음
 * - UI 버튼 클릭 (화면 전체 위임, 따로 정한 UI 소리가 같은 클릭에 나면 일반 클릭음은 생략)
 */
export class GameSounds {
  private readonly phase = new Map<string, number | null>();
  private readonly sliding = new Map<string, boolean>();
  private lastCount = -1;
  /** 따로 정한 UI 소리 횟수 (같은 클릭 안에서 늘었으면 일반 클릭음 생략) */
  private uiMark = 0;
  private readonly abort = new AbortController();

  constructor(
    private readonly audio: AudioManager,
    root: HTMLElement,
  ) {
    root.addEventListener('click', this.onClick, { capture: true, signal: this.abort.signal });
  }

  /** 따로 정한 UI 소리 (캐릭터 선택·무기 장착·메뉴 열기 등) — 같은 클릭의 일반 클릭음 대신 */
  ui(id: SoundId): void {
    this.uiMark++;
    this.audio.play(id);
  }

  update(f: SoundFrame): void {
    const cam = f.camera;
    cam.updateMatrixWorld();
    _right.setFromMatrixColumn(cam.matrixWorld, 0);
    this.audio.setListener(cam.getWorldPosition(_pos), _right);
    this.audio.setMusic(f.music);

    const seen = new Set<string>();
    for (const a of f.actors) {
      seen.add(a.key);
      this.actor(a);
    }
    for (const key of [...this.phase.keys()]) {
      if (!seen.has(key)) {
        this.phase.delete(key);
        this.sliding.delete(key);
      }
    }

    // 카운트다운 3·2·1 (GO는 매치 시작 때 Game이)
    if (f.countdown !== null) {
      const n = Math.ceil(f.countdown);
      if (n !== this.lastCount && n >= 1 && n <= 3) this.audio.play('countTick');
      this.lastCount = n;
    } else {
      this.lastCount = -1;
    }
  }

  private actor(a: SoundActor): void {
    const m = a.avatar.motion;
    const pos = a.local ? null : a.pos;
    const other = a.local ? undefined : 'other';
    const gain = a.local ? 1 : MIX.otherGain;
    if (m.dead) {
      this.phase.set(a.key, null);
      return;
    }
    // 점프·착지·슬라이딩 시작
    if (m.jumped) this.audio.play('jump', { pos, gain, channel: other && 'jumpOther' });
    if (m.landed && m.airTime >= FOOTSTEP.landMinAir) this.audio.play('land', { pos, gain, channel: other && 'landOther' });
    const wasSliding = this.sliding.get(a.key) ?? false;
    if (m.sliding && !wasSliding) this.audio.play('slide', { pos, gain, channel: other && 'slideOther' });
    this.sliding.set(a.key, m.sliding);

    // 발소리: 발 닿는 위치를 지날 때 (뒤로 걷기 = 진행이 거꾸로)
    const step = a.avatar.stepPhase();
    const prev = this.phase.get(a.key) ?? null;
    this.phase.set(a.key, step ? step.phase : null);
    if (!step || prev === null) return;
    const cur = step.phase;
    const contacts = step.run ? FOOTSTEP.run : FOOTSTEP.walk;
    let hit = false;
    for (const c of contacts) if (crossed(prev, cur, c)) hit = true;
    if (!hit) return;
    this.audio.play(step.run ? 'stepRun' : 'stepWalk', {
      pos,
      gain: a.local ? 1 : FOOTSTEP.otherGain,
      channel: a.local ? undefined : `step:${a.key}`,
    });
  }

  private readonly onClick = (e: MouseEvent): void => {
    const t = e.target as Element | null;
    const btn = t?.closest?.('button, [role="button"], a[href], .lb-card, .cs-card, .lo-btn, label.lb-toggle');
    // 전투 터치 버튼·HUD는 제외 (조작 소리와 겹치지 않게), 잠긴 버튼도 제외
    if (!btn || btn.closest('.touch-layer, .debug-panel, .net-panel') || (btn as HTMLButtonElement).disabled) return;
    const mark = this.uiMark;
    // 클릭 처리(선택·장착 등)가 끝난 뒤 확인 → 따로 정한 소리가 났으면 일반 클릭음 생략
    setTimeout(() => {
      if (this.uiMark === mark) this.audio.play('uiClick');
    }, 0);
  };

  dispose(): void {
    this.abort.abort();
  }
}

/** 진행 위치 prev → cur 사이에 c를 지났는지 (한 바퀴 넘어감·거꾸로 진행 포함) */
function crossed(prev: number, cur: number, c: number): boolean {
  const d = cur - prev;
  if (Math.abs(d) < 1e-6) return false;
  if (d > 0 && d < 0.5) return prev < c && c <= cur;
  if (d < 0 && d > -0.5) return cur <= c && c < prev;
  // 한 바퀴 넘어감
  if (d <= -0.5) return c > prev || c <= cur;
  return c < prev || c >= cur;
}

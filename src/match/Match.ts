import type { MatchRules } from '../config/match';
import { MatchStats, type DeathRecord, type Standing } from './MatchStats';

/**
 * 매치 진행 상태:
 * - WAITING: 시작 전 (시작 화면)
 * - COUNTDOWN: 시작 카운트다운 (전투·집계·타이머 정지)
 * - PLAYING: 전투 중 (킬·데스 집계, 타이머 진행)
 * - FINISHED: 종료 (전투 정지, 집계·리스폰 차단, 결과 확정)
 */
export type MatchState = 'WAITING' | 'COUNTDOWN' | 'PLAYING' | 'FINISHED';

export type FinishReason = 'score' | 'time';

export interface MatchResult {
  reason: FinishReason;
  standings: Standing[];
  /** 1위(최다 킬) 참가자 id. 2명 이상이면 무승부 */
  winners: string[];
  draw: boolean;
  /** 이 화면 플레이어 기준: 단독 1위 승리, 공동 1위 무승부, 그 외 패배 */
  localOutcome: 'win' | 'draw' | 'lose';
}

export interface MatchEvents {
  onStateChange?(state: MatchState, prev: MatchState): void;
  /** 매치 결과 확정 (매치마다 한 번만) */
  onFinish?(result: MatchResult): void;
  /** 집계된 사망 (킬 피드 등) */
  onDeath?(record: DeathRecord): void;
}

/**
 * 매치 하나의 진행·타이머·종료 판정 (렌더링과 무관, 모드 규칙은 MatchRules).
 * 게임 쪽은 사망 이벤트를 recordDeath로 넘기고, state·combatActive·respawnAllowed를 보고 전투·리스폰을 막는다.
 */
export class Match {
  readonly stats = new MatchStats();
  state: MatchState = 'WAITING';
  /** 남은 시간 (s) */
  timeLeft: number;
  /** 카운트다운 남은 시간 (s) */
  countdownLeft = 0;
  result: MatchResult | null = null;
  /** 매치 번호 (다시 플레이마다 +1, 이전 매치 이벤트 구분용) */
  round = 0;

  constructor(
    readonly rules: MatchRules,
    private readonly events: MatchEvents = {},
  ) {
    this.timeLeft = rules.timeLimit;
  }

  /** 전투 진행 중 (이동·사격·봇 AI·집계·타이머) */
  get combatActive(): boolean {
    return this.state === 'PLAYING';
  }

  /** 리스폰 가능 (종료 후에는 쓰러진 채로) */
  get respawnAllowed(): boolean {
    return this.state !== 'FINISHED';
  }

  /** 새 매치: 기록·타이머·결과 초기화 후 카운트다운 시작 (WAITING·FINISHED에서) */
  startCountdown(): void {
    this.round++;
    this.stats.reset();
    this.result = null;
    this.timeLeft = this.rules.timeLimit;
    this.countdownLeft = this.rules.countdown;
    this.setState('COUNTDOWN');
  }

  update(dt: number): void {
    if (this.state === 'COUNTDOWN') {
      this.countdownLeft -= dt;
      if (this.countdownLeft <= 0) {
        this.countdownLeft = 0;
        this.setState('PLAYING');
      }
    } else if (this.state === 'PLAYING') {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      if (this.timeLeft <= 0) this.finish('time');
    }
  }

  /**
   * 사망 이벤트. PLAYING에서만 집계 (카운트다운·종료 후에는 무시).
   * 목표 킬에 도달하면 즉시 종료 → 같은 프레임의 이후 사망은 집계되지 않음.
   */
  recordDeath(victimId: string, killerId: string | null): DeathRecord | null {
    if (this.state !== 'PLAYING') return null;
    const rec = this.stats.recordDeath(victimId, killerId);
    if (!rec) return null;
    this.events.onDeath?.(rec);
    if (rec.killer && (this.stats.get(rec.killer)?.kills ?? 0) >= this.rules.scoreToWin) this.finish('score');
    return rec;
  }

  /** 리스폰 알림 (다음 사망부터 다시 집계) */
  respawned(id: string): void {
    this.stats.respawned(id);
  }

  /** 종료 확정: PLAYING에서 한 번만 (타이머·킬 동시 발생해도 먼저 온 쪽 하나) */
  private finish(reason: FinishReason): void {
    if (this.state !== 'PLAYING') return;
    const standings = this.stats.standings();
    const top = standings[0]?.kills ?? 0;
    const winners = standings.filter((s) => s.kills === top).map((s) => s.id);
    const draw = winners.length > 1;
    const local = standings.find((s) => s.isLocal);
    const localOutcome = local && winners.includes(local.id) ? (draw ? 'draw' : 'win') : 'lose';
    this.result = { reason, standings, winners, draw, localOutcome };
    this.setState('FINISHED');
    this.events.onFinish?.(this.result);
  }

  private setState(next: MatchState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.events.onStateChange?.(next, prev);
  }
}

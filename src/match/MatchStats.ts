/**
 * 매치 참가자별 킬·데스 집계 (렌더링·물리와 무관한 순수 로직, 모드 공용).
 * - 한 번의 사망은 한 번만 집계: 사망 기록 후 respawned()가 호출되기 전까지 같은 참가자의 추가 사망은 무시
 * - 공격자 없는 사망(낙사·자살)·자기 자신에게 죽음은 데스만, 킬 없음
 * 나중에 서버 판정으로 옮길 때도 이 단위를 그대로 쓴다 (입력: 사망 이벤트, 출력: 기록·순위).
 */
export interface ParticipantInfo {
  readonly id: string;
  readonly name: string;
  /** 이 화면의 플레이어 */
  readonly isLocal: boolean;
  /** 진영 (TDM용, 개인전은 참가자마다 다름) */
  readonly team?: string;
}

export interface ParticipantRecord extends ParticipantInfo {
  kills: number;
  deaths: number;
  /** 집계상 살아 있음 (중복 사망 방지) */
  alive: boolean;
}

export interface Standing extends ParticipantRecord {
  /** 1부터. 킬·데스가 모두 같으면 같은 순위 */
  rank: number;
}

export interface DeathRecord {
  victim: string;
  /** 킬을 받은 참가자 (없으면 null) */
  killer: string | null;
}

export class MatchStats {
  private readonly records = new Map<string, ParticipantRecord>();
  private readonly order: string[] = [];

  register(info: ParticipantInfo): void {
    if (this.records.has(info.id)) return;
    this.records.set(info.id, { ...info, kills: 0, deaths: 0, alive: true });
    this.order.push(info.id);
  }

  get(id: string): ParticipantRecord | undefined {
    return this.records.get(id);
  }

  get count(): number {
    return this.order.length;
  }

  /** 새 매치: 모든 기록 0, 모두 살아 있음 */
  reset(): void {
    for (const r of this.records.values()) {
      r.kills = 0;
      r.deaths = 0;
      r.alive = true;
    }
  }

  /**
   * 사망 1회 기록. 이미 사망 처리된 참가자면 무시(null).
   * @param killerId 공격자 id (없거나 자기 자신이면 킬 없음)
   */
  recordDeath(victimId: string, killerId: string | null): DeathRecord | null {
    const victim = this.records.get(victimId);
    if (!victim || !victim.alive) return null;
    victim.alive = false;
    victim.deaths++;
    const killer = killerId && killerId !== victimId ? this.records.get(killerId) : undefined;
    if (killer) killer.kills++;
    return { victim: victimId, killer: killer ? killer.id : null };
  }

  /** 리스폰: 다음 사망부터 다시 집계 */
  respawned(id: string): void {
    const r = this.records.get(id);
    if (r) r.alive = true;
  }

  /** 순위표: 킬 내림차순 → 데스 오름차순 → 등록 순서. 킬·데스가 같으면 같은 순위 */
  standings(): Standing[] {
    const list = this.order.map((id) => this.records.get(id)!);
    const sorted = list
      .map((r, i) => ({ r, i }))
      .sort((a, b) => b.r.kills - a.r.kills || a.r.deaths - b.r.deaths || a.i - b.i)
      .map(({ r }) => r);
    const out: Standing[] = [];
    sorted.forEach((r, i) => {
      const prev = out[i - 1];
      const rank = prev && prev.kills === r.kills && prev.deaths === r.deaths ? prev.rank : i + 1;
      out.push({ ...r, rank });
    });
    return out;
  }

  /** 현재 순위 (없으면 0) */
  rankOf(id: string): number {
    return this.standings().find((s) => s.id === id)?.rank ?? 0;
  }
}

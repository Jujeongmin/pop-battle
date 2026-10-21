// 멀티플레이 테스트 HUD (검증용 최소 정보). 측정하지 못한 값은 '-'로 두고 임의 값을 넣지 않는다.
import { displayCode, type NetSession } from './NetSession';
import { NET_MAX_PLAYERS } from './shared/protocol';

export class NetTestHud {
  readonly root = document.createElement('div');
  private timer = 0;

  constructor(
    container: HTMLElement,
    private readonly session: NetSession,
    private readonly localHp: () => { hp: number; max: number },
  ) {
    this.root.className = 'net-test-hud';
    container.appendChild(this.root);
  }

  update(dt: number, visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
    if (!visible) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    const s = this.session;
    const c = s.client;
    const k = c.counters;
    const online = c.status === 'connected' && c.rsConnected && s.inRoom;
    const me = s.players[s.me];
    const oppEntry = Object.entries(s.players).find(([a]) => a !== s.me);
    const opp = oppEntry?.[1];
    const lh = this.localHp();
    const sim = c.sim.latencyMs > 0 || c.sim.jitterMs > 0 || c.sim.lossPct > 0;
    const rows: Array<[string, string, string?]> = [
      ['Room', displayCode(s.roomId) || '-'],
      ['Player', s.slot >= 0 ? `P${s.slot + 1} · ${short(s.me)}${s.isHost ? ' ★' : ''}` : short(s.me) || '-'],
      ['Players', `${Object.keys(s.players).length}/${NET_MAX_PLAYERS}`],
      ['Server', online ? 'Connected' : 'Disconnected', online ? 'ok' : 'bad'],
      ['RTT', k.rtt.samples > 0 ? `${Math.round(k.rtt.last)}ms (평균 ${Math.round(k.rtt.avg)})${sim ? ' SIM' : ''}` : '-'],
      ['My HP', me ? `${Math.round(lh.hp)}/${lh.max}${me.dead ? ' 사망' : ''}` : '-'],
      ['Opp HP', opp ? `${Math.round(opp.hp)}/${opp.max}${opp.dead ? ' 사망' : ''}${oppEntry && s.isLost(oppEntry[0]) ? ' (끊김)' : ''}` : '-'],
      ['Msgs', `보냄 ${k.sentStates + k.sentCalls} · 받음 ${k.recvStates + k.recvMessages}`],
      ['Error', k.lastError || (s.lastError ? s.lastError : '없음'), k.lastError || s.lastError ? 'bad' : undefined],
    ];
    this.root.innerHTML = '';
    const title = document.createElement('b');
    title.textContent = 'MULTIPLAYER TEST · 서버 판정';
    this.root.appendChild(title);
    for (const [label, value, cls] of rows) {
      const row = document.createElement('div');
      const l = document.createElement('span');
      l.textContent = label;
      const v = document.createElement('span');
      v.textContent = value;
      if (cls) v.className = cls;
      row.append(l, v);
      this.root.appendChild(row);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

function short(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

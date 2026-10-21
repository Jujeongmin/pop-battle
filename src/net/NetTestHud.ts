// 멀티플레이 테스트 HUD (검증용 최소 정보). 측정하지 못한 값은 '-'로 두고 임의 값을 넣지 않는다.
import { displayCode, type NetSession } from './NetSession';
import { NET_MAX_PLAYERS, NET_MODE_RULES } from './shared/protocol';

export class NetTestHud {
  readonly root = document.createElement('div');
  private timer = 0;

  constructor(
    container: HTMLElement,
    private readonly session: NetSession,
    private readonly localHp: () => { hp: number; max: number },
    private readonly fps: () => number,
  ) {
    this.root.className = 'net-test-hud';
    container.appendChild(this.root);
  }

  private readonly toastEl = document.createElement('div');
  private toastTimer = 0;

  /** 화면 위쪽 알림 (4초) */
  toast(text: string): void {
    if (!this.toastEl.isConnected) {
      this.toastEl.className = 'net-toast';
      this.root.parentElement?.appendChild(this.toastEl);
    }
    this.toastEl.textContent = text;
    this.toastEl.style.display = '';
    this.toastTimer = 4;
  }

  update(dt: number, visible: boolean): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.style.display = 'none';
    }
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
    const opps = Object.entries(s.players)
      .filter(([a]) => a !== s.me)
      .sort((a, b) => a[1].slot - b[1].slot);
    const lh = this.localHp();
    const sim = c.sim.latencyMs > 0 || c.sim.jitterMs > 0 || c.sim.lossPct > 0;
    const rows: Array<[string, string, string?]> = [
      ['Room', displayCode(s.roomId) || '-'],
      ['Player', s.slot >= 0 ? `P${s.slot + 1} · ${short(s.me)}${s.isHost ? ' ★' : ''}` : short(s.me) || '-'],
      ['Players', `${Object.keys(s.players).length}/${NET_MAX_PLAYERS}`],
      ['Mode', NET_MODE_RULES[s.mode].short],
      ['Match', `${s.matchPhase}${s.endAt > 0 && s.inMatch ? ` · 남은 ${Math.max(0, Math.ceil((s.endAt - Math.max(s.serverNow(), s.startAt)) / 1000))}s (서버)` : ''}${s.timeLimitMs > 0 && s.timeLimitMs !== NET_MODE_RULES[s.mode].timeLimitMs ? ' [테스트 시간]' : ''}`],
      ['FPS', String(Math.round(this.fps()))],
      ['Server', online ? 'Connected' : 'Disconnected', online ? 'ok' : 'bad'],
      ['RTT', k.rtt.samples > 0 ? `${Math.round(k.rtt.last)}ms (평균 ${Math.round(k.rtt.avg)})${sim ? ' SIM' : ''}` : '-'],
      ['My HP', me ? `${Math.round(lh.hp)}/${lh.max}${me.dead ? ' 사망' : ''}` : '-'],
      ...(opps.length
        ? opps.map(([a, p]): [string, string] => [`P${p.slot + 1} HP`, `${Math.round(p.hp)}/${p.max}${p.dead ? ' 사망' : ''}${s.isLost(a) ? ' (끊김)' : ''} · ${short(a)}`])
        : [['Opp HP', '-'] as [string, string]]),
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
    this.toastEl.remove();
    this.root.remove();
  }
}

function short(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

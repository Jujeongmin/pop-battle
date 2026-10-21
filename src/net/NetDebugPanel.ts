// 네트워크 테스트 패널 (NET_MODE에서만, F9로 접기/펴기). 실제 측정값과 시뮬레이션 값을 분리해 표시한다.
import type { NetGameMode } from './NetGameMode';
import { NET_MAX_PLAYERS, NET_TIMING } from './shared/protocol';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmt(ms: number): string {
  return Number.isFinite(ms) ? `${ms.toFixed(0)}ms` : '-';
}

function kb(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)}MB` : `${(bytes / 1024).toFixed(1)}KB`;
}

export class NetDebugPanel {
  readonly root = el('div', 'net-panel');
  private readonly info = el('pre', 'np-info');
  private readonly logBox = el('pre', 'np-log');
  private readonly codeInput = el('input', 'np-code');
  private readonly body = el('div', 'np-body');
  private timer = 0;
  private busy = false;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code === 'F9') {
      e.preventDefault();
      this.toggle();
    }
  };

  constructor(
    container: HTMLElement,
    private readonly mode: NetGameMode,
    private readonly characterId: () => string,
  ) {
    const s = mode.session;
    const c = s.client;
    const head = el('div', 'np-head');
    head.append(el('b', '', 'NETWORK TEST (2인 · Verse8)'), el('span', 'np-key', 'F9'));
    head.onclick = () => this.toggle();
    this.root.append(head, this.body);

    const btns = el('div', 'np-btns');
    const btn = (label: string, fn: () => Promise<unknown> | void) => {
      const b = el('button', '', label);
      b.onclick = async () => {
        if (this.busy) return;
        this.busy = true;
        b.disabled = true;
        try {
          await fn();
        } finally {
          this.busy = false;
          b.disabled = false;
          this.render();
        }
      };
      btns.appendChild(b);
      return b;
    };
    btn('연결', () => c.connect());
    btn('방 만들기', () => s.createRoom(this.characterId()));
    btn('빠른 매칭', () => s.quickMatch(this.characterId()));
    this.codeInput.placeholder = 'pb-xxxxxx';
    this.codeInput.spellcheck = false;
    const joinRow = el('div', 'np-join');
    const joinBtn = el('button', '', '코드 입장');
    joinBtn.onclick = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await s.joinByCode(this.characterId(), this.codeInput.value);
      } finally {
        this.busy = false;
        this.render();
      }
    };
    joinRow.append(this.codeInput, joinBtn);
    btn('룸 나가기', () => s.leave());
    btn('룸 코드 복사', () => navigator.clipboard?.writeText(s.roomId ?? '').catch(() => undefined));
    btn('로그 복사', () => navigator.clipboard?.writeText(this.logText(200)).catch(() => undefined));
    btn('통계 초기화', () => {
      c.counters.reset();
      s.rejected = 0;
      mode.confirmedHits = mode.confirmedKills = mode.remoteShotsShown = 0;
    });

    const interp = el('fieldset');
    interp.append(el('legend', '', '보간 (실제 설정)'));
    interp.append(this.slider('보간 지연', 0, 300, 10, () => mode.interpDelayMs, (v) => (mode.interpDelayMs = v), 'ms'));
    interp.append(this.check('원격 탄 연출을 보간 시점에 맞춤', () => mode.syncFxToInterp, (v) => (mode.syncFxToInterp = v)));

    const sim = el('fieldset', 'np-sim');
    sim.append(el('legend', '', 'SIMULATION — 실제 네트워크 아님'));
    sim.append(this.slider('추가 지연(왕복)', 0, 600, 10, () => c.sim.latencyMs, (v) => (c.sim.latencyMs = v), 'ms'));
    sim.append(this.slider('흔들림(편도)', 0, 200, 5, () => c.sim.jitterMs, (v) => (c.sim.jitterMs = v), 'ms'));
    sim.append(this.slider('손실', 0, 30, 1, () => c.sim.lossPct, (v) => (c.sim.lossPct = v), '%'));
    sim.append(el('div', 'np-hint', '손실: 위치 패킷·원격 상태·탄 연출만 버림. 사격·명중이 실린 패킷은 TCP 재전송처럼 지연만 추가 (SDK 전송은 WebSocket = 실제로는 유실 대신 지연).'));

    this.body.append(btns, joinRow, interp, sim, this.info, el('div', 'np-sub', '로그'), this.logBox);
    // 좁은 화면(모바일·작은 창)에서는 시작 화면을 가리지 않게 접은 채로 시작 (머리글 탭·F9로 펼침)
    if (window.innerWidth < 900) this.root.classList.add('collapsed');
    container.appendChild(this.root);
    window.addEventListener('keydown', this.onKey);
    this.render();
  }

  toggle(): void {
    this.root.classList.toggle('collapsed');
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0 || this.root.classList.contains('collapsed')) return;
    this.timer = 0.25;
    this.render();
  }

  private render(): void {
    const s = this.mode.session;
    const c = s.client;
    const k = c.counters;
    const sim = c.sim;
    const simOn = sim.latencyMs > 0 || sim.jitterMs > 0 || sim.lossPct > 0;
    const lines = [
      `연결 ${c.status}${c.statusReason ? ` — ${c.statusReason}` : ''}`,
      `verse ${c.verse ?? '(없음)'}  RS ${c.rsConnected ? '연결' : '-'}`,
      `계정 ${c.account || '-'}`,
      `룸 ${s.roomId ?? '-'}  ${s.phase}  자리 ${s.slot}  참가자 ${s.playerCount}/${NET_MAX_PLAYERS}`,
      ``,
      `RTT(ping 왕복) 최근 ${fmt(k.rtt.last)} 평균 ${fmt(k.rtt.avg)} 최소 ${fmt(k.rtt.min)} 최대 ${fmt(k.rtt.max)} (${k.rtt.samples}회)${simOn ? '  ※시뮬 지연 포함' : ''}`,
      `전송 ${k.sendHz}Hz (목표 ${1000 / NET_TIMING.sendIntervalMs}Hz)  수신 상태 ${k.recvHz}Hz`,
      `보냄: 상태 ${k.sentStates} · 호출 ${k.sentCalls} · ${kb(k.sentBytes)}`,
      `받음: 상태 ${k.recvStates} · 메시지 ${k.recvMessages} · ${kb(k.recvBytes)}`,
      `(바이트 = JSON 길이 추정, SDK 실제 전송량과 다를 수 있음)`,
      `서버 판정: 확정 명중 ${this.mode.confirmedHits} · 확정 처치 ${this.mode.confirmedKills} · 거부 ${s.rejected}${s.lastRejectReason ? ` (${s.lastRejectReason})` : ''}`,
      `원격 탄 연출 ${this.mode.remoteShotsShown}`,
      `오류 ${k.errors}${k.lastError ? ` — ${k.lastError}` : ''}`,
    ];
    for (const [acc, buf] of s.remotes) {
      const r = this.mode.remotes.get(acc);
      const rec = s.players[acc];
      lines.push(
        `원격 ${acc.slice(0, 14)}: 버퍼 ${buf.size}개 ${buf.spanMs.toFixed(0)}ms · 도착 간격 ${buf.lastArrivalGap.toFixed(0)}ms · 역순/중복 ${buf.dropped}${r?.extrapolating ? ' · 외삽 중' : ''}` +
          `${rec ? ` · HP ${rec.hp}/${rec.max}${rec.dead ? ' 사망' : ''} K${rec.k}/D${rec.d}` : ''}`,
      );
    }
    const me = s.players[s.me];
    if (me) lines.push(`나: HP ${me.hp}/${me.max}${me.dead ? ' 사망' : ''} K${me.k}/D${me.d} (서버 기록)`);
    if (simOn) lines.push(``, `[SIM] 지연 +${sim.latencyMs}ms 흔들림 ${sim.jitterMs}ms 손실 ${sim.lossPct}% · 버린 패킷 보냄 ${k.simDroppedOut} 받음 ${k.simDroppedIn}`);
    this.info.textContent = lines.join('\n');
    this.info.classList.toggle('sim-on', simOn);
    this.logBox.textContent = this.logText(18);
  }

  private logText(n: number): string {
    return this.mode.session.client.log
      .slice(-n)
      .map((e) => `${(e.t / 1000).toFixed(1).padStart(7)} ${e.level === 'error' ? '!' : e.level === 'warn' ? '?' : ' '} ${e.text}`)
      .join('\n');
  }

  private slider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, unit: string): HTMLElement {
    const row = el('label', 'np-row');
    const input = el('input');
    input.type = 'range';
    Object.assign(input, { min: String(min), max: String(max), step: String(step), value: String(get()) });
    const val = el('span', '', `${get()}${unit}`);
    input.oninput = () => {
      set(Number(input.value));
      val.textContent = `${input.value}${unit}`;
    };
    row.append(el('span', '', label), input, val);
    return row;
  }

  private check(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const row = el('label', 'np-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = get();
    input.onchange = () => set(input.checked);
    row.append(input, document.createTextNode(` ${label}`));
    return row;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}

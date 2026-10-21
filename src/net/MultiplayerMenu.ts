// 시작 화면의 "Multiplayer" 화면: 모드 선택(TDM 2v2 / FFA 4인 / 자유 테스트) · 방 만들기 · 코드로 입장 ·
// 대기실(팀·준비 상태·방장 Start Match) · 진행 중 일시정지 · 결과 화면 · 연결 끊김.
// 표시는 전부 서버가 확인한 상태(NetSession)만 읽는다 — 클라이언트가 임의로 성공·결과를 만들지 않음.
import { displayCode, type NetSession } from './NetSession';
import { NET_MAX_PLAYERS, NET_MODE_RULES, NET_TEAM_SIZE, type NetMode, type NetTeam } from './shared/protocol';

export interface MultiplayerMenuHost {
  /** 세션 (첫 연결 전에는 null) */
  session(): NetSession | null;
  /** 지금 캐릭터 이름 (시작 화면에서 고른 것) */
  characterName(): string;
  /** 캐릭터 id → 표시 이름 */
  characterLabel(id: string): string;
  /** 멀티 게임으로 전환됨 (봇 제거됨) */
  netGame(): boolean;
  /** 연결 끊김 등으로 룸에서 밀려남 (직접 나간 것 아님) */
  leftUnexpectedly(): boolean;
  /** 포인터 잠금 중 (게임 조작 중) */
  locked(): boolean;
  /** 로컬 매치가 시작됨 (카운트다운 이후) */
  matchStarted(): boolean;
  /** 내 팀 (TDM) */
  localTeam(): NetTeam | null;
  create(mode: NetMode): Promise<void>;
  join(code: string): Promise<void>;
  setMode(mode: NetMode): Promise<void>;
  switchTeam(): Promise<void>;
  start(): Promise<void>;
  toLobby(): Promise<void>;
  leave(): Promise<void>;
  rejoin(): Promise<void>;
  /** 싱글플레이로 돌아가기 (새로고침) */
  singlePlayer(): void;
}

type View = 'home' | 'busy' | 'lobby' | 'paused' | 'result' | 'left';

const MODES: NetMode[] = ['tdm', 'ffa', 'test'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function shortAccount(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** 모드 규칙 한 줄 */
export function modeRuleText(mode: NetMode): string {
  const r = NET_MODE_RULES[mode];
  if (mode === 'tdm') return `BLUE vs RED 2:2 · ${r.timeLimitMs / 60000}분 · 팀 ${r.scoreToWin}킬 먼저 · 시간 끝나면 킬 많은 팀, 같으면 무승부`;
  if (mode === 'ffa') return `4인 개인전 · ${r.timeLimitMs / 60000}분 · ${r.scoreToWin}킬 먼저 · 시간 끝나면 최다 킬, 공동 1위면 무승부`;
  return `2~${NET_MAX_PLAYERS}명 · 시간·점수 제한 없음 (연결·전투 점검용)`;
}

export class MultiplayerMenu {
  readonly root = el('div', 'mp-overlay hidden');
  private readonly card = el('div', 'mp-card');
  private opened = false;
  private busy = false;
  private notice = '';
  private codeValue = '';
  private lastKey = '';
  private createMode: NetMode = 'tdm';

  constructor(
    container: HTMLElement,
    private readonly host: MultiplayerMenuHost,
  ) {
    this.root.appendChild(this.card);
    // 카드 안 클릭은 게임(포인터 잠금)으로 넘기지 않음
    for (const t of ['mousedown', 'click', 'touchstart'] as const) this.card.addEventListener(t, (e) => e.stopPropagation());
    container.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** 지금 화면을 덮고 있는지 (시작 화면 카드를 숨길지 판단) */
  get covering(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(): void {
    this.opened = true;
    this.notice = '';
    this.refresh(true);
  }

  close(): void {
    this.opened = false;
    this.refresh(true);
  }

  private view(): View {
    const s = this.host.session();
    if (this.busy || s?.phase === 'joining') return 'busy';
    if (s?.inRoom) {
      if (s.matchPhase === 'result' && s.result) return 'result';
      return s.inMatch ? 'paused' : 'lobby';
    }
    if (this.host.leftUnexpectedly()) return 'left';
    return 'home';
  }

  private visible(v: View): boolean {
    if (v === 'paused') return !this.host.locked();
    if (v === 'left' || v === 'result') return true;
    return this.opened || this.host.netGame();
  }

  /** 상태가 바뀔 때마다 (세션 이벤트·잠금 변화·주기 갱신). 바뀐 게 없으면 DOM을 다시 만들지 않음 (입력칸 유지) */
  refresh(force = false): void {
    const v = this.view();
    const show = this.visible(v);
    this.root.classList.toggle('hidden', !show);
    // 진행 중 일시정지 화면: 카드 밖을 누르면 게임으로 (포인터 잠금)
    this.root.classList.toggle('pass-through', v === 'paused');
    if (!show) return;
    const key = this.stateKey(v);
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.render(v);
  }

  private stateKey(v: View): string {
    const s = this.host.session();
    const ps = s
      ? Object.entries(s.players)
          .map(([a, p]) => `${a}:${p.slot}:${p.char}:${p.team}:${p.k}:${p.d}:${s.isLost(a)}:${s.remotes.has(a)}`)
          .join('|')
      : '';
    return [v, this.notice, this.createMode, s?.roomId, s?.host, s?.mode, s?.matchPhase, s?.result?.endedAt, s?.lastError, s?.client.status, ps, this.host.matchStarted(), this.host.characterName()].join('#');
  }

  private render(v: View): void {
    const c = this.card;
    c.textContent = '';
    c.append(el('div', 'mp-kicker', 'POP! BATTLE'), el('h2', 'mp-title', 'MULTIPLAYER'));
    const s = this.host.session();
    if (v === 'busy') {
      c.append(el('p', 'mp-status', s?.inRoom ? '처리하는 중…' : '서버에 연결하는 중…'));
      return;
    }
    if (v === 'home') return this.renderHome(c, s);
    if (v === 'left') return this.renderLeft(c, s);
    if (!s) return;
    if (v === 'result') return this.renderResult(c, s);
    this.renderRoom(c, s, v);
  }

  private modePicker(current: NetMode, onPick: (m: NetMode) => void, disabled = false): HTMLElement {
    const row = el('div', 'mp-modes');
    for (const m of MODES) {
      const b = this.button(NET_MODE_RULES[m].short, `mp-mode${m === current ? ' on' : ''}`, () => onPick(m));
      b.disabled = disabled;
      b.title = NET_MODE_RULES[m].label;
      row.appendChild(b);
    }
    return row;
  }

  private renderHome(c: HTMLElement, s: NetSession | null): void {
    c.append(el('p', 'mp-sub', `캐릭터: ${this.host.characterName()} · 최대 ${NET_MAX_PLAYERS}명 (봇 없음)`));
    c.append(
      el('div', 'mp-label', '게임 모드 (방 만들 때 선택)'),
      this.modePicker(this.createMode, (m) => {
        this.createMode = m;
        this.refresh(true);
      }),
      el('p', 'mp-hint', modeRuleText(this.createMode)),
    );
    const create = this.button('Create Room', 'mp-primary', () => this.run(() => this.host.create(this.createMode)));
    const row = el('div', 'mp-join');
    const input = el('input', 'mp-code-input');
    input.placeholder = 'Room Code';
    input.maxLength = 15;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = this.codeValue;
    input.oninput = () => (this.codeValue = input.value.toUpperCase().replace(/\s/g, ''));
    const join = this.button('Join Room', '', () => {
      const code = this.codeValue.trim();
      if (!code) {
        this.notice = '방 코드를 입력하세요';
        this.refresh(true);
        return;
      }
      return this.run(() => this.host.join(code));
    });
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') join.click();
    };
    row.append(input, join);
    c.append(create, row);
    const err = this.notice || s?.lastError;
    if (err) c.append(el('p', 'mp-error', err));
    // 멀티로 전환된 뒤에는 봇이 없으므로 싱글플레이는 새로고침으로 복귀
    c.append(this.host.netGame() ? this.button('싱글플레이로 돌아가기', 'mp-ghost', () => this.host.singlePlayer()) : this.button('Back', 'mp-ghost', () => this.close()));
    c.append(el('p', 'mp-hint', '같은 게임 링크를 연 다른 사람(다른 브라우저·기기, 다른 계정)이 Room Code로 들어와요.'));
  }

  private renderLeft(c: HTMLElement, s: NetSession | null): void {
    c.append(el('p', 'mp-error', s?.lastError || '룸에서 나왔어요'));
    if (s?.lastRoomId) c.append(this.button(`다시 입장 (${displayCode(s.lastRoomId)})`, 'mp-primary', () => this.run(() => this.host.rejoin())));
    c.append(this.button('싱글플레이로 돌아가기', 'mp-ghost', () => this.host.singlePlayer()));
  }

  private codeRow(s: NetSession): HTMLElement {
    const code = displayCode(s.roomId);
    const row = el('div', 'mp-code');
    const box = el('input', 'mp-code-value');
    box.readOnly = true;
    box.value = code;
    const copy = this.button('Copy', 'mp-small', async () => {
      const ok = await copyText(code, box);
      this.notice = ok ? '방 코드를 복사했어요' : '복사가 막혀 있어요 — 코드를 직접 선택해 복사하세요';
      this.refresh(true);
    });
    row.append(el('span', 'mp-label', 'Room'), box, copy);
    return row;
  }

  private renderRoom(c: HTMLElement, s: NetSession, v: View): void {
    const mode = s.mode;
    const rule = NET_MODE_RULES[mode];
    c.append(this.codeRow(s));
    const modeRow = el('div', 'mp-mode-line');
    modeRow.append(el('b', '', rule.label), el('span', 'mp-hint', modeRuleText(mode)));
    c.append(modeRow);
    if (v === 'lobby' && s.isHost) c.append(this.modePicker(mode, (m) => void this.run(() => this.host.setMode(m))));

    const list = el('div', `mp-players${rule.teams ? ' teams' : ''}`);
    const bySlot = new Map(Object.entries(s.players).map(([acc, p]) => [p.slot, { acc, p }]));
    for (let slot = 0; slot < NET_MAX_PLAYERS; slot++) {
      const e = bySlot.get(slot);
      const row = el('div', 'mp-player');
      row.append(el('b', '', `P${slot + 1}`));
      if (!e) {
        row.append(el('span', 'mp-wait', '기다리는 중…'));
      } else {
        const mine = e.acc === s.me;
        const lost = s.isLost(e.acc);
        const status = lost ? 'Disconnected (재접속 대기 30초)' : mine || s.remotes.has(e.acc) ? 'Connected · Ready' : 'Connected';
        const name = el('span', 'mp-name', `${mine ? '나' : shortAccount(e.acc)} · ${this.host.characterLabel(e.p.char)}${s.host === e.acc ? ' · ★방장' : ''}`);
        if (rule.teams && e.p.team) row.classList.add(e.p.team === 'BLUE' ? 'team-blue' : 'team-red');
        row.append(name);
        if (rule.teams && e.p.team) row.append(el('span', `mp-team ${e.p.team === 'BLUE' ? 'blue' : 'red'}`, e.p.team));
        row.append(el('span', lost ? 'mp-bad' : 'mp-ok', status));
        if (v === 'paused') row.append(el('span', 'mp-hp', `HP ${Math.round(e.p.hp)}/${e.p.max}${e.p.dead ? ' 사망' : ''} · K${e.p.k}/D${e.p.d}`));
      }
      list.appendChild(row);
    }
    const n = Object.keys(s.players).length;
    c.append(list, el('p', 'mp-count', `Players: ${n}/${NET_MAX_PLAYERS}`));

    if (v === 'lobby') {
      const blue = Object.values(s.players).filter((p) => p.team === 'BLUE').length;
      const red = Object.values(s.players).filter((p) => p.team === 'RED').length;
      if (rule.teams) {
        const team = this.host.localTeam();
        const other = team === 'BLUE' ? red : blue;
        const sw = this.button(`팀 바꾸기 (${team === 'BLUE' ? '→ RED' : '→ BLUE'})`, 'mp-small', () => this.run(() => this.host.switchTeam()));
        sw.disabled = other >= NET_TEAM_SIZE;
        c.append(el('p', 'mp-count', `BLUE ${blue}/${NET_TEAM_SIZE} · RED ${red}/${NET_TEAM_SIZE}`), sw);
      }
      const anyLost = Object.keys(s.players).some((a) => s.isLost(a));
      const enough = n >= rule.requiredPlayers && (!rule.teams || (blue === NET_TEAM_SIZE && red === NET_TEAM_SIZE));
      const ready = enough && !anyLost;
      if (s.isHost) {
        const start = this.button('Start Match', 'mp-primary', () => this.run(() => this.host.start()));
        start.disabled = !ready;
        const hint = anyLost
          ? '연결이 끊긴 플레이어가 돌아오거나 나갈 때까지 기다려요'
          : n < rule.requiredPlayers
            ? `${rule.requiredPlayers}명이 모두 들어와야 시작할 수 있어요 (지금 ${n}명) — Room Code를 알려 주세요`
            : rule.teams && !enough
              ? '팀 인원을 2:2로 맞춰 주세요'
              : '시작하면 모두 같은 맵에서 3초 카운트다운 후 시작해요';
        c.append(start, el('p', 'mp-hint', hint));
      } else {
        c.append(el('p', 'mp-status', '방장이 Start Match를 누르면 시작해요'));
      }
    } else {
      const counting = s.matchPhase === 'countdown';
      c.append(el('p', 'mp-status', !this.host.matchStarted() || counting ? '곧 시작! 화면을 클릭해서 들어가요' : '매치 진행 중 — 화면을 클릭하면 계속'));
    }
    const err = this.notice || s.lastError;
    if (err) c.append(el('p', this.notice ? 'mp-hint' : 'mp-error', err));
    c.append(this.button('Leave Room', 'mp-ghost', () => this.run(() => this.host.leave())));
  }

  /** 결과 화면: 서버가 확정한 결과 그대로 (모든 플레이어 같은 값) */
  private renderResult(c: HTMLElement, s: NetSession): void {
    const r = s.result!;
    const mine = r.winners.includes(s.me);
    const outcome = r.draw ? (r.mode === 'tdm' || mine ? 'DRAW' : 'LOSE') : mine ? 'WIN' : 'LOSE';
    c.append(el('div', `mp-outcome ${outcome.toLowerCase()}`, outcome));
    const why = r.reason === 'score' ? `${NET_MODE_RULES[r.mode].scoreToWin}킬 달성` : '시간 종료';
    if (r.mode === 'tdm') {
      const sc = el('div', 'mp-final');
      sc.append(el('span', 'mp-team blue', `BLUE ${r.teamScore.BLUE}`), el('span', '', ':'), el('span', 'mp-team red', `${r.teamScore.RED} RED`));
      c.append(sc, el('p', 'mp-hint', `${NET_MODE_RULES[r.mode].label} · ${why}${r.winnerTeam ? ` · ${r.winnerTeam} 승리` : ' · 무승부'}`));
    } else {
      c.append(el('p', 'mp-hint', `${NET_MODE_RULES[r.mode].label} · ${why}${r.draw ? ' · 공동 1위 무승부' : ''}`));
    }
    const table = el('table', 'mp-table');
    const head = el('tr');
    for (const h of ['순위', '플레이어', r.mode === 'tdm' ? '팀' : '캐릭터', '킬', '데스']) head.append(el('th', '', h));
    table.append(head);
    let rank = 0;
    let prev = '';
    r.standings.forEach((p, i) => {
      const k = `${p.k}:${p.d}`;
      if (k !== prev) rank = i + 1;
      prev = k;
      const tr = el('tr', p.account === s.me ? 'me' : '');
      const team = r.mode === 'tdm' ? (p.team ?? '-') : this.host.characterLabel(p.char);
      for (const v of [String(rank), `${p.account === s.me ? '나' : shortAccount(p.account)}${p.left ? ' (나감)' : ''}`, team, String(p.k), String(p.d)]) tr.append(el('td', '', v));
      table.append(tr);
    });
    c.append(table);
    c.append(this.button('Return to Lobby', 'mp-primary', () => this.run(() => this.host.toLobby())));
    c.append(this.button('Leave Room', 'mp-ghost', () => this.run(() => this.host.leave())));
  }

  private button(label: string, cls: string, fn: () => unknown): HTMLButtonElement {
    const b = el('button', `mp-btn ${cls}`.trim(), label);
    b.type = 'button';
    b.onclick = () => void fn();
    return b;
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.notice = '';
    this.refresh(true);
    try {
      await fn();
    } finally {
      this.busy = false;
      this.refresh(true);
    }
  }

  /** 오류·안내 문구 (시작 거부 사유 등) */
  setNotice(text: string): void {
    this.notice = text;
    this.refresh(true);
  }

  dispose(): void {
    this.root.remove();
  }
}

/** 클립보드 복사: iframe(Verse8)에서는 clipboard 권한이 없을 수 있어 선택+execCommand로 한 번 더 시도 */
async function copyText(text: string, input: HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    input.focus();
    input.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

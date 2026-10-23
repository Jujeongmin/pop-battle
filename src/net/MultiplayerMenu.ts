// 시작 화면의 "Multiplayer" 화면: 모드 선택(TDM 4v4 / FFA 8인 / 자유 테스트) · 방 만들기 · 코드로 입장 ·
// 대기실(팀·방장 시작) · 진행 중 일시정지 · 결과 화면 · 연결 끊김. 서버에는 준비 상태가 없다.
// 표시는 전부 서버가 확인한 상태(NetSession)만 읽는다 — 클라이언트가 임의로 성공·결과를 만들지 않음.
import { levelBadge } from '../ui/popgun';
import { markRadios, radioGroup } from '../ui/lobby/lobbyDom';
import { displayCode, type NetSession } from './NetSession';
import { NET_MAX_PLAYERS, NET_MODE_RULES, NET_TEST_TIME_LIMIT_SEC, teamSeats, type NetMode, type NetPlayerRecord, type NetTeam } from './shared/protocol';
import '../ui/lobby/room.css';

export interface MultiplayerMenuHost {
  /** 세션 (첫 연결 전에는 null) */
  session(): NetSession | null;
  /** 지금 캐릭터 이름 (시작 화면에서 고른 것) */
  characterName(): string;
  /** 캐릭터 id → 표시 이름 */
  characterLabel(id: string): string;
  /** 캐릭터 id → 대표 색 (CSS 색) */
  characterColor(id: string): string;
  /** 실제 캐릭터 모델 얼굴·상반신 초상 (정사각 PNG data URL, 투명 배경). 처음엔 그리는 동안 기다림, 실패하면 reject → 색 원으로 */
  characterPortrait(id: string): Promise<string>;
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
  /** 빠른 시작: 서버 quickMatch가 고른 방(사람이 있는 대기 방, 없으면 새 방)으로 */
  quickMatch(): Promise<void>;
  setMode(mode: NetMode): Promise<void>;
  switchTeam(): Promise<void>;
  /** TDM 대기실: 빈 칸 클릭 → 그 팀·칸으로 */
  moveSeat(team: NetTeam, seat: number): Promise<void>;
  /** timeLimitSec: 개발 빌드 테스트용 제한 시간 (없으면 모드 규칙) */
  start(timeLimitSec?: number): Promise<void>;
  /** 새로고침 전에 있던 룸 코드 (같은 탭) */
  lastRoomCode(): string | null;
  /** 매치 결과 화면(ResultScreen)이 떠 있음 → 메뉴는 재접속·밀려남 안내만 */
  resultOpen(): boolean;
  leave(): Promise<void>;
  rejoin(): Promise<void>;
  /** 자동 재접속 취소 */
  cancelReconnect(): void;
  /** 싱글플레이로 돌아가기 (새로고침) */
  singlePlayer(): void;
}

type View = 'home' | 'busy' | 'lobby' | 'paused' | 'result' | 'left' | 'reconnecting';

/** 방 만들 때 고르는 모드 — 자유 테스트(TEST)는 개발용이라 개발 빌드에서만 보임 (서버 처리는 그대로) */
const MODES: NetMode[] = import.meta.env.DEV ? ['tdm', 'ffa', 'test'] : ['tdm', 'ffa'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 모드 규칙 한 줄 */
export function modeRuleText(mode: NetMode): string {
  const r = NET_MODE_RULES[mode];
  if (mode === 'tdm') return `BLUE vs RED 최대 4:4 (2~${NET_MAX_PLAYERS}명) · ${r.timeLimitMs / 60000}분 · 팀 ${r.scoreToWin}킬 먼저 · 시간 끝나면 킬 많은 팀, 같으면 무승부`;
  if (mode === 'ffa') return `개인전 2~${NET_MAX_PLAYERS}명 · ${r.timeLimitMs / 60000}분 · ${r.scoreToWin}킬 먼저 · 시간 끝나면 최다 킬, 공동 1위면 무승부`;
  return `2~${NET_MAX_PLAYERS}명 · 시간·점수 제한 없음 (연결·전투 점검용)`;
}

export class MultiplayerMenu {
  readonly root = el('div', 'lb-mp-overlay lb-mp-hidden');
  private readonly card = el('div', 'lb-mp-card');
  private opened = false;
  private busy = false;
  private notice = '';
  private codeValue = '';
  private lastKey = '';
  private createMode: NetMode = 'tdm';
  /** 개발 빌드: 테스트용 제한 시간 (0 = 기본 3분) */
  private testTime = 0;

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
    return !this.root.classList.contains('lb-mp-hidden');
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

  /** 로비 PLAY에서 열기: 고른 모드를 방 만들기 모드로 (null = 그대로) */
  openWith(mode: NetMode | null): void {
    if (mode) this.createMode = mode;
    this.open();
  }

  /** 로비 CREATE ROOM: 이 모드로 바로 방 만들기 (진행 중·실패 안내는 이 화면이 보여 줌) */
  createNow(mode: NetMode): void {
    this.createMode = mode;
    this.open();
    void this.run(() => this.host.create(mode));
  }

  /** 로비 ROOM LIST·코드 입장: 바로 참가 */
  joinNow(code: string): void {
    this.open();
    void this.run(() => this.host.join(code));
  }

  /** 로비 빠른 시작: 바로 자동 참가 */
  quickMatchNow(): void {
    this.open();
    void this.run(() => this.host.quickMatch());
  }

  /** 로비 "이전 방 다시 입장" */
  rejoinNow(): void {
    void this.run(() => this.host.rejoin());
  }

  private view(): View {
    const s = this.host.session();
    if (s?.reconnecting && !s.inRoom) return 'reconnecting';
    if (this.busy || s?.phase === 'joining') return 'busy';
    if (s?.inRoom) {
      if (s.matchPhase === 'result' && s.result) return 'result';
      return s.inMatch ? 'paused' : 'lobby';
    }
    if (this.host.leftUnexpectedly()) return 'left';
    return 'home';
  }

  private visible(v: View): boolean {
    // 매치 중 조작을 놓침 → 정식 일시정지 메뉴(PauseMenu)가 대신 뜸. 결과는 결과 화면(ResultScreen)이 보여 줌
    if (v === 'paused' || v === 'result') return false;
    if (v === 'left' || v === 'reconnecting') return true;
    // 결과 화면을 보는 동안(다른 사람이 먼저 대기실로 가도) 대기실 메뉴는 결과를 닫은 뒤에
    if (this.host.resultOpen()) return false;
    return this.opened || this.host.netGame();
  }

  /** 상태가 바뀔 때마다 (세션 이벤트·잠금 변화·주기 갱신). 바뀐 게 없으면 DOM을 다시 만들지 않음 (입력칸 유지) */
  refresh(force = false): void {
    const v = this.view();
    const show = this.visible(v);
    this.root.classList.toggle('lb-mp-hidden', !show);
    // 진행 중 일시정지 화면: 카드 밖을 누르면 게임으로 (포인터 잠금)
    this.root.classList.toggle('lb-mp-pass-through', v === 'paused');
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
          .map(([a, p]) => `${a}:${p.slot}:${p.char}:${p.team}:${p.seat ?? -1}:${p.k}:${p.d}:${s.isLost(a)}:${s.remotes.has(a)}`)
          .join('|')
      : '';
    return [v, s?.reconnectAttempt, this.notice, this.createMode, this.testTime, this.host.lastRoomCode(), s?.roomId, s?.host, s?.mode, s?.matchPhase, s?.result?.endedAt, s?.lastError, s?.client.status, ps, this.host.matchStarted(), this.host.characterName()].join('#');
  }

  private render(v: View): void {
    const c = this.card;
    c.textContent = '';
    const s = this.host.session();
    if (v === 'busy') {
      c.append(el('p', 'lb-mp-status', s?.inRoom ? '처리하는 중…' : '서버에 연결하는 중…'));
      return;
    }
    if (v === 'reconnecting' && s) return this.renderReconnecting(c, s);
    if (v === 'home') return this.renderHome(c, s);
    if (v === 'left') return this.renderLeft(c, s);
    if (!s) return;
    this.renderRoom(c, s, v);
  }

  private modePicker(current: NetMode, onPick: (m: NetMode) => void, disabled = false): HTMLElement {
    const row = el('div', 'lb-mp-modes');
    radioGroup(row, '게임 모드');
    const items: HTMLButtonElement[] = [];
    for (const m of MODES) {
      const b = this.button(NET_MODE_RULES[m].short, `lb-mp-mode lb-mp-mode-${m}${m === current ? ' lb-mp-on' : ''}`, () => {
        onPick(m);
        // 다시 그려진 화면에서 고른 모드에 포커스 유지 (키보드 사용자)
        this.card.querySelector<HTMLElement>('.lb-mp-mode[aria-checked="true"]')?.focus();
      });
      b.disabled = disabled;
      b.title = NET_MODE_RULES[m].label;
      b.dataset.mode = m;
      items.push(b);
      row.appendChild(b);
    }
    markRadios(items, (b) => b.dataset.mode === current);
    return row;
  }

  private renderHome(c: HTMLElement, s: NetSession | null): void {
    c.append(el('p', 'lb-mp-sub', `캐릭터: ${this.host.characterName()} · 최대 ${NET_MAX_PLAYERS}명 (봇 없음)`));
    c.append(
      el('div', 'lb-mp-label', '게임 모드 (방 만들 때 선택)'),
      this.modePicker(this.createMode, (m) => {
        this.createMode = m;
        this.refresh(true);
      }),
      el('p', 'lb-mp-hint', modeRuleText(this.createMode)),
    );
    const create = this.button('방 만들기', 'lb-mp-primary', () => this.run(() => this.host.create(this.createMode)));
    const row = el('div', 'lb-mp-join');
    const input = el('input', 'lb-mp-code-input');
    input.placeholder = '방 코드';
    input.maxLength = 15;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = this.codeValue;
    input.oninput = () => (this.codeValue = input.value.toUpperCase().replace(/\s/g, ''));
    const join = this.button('참가', '', () => {
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
    if (err) c.append(el('p', 'lb-mp-error', err));
    // 멀티로 전환된 뒤에는 봇이 없으므로 싱글플레이는 새로고침으로 복귀
    c.append(this.host.netGame() ? this.button('메인 로비로', 'lb-mp-ghost', () => this.host.singlePlayer()) : this.button('뒤로', 'lb-mp-ghost', () => this.close()));
    c.append(el('p', 'lb-mp-hint', '같은 게임 링크를 연 다른 사람(다른 브라우저·기기, 다른 계정)이 방 코드로 들어와요.'));
  }

  /** 자동 재접속 중: 시도 횟수 + 취소 (취소하면 끊김 화면의 수동 "다시 입장") */
  private renderReconnecting(c: HTMLElement, s: NetSession): void {
    const box = el('div', 'lb-mp-reconnect');
    box.append(el('div', 'lb-mp-spinner'), el('b', '', '다시 연결 중…'));
    c.append(box);
    const attempt = s.reconnectAttempt > 0 ? `시도 ${s.reconnectAttempt}/${s.reconnectMax}` : '곧 다시 연결해요';
    c.append(el('p', 'lb-mp-status', `연결이 끊겼어요 — 같은 방(${displayCode(s.lastRoomId)})으로 자동 복귀 중 · ${attempt}`));
    c.append(el('p', 'lb-mp-hint', '복귀하면 팀·캐릭터·킬/데스·체력이 그대로 이어져요'));
    c.append(this.button('취소', 'lb-mp-ghost', () => this.host.cancelReconnect()));
  }

  private renderLeft(c: HTMLElement, s: NetSession | null): void {
    c.append(el('p', 'lb-mp-error', s?.lastError || '룸에서 나왔어요'));
    if (s?.lastRoomId) c.append(this.button(`다시 입장 (${displayCode(s.lastRoomId)})`, 'lb-mp-primary', () => this.run(() => this.host.rejoin())));
    c.append(this.button('메인 로비로', 'lb-mp-ghost', () => this.host.singlePlayer()));
  }

  private roomHeader(s: NetSession): HTMLElement {
    const code = displayCode(s.roomId);
    const row = el('div', 'lb-mp-room-head');
    const title = el('div', 'lb-mp-room-title');
    title.append(el('small', '', '대기실'), el('b', '', `방 ${code}`));
    const box = el('input', 'lb-mp-code-value');
    box.readOnly = true;
    box.value = code;
    const copy = this.button('코드 복사', 'lb-mp-small', async () => {
      const ok = await copyText(code, box);
      this.notice = ok ? '방 코드를 복사했어요' : '복사가 막혀 있어요 — 코드를 직접 선택해 복사하세요';
      this.refresh(true);
    });
    const codeTools = el('div', 'lb-mp-code-tools');
    codeTools.append(box, copy);
    const meta = el('div', 'lb-mp-room-meta');
    meta.append(
      el('span', `lb-mp-mode-badge lb-mp-mode-${s.mode}`, NET_MODE_RULES[s.mode].short),
      el('span', 'lb-mp-player-count', `${Object.keys(s.players).length}/${NET_MAX_PLAYERS}명`),
    );
    row.append(title, codeTools, meta);
    return row;
  }

  private renderRoom(c: HTMLElement, s: NetSession, v: View): void {
    const mode = s.mode;
    const rule = NET_MODE_RULES[mode];
    c.append(this.roomHeader(s));
    const modeRow = el('div', 'lb-mp-mode-line');
    modeRow.append(el('b', '', rule.label), el('span', 'lb-mp-hint', modeRuleText(mode)));
    c.append(modeRow);

    const bySlot = new Map(Object.entries(s.players).map(([acc, p]) => [p.slot, { acc, p }]));
    const list = el('div', `lb-mp-players${rule.teams ? ' lb-mp-teams' : ' lb-mp-ffa'}`);
    if (rule.teams) {
      for (const team of ['BLUE', 'RED'] as const) {
        const column = el('section', `lb-mp-team-column lb-mp-team-${team.toLowerCase()}`);
        column.append(el('h3', '', `${team} TEAM`));
        teamSeats(s.players, team).forEach((acc, seat) => {
          const p = acc ? s.players[acc] : undefined;
          const box = this.playerSlot(s, acc && p ? { acc, p } : undefined, v);
          // 대기실 빈 칸: 클릭하면 그 팀·그 칸으로 이동
          if (!p && v === 'lobby') {
            box.classList.add('lb-mp-seat-open');
            box.tabIndex = 0;
            box.setAttribute('role', 'button');
            box.setAttribute('aria-label', `${team} 팀 ${seat + 1}번 자리로 이동`);
            box.title = '이 자리로 이동';
            const go = () => void this.run(() => this.host.moveSeat(team, seat));
            box.addEventListener('click', go);
            box.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                go();
              }
            });
          }
          column.append(box);
        });
        list.append(column);
      }
    } else {
      for (let slot = 0; slot < NET_MAX_PLAYERS; slot++) list.append(this.playerSlot(s, bySlot.get(slot), v));
    }
    const n = Object.keys(s.players).length;
    c.append(list);

    // 아래 버튼 줄: 방 나가기 (TDM 팀·자리는 빈 칸 클릭으로 옮김)
    if (v === 'lobby') {
      const blue = Object.values(s.players).filter((p) => p.team === 'BLUE').length;
      const red = Object.values(s.players).filter((p) => p.team === 'RED').length;
      if (rule.teams) c.append(el('p', 'lb-mp-hint', '빈 자리를 누르면 그 자리로 옮겨요 (팀 인원 차이는 시작할 때 자동으로 맞춰요)'));
      const anyLost = Object.keys(s.players).some((a) => s.isLost(a));
      // TDM 팀 인원은 시작할 때 서버가 차이 1명 이하로 맞춤 (1v1 … 4v4)
      const enough = n >= rule.requiredPlayers;
      const ready = enough && !anyLost;
      if (s.isHost) {
        if (import.meta.env.DEV && rule.timeLimitMs > 0) c.append(this.testTimePicker());
        const start = this.button('게임 시작', 'lb-mp-primary', () => this.run(() => this.host.start(this.testTime || undefined)));
        start.disabled = !ready;
        const hint = anyLost
          ? '연결이 끊긴 플레이어가 돌아오거나 나갈 때까지 기다려요'
          : n < rule.requiredPlayers
            ? `${rule.requiredPlayers}명 이상 있어야 시작할 수 있어요 (지금 ${n}명) — 방 코드를 알려 주세요`
            : rule.teams && Math.abs(blue - red) > 1
              ? '시작하면 팀 인원 차이가 1명 이하가 되게 자동으로 맞춰요'
              : '시작하면 모두 같은 맵에서 3초 카운트다운 후 시작해요';
        c.append(start, el('p', 'lb-mp-hint', hint));
      } else {
        c.append(el('p', 'lb-mp-status', '방장이 시작하면 바로 카운트다운이 시작돼요'));
      }
    } else {
      const counting = s.matchPhase === 'countdown';
      c.append(el('p', 'lb-mp-status', !this.host.matchStarted() || counting ? '곧 시작! 화면을 클릭해서 들어가요' : '매치 진행 중 — 화면을 클릭하면 계속'));
    }
    const err = this.notice || s.lastError;
    if (err) c.append(el('p', this.notice ? 'lb-mp-hint' : 'lb-mp-error', err));
    const foot = el('div', 'lb-mp-foot');
    foot.append(this.button('방 나가기', 'lb-mp-ghost', () => this.run(() => this.host.leave())));
    c.append(foot);
  }

  private playerSlot(s: NetSession, entry: { acc: string; p: NetPlayerRecord } | undefined, v: View): HTMLElement {
    const row = el('article', entry ? 'lb-mp-player' : 'lb-mp-player lb-mp-empty');
    if (!entry) {
      row.append(el('span', 'lb-mp-empty-icon', '+'), el('b', '', '빈 자리'));
      return row;
    }
    const mine = entry.acc === s.me;
    const lost = s.isLost(entry.acc);
    const swatch = el('span', 'lb-mp-char-swatch');
    swatch.style.setProperty('--lb-char-color', this.host.characterColor(entry.p.char));
    void this.host.characterPortrait(entry.p.char).then((source) => {
      if (!row.isConnected) return;
      const image = el('img');
      image.src = source;
      image.alt = this.host.characterLabel(entry.p.char);
      image.draggable = false;
      swatch.appendChild(image);
      swatch.classList.add('lb-mp-has-portrait');
    }).catch(() => {
      // 초상 렌더 실패 시 캐릭터 대표 색 실루엣을 유지한다.
    });
    const copy = el('span', 'lb-mp-player-copy');
    // 닉네임(서버 검사 값) 우선, 없으면 자리 번호. 계정·캐릭터 id는 표시하지 않음
    const nick = s.nickOf(entry.acc) ?? (mine ? s.nick : null);
    // 닉네임 줄은 닉네임만 ("나"는 아래 배지) · 긴 닉네임은 글자를 조금 작게 (최대 12자가 두 줄 안에)
    const name = nick ?? (mine ? '나' : `P${entry.p.slot + 1}`);
    const player = el('b', name.length > 7 ? 'lb-mp-name lb-mp-name-long' : 'lb-mp-name', name);
    player.title = name;
    // 계급 아이콘·레벨은 둘째 줄 (닉네임 줄 폭을 차지하지 않게)
    const character = el('small', 'lb-mp-meta');
    character.append(levelBadge(entry.p.lv ?? 1, 'popgun-badge lb-mp-level'), this.host.characterLabel(entry.p.char));
    copy.append(player, character);
    if (s.host === entry.acc) copy.append(el('em', '', '★ 방장'));
    const connection = el('span', lost ? 'lb-mp-connection lb-mp-lost' : 'lb-mp-connection', lost ? '연결 끊김 대기' : '연결됨');
    row.append(swatch, copy, connection);
    // 내 칸: 초상 모서리 "나" 표시 (닉네임 줄 폭을 쓰지 않게)
    if (mine) {
      row.classList.add('lb-mp-mine');
      row.append(el('span', 'lb-mp-me', '나'));
    }
    if (v === 'paused') row.append(el('span', 'lb-mp-stats', `HP ${Math.round(entry.p.hp)}/${entry.p.max}${entry.p.dead ? ' · 사망' : ''} · K${entry.p.k}/D${entry.p.d}`));
    return row;
  }

  /** 개발 빌드 전용: 시간 종료·무승부 확인용 짧은 제한 시간 (기본 규칙 3분은 그대로) */
  private testTimePicker(): HTMLElement {
    const row = el('div', 'lb-mp-modes');
    for (const [label, sec] of [['3분 (기본)', 0], ['60초', 60], [`${NET_TEST_TIME_LIMIT_SEC.min}초`, NET_TEST_TIME_LIMIT_SEC.min]] as const) {
      row.appendChild(
        this.button(label, `lb-mp-mode${this.testTime === sec ? ' lb-mp-on' : ''}`, () => {
          this.testTime = sec;
          this.refresh(true);
        }),
      );
    }
    const wrap = el('div');
    wrap.append(el('div', 'lb-mp-label', '테스트용 제한 시간 (개발 빌드에서만)'), row);
    return wrap;
  }

  private button(label: string, cls: string, fn: () => unknown): HTMLButtonElement {
    const b = el('button', `lb-mp-btn ${cls}`.trim(), label);
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

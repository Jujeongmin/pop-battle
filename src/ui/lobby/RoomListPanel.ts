// 공개 방 목록: 서버가 준 값만 표시하며, 열린 동안에만 5초마다 갱신한다.
import { NET_MODE_RULES } from '../../net/shared/protocol';
import { button, el, ICON, type LobbyHost, type LobbyPanel, type LobbyRoomInfo } from './lobbyDom';

export class RoomListPanel implements LobbyPanel {
  readonly id = 'rooms';
  readonly title = '방 목록';
  private body: HTMLElement | null = null;
  private timer: number | null = null;
  private request = 0;
  private active = false;
  private loading = false;
  private loadedOnce = false;
  private readonly openCreate: () => void;

  constructor(private readonly host: LobbyHost, openCreate: () => void) {
    this.openCreate = openCreate;
  }

  render(body: HTMLElement): void {
    this.body = body;
    this.drawLoading();
    if (this.active) void this.load();
  }

  activate(): void {
    this.active = true;
    if (this.body) void this.load();
    if (this.timer === null) this.timer = window.setInterval(() => void this.load(), 5000);
  }

  deactivate(): void {
    this.active = false;
    this.request++;
    this.loading = false;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.deactivate();
    this.body = null;
  }

  private async load(): Promise<void> {
    if (!this.active || this.loading) return;
    this.loading = true;
    const token = ++this.request;
    this.drawLoading();
    try {
      const result = await this.host.listRooms();
      if (!this.active || token !== this.request || !this.body) return;
      this.loadedOnce = true;
      if (!result.ok) this.drawError(result.reason);
      else if (result.rooms.length === 0) this.drawEmpty();
      else this.drawRooms(result.rooms);
    } catch {
      if (this.active && token === this.request && this.body) this.drawError('error');
    } finally {
      if (token === this.request) this.loading = false;
    }
  }

  private shell(): { tools: HTMLElement; list: HTMLElement } | null {
    if (!this.body) return null;
    this.body.textContent = '';
    const tools = el('div', 'lb-room-tools');
    const copy = el('div', 'lb-room-tools-copy');
    copy.append(el('b', '', '열려 있는 방'), el('span', '', '5초마다 자동 갱신'));
    const refresh = button('', 'lb-room-refresh', () => void this.load(), `${ICON.refresh}<span>새로고침</span>`);
    refresh.setAttribute('aria-label', '방 목록 새로고침');
    refresh.disabled = this.loading;
    tools.append(copy, refresh);
    const list = el('div', 'lb-room-list');
    this.body.append(tools, list, this.codeJoin());
    return { tools, list };
  }

  private drawLoading(): void {
    const shell = this.shell();
    if (!shell) return;
    const state = el('div', 'lb-room-state lb-room-loading');
    // 첫 조회는 서버 연결부터 (이후 자동 새로고침은 목록 조회만)
    state.append(el('i', 'lb-room-spinner'), el('b', '', this.loadedOnce ? '방 목록을 불러오는 중…' : '서버에 연결하는 중…'));
    shell.list.append(state);
  }

  private drawEmpty(): void {
    const shell = this.shell();
    if (!shell) return;
    const state = el('div', 'lb-room-state');
    state.append(el('b', '', '지금은 열린 방이 없어요'), el('p', '', '첫 방을 만들고 친구를 초대해 보세요!'), button('방 만들기', 'lb-room-create', this.openCreate));
    shell.list.append(state);
  }

  /**
   * 실패 상태 (게임이 알려 준 실제 이유별): offline = 이 빌드에 서버 없음, not_deployed = 서버 준비 중(기능 미배포),
   * connect = 연결 실패, error = 조회 실패. 서버가 있는 경우만 다시 시도
   */
  private drawError(reason?: string): void {
    const shell = this.shell();
    if (!shell) return;
    const [title, desc] =
      reason === 'offline'
        ? ['이 빌드에는 멀티플레이 서버가 없어요', '· Verse8에 올린 게임에서 방 목록을 볼 수 있어요']
        : reason === 'not_deployed'
          ? ['서버 준비 중이에요', '· 방 목록 기능이 아직 서버에 배포되지 않았어요 · 방 코드로는 참가할 수 있어요']
          : reason === 'connect'
            ? ['서버에 연결하지 못했어요', '· 네트워크를 확인하고 다시 시도해 주세요']
            : ['방 목록을 불러오지 못했어요', '· 잠시 후 다시 시도해 주세요'];
    const state = el('div', 'lb-room-state lb-room-error');
    state.append(el('b', '', title), el('p', '', desc));
    if (reason !== 'offline') state.append(button('다시 시도', 'lb-room-retry', () => void this.load()));
    shell.list.append(state);
  }

  private drawRooms(rooms: LobbyRoomInfo[]): void {
    const shell = this.shell();
    if (!shell) return;
    for (const room of rooms) shell.list.append(this.roomCard(room));
  }

  private roomCard(room: LobbyRoomInfo): HTMLElement {
    const row = el('article', 'lb-room-card');
    const badge = el('span', `lb-room-mode lb-room-mode-${room.mode}`, NET_MODE_RULES[room.mode].short);
    const name = el('span', 'lb-room-name');
    name.append(el('b', '', `방 ${room.code}`), el('small', '', this.phaseLabel(room.phase)));
    const slots = el('span', 'lb-room-slots');
    const dots = el('i', 'lb-room-dots');
    for (let i = 0; i < room.maxPlayers; i++) dots.append(el('i', i < room.players ? 'lb-filled' : ''));
    slots.append(dots, el('b', '', `${room.players}/${room.maxPlayers}`));
    const status = el('span', `lb-room-status lb-room-phase-${room.phase}`, this.phaseLabel(room.phase));
    const action = button(room.joinable ? '참가' : this.reasonLabel(room.reason), 'lb-room-join', () => this.host.joinRoom(room.code));
    action.disabled = !room.joinable;
    row.append(badge, name, slots, status, action);
    return row;
  }

  private codeJoin(): HTMLElement {
    const wrap = el('form', 'lb-code-join');
    const label = el('label');
    label.append(el('span', '', '방 코드로 참가'));
    const input = el('input');
    input.placeholder = '방 코드 입력';
    input.maxLength = 15;
    input.autocomplete = 'off';
    input.spellcheck = false;
    for (const eventName of ['keydown', 'keyup'] as const) input.addEventListener(eventName, (event) => event.stopPropagation());
    const join = button('참가', 'lb-code-submit', () => {
      const code = input.value.trim().toUpperCase().replace(/\s/g, '');
      if (code) this.host.joinRoom(code);
      else input.focus();
    });
    wrap.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopPropagation();
      join.click();
    });
    label.append(input);
    wrap.append(label, join);
    return wrap;
  }

  private phaseLabel(phase: LobbyRoomInfo['phase']): string {
    if (phase === 'lobby') return '대기 중';
    if (phase === 'result') return '종료(결과)';
    return '진행 중';
  }

  private reasonLabel(reason?: string): string {
    if (reason === 'full') return '가득 참';
    if (reason === 'left_match') return '이번 매치에서 나가서 입장 불가';
    return '진행 중이라 입장 불가';
  }
}

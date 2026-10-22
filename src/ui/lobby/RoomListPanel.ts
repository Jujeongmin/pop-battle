// 공개 방 목록 (로비 화면 위쪽 가운데에 늘 보이는 칸): 서버가 준 값만 표시, 보이는 동안 5초마다 갱신.
// 머리: 방 만들기(크게) · 빠른 시작 · 연습전 · 새로고침. 줄마다 참가 버튼 (줄을 누르면 선택 강조, 두 번 누르면 참가).
// 갱신해도 선택·입력 중인 방 코드는 그대로.
import { NET_MODE_RULES } from '../../net/shared/protocol';
import { button, el, ICON, type LobbyHost, type LobbyPanel, type LobbyRoomInfo } from './lobbyDom';

/** 방 제목 (서버에 방 이름이 없음 → 모드 이름) */
const MODE_TITLE: Record<LobbyRoomInfo['mode'], string> = { tdm: '팀 데스매치', ffa: '개인전', test: '자유 테스트' };

export class RoomListPanel implements LobbyPanel {
  readonly id = 'rooms';
  readonly title = '방 목록';
  private body: HTMLElement | null = null;
  /** 다시 그리는 곳은 목록·하단만 */
  private list: HTMLElement | null = null;
  private refreshButton: HTMLButtonElement | null = null;
  private rooms: LobbyRoomInfo[] = [];
  /** 선택한 방 코드 (갱신 뒤에도 같은 방이 있으면 유지) */
  private selected: string | null = null;
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
    body.textContent = '';
    const tools = el('div', 'lb-room-tools');
    const copy = el('div', 'lb-room-tools-copy');
    copy.append(el('b', '', '방 목록'), el('span', '', '5초마다 자동 갱신'));
    this.refreshButton = button('', 'lb-room-refresh', () => void this.load(), `${ICON.refresh}<span>새로고침</span>`);
    this.refreshButton.setAttribute('aria-label', '방 목록 새로고침');
    const actions = el('div', 'lb-room-actions');
    const practice = button('', 'lb-room-practice', () => this.host.playPractice(), `${ICON.bot}<span>연습전</span>`);
    practice.title = '봇 3명과 개인전 (3분 · 15킬 먼저)';
    const quick = button('', 'lb-room-quick', () => this.host.quickMatch(), `${ICON.play}<span>빠른 시작</span>`);
    quick.title = '사람이 기다리는 방에 자동으로 참가 (없으면 새 방)';
    const create = button('', 'lb-room-create lb-room-create-main', this.openCreate, `${ICON.create}<span>방 만들기</span>`);
    actions.append(this.refreshButton, practice, quick, create);
    tools.append(copy, actions);
    this.list = el('div', 'lb-room-list');
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', '열려 있는 방');
    body.append(tools, this.list, this.codeJoin());
    if (this.loadedOnce && this.rooms.length) this.drawRooms(this.rooms);
    else this.drawLoading();
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
    this.list = null;
  }

  private async load(): Promise<void> {
    if (!this.active || this.loading) return;
    this.loading = true;
    if (this.refreshButton) this.refreshButton.disabled = true;
    const token = ++this.request;
    // 첫 조회만 불러오는 중 표시 (자동 갱신은 지금 목록을 둔 채 바꿈 → 깜빡임·선택 해제 없음)
    if (!this.loadedOnce) this.drawLoading();
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
      if (this.refreshButton) this.refreshButton.disabled = false;
    }
  }

  private clearList(): HTMLElement | null {
    if (!this.list) return null;
    this.list.textContent = '';
    return this.list;
  }

  private drawLoading(): void {
    const list = this.clearList();
    if (!list) return;
    const state = el('div', 'lb-room-state lb-room-loading');
    // 첫 조회는 서버 연결부터 (이후 자동 새로고침은 목록 조회만)
    state.append(el('i', 'lb-room-spinner'), el('b', '', this.loadedOnce ? '방 목록을 불러오는 중…' : '서버에 연결하는 중…'));
    list.append(state);
  }

  private drawEmpty(): void {
    this.rooms = [];
    this.selected = null;
    const list = this.clearList();
    if (!list) return;
    const state = el('div', 'lb-room-state');
    state.append(el('b', '', '지금은 열린 방이 없어요'), el('p', '', '위의 방 만들기로 첫 방을 만들거나 연습전을 해 보세요!'));
    list.append(state);
  }

  /**
   * 실패 상태 (게임이 알려 준 실제 이유별): offline = 이 빌드에 서버 없음, not_deployed = 서버 준비 중(기능 미배포),
   * connect = 연결 실패, error = 조회 실패. 서버가 있는 경우만 다시 시도
   */
  private drawError(reason?: string): void {
    this.rooms = [];
    this.selected = null;
    const list = this.clearList();
    if (!list) return;
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
    list.append(state);
  }

  private drawRooms(rooms: LobbyRoomInfo[]): void {
    this.rooms = rooms;
    if (this.selected && !rooms.some((r) => r.code === this.selected)) this.selected = null;
    const list = this.clearList();
    if (!list) return;
    for (const room of rooms) list.append(this.roomRow(room));
  }

  /** 방 한 줄: 모드 · 제목 · 코드 · 인원 · 진행 상태 · 참가 */
  private roomRow(room: LobbyRoomInfo): HTMLElement {
    const on = room.code === this.selected;
    const row = el('div', `lb-room-card${on ? ' lb-selected' : ''}${room.joinable ? '' : ' lb-room-closed'}`);
    row.tabIndex = 0;
    row.addEventListener('click', () => this.select(room.code));
    row.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && room.joinable) this.host.joinRoom(room.code);
    });
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(on));
    row.dataset.code = room.code;
    const badge = el('span', `lb-room-mode lb-room-mode-${room.mode}`, NET_MODE_RULES[room.mode].short);
    const name = el('span', 'lb-room-name');
    name.append(el('b', '', MODE_TITLE[room.mode]), el('small', '', `코드 ${room.code}`));
    const slots = el('span', 'lb-room-slots');
    const dots = el('i', 'lb-room-dots');
    for (let i = 0; i < room.maxPlayers; i++) dots.append(el('i', i < room.players ? 'lb-filled' : ''));
    slots.append(dots, el('b', '', `${room.players}/${room.maxPlayers}`));
    const status = el('span', `lb-room-status lb-room-phase-${room.phase}`, room.joinable ? this.phaseLabel(room.phase) : this.reasonLabel(room.reason));
    const join = button(room.joinable ? '참가' : '입장 불가', 'lb-room-join', () => this.host.joinRoom(room.code));
    join.disabled = !room.joinable;
    row.append(badge, name, slots, status, join);
    row.addEventListener('dblclick', () => {
      if (room.joinable) this.host.joinRoom(room.code);
    });
    return row;
  }

  private select(code: string): void {
    this.selected = code;
    for (const row of this.list?.querySelectorAll<HTMLElement>('.lb-room-card') ?? []) {
      const on = row.dataset.code === code;
      row.classList.toggle('lb-selected', on);
      row.setAttribute('aria-selected', String(on));
    }
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
    // 새로고침 전에 있던 방 (같은 탭) 다시 입장
    const last = this.host.lastRoomCode();
    if (last) wrap.append(button('', 'lb-room-rejoin', () => this.host.rejoinLastRoom(), `${ICON.return}<span>이전 방</span>`));
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

// 공개 방 목록 (넓은 화면 = 오른쪽 떠 있는 칸, 좁은·낮은 화면 = 아래 시트): 서버가 준 값만 표시, 보이는 동안 5초마다 갱신.
// 머리: 손잡이(접기·펼치기) · 제목 · 방 수 · 새로고침(아이콘). 그 아래 시작 버튼 위계: 빠른 시작(가장 크게) > 연습전 > 방 만들기.
// 접어도 머리·시작 버튼은 보임 (빠른 시작은 늘 누를 수 있음). 방 코드 참가는 접힌 보조 기능. 목록만 안에서 스크롤.
// 방마다: 제목(서버가 정한 번호 → 보는 사람 언어) · 모드 · 코드(작게) · 인원 · 상태 · 참가.
// 갱신 때 방 코드 기준으로 같은 줄을 고쳐 씀 (다시 만들지 않음) → 깜빡임·스크롤 위치·선택·입력 중인 코드 유지.
import { NET_MODE_RULES } from '../../net/shared/protocol';
import { roomTitle, viewerLang } from '../../net/shared/roomTitles';
import { button, el, ICON, type LobbyHost, type LobbyPanel, type LobbyRoomInfo } from './lobbyDom';

/** 제목 번호가 없는 방(이 기능 전에 만들어진 방)의 대체 제목 = 모드 이름 */
const MODE_TITLE: Record<LobbyRoomInfo['mode'], string> = { tdm: '팀 데스매치', ffa: '개인전', test: '자유 테스트' };

/** 방 한 줄의 고칠 수 있는 부분 */
interface RoomRow {
  row: HTMLElement;
  title: HTMLElement;
  mode: HTMLElement;
  code: HTMLElement;
  count: HTMLElement;
  dots: HTMLElement;
  status: HTMLElement;
  join: HTMLButtonElement;
  room: LobbyRoomInfo;
}

export class RoomListPanel implements LobbyPanel {
  readonly id = 'rooms';
  readonly title = '방 목록';
  private body: HTMLElement | null = null;
  /** 다시 그리는 곳은 목록·하단만 */
  private list: HTMLElement | null = null;
  private refreshButton: HTMLButtonElement | null = null;
  private rooms: LobbyRoomInfo[] = [];
  /** 방 코드 → 화면의 줄 (갱신 때 재사용) */
  private readonly rows = new Map<string, RoomRow>();
  private stateBox: HTMLElement | null = null;
  /** 선택한 방 코드 (갱신 뒤에도 같은 방이 있으면 유지) */
  private selected: string | null = null;
  private timer: number | null = null;
  private request = 0;
  private active = false;
  private loading = false;
  private loadedOnce = false;
  private readonly openCreate: () => void;
  private countEl: HTMLElement | null = null;
  /** 접힘 (손잡이로 바꿈, 처음엔 넓은 화면 펼침 · 좁은 화면 접힘) */
  private collapsed: boolean | null = null;

  constructor(private readonly host: LobbyHost, openCreate: () => void) {
    this.openCreate = openCreate;
    // 브라우저 언어가 바뀌면 방 제목을 바로 다시 씀
    window.addEventListener('languagechange', () => {
      for (const r of this.rows.values()) this.fillTitle(r);
    });
  }

  render(body: HTMLElement): void {
    this.body = body;
    body.textContent = '';
    body.classList.add('lb-dock2');
    if (this.collapsed === null) this.collapsed = matchMedia('(max-width: 899px), (max-height: 520px)').matches;
    body.classList.toggle('lb-dock-collapsed', this.collapsed);
    // 머리: 손잡이 · 제목 · 방 수 · 새로고침
    const head = el('div', 'lb-dock-head');
    const handle = button('', 'lb-dock-handle', () => this.setCollapsed(!this.collapsed), '<i aria-hidden="true"></i>');
    handle.setAttribute('aria-controls', 'lb-dock-body');
    const title = el('b', 'lb-dock-title', '방 목록');
    this.countEl = el('span', 'lb-dock-count');
    this.refreshButton = button('', 'lb-room-refresh lb-icon-btn', () => void this.load(), ICON.refresh);
    this.refreshButton.setAttribute('aria-label', '방 목록 새로고침');
    this.refreshButton.title = '방 목록 새로고침';
    head.append(handle, title, this.countEl, this.refreshButton);
    // 시작 버튼 위계: 빠른 시작(주) > 연습전(보조) > 방 만들기(3순위)
    const cta = el('div', 'lb-dock-cta');
    const quick = button('', 'lb-room-quick lb-cta-primary', () => this.host.quickMatch(), `${ICON.play}<span class="lb-cta-copy"><b>빠른 시작</b><small>바로 매치 참가</small></span>`);
    quick.title = '사람이 기다리는 방에 자동으로 참가 (없으면 새 방)';
    const row = el('div', 'lb-dock-cta-row');
    const practice = button('', 'lb-room-practice lb-cta-secondary', () => this.host.playPractice(), `${ICON.bot}<span>연습전</span>`);
    practice.title = '봇 3명과 개인전 (3분 · 15킬 먼저)';
    const create = button('', 'lb-room-create lb-cta-tertiary', this.openCreate, `${ICON.create}<span>방 만들기</span>`);
    create.title = '모드를 골라 새 방 만들기';
    row.append(practice, create);
    cta.append(quick, row);
    this.rows.clear();
    this.stateBox = null;
    this.list = el('div', 'lb-room-list');
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', '열려 있는 방');
    const bodyBox = el('div', 'lb-dock-body');
    bodyBox.id = 'lb-dock-body';
    bodyBox.append(this.list, this.codeJoin());
    body.append(head, cta, bodyBox);
    this.syncHandle();
    if (this.loadedOnce && this.rooms.length) this.drawRooms(this.rooms);
    else this.drawLoading();
    if (this.active) void this.load();
  }

  /** 접기·펼치기 (머리와 시작 버튼은 늘 보임) */
  private setCollapsed(on: boolean): void {
    this.collapsed = on;
    this.body?.classList.toggle('lb-dock-collapsed', on);
    this.syncHandle();
  }

  private syncHandle(): void {
    const h = this.body?.querySelector<HTMLButtonElement>('.lb-dock-handle');
    if (!h) return;
    h.setAttribute('aria-expanded', String(!this.collapsed));
    const label = this.collapsed ? '방 목록 펼치기' : '방 목록 접기';
    h.setAttribute('aria-label', label);
    h.title = label;
  }

  private setCount(text: string): void {
    if (this.countEl && this.countEl.textContent !== text) this.countEl.textContent = text;
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

  /** 안내 상태(불러오는 중·없음·오류)로 바꿈: 방 줄을 모두 치우고 안내 칸 하나 */
  private clearList(): HTMLElement | null {
    if (!this.list) return null;
    this.list.textContent = '';
    this.rows.clear();
    this.stateBox = el('div', 'lb-room-state');
    this.list.append(this.stateBox);
    return this.stateBox;
  }

  private drawLoading(): void {
    const state = this.clearList();
    if (!state) return;
    state.classList.add('lb-room-loading');
    state.setAttribute('role', 'status');
    this.setCount('');
    // 첫 조회는 서버 연결부터 (이후 자동 새로고침은 목록 조회만)
    state.append(el('i', 'lb-room-spinner'), el('b', '', this.loadedOnce ? '방 목록을 불러오는 중…' : '서버에 연결하는 중…'));
  }

  private drawEmpty(): void {
    this.rooms = [];
    this.selected = null;
    const state = this.clearList();
    if (!state) return;
    state.setAttribute('role', 'status');
    this.setCount('0개');
    state.append(el('b', '', '열린 방이 없어요'), el('p', '', '빠른 시작으로 바로 들어가거나 방을 만들어 보세요'));
  }

  /**
   * 실패 상태 (게임이 알려 준 실제 이유별): offline = 이 빌드에 서버 없음, not_deployed = 서버 준비 중(기능 미배포),
   * connect = 연결 실패, error = 조회 실패. 서버가 있는 경우만 다시 시도
   */
  private drawError(reason?: string): void {
    this.rooms = [];
    this.selected = null;
    const state = this.clearList();
    if (!state) return;
    state.classList.add('lb-room-error');
    state.setAttribute('role', 'alert');
    this.setCount('');
    const [title, desc] =
      reason === 'offline'
        ? ['이 빌드에는 멀티플레이 서버가 없어요', '· Verse8에 올린 게임에서 방 목록을 볼 수 있어요']
        : reason === 'not_deployed'
          ? ['서버 준비 중이에요', '· 방 목록 기능이 아직 서버에 배포되지 않았어요 · 방 코드로는 참가할 수 있어요']
          : reason === 'connect'
            ? ['서버에 연결하지 못했어요', '· 네트워크를 확인하고 다시 시도해 주세요']
            : ['방 목록을 불러오지 못했어요', '· 잠시 후 다시 시도해 주세요'];
    state.append(el('b', '', title), el('p', '', desc));
    if (reason !== 'offline') state.append(button('다시 시도', 'lb-room-retry', () => void this.load()));
  }

  /**
   * 방 줄을 방 코드 기준으로 맞춤: 있던 방은 내용만 고치고, 새 방만 만들고, 없어진 방만 지움 (목록 전체를 다시 만들지 않음).
   * 순서가 바뀐 줄만 옮기고, 스크롤 위치는 그대로 두되 목록이 짧아지면 유효한 범위로 (사용자가 스크롤 중이어도 끊기지 않음)
   */
  private drawRooms(rooms: LobbyRoomInfo[]): void {
    this.rooms = rooms;
    this.setCount(`${rooms.length}개`);
    if (this.selected && !rooms.some((r) => r.code === this.selected)) this.selected = null;
    const list = this.list;
    if (!list) return;
    const scroll = list.scrollTop;
    if (this.stateBox) {
      this.stateBox.remove();
      this.stateBox = null;
    }
    const keep = new Set(rooms.map((r) => r.code));
    for (const [code, r] of this.rows) {
      if (keep.has(code)) continue;
      r.row.remove();
      this.rows.delete(code);
    }
    let prev: Element | null = null;
    for (const room of rooms) {
      let r = this.rows.get(room.code);
      if (!r) {
        r = this.makeRow(room);
        this.rows.set(room.code, r);
      }
      this.fillRow(r, room);
      const want: Element | null = prev ? prev.nextElementSibling : list.firstElementChild;
      if (want !== r.row) list.insertBefore(r.row, want);
      prev = r.row;
    }
    list.scrollTop = Math.min(scroll, Math.max(0, list.scrollHeight - list.clientHeight));
  }

  /** 방 하나: 제목 · 모드 · 코드(작게) · 인원 · 진행 상태 · 참가 */
  private makeRow(room: LobbyRoomInfo): RoomRow {
    const row = el('div', 'lb-room-card');
    row.tabIndex = 0;
    row.setAttribute('role', 'option');
    row.dataset.code = room.code;
    const name = el('span', 'lb-room-name');
    const title = el('b', 'lb-room-title');
    const code = el('small', 'lb-room-no');
    name.append(title, code);
    const mode = el('span', 'lb-room-mode');
    const slots = el('span', 'lb-room-slots');
    const dots = el('i', 'lb-room-dots');
    const count = el('b');
    slots.append(dots, count);
    const status = el('span', 'lb-room-status');
    const r: RoomRow = { row, title, mode, code, count, dots, status, join: null as unknown as HTMLButtonElement, room };
    // 버튼·이벤트는 지금 방 값(r.room)을 읽음 (갱신해도 줄을 다시 만들지 않으므로)
    r.join = button('참가', 'lb-room-join', () => {
      if (r.room.joinable) this.host.joinRoom(r.room.code);
    });
    row.addEventListener('click', () => this.select(r.room.code));
    row.addEventListener('dblclick', () => {
      if (r.room.joinable) this.host.joinRoom(r.room.code);
    });
    row.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && r.room.joinable) this.host.joinRoom(r.room.code);
    });
    row.append(name, mode, slots, status, r.join);
    return r;
  }

  /** 바뀐 값만 DOM에 씀 (같으면 건드리지 않아 깜빡임 없음) */
  private fillRow(r: RoomRow, room: LobbyRoomInfo): void {
    r.room = room;
    const set = (e: HTMLElement, text: string) => {
      if (e.textContent !== text) e.textContent = text;
    };
    this.fillTitle(r);
    set(r.code, room.code);
    set(r.mode, NET_MODE_RULES[room.mode].short);
    r.mode.className = `lb-room-mode lb-room-mode-${room.mode}`;
    set(r.count, `${room.players}/${room.maxPlayers}`);
    if (r.dots.childElementCount !== room.maxPlayers) {
      r.dots.textContent = '';
      for (let i = 0; i < room.maxPlayers; i++) r.dots.append(el('i'));
    }
    [...r.dots.children].forEach((d, i) => d.classList.toggle('lb-filled', i < room.players));
    set(r.status, room.joinable ? this.phaseLabel(room.phase) : this.reasonLabel(room.reason));
    r.status.className = `lb-room-status lb-room-phase-${room.phase}`;
    set(r.join, room.joinable ? '참가' : '입장 불가');
    r.join.disabled = !room.joinable;
    const on = room.code === this.selected;
    r.row.classList.toggle('lb-selected', on);
    r.row.classList.toggle('lb-room-closed', !room.joinable);
    r.row.setAttribute('aria-selected', String(on));
  }

  /** 제목: 서버 번호 → 보는 사람 언어 (번호 없는 예전 방은 모드 이름). 잘리면 마우스를 올려 전체 제목 */
  private fillTitle(r: RoomRow): void {
    const text = roomTitle(r.room.title, viewerLang()) ?? MODE_TITLE[r.room.mode];
    if (r.title.textContent !== text) r.title.textContent = text;
    r.row.title = `${text} · ${NET_MODE_RULES[r.room.mode].short} · ${r.room.code}`;
  }

  private select(code: string): void {
    this.selected = code;
    for (const row of this.list?.querySelectorAll<HTMLElement>('.lb-room-card') ?? []) {
      const on = row.dataset.code === code;
      row.classList.toggle('lb-selected', on);
      row.setAttribute('aria-selected', String(on));
    }
  }

  /** 방 코드로 참가: 기본 접힘 (보조 기능) */
  private codeJoin(): HTMLElement {
    const details = el('details', 'lb-code-details');
    details.append(el('summary', '', '방 코드로 참가'));
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
    details.append(wrap);
    return details;
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

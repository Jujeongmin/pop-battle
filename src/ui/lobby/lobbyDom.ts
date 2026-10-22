// 로비 공용: DOM 도우미 + 로비가 게임에 요청하는 동작(LobbyHost). 패널은 이 인터페이스만 알고 Game 내부는 모름.
import type { NetMode } from '../../net/shared/protocol';

export interface LobbyCharacter {
  id: string;
  name: string;
  role: string;
  color: string;
  maxHp: number;
  /** 이동 속도 배율 (1 = 100%) */
  speed: number;
  locked: boolean;
  /** 이 빌드에서 고를 수 있음 (개발 서버는 잠겨도 true) */
  selectable: boolean;
}

export interface LobbyWeapon {
  id: string;
  name: string;
}

export interface LobbySlider {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
  format(v: number): string;
}

/** 로비 → 게임 요청 (Game이 구현). 실제 기능이 있는 것만 둔다 */
export interface LobbyHost {
  characters(): LobbyCharacter[];
  currentCharacter(): string;
  /** 장착 (저장·매치에 쓰임). 잠긴 캐릭터는 이 빌드에서 고를 수 없으면 false */
  selectCharacter(id: string): Promise<boolean>;
  /** 정비소 미리보기: 가운데 3D를 이 캐릭터로 (장착과 별개, 잠긴 캐릭터도 가능, 모델 로딩·해제는 게임이 함) */
  previewCharacter(id: string): void;
  /** 지금 가운데에 보이는 캐릭터 */
  previewedCharacter(): string;
  /** 미리보기 회전 (드래그한 가로 px) / 정면으로 되돌리기 */
  rotatePreview(dxPx: number): void;
  resetPreviewRotation(): void;
  primaryWeapons(): LobbyWeapon[];
  fixedWeapons(): { secondary: LobbyWeapon; melee: LobbyWeapon };
  currentPrimary(): string;
  selectPrimary(id: string): void;
  /** 봇 3명과 개인전 (기존 싱글플레이) */
  playPractice(): void;
  /** 멀티플레이 메뉴 (모드를 고르고 방 만들기·코드 입장) */
  openMultiplayer(mode: NetMode | null): void;
  /** 새로고침 전 같은 탭에서 있던 방 */
  lastRoomCode(): string | null;
  rejoinLastRoom(): void;
  /** 설정 화면 슬라이더 (사운드·조작·모바일 터치) */
  settings(): { sound: LobbySlider[]; controls: LobbySlider[]; touch: LobbySlider[] };
  /** 패널·메뉴를 피한 빈 공간의 가로 가운데 (px, null = 화면 가운데) → 3D 캐릭터를 그곳에 */
  panelChanged(centerX: number | null): void;
  /**
   * TAB 메뉴가 열리거나 닫히거나 패널이 바뀔 때마다 (open = 메뉴 열림, panel = 열린 패널 id, 메뉴 첫 화면이면 null).
   * 사용자 동작(클릭·키) 처리 안에서 바로 불러야 함: 닫힐 때 게임이 포인터 잠금·터치 조작을 다시 켬 (브라우저는 사용자 동작 안에서만 허용).
   * 열릴 때 게임은 이동·카메라 입력을 멈추고 커서를 보이게 함. panel = 'character'면 정비소 카메라
   */
  menuChanged(open: boolean, panel: string | null): void;
  /** 내 표시 닉네임 (아직 정하지 않았으면 기본 이름 "플레이어") */
  playerName(): string;
  /** 저장된 닉네임 (null = 아직 정하지 않음 → 처음 접속 닉네임 입력 창) */
  nickname(): string | null;
  /**
   * 닉네임 정하기·바꾸기 (이 기기에 저장, 서버에도 알림). 규칙은 protocol.ts NICK_LIMITS·sanitizeNick
   * (2~12자, 글자·숫자·공백·_ - . 만). 통과하면 정리된 값, 아니면 ok: false
   */
  setNickname(raw: string): { ok: boolean; value?: string };
  /** 로비 시작 지점으로 복귀 (PC R 키와 같은 동작, 메뉴 창이 열려 있으면 무시) */
  returnToStart(): void;
  /** 같은 로비 인스턴스 인원 (매 프레임 읽어도 됨) */
  presence(): LobbyPresence;
  /** 로비 연결 바로 다시 시도 (disconnected 상태의 다시 시도 버튼) */
  retryLobby(): void;
  /** 방 목록 (서버 조회, 실패하면 ok: false) */
  listRooms(): Promise<LobbyRoomList>;
  /** 방 만들기 → 기존 멀티 흐름(대기실 화면)으로 */
  createRoom(mode: NetMode): void;
  /** 코드로 참가 → 기존 멀티 흐름(대기실 화면)으로 */
  joinRoom(code: string): void;
}

/** 방 목록 한 줄 (서버가 아는 값만: 방 이름이 없어 코드로 표시) */
export interface LobbyRoomInfo {
  /** 참가에 쓰는 방 코드 (화면 표시용, 예: AB12CD) */
  code: string;
  mode: NetMode;
  players: number;
  maxPlayers: number;
  /** lobby = 대기 중, countdown·playing = 진행 중, result = 결과 화면(종료) */
  phase: 'lobby' | 'countdown' | 'playing' | 'result';
  /** 지금 내가 들어갈 수 있는지 (서버 판정) */
  joinable: boolean;
  /** 못 들어가는 이유: full | in_progress | left_match */
  reason?: string;
}

export interface LobbyRoomList {
  ok: boolean;
  /** 실패 이유 (offline | not_supported | error 등) — 화면에 그대로 지어내지 말고 안내 문구로 */
  reason?: string;
  rooms: LobbyRoomInfo[];
}

/** 같은 로비 인스턴스 접속 현황 (실제 접속 데이터만, 모르면 null) */
export interface LobbyPresence {
  /**
   * offline = 서버 기능 없음(배포 전 등) · connecting = 연결 중 · online = 접속 완료(count·max 있음)
   * disconnected = 끊김·실패 (다음 재시도 대기, retryLobby로 바로 시도 가능) · reconnecting = 다시 연결하는 중
   */
  status: 'offline' | 'connecting' | 'online' | 'disconnected' | 'reconnecting';
  /** 같은 로비 인스턴스에 있는 인원 (나 포함) */
  count: number | null;
  max: number | null;
}

/** 로비 자유 이동 상태 (게임 → 로비 HUD 안내 문구) */
export interface LobbyRoamState {
  /** 터치 조작 기기 (MENU 버튼·터치 안내) / PC (TAB 키·클릭 안내) */
  touch: boolean;
  /** 지금 캐릭터를 조작 중 (PC 포인터 잠금 / 모바일 터치 조작 켜짐). false면 "클릭(터치)해서 움직이기" 안내 */
  active: boolean;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(label: string, cls: string, onClick: () => void, html?: string): HTMLButtonElement {
  const b = el('button', `lb-btn ${cls}`.trim());
  b.type = 'button';
  if (html) b.innerHTML = html;
  else b.textContent = label;
  // 버튼 조작이 뒤의 게임 캔버스·터치 레이어까지 내려가면 포인터 잠금이나 이동이 함께 시작된다.
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel'] as const) {
    b.addEventListener(type, (event) => event.stopPropagation());
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** 준비 중 기능 표시 (작동하는 것처럼 보이지 않게 흐리게 + 배지) */
export function comingSoon(title: string, desc: string): HTMLElement {
  const box = el('div', 'lb-soon');
  box.setAttribute('aria-disabled', 'true');
  const copy = el('div', 'lb-soon-copy');
  copy.append(el('b', '', title), el('p', '', desc));
  box.append(el('span', 'lb-soon-mark', '…'), copy, el('span', 'lb-soon-badge', 'COMING SOON'));
  return box;
}

export function slider(s: LobbySlider): HTMLElement {
  const row = el('label', 'lb-slider');
  const val = el('span', 'lb-slider-val', s.format(s.get()));
  const input = el('input');
  input.type = 'range';
  input.min = String(s.min);
  input.max = String(s.max);
  input.step = String(s.step);
  input.value = String(s.get());
  input.addEventListener('input', () => {
    const v = Number(input.value);
    s.set(v);
    val.textContent = s.format(v);
  });
  row.append(el('span', 'lb-slider-label', s.label), input, val);
  return row;
}

/** 패널 공통 틀: 제목 + 닫기 + 본문 */
export interface LobbyPanel {
  readonly id: string;
  readonly title: string;
  /** 열 때마다 최신 상태로 다시 그림 */
  render(body: HTMLElement): void;
}

export const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  character:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="4.5" fill="currentColor"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z" fill="currentColor"/></svg>',
  loadout:
    '<svg viewBox="0 0 24 24"><rect x="2" y="9" width="15" height="5" rx="2.5" fill="currentColor"/><rect x="16" y="10" width="6" height="2.6" rx="1.3" fill="currentColor"/><rect x="7" y="13" width="3.6" height="6" rx="1.6" fill="currentColor"/></svg>',
  shop: '<svg viewBox="0 0 24 24"><path d="M5 8h14l-1.3 12H6.3z" fill="currentColor"/><path d="M8.5 9V7a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm9 4.7v-2.4l-2.4-.6a7 7 0 0 0-.7-1.6l1.3-2.1-1.7-1.7-2.1 1.3a7 7 0 0 0-1.6-.7L13.2 3h-2.4l-.6 2.4a7 7 0 0 0-1.6.7L6.5 4.8 4.8 6.5l1.3 2.1a7 7 0 0 0-.7 1.6L3 10.8v2.4l2.4.6c.2.6.4 1.1.7 1.6l-1.3 2.1 1.7 1.7 2.1-1.3c.5.3 1 .5 1.6.7l.6 2.4h2.4l.6-2.4c.6-.2 1.1-.4 1.6-.7l2.1 1.3 1.7-1.7-1.3-2.1c.3-.5.5-1 .7-1.6z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="3" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
  coin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#ffd45e" stroke="#e0a91b" stroke-width="2"/><text x="12" y="16.5" text-anchor="middle" font-size="11" font-weight="900" fill="#b9831a">P</text></svg>',
  team: '<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="3" fill="currentColor"/><circle cx="17" cy="9" r="2.6" fill="currentColor"/><path d="M2.5 19c0-3.8 2.3-6 5.5-6s5.5 2.2 5.5 6zM13 19c0-2.7 1.6-4.6 4-4.6s4 1.9 4 4.6z" fill="currentColor"/></svg>',
  target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  bot: '<svg viewBox="0 0 24 24"><path d="M12 3v3M9.5 3h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="4" y="6" width="16" height="14" rx="5" fill="currentColor"/><circle cx="9" cy="12" r="1.5" fill="#fff"/><circle cx="15" cy="12" r="1.5" fill="#fff"/><path d="M9 16h6" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 4l-3 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  return: '<svg viewBox="0 0 24 24"><path d="M9 7H6V4L2 8l4 4V9h3c5 0 8 2.4 9 7 1-6-2-9-9-9z" fill="currentColor"/></svg>',
  rooms:
    '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="2" fill="currentColor"/><rect x="3" y="11" width="18" height="9" rx="2.5" fill="currentColor"/><circle cx="7" cy="15.5" r="1.3" fill="#fff"/><path d="M11 14.5h7M11 17.5h5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>',
  create:
    '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="5" fill="currentColor"/><path d="M12 8v8M8 12h8" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
  menu:
    '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24"><path d="M19 8V4l-2 2a8 8 0 1 0 2.4 8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

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
  selectCharacter(id: string): Promise<boolean>;
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
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** 준비 중 기능 표시 (작동하는 것처럼 보이지 않게 흐리게 + 배지) */
export function comingSoon(title: string, desc: string): HTMLElement {
  const box = el('div', 'lb-soon');
  box.append(el('b', '', title), el('span', 'lb-soon-badge', 'COMING SOON'), el('p', '', desc));
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
};

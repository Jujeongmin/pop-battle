// 메인 로비 (게임 시작 전 화면). 가운데는 게임 장면의 실제 플레이어 아바타(로비 카메라) — 3D 객체를 따로 만들지 않음.
// 구성: 상단(로고·플레이어 정보·재화 자리) · 왼쪽 메뉴(CHARACTER·LOADOUT·SHOP·SETTINGS) · 오른쪽 아래 PLAY · 오른쪽 패널(메뉴별 컴포넌트)
// 로비가 떠 있는 동안 게임 입력(캔버스 클릭·터치 조작)은 막힘: 로비가 화면을 덮고 이벤트를 받음.
import './lobby.css';
import { CharacterPanel } from './CharacterPanel';
import { LoadoutPanel } from './LoadoutPanel';
import { button, el, ICON, type LobbyHost, type LobbyPanel } from './lobbyDom';
import { PlayPanel } from './PlayPanel';
import { SettingsPanel } from './SettingsPanel';
import { ShopPanel } from './ShopPanel';

const NAV: Array<{ id: string; label: string; icon: string }> = [
  { id: 'character', label: 'CHARACTER', icon: ICON.character },
  { id: 'loadout', label: 'LOADOUT', icon: ICON.loadout },
  { id: 'shop', label: 'SHOP', icon: ICON.shop },
  { id: 'settings', label: 'SETTINGS', icon: ICON.settings },
];

export class Lobby {
  readonly root = el('div', 'lobby hidden');
  private readonly panels = new Map<string, LobbyPanel>();
  private readonly panelBox = el('section', 'lb-panel');
  private readonly panelTitle = el('h2', 'lb-panel-title');
  private readonly panelBody = el('div', 'lb-panel-body');
  private readonly navButtons = new Map<string, HTMLButtonElement>();
  private readonly nav = el('nav', 'lb-nav');
  private readonly avatarEl = el('div', 'lb-avatar');
  private readonly charNameEl = el('span', 'lb-profile-char');
  private open: string | null = null;
  private visible = false;
  private lastChar = '';
  private readonly abort = new AbortController();

  constructor(
    container: HTMLElement,
    private readonly host: LobbyHost,
  ) {
    for (const p of [new PlayPanel(host), new CharacterPanel(host), new LoadoutPanel(host), new ShopPanel(), new SettingsPanel(host)]) this.panels.set(p.id, p);

    // 상단: 로고 / 플레이어 정보 (Verse8 SDK에 닉네임 API 없음 → "플레이어" + 선택 캐릭터) / 재화 자리 (재화 시스템 없음)
    const top = el('header', 'lb-top');
    const logo = el('div', 'lb-logo');
    logo.innerHTML = '<b>POP!</b><span>BATTLE</span>';
    const profile = el('div', 'lb-profile');
    const who = el('div', 'lb-profile-text');
    who.append(el('b', 'lb-profile-name', '플레이어'), this.charNameEl);
    profile.append(this.avatarEl, who);
    const coin = el('div', 'lb-coin');
    coin.innerHTML = `${ICON.coin}<span>재화 · 준비 중</span>`;
    coin.title = '재화 시스템은 다음 단계에서 열려요';
    const right = el('div', 'lb-top-right');
    right.append(coin, profile);
    top.append(logo, right);

    const nav = this.nav;
    for (const n of NAV) {
      const b = button('', 'lb-nav-btn', () => this.toggle(n.id), `<span class="lb-nav-icon">${n.icon}</span><span class="lb-nav-label">${n.label}</span>`);
      this.navButtons.set(n.id, b);
      nav.appendChild(b);
    }

    const play = button('', 'lb-play', () => this.toggle('play'), `<span class="lb-play-icon">${ICON.play}</span><span class="lb-play-label">PLAY</span>`);
    this.navButtons.set('play', play);

    const head = el('div', 'lb-panel-head');
    const close = button('', 'lb-close', () => this.show(null), ICON.close);
    close.setAttribute('aria-label', '닫기');
    head.append(this.panelTitle, close);
    this.panelBox.append(head, this.panelBody);

    this.root.append(top, nav, play, this.panelBox);
    // 로비 위 조작은 게임(캔버스·포인터 잠금·터치 시작)으로 넘기지 않음
    for (const t of ['pointerdown', 'mousedown', 'touchstart', 'click', 'wheel'] as const) this.root.addEventListener(t, (e) => e.stopPropagation(), { signal: this.abort.signal });
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.visible && e.key === 'Escape' && this.open) this.show(null);
      },
      { signal: this.abort.signal },
    );
    window.addEventListener('resize', () => this.layout(), { signal: this.abort.signal });
    container.appendChild(this.root);
    this.layout();
    this.refresh();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('hidden', !on);
    if (on) {
      this.root.classList.remove('enter');
      void this.root.offsetWidth;
      this.root.classList.add('enter');
      this.refresh();
    }
    this.reportPanel();
  }

  /** 선택 캐릭터가 바뀌었으면 상단 정보 갱신 (주기적으로 호출, 바뀐 게 없으면 DOM 그대로) */
  refresh(): void {
    const cur = this.host.currentCharacter();
    if (cur === this.lastChar) return;
    this.lastChar = cur;
    const c = this.host.characters().find((x) => x.id === cur);
    this.charNameEl.textContent = c ? c.name : cur;
    this.avatarEl.style.setProperty('--c', c?.color ?? '#5b8cff');
    this.avatarEl.textContent = (c?.name ?? cur).slice(0, 1);
  }

  private toggle(id: string): void {
    this.show(this.open === id ? null : id);
  }

  /** 패널 열기 (null = 닫기). 열 때마다 최신 상태로 다시 그림 */
  show(id: string | null): void {
    this.open = id;
    for (const [k, b] of this.navButtons) b.classList.toggle('active', k === id);
    const p = id ? this.panels.get(id) : undefined;
    this.root.classList.toggle('panel-open', !!p);
    if (p) {
      this.panelTitle.textContent = p.title;
      this.panelBody.textContent = '';
      this.panelBody.scrollTop = 0;
      p.render(this.panelBody);
      this.panelBox.classList.remove('in');
      void this.panelBox.offsetWidth;
      this.panelBox.classList.add('in');
    }
    this.reportPanel();
  }

  /** 화면 크기 → 로비 배율 (높이 720px 기준 0.62~1.15) + 패널 폭 다시 알림 */
  private layout(): void {
    const lu = Math.min(1.15, Math.max(0.62, innerHeight / 720));
    this.root.style.setProperty('--lu', lu.toFixed(3));
    this.reportPanel();
  }

  /** 패널이 열리면 왼쪽 메뉴와 패널 사이 빈 공간 가운데 → 게임이 3D 캐릭터를 그곳으로 (닫히면 화면 가운데) */
  private reportPanel(): void {
    if (!this.visible || !this.open) {
      this.host.panelChanged(null);
      return;
    }
    const left = this.nav.offsetLeft + this.nav.offsetWidth;
    const right = this.panelBox.offsetLeft;
    this.host.panelChanged(right > left ? (left + right) / 2 : null);
  }

  dispose(): void {
    this.abort.abort();
    this.root.remove();
  }
}

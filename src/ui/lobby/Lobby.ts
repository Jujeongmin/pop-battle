// 자유 이동 로비의 상단 메뉴 바와 창. 3D 월드와 캐릭터는 게임이 그리고, 여기서는 DOM UI만 맡는다.
import './lobby.css';
import './toy.css';
import { toGame, viewH } from '../../core/screenRotation';
import { CharacterPanel } from './CharacterPanel';
import { CreateRoomPanel } from './CreateRoomPanel';
import { LoadoutPanel } from './LoadoutPanel';
import { button, el, ICON, type LobbyCharacter, type LobbyHost, type LobbyPanel, type LobbyRoamState } from './lobbyDom';
import { PlayPanel } from './PlayPanel';
import { RoomListPanel } from './RoomListPanel';
import { SettingsPanel } from './SettingsPanel';
import { ShopPanel } from './ShopPanel';
import { nicknameEditor, type NicknameEditor } from './nicknameUi';

const NAV: Array<{ id: string; label: string; korean: string; icon: string }> = [
  { id: 'play', label: 'PLAY', korean: '게임 시작', icon: ICON.play },
  { id: 'create', label: 'CREATE ROOM', korean: '방 만들기', icon: ICON.create },
  { id: 'character', label: 'CHARACTER', korean: '캐릭터', icon: ICON.character },
  { id: 'loadout', label: 'LOADOUT', korean: '장비', icon: ICON.loadout },
  { id: 'shop', label: 'SHOP', korean: '상점', icon: ICON.shop },
  { id: 'settings', label: 'SETTINGS', korean: '설정', icon: ICON.settings },
];

/** 전체 화면 메뉴 (로비를 가리고 독립 화면으로): 캐릭터·장비·상점·설정. 게임 시작·방 만들기는 로비 위 창 */
const FULLSCREEN = new Set(['character', 'loadout', 'shop', 'settings']);

type ManagedLobbyPanel = LobbyPanel & {
  activate?(): void;
  deactivate?(): void;
  dispose?(): void;
};

export class Lobby {
  readonly root = el('div', 'lb-lobby lb-hidden');
  private readonly panels = new Map<string, ManagedLobbyPanel>();
  private readonly characterPanel: CharacterPanel;
  private readonly roomListPanel: RoomListPanel;
  private readonly menuLayer = el('div', 'lb-menu-layer');
  private readonly panelBox = el('section', 'lb-panel');
  private readonly panelTitle = el('h2', 'lb-panel-title');
  private readonly panelBody = el('div', 'lb-panel-body');
  /** 로비에 늘 보이는 방 목록 칸 (창이 열리면 숨김, 서버 연결·방 목록 갱신은 보일 때만) */
  private readonly roomDock = el('section', 'lb-room-dock');
  private dockOn = false;
  /** 전체 화면 메뉴 닫힘 페이드아웃 (끝나면 화면 배치 클래스를 뗌). 다시 열면 바로 취소 */
  private fadeOutTimer: number | null = null;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly closeLabel = el('span', '', '닫기');
  private readonly navButtons = new Map<string, HTMLButtonElement>();
  private readonly nav = el('nav', 'lb-nav');
  private readonly charStage = el('div', 'lb-char-stage');
  private readonly stageName = el('b', 'lb-stage-name');
  private readonly stageRole = el('span', 'lb-stage-role');
  private readonly stageBadges = el('span', 'lb-stage-badges');
  private readonly playerName = el('b', 'lb-player-name');
  private readonly presence = el('span', 'lb-presence');
  private readonly presenceLabel = el('span', 'lb-presence-label');
  /** 연결이 끊겼을 때 바로 다시 연결 */
  private readonly presenceRetry = button('다시 시도', 'lb-presence-retry', () => this.host.retryLobby());
  private readonly controlHint = el('div', 'lb-control-hint');
  private readonly nicknameModal = el('div', 'lb-nickname-modal');
  private readonly nicknameEditor: NicknameEditor;
  private open: string | null = null;
  private menu = false;
  private nicknameOpen = false;
  private visible = false;
  private lastPlayer = '';
  private lastPresence = '';
  private roamTouch = false;
  private characterSuspended = false;
  private dragPointer: number | null = null;
  private dragX = 0;
  private readonly abort = new AbortController();
  private readonly resizeObserver: ResizeObserver;

  constructor(
    container: HTMLElement,
    private readonly host: LobbyHost,
  ) {
    this.characterPanel = new CharacterPanel(host, (character) => {
      this.updateStageNameplate(character);
      this.refresh();
    });
    this.roomListPanel = new RoomListPanel(host, () => this.show('create'));
    const openPanel = (id: string) => this.show(id);
    for (const panel of [
      new PlayPanel(host, openPanel),
      new CreateRoomPanel(host),
      this.characterPanel,
      new LoadoutPanel(host),
      new ShopPanel(host),
      new SettingsPanel(host),
    ]) {
      this.panels.set(panel.id, panel);
    }


    this.nicknameEditor = this.buildNicknameModal();

    this.buildBar();
    this.buildWindow();
    this.buildDock();
    this.buildHint();
    this.root.append(this.nav, this.roomDock, this.controlHint, this.menuLayer, this.nicknameModal);

    window.addEventListener(
      'keydown',
      (event) => {
        if (this.visible && this.nicknameOpen && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.nicknameEditor.input.focus();
          return;
        }
        if (!this.visible || !this.menu || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        this.closeMenu();
      },
      { capture: true, signal: this.abort.signal },
    );
    window.addEventListener('resize', () => this.layout(), { signal: this.abort.signal });

    container.appendChild(this.root);
    this.resizeObserver = new ResizeObserver(() => this.reportPanel());
    this.resizeObserver.observe(this.nav);
    this.resizeObserver.observe(this.panelBox);
    this.resizeObserver.observe(this.roomDock);
    this.layout();
    this.setRoam({ touch: false, active: true });
    this.refresh();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get menuOpen(): boolean {
    return this.menu;
  }

  /** 창을 연다. null과 알 수 없는 패널은 PLAY로 연다. */
  openMenu(panel: string | null = null): void {
    if (this.nicknameOpen) {
      this.nicknameEditor.input.focus();
      return;
    }
    const next = panel && this.panels.has(panel) ? panel : 'play';
    this.cancelFadeOut();
    const changed = !this.menu || this.open !== next;
    this.menu = true;
    this.root.classList.add('lb-menu-open', 'lb-panel-open');
    this.menuLayer.inert = false;
    this.menuLayer.setAttribute('aria-hidden', 'false');
    if (changed) this.applyPanel(next);
    this.syncDock();
    this.host.menuChanged(true, next);
  }

  /** 창을 닫고 로비 이동을 즉시 다시 켠다. */
  closeMenu(): void {
    if (this.nicknameOpen) return;
    if (!this.menu) return;
    const previous = this.open;
    if (previous === 'character') this.leaveCharacterWorkshop();
    if (previous) this.panels.get(previous)?.deactivate?.();
    this.open = null;
    this.menu = false;
    this.characterSuspended = false;
    // 전체 화면 메뉴는 150ms 페이드아웃 동안 배치 그대로 두고 입력만 막음 (screens.css lb-fs-out)
    const fading = this.root.classList.contains('lb-fullscreen') && this.visible && !this.reducedMotion.matches;
    this.root.classList.remove('lb-menu-open', 'lb-panel-open');
    if (fading) {
      this.root.classList.add('lb-fs-out');
      this.fadeOutTimer = window.setTimeout(() => this.finishFadeOut(), 150);
    } else {
      this.root.classList.remove('lb-character-open', 'lb-fullscreen');
    }
    document.documentElement.classList.remove('pop-lobby-fullscreen');
    this.panelBox.classList.remove('lb-panel-in');
    this.menuLayer.inert = true;
    this.menuLayer.setAttribute('aria-hidden', 'true');
    this.markNavigation();
    this.syncDock();
    this.host.panelChanged(null);
    this.host.menuChanged(false, null);
  }

  private finishFadeOut(): void {
    this.fadeOutTimer = null;
    this.root.classList.remove('lb-fs-out');
    if (!this.menu) this.root.classList.remove('lb-character-open', 'lb-fullscreen');
  }

  /** 페이드아웃 중 다시 열면 바로 끝내고 새 화면으로 (빠른 연속 클릭에도 화면이 겹치지 않게) */
  private cancelFadeOut(): void {
    if (this.fadeOutTimer === null) return;
    window.clearTimeout(this.fadeOutTimer);
    this.finishFadeOut();
  }

  /** TAB: 닫혀 있으면 게임 시작 창, 열려 있으면(어느 창이든) 닫기 */
  toggleMenu(): void {
    if (this.menu) this.closeMenu();
    else this.openMenu('play');
  }

  /** 터치 여부만 UI에 반영한다. 로비에는 이동 시작 안내나 포인터 잠금 안내가 없다. */
  setRoam(state: LobbyRoamState): void {
    if (state.touch === this.roamTouch && this.root.dataset.roamReady === 'true') return;
    this.roamTouch = state.touch;
    this.root.dataset.roamReady = 'true';
    this.root.classList.toggle('lb-touch', state.touch);
    if (!state.touch) this.replayHint();
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    if (!on) this.cancelFadeOut();
    // 매치 중에는 로비 전체 화면 표시가 터치 조작을 숨기지 않게
    document.documentElement.classList.toggle('pop-lobby-fullscreen', on && this.root.classList.contains('lb-fullscreen'));
    if (!on) {
      this.open && this.panels.get(this.open)?.deactivate?.();
      if (this.open === 'character') {
        this.leaveCharacterWorkshop();
        this.characterSuspended = true;
      }
    }
    this.visible = on;
    this.root.classList.toggle('lb-hidden', !on);
    this.menuLayer.inert = !on || !this.menu;
    if (on) {
      this.syncRequiredNickname();
      if (this.menu && this.open) {
        if (this.open === 'character' && this.characterSuspended) {
          this.characterSuspended = false;
          this.renderPanel(this.characterPanel);
        }
        this.panels.get(this.open)?.activate?.();
      }
      this.refresh();
      this.replayHint();
    }
    this.syncDock();
    this.reportPanel();
  }

  /** 매 프레임 호출되어도 실제 값이 달라진 요소만 갱신한다. */
  refresh(): void {
    const player = this.host.playerName();
    if (player !== this.lastPlayer) {
      this.lastPlayer = player;
      this.playerName.textContent = player;
      this.playerName.title = player;
      this.playerName.setAttribute('aria-label', `플레이어: ${player}`);
    }
    const p = this.host.presence();
    const presenceKey = p.status;
    if (presenceKey !== this.lastPresence) {
      this.lastPresence = presenceKey;
      this.presence.className = `lb-presence lb-presence-${p.status}`;
      // 정상 연결 중에는 상태 칩을 숨기고, 문제가 있거나 연결 중일 때만 짧게 알린다.
      const [label, title] =
        p.status === 'online'
          ? ['', '로비 서버 연결됨']
          : p.status === 'connecting'
            ? ['연결 중…', '로비 서버에 연결 중']
            : p.status === 'reconnecting'
              ? ['재연결 중…', '로비 서버에 다시 연결 중']
              : p.status === 'disconnected'
                ? ['연결 끊김', '로비 서버 연결이 끊겼어요 · 잠시 뒤 자동으로 다시 시도해요']
                : ['오프라인', '이 빌드에는 멀티플레이 서버가 없어요'];
      this.presenceLabel.textContent = label;
      this.presence.title = title;
      this.presence.setAttribute('aria-label', title);
      this.presence.hidden = p.status === 'online';
      this.presenceRetry.hidden = p.status !== 'disconnected';
    }
    this.syncRequiredNickname();
  }

  show(id: string | null): void {
    this.openMenu(id);
  }

  private buildBar(): void {
    const status = el('div', 'lb-nav-status');
    const brand = el('div', 'lb-nav-brand');
    brand.setAttribute('aria-label', 'POP! BATTLE');
    brand.innerHTML = '<b>POP!</b><span>BATTLE</span>';
    const identity = el('div', 'lb-identity');
    this.presence.append(this.presenceLabel, this.presenceRetry);
    this.presenceRetry.hidden = true;
    this.presence.hidden = true;
    identity.append(this.playerName, this.presence);
    status.append(brand, identity);
    // 상단: [로고 · 캐릭터 · 장비 · 상점 · 설정]. 게임 시작·방 만들기는 그 아래 방 목록 칸 머리에 (예전 큰 버튼 줄·MENU 창 없음)
    const icons = el('div', 'lb-top-icons');
    for (const item of NAV) {
      if (item.id === 'play' || item.id === 'create') continue;
      const navButton = button(
        '',
        `lb-top-btn lb-top-icon-btn lb-top-${item.id}`,
        () => (this.menu && this.open === item.id ? this.closeMenu() : this.show(item.id)),
        `<span class="lb-top-icon">${item.icon}</span><b>${item.korean}</b>`,
      );
      navButton.setAttribute('aria-label', item.korean);
      navButton.setAttribute('aria-pressed', 'false');
      // 누름 피드백: 마우스·터치 똑같이 100ms 어둡게 (짧은 탭은 :active가 거의 안 보여서 클래스로)
      let tapTimer = 0;
      navButton.addEventListener('pointerdown', () => {
        navButton.classList.add('lb-tap');
        window.clearTimeout(tapTimer);
        tapTimer = window.setTimeout(() => navButton.classList.remove('lb-tap'), 100);
      }, { signal: this.abort.signal });
      this.navButtons.set(item.id, navButton);
      icons.append(navButton);
    }
    const row = el('div', 'lb-top-row');
    row.append(status, icons);
    this.nav.classList.add('lb-topbar');
    this.nav.append(row);
  }

  private buildWindow(): void {
    this.menuLayer.setAttribute('aria-hidden', 'true');
    this.menuLayer.inert = true;
    this.menuLayer.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        if (event.target === this.menuLayer) this.closeMenu();
      },
      { signal: this.abort.signal },
    );
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel'] as const) {
      this.menuLayer.addEventListener(type, (event) => event.stopPropagation(), { signal: this.abort.signal });
    }

    const stagePlate = el('div', 'lb-stage-plate');
    const stageCopy = el('span', 'lb-stage-copy');
    stageCopy.append(this.stageName, this.stageRole);
    stagePlate.append(stageCopy, this.stageBadges);
    // 드래그 회전은 그대로, 안내 문구·정면 버튼은 두지 않음 (화면을 가림)
    this.charStage.setAttribute('aria-label', '캐릭터 3D 미리보기 회전 영역');
    this.charStage.append(stagePlate);
    this.bindStageDrag();

    const close = button('', 'lb-panel-close', () => this.closeMenu(), ICON.close);
    close.append(this.closeLabel);
    close.setAttribute('aria-label', '창 닫기');
    const panelHead = el('div', 'lb-panel-head');
    panelHead.append(this.panelTitle, close);
    this.panelBox.append(panelHead, this.panelBody);
    this.panelBox.setAttribute('aria-live', 'polite');
    this.menuLayer.append(this.charStage, this.panelBox);
  }

  /** 방 목록 칸: 로비 화면 오른쪽 (게임 조작·카메라로 입력이 새지 않게) */
  private buildDock(): void {
    this.roomDock.setAttribute('aria-label', '방 목록');
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel'] as const) {
      this.roomDock.addEventListener(type, (event) => event.stopPropagation(), { signal: this.abort.signal });
    }
    this.roomListPanel.render(this.roomDock);
    this.roomDock.hidden = true;
  }

  /** 방 목록 칸은 로비가 보이고 창·닉네임 입력이 없을 때만 보이고 갱신 */
  private syncDock(): void {
    const on = this.visible && !this.menu && !this.nicknameOpen;
    if (on === this.dockOn) return;
    this.dockOn = on;
    this.roomDock.hidden = !on;
    if (on) this.roomListPanel.activate();
    else this.roomListPanel.deactivate();
    this.reportPanel();
  }

  private buildHint(): void {
    this.controlHint.textContent = 'WASD 이동 · W 두 번 달리기 · Space 점프 · Shift 슬라이딩 · TAB 게임 시작';
    this.controlHint.addEventListener('mouseenter', () => this.replayHint(), { signal: this.abort.signal });
  }

  private buildNicknameModal(): NicknameEditor {
    const titleId = 'lb-nickname-title';
    this.nicknameModal.setAttribute('role', 'dialog');
    this.nicknameModal.setAttribute('aria-modal', 'true');
    this.nicknameModal.setAttribute('aria-labelledby', titleId);
    this.nicknameModal.setAttribute('aria-hidden', 'true');
    this.nicknameModal.inert = true;

    // 입력 중인 키가 로비 이동·메뉴 단축키까지 전달되지 않게 모달 경계에서 막는다.
    for (const eventName of ['keydown', 'keyup'] as const) {
      this.nicknameModal.addEventListener(eventName, (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') event.preventDefault();
      }, { signal: this.abort.signal });
    }
    for (const eventName of ['pointerdown', 'mousedown', 'touchstart', 'wheel'] as const) {
      this.nicknameModal.addEventListener(eventName, (event) => event.stopPropagation(), { signal: this.abort.signal });
    }

    const card = el('section', 'lb-nickname-card');
    const logo = el('div', 'lb-logo lb-nickname-logo');
    logo.setAttribute('aria-label', 'POP! BATTLE');
    logo.innerHTML = '<b>POP!</b><span>BATTLE</span>';
    const eyebrow = el('span', 'lb-nickname-eyebrow', 'WELCOME');
    const title = el('h2', 'lb-nickname-title', '닉네임을 정해 주세요');
    title.id = titleId;
    const copy = el('p', 'lb-nickname-copy', '다른 플레이어에게 보일 이름이에요. 나중에 SETTINGS에서 바꿀 수 있어요.');
    const editor = nicknameEditor(this.host, {
      buttonLabel: '확인',
      onSuccess: () => {
        this.closeRequiredNickname();
        this.refresh();
      },
    });
    card.append(logo, eyebrow, title, copy, editor.root);
    this.nicknameModal.appendChild(card);
    return editor;
  }

  /** 저장된 이름이 없으면 필수 입력 창을 열고 게임 이동을 멈춘다. 서버 확인이 끝나기 전에는 열지 않음 (저장된 이름이 있으면 건너뜀) */
  private syncRequiredNickname(): void {
    if (!this.visible) return;
    if (this.host.nickname() !== null || !this.host.nicknameReady()) {
      if (this.nicknameOpen) this.closeRequiredNickname();
      return;
    }
    if (this.nicknameOpen) return;
    if (this.menu) this.closeMenu();
    this.nicknameOpen = true;
    this.root.classList.add('lb-nickname-open');
    this.nicknameModal.inert = false;
    this.nicknameModal.setAttribute('aria-hidden', 'false');
    this.syncDock();
    this.host.menuChanged(true, 'nickname');
    requestAnimationFrame(() => {
      if (this.visible && this.nicknameOpen) this.nicknameEditor.input.focus();
    });
  }

  private closeRequiredNickname(): void {
    if (!this.nicknameOpen) return;
    this.nicknameOpen = false;
    this.root.classList.remove('lb-nickname-open');
    this.nicknameModal.inert = true;
    this.nicknameModal.setAttribute('aria-hidden', 'true');
    this.syncDock();
    this.host.menuChanged(false, null);
  }

  private replayHint(): void {
    if (this.roamTouch) return;
    this.controlHint.classList.remove('lb-control-hint-fade');
    void this.controlHint.offsetWidth;
    this.controlHint.classList.add('lb-control-hint-fade');
  }

  private applyPanel(next: string): void {
    const previous = this.open;
    if (previous && previous !== next) this.panels.get(previous)?.deactivate?.();
    if (previous === 'character' && next !== 'character') this.leaveCharacterWorkshop();
    this.open = next;
    this.characterSuspended = false;
    this.root.classList.toggle('lb-character-open', next === 'character');
    // 캐릭터·장비·상점·설정 = 전체 화면 (로비를 가리고 '로비로' 버튼·ESC로 복귀)
    const full = FULLSCREEN.has(next);
    this.root.classList.toggle('lb-fullscreen', full);
    // 전체 화면 메뉴 동안 게임 쪽 터치 조이스틱도 숨김 (screens.css)
    document.documentElement.classList.toggle('pop-lobby-fullscreen', full);
    this.closeLabel.textContent = full ? '로비로' : '닫기';
    this.markNavigation();
    const panel = this.panels.get(next)!;
    this.renderPanel(panel);
    if (this.visible) panel.activate?.();
    this.reportPanel();
  }

  private renderPanel(panel: LobbyPanel): void {
    if (panel.id === 'character') this.host.resetPreviewRotation();
    this.panelTitle.textContent = panel.title;
    this.panelBody.textContent = '';
    this.panelBody.scrollTop = 0;
    panel.render(this.panelBody);
    this.panelBox.classList.remove('lb-panel-in');
    void this.panelBox.offsetWidth;
    this.panelBox.classList.add('lb-panel-in');
    this.reportPanel();
  }

  private markNavigation(): void {
    for (const [id, navButton] of this.navButtons) {
      const active = this.menu && id === this.open;
      navButton.classList.toggle('lb-active', active);
      navButton.setAttribute('aria-pressed', String(active));
    }
  }

  private layout(): void {
    const scale = Math.min(1.08, Math.max(0.72, viewH() / 720));
    this.root.style.setProperty('--lu', scale.toFixed(3));
    this.reportPanel();
  }

  /** CHARACTER에서만 시트 왼쪽 빈 영역의 가운데를 게임에 알린다. */
  private reportPanel(): void {
    // MENU 창은 상단 바 바로 아래·오른쪽 끝 맞춤 (바 높이는 화면 크기에 따라 달라짐 → 실제 위치로)
    this.root.style.setProperty('--lb-nav-bottom', `${this.nav.offsetTop + this.nav.offsetHeight}px`);
    this.root.style.setProperty('--lb-nav-right', `${Math.max(0, this.root.clientWidth - this.nav.offsetLeft - this.nav.offsetWidth)}px`);
    this.layoutCharacterStage();
    // 방 목록 칸 아래 끝 → 게임이 캐릭터를 그 아래에 보이게
    this.host.uiBottomChanged(this.visible && this.dockOn ? this.roomDock.offsetTop + this.roomDock.offsetHeight : null);
    if (!this.visible || !this.menu || this.open !== 'character') {
      this.host.panelChanged(null);
      return;
    }
    const scale = Number.parseFloat(getComputedStyle(this.root).getPropertyValue('--lu')) || 1;
    const left = Math.max(8, 18 * scale);
    const right = this.panelBox.offsetLeft;
    this.host.panelChanged(right > left ? (left + right) / 2 : null);
  }

  private layoutCharacterStage(): void {
    if (!this.visible || !this.menu || this.open !== 'character') return;
    const scale = Number.parseFloat(getComputedStyle(this.root).getPropertyValue('--lu')) || 1;
    const gap = Math.max(6, 12 * scale);
    const left = Math.max(8, 18 * scale);
    const right = this.panelBox.offsetLeft - gap;
    const top = this.nav.offsetTop + this.nav.offsetHeight + gap;
    this.charStage.style.left = `${left}px`;
    this.charStage.style.top = `${top}px`;
    this.charStage.style.width = `${Math.max(0, right - left)}px`;
    this.charStage.style.height = `${Math.max(0, this.root.clientHeight - top - gap)}px`;
    // 전체 화면 캐릭터: 무대 밖 바탕만 덮음 (screens.css 마스크)
    const s = this.root.style;
    s.setProperty('--lb-stage-top', `${top}px`);
    s.setProperty('--lb-stage-left', `${left}px`);
    s.setProperty('--lb-stage-right-gap', `${Math.max(0, this.root.clientWidth - right)}px`);
    s.setProperty('--lb-stage-bottom-gap', `${gap}px`);
  }

  private updateStageNameplate(character: LobbyCharacter): void {
    this.stageName.textContent = character.name;
    this.stageName.style.setProperty('--c', character.color);
    this.stageRole.textContent = character.role;
    this.stageBadges.textContent = '';
    if (character.locked) {
      const locked = el('span', 'lb-stage-badge lb-stage-locked');
      locked.innerHTML = `${ICON.lock}<span>잠김</span>`;
      this.stageBadges.appendChild(locked);
    }
    const equipped = character.id === this.host.currentCharacter();
    this.stageBadges.appendChild(el('span', equipped ? 'lb-stage-badge lb-stage-equipped' : 'lb-stage-badge', equipped ? '장착 중' : '미리보기'));
  }

  private bindStageDrag(): void {
    this.charStage.addEventListener('pointerdown', (event) => {
      if (this.open !== 'character' || (event.pointerType === 'mouse' && event.button !== 0)) return;
      this.dragPointer = event.pointerId;
      // 게임 화면 기준 가로 위치 (세로로 든 기기에서 돌려 그릴 때도 손가락 방향 그대로)
      this.dragX = toGame(event.clientX, event.clientY).x;
      this.charStage.classList.add('lb-dragging');
      try { this.charStage.setPointerCapture(event.pointerId); } catch { /* 포인터 캡처 미지원 */ }
      event.preventDefault();
      event.stopPropagation();
    }, { signal: this.abort.signal });
    this.charStage.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.dragPointer) return;
      const x = toGame(event.clientX, event.clientY).x;
      const dx = x - this.dragX;
      this.dragX = x;
      if (dx) this.host.rotatePreview(dx);
      event.preventDefault();
    }, { signal: this.abort.signal });
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== this.dragPointer) return;
      try { this.charStage.releasePointerCapture(event.pointerId); } catch { /* 이미 해제됨 */ }
      this.dragPointer = null;
      this.charStage.classList.remove('lb-dragging');
    };
    this.charStage.addEventListener('pointerup', finish, { signal: this.abort.signal });
    this.charStage.addEventListener('pointercancel', finish, { signal: this.abort.signal });
  }

  private leaveCharacterWorkshop(): void {
    this.characterPanel.close();
    this.dragPointer = null;
    this.charStage.classList.remove('lb-dragging');
    this.host.previewCharacter(this.host.currentCharacter());
    this.host.resetPreviewRotation();
  }

  dispose(): void {
    if (this.open === 'character') this.leaveCharacterWorkshop();
    for (const panel of this.panels.values()) panel.dispose?.();
    this.roomListPanel.dispose();
    this.abort.abort();
    this.resizeObserver.disconnect();
    this.root.remove();
  }
}

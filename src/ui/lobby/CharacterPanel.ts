// CHARACTER (전체 화면): 왼쪽 큰 3D 전신(게임 쇼케이스) + 오른쪽 6종 카드. 카드마다 전신 이미지·이름·HP·이동속도 게이지를 늘 보여
// 한눈에 비교한다 (게이지는 6종 중 가장 큰 값을 기준으로 같은 스케일, 값은 캐릭터 데이터 그대로).
// 카드를 누르면 3D 미리보기만 바뀌고(장착과 별개), 아래 장착 버튼으로 장착한다. 잠긴 캐릭터는 미리보기·능력치만.
import { button, el, ICON, type LobbyCharacter, type LobbyHost, type LobbyPanel } from './lobbyDom';

export class CharacterPanel implements LobbyPanel {
  readonly id = 'character';
  readonly title = '캐릭터';
  private note: HTMLElement | null = null;
  private nameEl: HTMLElement | null = null;
  private stateEl: HTMLElement | null = null;
  private equipButton: HTMLButtonElement | null = null;
  private cards: HTMLButtonElement[] = [];
  private characters: LobbyCharacter[] = [];
  private preview = '';
  private loading = false;
  private active = false;
  private renderVersion = 0;

  constructor(
    private readonly host: LobbyHost,
    private readonly onPreview: (character: LobbyCharacter) => void,
  ) {}

  render(body: HTMLElement): void {
    const version = ++this.renderVersion;
    this.active = true;
    this.loading = false;
    this.characters = this.host.characters();
    // 같은 스케일: 6종 중 최대값 기준 (데이터에서 직접)
    const hpMax = Math.max(...this.characters.map((c) => c.maxHp));
    const speedMax = Math.max(...this.characters.map((c) => c.speed));

    const grid = el('div', 'lb-char-grid lb-char-compare');
    this.cards = this.characters.map((character) => {
      const card = button('', 'lb-char-card lb-portrait-loading', () => this.show(character, true));
      card.dataset.id = character.id;
      card.style.setProperty('--c', character.color);
      const figure = el('span', 'lb-char-portrait');
      figure.append(el('i', 'lb-swatch'));
      const copy = el('span', 'lb-char-card-copy');
      copy.append(el('b', '', character.name), el('small', '', character.role));
      const stats = el('span', 'lb-char-stats');
      stats.append(
        this.gauge('HP', 'lb-g-hp', character.maxHp / hpMax, String(character.maxHp)),
        this.gauge('이동', 'lb-g-speed', character.speed / speedMax, `${Math.round(character.speed * 100)}%`),
      );
      card.append(figure, copy, stats, el('span', 'lb-card-equipped', '장착 중'));
      if (character.locked) {
        const lock = el('span', 'lb-lock');
        lock.innerHTML = `${ICON.lock}<i>잠김</i>`;
        card.append(lock);
      }
      card.classList.toggle('lb-locked', character.locked);
      card.setAttribute('aria-pressed', 'false');
      card.title = character.locked ? `${character.name} · 잠김 · 미리보기` : `${character.name} 미리보기`;
      grid.appendChild(card);
      void this.loadFigure(card, character, version);
      return card;
    });
    body.appendChild(grid);

    // 아래: 선택한 캐릭터 이름·상태 + 장착 버튼
    const bar = el('div', 'lb-char-bar');
    const info = el('div', 'lb-char-bar-info');
    this.nameEl = el('b', 'lb-char-name');
    this.stateEl = el('span', 'lb-char-state');
    this.note = el('p', 'lb-char-note');
    this.note.setAttribute('aria-live', 'polite');
    info.append(this.nameEl, this.stateEl, this.note);
    this.equipButton = button('', 'lb-char-equip', () => void this.equip(version));
    bar.append(info, this.equipButton);
    body.appendChild(bar);

    // 열 때는 저장된 장착 캐릭터부터 보여 준다.
    const equipped = this.host.currentCharacter();
    const first = this.characters.find((character) => character.id === equipped) ?? this.characters[0];
    if (first) this.show(first, true);
  }

  /** 패널이 사라진 뒤 끝난 비동기 장착 응답이 옛 DOM을 바꾸지 않게 한다. */
  close(): void {
    this.renderVersion++;
    this.active = false;
    this.loading = false;
  }

  private gauge(label: string, cls: string, ratio: number, value: string): HTMLElement {
    const row = el('span', `lb-gauge ${cls}`);
    const track = el('span', 'lb-gauge-track');
    const fill = el('span', 'lb-gauge-fill');
    fill.style.width = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(1)}%`;
    track.appendChild(fill);
    row.append(el('span', 'lb-gauge-label', label), track, el('b', 'lb-gauge-value', value));
    return row;
  }

  private async equip(version: number): Promise<void> {
    const character = this.characters.find((item) => item.id === this.preview);
    if (!character || this.loading || !character.selectable || character.id === this.host.currentCharacter()) return;

    this.loading = true;
    this.updateAction(character, 'loading');
    let ok = false;
    try {
      ok = await this.host.selectCharacter(character.id);
    } catch {
      ok = false;
    }
    if (version !== this.renderVersion) {
      if (this.active) {
        const visible = this.characters.find((item) => item.id === this.preview);
        this.mark();
        if (visible) {
          this.updateAction(visible);
          this.onPreview(visible);
        }
      } else {
        // 닫히는 순간 진행 중이던 장착이 뒤늦게 끝나도 홈은 새 장착 캐릭터를 보여야 한다.
        this.host.previewCharacter(this.host.currentCharacter());
        this.host.resetPreviewRotation();
      }
      return;
    }

    this.loading = false;
    this.mark();
    const visible = this.characters.find((item) => item.id === this.preview) ?? character;
    this.onPreview(visible);
    if (visible.id !== character.id) {
      this.updateAction(visible);
      return;
    }
    if (ok) {
      this.updateAction(character, 'success');
      window.setTimeout(() => {
        if (version === this.renderVersion && this.preview === character.id) this.updateAction(character);
      }, 1200);
    } else {
      this.updateAction(character, 'failure');
    }
  }

  /** 캐시된 전신 이미지(6종 한 번씩 렌더). 실패하면 카드의 색상 실루엣이 대체 이미지 */
  private async loadFigure(card: HTMLButtonElement, character: LobbyCharacter, version: number): Promise<void> {
    try {
      const source = await this.host.characterFullBody(character.id);
      if (version !== this.renderVersion || !card.isConnected) return;
      const image = el('img');
      image.src = source;
      image.alt = character.name;
      image.draggable = false;
      card.querySelector('.lb-char-portrait')?.appendChild(image);
      card.classList.add('lb-has-portrait');
    } catch {
      // 모델 렌더 실패 시 기존 색상 실루엣을 사용한다.
    } finally {
      if (version === this.renderVersion) card.classList.remove('lb-portrait-loading');
    }
  }

  /** 3D 미리보기·아래 정보를 바꾼다. 장착 상태는 건드리지 않는다. */
  private show(character: LobbyCharacter, changeModel: boolean): void {
    this.preview = character.id;
    if (changeModel) this.host.previewCharacter(character.id);
    this.nameEl!.textContent = `${character.name} · ${character.role}`;
    this.nameEl!.style.setProperty('--c', character.color);
    this.mark();
    this.updateAction(character);
    this.onPreview(character);
  }

  private updateAction(character: LobbyCharacter, result?: 'loading' | 'success' | 'failure'): void {
    const equipped = character.id === this.host.currentCharacter();
    this.stateEl!.classList.toggle('lb-locked', character.locked && !equipped);
    this.stateEl!.classList.toggle('lb-equipped', equipped);
    this.stateEl!.textContent = equipped ? '장착 중' : character.locked ? '잠김 · 미리보기' : '미리보기 중';

    const equip = this.equipButton!;
    equip.classList.toggle('lb-loading', result === 'loading');
    equip.classList.toggle('lb-success', result === 'success');
    equip.classList.toggle('lb-equip-locked', !character.selectable);
    equip.disabled = this.loading || equipped || !character.selectable;

    if (result === 'loading') {
      equip.textContent = '불러오는 중';
      this.note!.textContent = '';
    } else if (result === 'success') {
      equip.textContent = '장착 중';
      this.note!.textContent = '이 캐릭터로 장착했어요.';
    } else if (equipped) {
      equip.textContent = '장착 중';
      this.note!.textContent = result === 'failure' ? '지금은 캐릭터를 바꿀 수 없어요.' : '';
    } else if (!character.selectable) {
      equip.innerHTML = `<span class="lb-equip-lock">${ICON.lock}</span><span>잠김</span>`;
      this.note!.textContent = '잠긴 캐릭터 · 미리보기만 가능해요 (해금 준비 중)';
    } else {
      equip.textContent = '장착하기';
      this.note!.textContent = result === 'failure' ? '지금은 캐릭터를 바꿀 수 없어요.' : '';
    }
  }

  private mark(): void {
    const equipped = this.host.currentCharacter();
    for (const card of this.cards) {
      const isEquipped = card.dataset.id === equipped;
      const isPreview = card.dataset.id === this.preview;
      card.classList.toggle('lb-equipped', isEquipped);
      card.classList.toggle('lb-preview', isPreview);
      card.setAttribute('aria-pressed', String(isPreview));
    }
  }
}

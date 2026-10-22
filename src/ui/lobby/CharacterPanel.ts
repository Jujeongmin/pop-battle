// CHARACTER 정비소: 카드는 3D 미리보기만 바꾸고, 별도 결정 버튼으로 장착한다.
// 체력·이동속도는 모든 캐릭터가 같은 최대 기준으로 비교하며 수치는 표시하지 않는다.
import { button, el, ICON, type LobbyCharacter, type LobbyHost, type LobbyPanel } from './lobbyDom';

const HP_MAX = 130;
const SPEED_MAX = 1.15;

export class CharacterPanel implements LobbyPanel {
  readonly id = 'character';
  readonly title = 'CHARACTER';
  private note: HTMLElement | null = null;
  private hpBar: HTMLElement | null = null;
  private speedBar: HTMLElement | null = null;
  private nameEl: HTMLElement | null = null;
  private roleEl: HTMLElement | null = null;
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
    const info = el('div', 'lb-char-info');
    const heading = el('div', 'lb-char-heading');
    const copy = el('div', 'lb-char-copy');
    this.nameEl = el('b', 'lb-char-name');
    this.roleEl = el('span', 'lb-char-role');
    this.stateEl = el('span', 'lb-char-state');
    copy.append(this.nameEl, this.roleEl);
    heading.append(copy, this.stateEl);

    const gauges = el('div', 'lb-gauges');
    const gauge = (label: string, cls: string) => {
      const row = el('div', `lb-gauge ${cls}`);
      const track = el('div', 'lb-gauge-track');
      const fill = el('div', 'lb-gauge-fill');
      track.appendChild(fill);
      row.append(el('span', 'lb-gauge-label', label), track);
      gauges.appendChild(row);
      return fill;
    };
    this.hpBar = gauge('HP', 'lb-g-hp');
    this.speedBar = gauge('SPEED', 'lb-g-speed');
    info.append(heading, gauges);
    body.appendChild(info);

    const grid = el('div', 'lb-char-grid');
    this.cards = this.characters.map((character) => {
      const card = button(
        '',
        'lb-char-card',
        () => this.show(character, false, true),
        `<i class="lb-swatch"></i><b></b><span class="lb-card-equipped">장착 중</span>${character.locked ? `<span class="lb-lock">${ICON.lock}</span>` : ''}`,
      );
      card.dataset.id = character.id;
      card.style.setProperty('--c', character.color);
      card.querySelector('b')!.textContent = character.name;
      card.classList.toggle('lb-locked', character.locked);
      card.setAttribute('aria-pressed', 'false');
      card.title = character.locked ? `${character.name} · 잠김 · 미리보기` : `${character.name} 미리보기`;
      grid.appendChild(card);
      return card;
    });
    body.appendChild(grid);

    this.equipButton = button('', 'lb-char-equip', () => void this.equip(version));
    body.appendChild(this.equipButton);
    this.note = el('p', 'lb-char-note');
    this.note.setAttribute('aria-live', 'polite');
    body.appendChild(this.note);

    // 정비소를 열 때는 저장된 장착 캐릭터부터 보여 준다.
    const equipped = this.host.currentCharacter();
    const first = this.characters.find((character) => character.id === equipped) ?? this.characters[0];
    if (first) this.show(first, true, true);
  }

  /** 패널이 사라진 뒤 끝난 비동기 장착 응답이 옛 DOM을 바꾸지 않게 한다. */
  close(): void {
    this.renderVersion++;
    this.active = false;
    this.loading = false;
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

  /** 이름·게이지·3D 미리보기를 함께 바꾼다. 장착 상태는 건드리지 않는다. */
  private show(character: LobbyCharacter, first: boolean, changeModel: boolean): void {
    this.preview = character.id;
    if (changeModel) this.host.previewCharacter(character.id);
    this.nameEl!.textContent = character.name;
    this.nameEl!.style.setProperty('--c', character.color);
    this.roleEl!.textContent = character.role;

    const hp = `${Math.min(100, (character.maxHp / HP_MAX) * 100).toFixed(1)}%`;
    const speed = `${Math.min(100, (character.speed / SPEED_MAX) * 100).toFixed(1)}%`;
    const apply = () => {
      this.hpBar!.style.width = hp;
      this.speedBar!.style.width = speed;
    };
    if (first) requestAnimationFrame(() => requestAnimationFrame(apply));
    else apply();

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
      equip.textContent = '장착하는 중…';
      this.note!.textContent = '';
    } else if (result === 'success') {
      equip.textContent = '장착 완료';
      this.note!.textContent = '이 캐릭터로 장착했어요.';
    } else if (equipped) {
      equip.textContent = '장착 중';
      this.note!.textContent = result === 'failure' ? '지금은 캐릭터를 바꿀 수 없어요.' : '';
    } else if (!character.selectable) {
      equip.innerHTML = `<span class="lb-equip-lock">${ICON.lock}</span><span>잠긴 캐릭터</span>`;
      this.note!.textContent = '잠긴 캐릭터 · 미리보기만 가능해요 (해금 준비 중)';
    } else {
      equip.textContent = '이 캐릭터로 결정';
      this.note!.textContent = result === 'failure' ? '지금은 캐릭터를 바꿀 수 없어요.' : '카드를 눌러 모습과 능력을 미리 볼 수 있어요.';
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

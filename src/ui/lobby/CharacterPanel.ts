// CHARACTER (전체 화면): 왼쪽 큰 3D 전신(게임 쇼케이스) + 오른쪽 6종 카드. 카드마다 전신 이미지·이름·HP·이동속도 게이지를 늘 보여
// 한눈에 비교한다 (게이지는 6종 중 가장 큰 값을 기준으로 같은 스케일, 값은 캐릭터 데이터 그대로).
// 카드를 누르면 3D 미리보기만 바뀌고(장착과 별개), 아래 장착 버튼으로 장착한다. 잠긴 캐릭터는 미리보기·능력치만.
// 유료 캐릭터(SHONI·BAM): 카드에 가격, 아래 버튼이 VXShop 구매 버튼 (지급은 서버, 보유가 확인되면 바로 장착 버튼으로).
import { CHARACTER_PRICE_VX } from '../../net/shared/shop';
import { button, el, ICON, markRadios, radioGroup, type LobbyCharacter, type LobbyHost, type LobbyPanel } from './lobbyDom';

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
  /** 상점·보유 상태 구독 해제 */
  private offShop: (() => void) | null = null;

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
    radioGroup(grid, '캐릭터 미리보기');
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
      card.append(figure, copy, stats, el('span', 'lb-card-equipped', '✓ 장착 중'), el('span', 'lb-card-preview', '미리보기'));
      this.decorateLock(card, character);
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
    this.equipButton = button('', 'lb-char-equip', () => {
      // 유료 잠김: 구매(또는 반영 재확인), 그 외: 장착
      const c = this.characters.find((item) => item.id === this.preview);
      const offer = c ? this.host.characterOffer(c.id) : null;
      if (offer?.returnFullscreen) {
        this.host.returnPurchaseFullscreen(offer.charId);
        return;
      }
      if (offer && c && !c.selectable) {
        if (offer.delayed) this.host.recheckPurchase(offer.charId);
        else if (offer.canBuy) this.host.buyCharacter(offer.charId);
        return;
      }
      void this.equip(version);
    });
    bar.append(info, this.equipButton);
    body.appendChild(bar);

    // 열 때는 저장된 장착 캐릭터부터 보여 준다.
    const equipped = this.host.currentCharacter();
    const first = this.characters.find((character) => character.id === equipped) ?? this.characters[0];
    if (first) this.show(first, true);
    // 결제·보유 확인·상품 조회 결과가 오면 잠금·가격·버튼을 바로 바꿈 (패널이 다시 그려지면 이전 구독 해제)
    this.offShop?.();
    this.offShop = this.host.onShopChange(() => {
      if (version !== this.renderVersion || !grid.isConnected) {
        this.offShop?.();
        this.offShop = null;
        return;
      }
      this.characters = this.host.characters();
      for (const card of this.cards) {
        const c = this.characters.find((x) => x.id === card.dataset.id);
        if (c) this.decorateLock(card, c);
      }
      this.mark();
      const visible = this.characters.find((x) => x.id === this.preview);
      if (visible && !this.loading) this.updateAction(visible);
    });
  }

  /** 잠금 표시: 자물쇠 + (유료면) 가격, 화면 읽기 설명. 보유하면 지움 */
  private decorateLock(card: HTMLButtonElement, character: LobbyCharacter): void {
    card.querySelector('.lb-lock')?.remove();
    card.querySelector(`#lb-char-lock-${character.id}`)?.remove();
    card.removeAttribute('aria-describedby');
    card.classList.toggle('lb-locked', character.locked);
    card.title = character.locked ? `${character.name} · 잠김 · 미리보기` : `${character.name} 미리보기`;
    if (!character.locked) return;
    const offer = this.host.characterOffer(character.id);
    const price = offer ? `${offer.price ?? CHARACTER_PRICE_VX} VX` : '';
    const lock = el('span', 'lb-lock');
    lock.innerHTML = `${ICON.lock}<i>${price || '잠김'}</i>`;
    card.append(lock);
    // 잠긴 이유·해제 방법을 화면 읽기에도 연결
    const why = el('span', 'lb-sr-only', offer ? `잠긴 캐릭터 · ${price}에 구매하면 장착할 수 있어요 · 지금은 미리보기만` : '잠긴 캐릭터 · 미리보기만 가능');
    why.id = `lb-char-lock-${character.id}`;
    card.append(why);
    card.setAttribute('aria-describedby', why.id);
  }

  /** 패널이 사라진 뒤 끝난 비동기 장착 응답이 옛 DOM을 바꾸지 않게 한다. */
  close(): void {
    this.offShop?.();
    this.offShop = null;
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
    row.append(el('span', 'lb-gauge-label', label), track, el('b', 'lb-gauge-value', value), el('em', 'lb-gauge-delta'));
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
    equip.classList.remove('lb-equip-buy');
    equip.removeAttribute('aria-label');
    equip.classList.toggle('lb-loading', result === 'loading');
    equip.classList.toggle('lb-success', result === 'success');
    equip.classList.toggle('lb-equip-locked', !character.selectable);
    equip.disabled = this.loading || equipped || !character.selectable;
    const offer = this.host.characterOffer(character.id);

    if (offer?.returnFullscreen) {
      equip.classList.add('lb-equip-buy');
      equip.disabled = false;
      equip.textContent = '전체화면으로 돌아가기';
      equip.setAttribute('aria-label', '전체화면으로 돌아가기');
      this.note!.textContent = offer.note;
      return;
    }

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
      if (offer) {
        // 유료: 가격(VXShop 조회값 우선) 구매 버튼, 결제 중·확인 중엔 막음, 반영이 늦으면 다시 확인
        equip.classList.add('lb-equip-buy');
        equip.disabled = !(offer.canBuy || offer.delayed);
        equip.innerHTML = offer.delayed
          ? '<span>다시 확인</span>'
          : offer.busy
            ? '<span>결제 진행 중…</span>'
            : `<span class="lb-equip-lock">${ICON.lock}</span><span>${offer.price ?? CHARACTER_PRICE_VX} VX 구매</span>`;
        equip.setAttribute('aria-label', offer.delayed ? '구매 반영 다시 확인' : `${character.name} ${offer.price ?? CHARACTER_PRICE_VX} VX에 구매`);
        this.note!.textContent = offer.note;
        return;
      }
      equip.innerHTML = `<span class="lb-equip-lock">${ICON.lock}</span><span>잠김</span>`;
      this.note!.textContent = '잠긴 캐릭터 · 미리보기만 가능해요';
    } else {
      equip.textContent = '장착하기';
      this.note!.textContent = result === 'failure' ? '지금은 캐릭터를 바꿀 수 없어요.' : '';
    }
  }

  private mark(): void {
    const equipped = this.host.currentCharacter();
    // 장착 캐릭터 대비 증감 (HP +10 · 이동 -5%), 장착 카드는 비움
    const base = this.characters.find((c) => c.id === equipped);
    for (const card of this.cards) {
      const c = this.characters.find((x) => x.id === card.dataset.id);
      const [hp, speed] = card.querySelectorAll<HTMLElement>('.lb-gauge-delta');
      if (c && base && hp && speed) {
        const dh = c.maxHp - base.maxHp;
        const ds = Math.round((c.speed - base.speed) * 100);
        const fmt = (n: number, unit: string) => (c.id === equipped || n === 0 ? '' : `${n > 0 ? '+' : ''}${n}${unit}`);
        hp.textContent = fmt(dh, '');
        speed.textContent = fmt(ds, '%');
        hp.className = `lb-gauge-delta${dh > 0 ? ' lb-up' : dh < 0 ? ' lb-down' : ''}`;
        speed.className = `lb-gauge-delta${ds > 0 ? ' lb-up' : ds < 0 ? ' lb-down' : ''}`;
      }
    }
    for (const card of this.cards) {
      const isEquipped = card.dataset.id === equipped;
      const isPreview = card.dataset.id === this.preview;
      card.classList.toggle('lb-equipped', isEquipped);
      card.classList.toggle('lb-preview', isPreview);
    }
    markRadios(this.cards, (card) => card.dataset.id === this.preview);
  }
}

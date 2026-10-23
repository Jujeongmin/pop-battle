// SHOP: 유료 캐릭터 (VXShop 공식 결제, SHONI·BAM 영구 해금) + 무기 스킨 미리보기(준비 중, 구매 버튼 없음).
// 캐릭터 카드: 전신 그림 · 이름 · 유형 · HP·이동 · 가격(VXShop 조회값 우선) · 구매/보유/다시 확인 버튼 · 안내 한 줄.
// 구매 버튼은 공식 결제창만 엶 — 지급·보유 확인은 서버. 상품을 못 받으면 버튼을 끄고 이유를 보여 줌 (가짜 결제창 없음).
import { CHARACTER_PRICE_VX } from '../../net/shared/shop';
import { button, el, ICON, type LobbyCharacter, type LobbyHost, type LobbyPanel, type LobbyWeapon } from './lobbyDom';

export class ShopPanel implements LobbyPanel {
  readonly id = 'shop';
  readonly title = '상점';
  private offShop: (() => void) | null = null;

  constructor(
    private readonly host: LobbyHost,
    private readonly openCharacter: () => void,
  ) {}

  render(body: HTMLElement): void {
    const fixed = this.host.fixedWeapons();
    const weapons = [...this.host.primaryWeapons(), fixed.secondary, fixed.melee];
    const paid = this.host.characters().filter((c) => this.host.characterOffer(c.id));
    const section = el('section', 'lb-shop-chars');
    section.setAttribute('aria-label', '캐릭터 판매');
    const head = el('div', 'lb-shop-chars-head');
    const status = el('p', 'lb-shop-status');
    status.setAttribute('role', 'status');
    head.append(el('b', 'lb-shop-chars-title', '캐릭터'), el('span', 'lb-shop-chars-sub', 'VX로 영구 해금 · 계정당 1회'), status);
    const row = el('div', 'lb-shop-char-row');
    const draw: Array<() => void> = [];
    for (const c of paid) {
      const { card, update } = this.characterCard(c);
      row.append(card);
      draw.push(update);
    }
    section.append(head, row);
    body.append(section, this.weaponSkinPreview(weapons));
    const refresh = () => {
      const st = this.host.shopStatus();
      status.textContent = st.error ?? (st.loading ? '상품 정보를 불러오는 중…' : '');
      for (const d of draw) d();
    };
    refresh();
    this.offShop?.();
    this.offShop = this.host.onShopChange(() => {
      if (!section.isConnected) {
        this.offShop?.();
        this.offShop = null;
        return;
      }
      refresh();
    });
  }

  /** 유료 캐릭터 한 장 (상태는 update로 다시 그림) */
  private characterCard(c: LobbyCharacter): { card: HTMLElement; update: () => void } {
    const card = el('article', 'lb-shop-char');
    card.style.setProperty('--c', c.color);
    const art = el('span', 'lb-shop-char-art');
    void this.host.characterFullBody(c.id).then((src) => {
      if (!art.isConnected) return;
      const img = el('img');
      img.src = src;
      img.alt = c.name;
      img.draggable = false;
      art.append(img);
    }).catch(() => undefined);
    const copy = el('div', 'lb-shop-char-copy');
    copy.append(el('b', 'lb-shop-char-name', c.name), el('span', 'lb-shop-char-role', c.role), el('span', 'lb-shop-char-stats', `HP ${c.maxHp} · 이동 ${Math.round(c.speed * 100)}%`));
    const price = el('span', 'lb-shop-char-price');
    const note = el('p', 'lb-shop-char-note');
    note.setAttribute('aria-live', 'polite');
    const action = button('', 'lb-shop-char-buy', () => {
      const o = this.host.characterOffer(c.id);
      if (!o) return;
      if (o.owned) this.openCharacter();
      else if (o.delayed) this.host.recheckPurchase(c.id);
      else if (o.canBuy) this.host.buyCharacter(c.id);
    });
    card.append(art, copy, price, action, note);
    const update = () => {
      const o = this.host.characterOffer(c.id);
      if (!o) return;
      const vx = o.price ?? CHARACTER_PRICE_VX;
      price.innerHTML = o.owned ? '<span class="lb-shop-owned">✓ 보유 중</span>' : `<span class="lb-vx">VX</span><b>${vx}</b>`;
      card.classList.toggle('lb-shop-char-owned', o.owned);
      action.classList.toggle('lb-shop-char-owned-btn', o.owned);
      if (o.owned) {
        action.disabled = false;
        action.textContent = '장착하러 가기';
      } else if (o.delayed) {
        action.disabled = false;
        action.textContent = '다시 확인';
      } else if (o.busy) {
        action.disabled = true;
        action.textContent = '결제 진행 중…';
      } else {
        action.disabled = !o.canBuy;
        action.innerHTML = `${ICON.lock}<span>${vx} VX 구매</span>`;
      }
      action.setAttribute('aria-label', o.owned ? `${c.name} 보유 중 · 캐릭터 화면으로` : `${c.name} ${vx} VX에 구매`);
      // 상점 전체 이유(머리 줄)와 같은 문구는 카드마다 반복하지 않음
      note.textContent = o.note === this.host.shopStatus().error ? '' : o.note;
    };
    return { card, update };
  }

  private weaponSkinPreview(weapons: LobbyWeapon[]): HTMLElement {
    const section = el('section', 'lb-shop-weapon-preview');
    section.setAttribute('aria-label', '무기 스킨 미리보기');
    const title = el('div', 'lb-shop-weapon-title', '무기 스킨 미리보기 · 준비 중');
    const row = el('div', 'lb-shop-weapon-row');
    for (const weapon of weapons) {
      const card = el('div', 'lb-shop-weapon-card');
      card.setAttribute('aria-disabled', 'true');
      const visual = el('span', 'lb-shop-weapon-image');
      const source = this.host.weaponImage(weapon.id);
      if (source) {
        const image = el('img');
        image.src = source;
        image.alt = weapon.name;
        image.draggable = false;
        visual.appendChild(image);
      }
      const badge = el('span', 'lb-shop-weapon-badge');
      badge.innerHTML = `${ICON.lock}<span>준비 중</span>`;
      card.append(visual, el('b', '', weapon.name), badge);
      row.appendChild(card);
    }
    section.append(title, row);
    return section;
  }
}

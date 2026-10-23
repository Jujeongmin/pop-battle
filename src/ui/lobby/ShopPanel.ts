// SHOP: 구조만 (상품·재화·구매는 다음 단계). 작동하는 것처럼 보이지 않게 모두 잠금 + 준비 중으로 표시 (구매 버튼 없음)
import { el, ICON, type LobbyHost, type LobbyPanel, type LobbyWeapon } from './lobbyDom';

export class ShopPanel implements LobbyPanel {
  readonly id = 'shop';
  readonly title = '상점';

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    const fixed = this.host.fixedWeapons();
    const weapons = [...this.host.primaryWeapons(), fixed.secondary, fixed.melee];
    const banner = el('div', 'lb-shop-banner');
    banner.setAttribute('aria-disabled', 'true');
    const copy = el('div', 'lb-shop-banner-copy');
    copy.append(el('b', '', '상점 준비 중'), el('p', '', '캐릭터·무기 스킨을 준비하고 있어요. 지금은 구매할 수 없어요'));
    const mark = el('span', 'lb-shop-banner-mark');
    mark.innerHTML = ICON.shop;
    banner.append(mark, copy);
    body.append(banner, this.weaponSkinPreview(weapons));
  }

  private weaponSkinPreview(weapons: LobbyWeapon[]): HTMLElement {
    const section = el('section', 'lb-shop-weapon-preview');
    section.setAttribute('aria-label', '무기 스킨 미리보기');
    const title = el('div', 'lb-shop-weapon-title', '무기 스킨 미리보기');
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

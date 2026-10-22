// SHOP: 구조만 (상품·재화·구매는 다음 단계). 작동하는 것처럼 보이지 않게 모두 준비 중으로 표시
import { comingSoon, el, type LobbyHost, type LobbyPanel, type LobbyWeapon } from './lobbyDom';

export class ShopPanel implements LobbyPanel {
  readonly id = 'shop';
  readonly title = 'SHOP';

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    const fixed = this.host.fixedWeapons();
    const weapons = [...this.host.primaryWeapons(), fixed.secondary, fixed.melee];
    body.append(
      comingSoon('캐릭터', '새 캐릭터 해금 기능'),
      comingSoon('스킨', '캐릭터·무기 꾸미기'),
      this.weaponSkinPreview(weapons),
      comingSoon('재화', '게임 재화와 보상 (지금은 보유 재화 없음)'),
    );
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
      card.append(visual, el('b', '', weapon.name), el('span', 'lb-shop-weapon-badge', '준비 중'));
      row.appendChild(card);
    }
    section.append(title, row);
    return section;
  }
}

// SHOP: 구조만 (상품·재화·구매는 다음 단계). 작동하는 것처럼 보이지 않게 모두 준비 중으로 표시
import { comingSoon, type LobbyPanel } from './lobbyDom';

export class ShopPanel implements LobbyPanel {
  readonly id = 'shop';
  readonly title = 'SHOP';

  render(body: HTMLElement): void {
    body.append(
      comingSoon('캐릭터', '새 캐릭터 해금 기능'),
      comingSoon('스킨', '캐릭터·무기 꾸미기'),
      comingSoon('재화', '게임 재화와 보상 (지금은 보유 재화 없음)'),
    );
  }
}

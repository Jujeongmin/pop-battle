// MENU: 상단 바 대신 작은 게임 메뉴 창 (방 목록·방 만들기·캐릭터·장비·상점·설정으로 이동). MENU·TAB·ESC로 닫힘
import { button, el, type LobbyPanel } from './lobbyDom';

export interface MenuItem {
  id: string;
  korean: string;
  label: string;
  icon: string;
}

export class MenuPanel implements LobbyPanel {
  readonly id = 'menu';
  readonly title = '메뉴';

  constructor(
    private readonly items: readonly MenuItem[],
    private readonly open: (id: string) => void,
  ) {}

  render(body: HTMLElement): void {
    const grid = el('div', 'lb-gamemenu-grid');
    for (const item of this.items) {
      const tile = button(
        '',
        `lb-gamemenu-tile lb-gamemenu-${item.id}`,
        () => this.open(item.id),
        `<span class="lb-nav-icon">${item.icon}</span><b>${item.korean}</b><small>${item.label}</small>`,
      );
      tile.setAttribute('aria-label', item.korean);
      grid.appendChild(tile);
    }
    body.appendChild(grid);
  }
}

// PLAY: 바로 시작할 수 있는 연습전과 멀티플레이 창 바로가기를 모은다.
import { button, el, ICON, type LobbyHost, type LobbyPanel } from './lobbyDom';

export class PlayPanel implements LobbyPanel {
  readonly id = 'play';
  readonly title = '게임 시작';

  constructor(
    private readonly host: LobbyHost,
    private readonly openPanel: (id: string) => void,
  ) {}

  render(body: HTMLElement): void {
    const grid = el('div', 'lb-play-grid');
    grid.append(
      button(
        '',
        'lb-mode lb-mode-practice lb-play-hero',
        () => this.host.playPractice(),
        `<span class="lb-mode-icon">${ICON.bot}</span><span class="lb-mode-copy"><small>PRACTICE</small><b>봇 연습전</b><span>봇 3명과 개인전 · 3분 · 15킬 먼저</span></span><i>바로 시작</i>`,
      ),
      button(
        '',
        'lb-mode lb-mode-tdm',
        () => this.openPanel('create'),
        `<span class="lb-mode-icon">${ICON.create}</span><span class="lb-mode-copy"><small>CREATE ROOM</small><b>새 방 만들기</b><span>TDM 또는 FFA 규칙을 선택</span></span><i>열기</i>`,
      ),
    );
    body.appendChild(grid);
  }
}

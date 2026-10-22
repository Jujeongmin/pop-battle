// PLAY: 바로 시작할 수 있는 연습전과 멀티플레이 창 바로가기를 모은다.
import { displayCode } from '../../net/NetSession';
import { button, comingSoon, el, ICON, type LobbyHost, type LobbyPanel } from './lobbyDom';

export class PlayPanel implements LobbyPanel {
  readonly id = 'play';
  readonly title = 'PLAY';

  constructor(
    private readonly host: LobbyHost,
    private readonly openPanel: (id: string) => void,
  ) {}

  render(body: HTMLElement): void {
    body.append(el('p', 'lb-panel-lead', '원하는 방식으로 바로 시작해 보세요.'));
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
        'lb-mode lb-mode-join',
        () => this.openPanel('rooms'),
        `<span class="lb-mode-icon">${ICON.rooms}</span><span class="lb-mode-copy"><small>ROOM LIST</small><b>방 찾아보기</b><span>열려 있는 방을 보거나 코드로 참가</span></span><i>열기</i>`,
      ),
      button(
        '',
        'lb-mode lb-mode-tdm',
        () => this.openPanel('create'),
        `<span class="lb-mode-icon">${ICON.create}</span><span class="lb-mode-copy"><small>CREATE ROOM</small><b>새 방 만들기</b><span>TDM 또는 FFA 규칙을 선택</span></span><i>열기</i>`,
      ),
    );
    const last = this.host.lastRoomCode();
    if (last) {
      grid.append(
        button(
          '',
          'lb-mode lb-rejoin',
          () => this.host.rejoinLastRoom(),
          `<span class="lb-mode-icon">${ICON.return}</span><span class="lb-mode-copy"><small>RECENT ROOM</small><b>이전 방 다시 입장</b><span>방 코드 ${displayCode(last)} · 진행 중인 매치로 복귀</span></span><i>입장</i>`,
        ),
      );
    }
    grid.append(comingSoon('빠른 매칭', '자동으로 알맞은 방을 찾는 기능은 준비 중이에요.'));
    body.appendChild(grid);
  }
}

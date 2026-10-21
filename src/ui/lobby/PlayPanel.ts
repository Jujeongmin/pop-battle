// PLAY: 게임 모드 고르기 → 기존 기능으로 연결 (연습전 = 봇 개인전, 멀티 = 기존 Multiplayer 메뉴의 방 만들기·코드 입장)
import { displayCode } from '../../net/NetSession';
import { NET_MODE_RULES } from '../../net/shared/protocol';
import { button, comingSoon, el, type LobbyHost, type LobbyPanel } from './lobbyDom';

export class PlayPanel implements LobbyPanel {
  readonly id = 'play';
  readonly title = 'PLAY';

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    const last = this.host.lastRoomCode();
    if (last) {
      body.appendChild(
        button('', 'lb-mode lb-rejoin', () => this.host.rejoinLastRoom(), `<b>이전 방 다시 입장</b><span>방 코드 ${displayCode(last)} · 진행 중이던 매치로 복귀</span>`),
      );
    }
    body.appendChild(el('div', 'lb-section', '멀티플레이 (최대 4인)'));
    const grid = el('div', 'lb-mode-grid');
    for (const mode of ['tdm', 'ffa'] as const) {
      const r = NET_MODE_RULES[mode];
      const desc = mode === 'tdm' ? `BLUE vs RED 2:2 · ${r.timeLimitMs / 60000}분 · 팀 ${r.scoreToWin}킬` : `4인 개인전 · ${r.timeLimitMs / 60000}분 · ${r.scoreToWin}킬`;
      grid.appendChild(button('', `lb-mode lb-mode-${mode}`, () => this.host.openMultiplayer(mode), `<b>${r.short}</b><span>${desc}</span><i>방 만들기 · 코드로 입장</i>`));
    }
    body.appendChild(grid);
    body.appendChild(button('', 'lb-mode lb-mode-join', () => this.host.openMultiplayer(null), '<b>방 코드로 입장</b><span>친구가 알려 준 Room Code로 들어가기</span>'));
    body.appendChild(el('div', 'lb-section', '혼자 하기'));
    body.appendChild(button('', 'lb-mode lb-mode-practice', () => this.host.playPractice(), '<b>연습전</b><span>봇 3명과 개인전 · 3분 · 15킬 먼저</span>'));
    body.appendChild(comingSoon('빠른 매칭', '자동으로 방을 찾아 들어가는 기능은 다음 단계에서 열려요.'));
  }
}

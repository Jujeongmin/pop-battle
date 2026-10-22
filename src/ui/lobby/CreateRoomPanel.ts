// 새 방 만들기: 서버 규칙을 그대로 보여 주고 선택한 모드로 대기실을 연다.
import { NET_MODE_RULES, type NetMode } from '../../net/shared/protocol';
import { button, el, ICON, type LobbyHost, type LobbyPanel } from './lobbyDom';

export class CreateRoomPanel implements LobbyPanel {
  readonly id = 'create';
  readonly title = 'CREATE ROOM';
  private selected: NetMode = 'tdm';

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    body.append(el('p', 'lb-panel-lead', '게임 모드를 고르면 새 방을 만들고 대기실로 이동해요.'));
    const choices = el('div', 'lb-create-grid');
    const modes: NetMode[] = import.meta.env.DEV ? ['tdm', 'ffa', 'test'] : ['tdm', 'ffa'];
    const cards: HTMLButtonElement[] = [];
    const mark = () => {
      for (const card of cards) {
        const on = card.dataset.mode === this.selected;
        card.classList.toggle('lb-selected', on);
        card.setAttribute('aria-pressed', String(on));
      }
      rule.textContent = this.ruleText(this.selected);
      create.textContent = `${this.modeName(this.selected)} 방 만들기`;
    };
    for (const mode of modes) {
      const rule = NET_MODE_RULES[mode];
      const card = button(
        '',
        `lb-create-card lb-create-${mode}`,
        () => {
          this.selected = mode;
          mark();
        },
        `<span class="lb-create-icon">${mode === 'tdm' ? ICON.team : mode === 'ffa' ? ICON.target : ICON.settings}</span><span><small>${rule.short}</small><b>${this.modeName(mode)}</b><em>${mode === 'tdm' ? 'BLUE vs RED 2:2' : mode === 'ffa' ? '4인 개인전' : '연결·전투 점검용'}</em></span>`,
      );
      card.dataset.mode = mode;
      cards.push(card);
      choices.append(card);
    }
    const rule = el('p', 'lb-create-rule');
    const create = button('', 'lb-create-submit', () => this.host.createRoom(this.selected));
    body.append(choices, rule, create);
    mark();
  }

  private modeName(mode: NetMode): string {
    if (mode === 'tdm') return '팀 데스매치';
    if (mode === 'ffa') return '개인전';
    return '자유 테스트';
  }

  private ruleText(mode: NetMode): string {
    const rule = NET_MODE_RULES[mode];
    if (mode === 'tdm') return `BLUE vs RED 2:2 · ${rule.timeLimitMs / 60000}분 · 팀 ${rule.scoreToWin}킬 먼저 · 시간 종료 시 킬이 많은 팀 승리`;
    if (mode === 'ffa') return `4인 개인전 · ${rule.timeLimitMs / 60000}분 · ${rule.scoreToWin}킬 먼저 · 시간 종료 시 최다 킬 승리`;
    return `2~4명 · 시간과 점수 제한 없이 자유롭게 테스트`;
  }
}

// 방 만들기 (모달): 제목 + 닫기 · 모드 카드(팀 데스매치 = BLUE·RED / 개인전 = 노랑·주황 / 자유 테스트 = 중립, 같은 높이,
// 선택 = 모드 색 테두리 + 체크 + 작은 별 팝) · 고른 모드의 규칙 칩(시간 · 목표 킬 · 방식, 자세한 규칙은 펼쳐 보기) · 방 만들기 버튼 하나.
// 정원·시간·목표 킬은 서버 규칙(NET_MODE_RULES·NET_MAX_PLAYERS·NET_TEAM_SIZE) 그대로. TEST(자유 테스트)는 개발 빌드에서만 보임
// (서버 쪽 처리는 그대로 — 화면에서 숨길 뿐). 생성 진행·실패 안내는 멀티 창(MultiplayerMenu)이 맡음.
import { NET_MAX_PLAYERS, NET_MODE_RULES, NET_TEAM_SIZE, type NetMode } from '../../net/shared/protocol';
import { button, el, ICON, markRadios, radioGroup, type LobbyHost, type LobbyPanel } from './lobbyDom';

/** 선택한 카드 모서리의 작은 별 (장식, 화면 읽기 제외) */
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.6 6 6.4.6-4.9 4.3 1.5 6.3L12 16.4 6.4 19.7l1.5-6.3L3 9.1l6.4-.6z" fill="currentColor"/></svg>';
const INFO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 11v6M12 7.5v.1" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class CreateRoomPanel implements LobbyPanel {
  readonly id = 'create';
  readonly title = '방 만들기';
  private selected: NetMode = 'tdm';

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    const wrap = el('div', 'lb-create');
    const choices = el('div', 'lb-create-modes');
    radioGroup(choices, '게임 모드');
    const modes: NetMode[] = import.meta.env.DEV ? ['tdm', 'ffa', 'test'] : ['tdm', 'ffa'];
    if (!modes.includes(this.selected)) this.selected = 'tdm';
    const cards: HTMLButtonElement[] = [];
    const rule = el('div', 'lb-create-summary');
    rule.setAttribute('aria-live', 'polite');
    const detail = el('p', 'lb-create-detail');
    detail.hidden = true;
    const more = button('', 'lb-create-more', () => {
      detail.hidden = !detail.hidden;
      more.setAttribute('aria-expanded', String(!detail.hidden));
    });
    more.innerHTML = `${INFO}<span>자세한 규칙</span>`;
    more.setAttribute('aria-expanded', 'false');
    const mark = () => {
      for (const card of cards) card.classList.toggle('lb-on', card.dataset.mode === this.selected);
      markRadios(cards, (card) => card.dataset.mode === this.selected);
      // 규칙: 칩 3개 (시간 · 목표 킬 · 방식) — 한 줄에 억지로 넣지 않음
      rule.textContent = '';
      for (const t of this.summary(this.selected)) rule.append(el('span', 'lb-create-chip', t));
      rule.setAttribute('aria-label', this.summary(this.selected).join(', '));
      detail.textContent = this.detail(this.selected);
    };
    for (const mode of modes) {
      const card = button('', `lb-create-mode lb-create-mode-${mode}`, () => {
        this.selected = mode;
        mark();
      });
      const icon = el('span', 'lb-create-mode-icon');
      icon.innerHTML = mode === 'tdm' ? ICON.team : mode === 'ffa' ? ICON.target : ICON.settings;
      const copy = el('span', 'lb-create-mode-copy');
      copy.append(el('b', '', this.modeName(mode)), el('small', '', this.modeSub(mode)));
      const check = el('span', 'lb-create-mode-check');
      check.innerHTML = CHECK;
      const star = el('span', 'lb-create-mode-star');
      star.innerHTML = STAR;
      card.append(icon, copy, check, star);
      card.dataset.mode = mode;
      cards.push(card);
      choices.append(card);
    }
    const info = el('div', 'lb-create-info');
    info.append(rule, more);
    // 방 만들기: 누르면 멀티 창이 생성·대기실 이동·실패 안내를 맡음. 그동안 다시 누르지 못하게
    const create = button('방 만들기', 'lb-create-go', () => {
      if (create.disabled) return;
      create.disabled = true;
      create.textContent = '만드는 중…';
      this.host.createRoom(this.selected);
      window.setTimeout(() => {
        create.disabled = false;
        create.textContent = '방 만들기';
      }, 2500);
    });
    wrap.append(choices, info, detail, create);
    body.append(wrap);
    mark();
  }

  private modeName(mode: NetMode): string {
    if (mode === 'tdm') return '팀 데스매치';
    if (mode === 'ffa') return '개인전';
    return '자유 테스트';
  }

  /** 카드 보조 정보: 실제 정원 기준 (TDM 팀당 인원, FFA 최대 인원) */
  private modeSub(mode: NetMode): string {
    if (mode === 'tdm') return `TDM · ${NET_TEAM_SIZE}v${NET_TEAM_SIZE}`;
    if (mode === 'ffa') return `FFA · ${NET_MAX_PLAYERS}인`;
    return '개발용';
  }

  /** 짧은 규칙 칩 (서버 규칙 값) */
  private summary(mode: NetMode): string[] {
    const r = NET_MODE_RULES[mode];
    if (mode === 'test') return ['시간 제한 없음', '점수 제한 없음', '점검용'];
    return [`${r.timeLimitMs / 60000}분`, `${r.scoreToWin}킬 선취`, mode === 'tdm' ? '팀전' : '개인전'];
  }

  /** 자세한 규칙 (펼쳤을 때만) */
  private detail(mode: NetMode): string {
    const r = NET_MODE_RULES[mode];
    if (mode === 'tdm') return `BLUE와 RED 최대 ${NET_TEAM_SIZE}대${NET_TEAM_SIZE} (2~${NET_MAX_PLAYERS}명, 시작할 때 팀 인원 차이 1명 이하로 맞춤). 팀 합계 ${r.scoreToWin}킬을 먼저 채우면 승리, 시간이 끝나면 킬이 많은 팀 승리 · 같으면 무승부.`;
    if (mode === 'ffa') return `2~${NET_MAX_PLAYERS}명. ${r.scoreToWin}킬을 먼저 채우면 승리, 시간이 끝나면 킬이 가장 많은 사람 승리 · 공동 1위면 무승부.`;
    return `2~${NET_MAX_PLAYERS}명이 시간·점수 제한 없이 연결과 전투를 점검하는 개발용 모드.`;
  }
}

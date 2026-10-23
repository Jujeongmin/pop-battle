// RANKING: 레벨 기준 통합 랭킹 하나 (TDM·FFA 구분 없음). 서버가 정렬해 상위 100명 + 내 순위만 내려줌 (전체 사용자를 받지 않음).
// 순서: 레벨 → 누적 경험치 → 사용자 ID 고정 순서 (전적은 순위에 쓰지 않음).
// 표시: 순위 · 팝건 계급 아이콘 · 닉네임 · 레벨 · 팀전 승/패 · 개인전 1등 횟수 (킬·데스·승률·캐릭터 그림 없음).
// 1~3위 금·은·동, 내 줄 강조, 아래 '내 랭킹' 고정. 열 때마다 새로 조회, 불러오는 중 / 빈 목록 / 실패(다시 시도) 상태 (aria-live).
// 빈 목록: 큰 빈 표 대신 내 캐릭터 그림 + "첫 공식 기록을 만들어 보세요" + 빠른 시작 · 로비로 (내 랭킹 칸은 그대로).
import type { RankingResult, RankRow } from '../../net/shared/ranking';
import { rankName } from '../../net/shared/progression';
import { popgunImg } from '../popgun';
import { button, el, ICON, type LobbyHost, type LobbyPanel } from './lobbyDom';

export class RankingPanel implements LobbyPanel {
  readonly id = 'ranking';
  readonly title = '랭킹';
  private request = 0;

  constructor(
    private readonly host: LobbyHost,
    private readonly close: () => void,
  ) {}

  render(body: HTMLElement): void {
    body.textContent = '';
    const wrap = el('div', 'lb-rank');
    const hint = el('p', 'lb-rank-hint', '레벨 순위 · 같은 레벨이면 누적 경험치 순 (팀전·개인전 공식 경기 기록)');
    const panel = el('div', 'lb-rank-panel');
    const head = el('div', 'lb-rank-row lb-rank-head');
    head.append(
      el('span', 'lb-rank-pos', '순위'),
      el('span', 'lb-rank-icon-col', '계급'),
      el('span', 'lb-rank-nick', '닉네임'),
      el('span', 'lb-rank-lv', '레벨'),
      el('span', 'lb-rank-tdm', '팀전'),
      el('span', 'lb-rank-ffa', '개인전 1등'),
    );
    const list = el('div', 'lb-rank-list');
    list.setAttribute('aria-live', 'polite');
    const mine = el('div', 'lb-rank-mine');
    panel.append(head, list);
    wrap.append(hint, panel, mine);
    body.append(wrap);
    void this.load(list, mine);
  }

  private async load(list: HTMLElement, mine: HTMLElement): Promise<void> {
    const id = ++this.request;
    list.textContent = '';
    list.append(this.state('loading', '랭킹을 불러오는 중…'));
    mine.textContent = '';
    let res: RankingResult;
    try {
      res = await this.host.ranking();
    } catch {
      res = { ok: false, reason: 'error', rows: [], mine: null, total: 0 };
    }
    if (id !== this.request || !list.isConnected) return;
    list.textContent = '';
    if (!res.ok) {
      const offline = res.reason === 'offline';
      const box = this.state('error', offline ? '이 빌드에는 랭킹 서버가 없어요' : '랭킹을 불러오지 못했어요 · 연결을 확인해 주세요');
      if (!offline) {
        const retry = el('button', 'lb-btn lb-rank-retry', '다시 시도');
        retry.type = 'button';
        retry.addEventListener('click', () => void this.load(list, mine));
        box.append(retry);
      }
      list.append(box);
      return;
    }
    list.closest('.lb-rank-panel')?.classList.toggle('lb-rank-panel-empty', res.rows.length === 0);
    if (res.rows.length === 0) list.append(this.emptyCard());
    for (const r of res.rows) list.append(this.row(r));
    if (res.total > res.rows.length) list.append(el('p', 'lb-rank-more', `상위 ${res.rows.length}명 표시 · 전체 ${res.total.toLocaleString()}명`));
    mine.append(el('span', 'lb-rank-mine-label', '내 랭킹'));
    if (res.mine) mine.append(this.row(res.mine, true));
    else {
      const lv = this.host.progress().level;
      const none = el('div', 'lb-rank-row lb-rank-row-mine lb-rank-mine-none');
      const icon = el('span', 'lb-rank-icon-col');
      icon.append(popgunImg(lv, 'lb-rank-icon'));
      none.append(el('span', 'lb-rank-pos lb-rank-none', '순위 없음'), icon, el('span', 'lb-rank-nick', this.host.playerName()), el('span', 'lb-rank-lv', `Lv.${lv}`), el('span', 'lb-rank-mine-why', '공식 경기 1판을 마치면 등록돼요'));
      mine.append(none);
    }
  }

  /** 빈 랭킹: 내 캐릭터 그림 · 다음 행동 (빠른 시작 · 로비로) · 연습전은 반영 안 됨 */
  private emptyCard(): HTMLElement {
    const box = el('div', 'lb-rank-empty');
    box.setAttribute('role', 'status');
    const art = el('span', 'lb-rank-empty-art');
    art.append(el('span', 'lb-rank-empty-trophy', '🏆'));
    void this.host.characterPortrait(this.host.currentCharacter()).then((src) => {
      if (!art.isConnected) return;
      const img = el('img');
      img.src = src;
      img.alt = '';
      img.draggable = false;
      art.prepend(img);
    }).catch(() => undefined);
    const quick = button('', 'lb-rank-empty-quick', () => {
      this.close();
      this.host.quickMatch();
    }, `${ICON.play}<span>빠른 시작</span>`);
    const back = button('로비로', 'lb-rank-empty-back', () => this.close());
    const row = el('div', 'lb-rank-empty-actions');
    row.append(quick, back);
    box.append(
      art,
      el('b', 'lb-rank-empty-title', '첫 공식 기록을 만들어 보세요'),
      el('p', 'lb-rank-empty-desc', '팀전이나 개인전을 완료하면 레벨과 경험치를 기준으로 랭킹에 등록돼요.'),
      row,
      el('small', 'lb-rank-empty-note', '연습전 기록은 랭킹에 반영되지 않아요'),
    );
    return box;
  }

  private row(r: RankRow, mineBar = false): HTMLElement {
    const top = r.rank >= 1 && r.rank <= 3 ? ` lb-rank-top lb-rank-top-${r.rank}` : '';
    const row = el('div', `lb-rank-row${top}${r.me ? ' lb-rank-me' : ''}${mineBar ? ' lb-rank-row-mine' : ''}`);
    const pos = el('span', 'lb-rank-pos', r.rank > 0 ? String(r.rank) : '순위 없음');
    if (r.rank <= 0) pos.classList.add('lb-rank-none');
    const icon = el('span', 'lb-rank-icon-col');
    icon.append(popgunImg(r.lv, 'lb-rank-icon'));
    const nick = el('span', 'lb-rank-nick', r.nick || '나');
    nick.title = r.nick;
    const lv = el('span', 'lb-rank-lv', `Lv.${r.lv}`);
    lv.title = rankName(r.lv);
    // 팀전: 승·패만 (무승부 제외), 개인전: 최종 1위 횟수
    const tdm = el('span', 'lb-rank-tdm', `${r.s.tw}승 ${r.s.tl}패`);
    const ffa = el('span', 'lb-rank-ffa', `${r.s.f1}회`);
    row.append(pos, icon, nick, lv, tdm, ffa);
    row.setAttribute('aria-label', `${r.rank > 0 ? `${r.rank}위` : '순위 없음'} ${r.nick} 레벨 ${r.lv} 팀전 ${r.s.tw}승 ${r.s.tl}패 개인전 1등 ${r.s.f1}회`);
    return row;
  }

  private state(kind: 'loading' | 'empty' | 'error', text: string): HTMLElement {
    const box = el('div', `lb-rank-state lb-rank-state-${kind}`);
    box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    if (kind === 'loading') box.append(el('span', 'lb-rank-spinner'));
    box.append(el('span', '', text));
    return box;
  }
}

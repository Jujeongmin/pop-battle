// RANKING: 레벨 기준 통합 랭킹 하나 (TDM·FFA 구분 없음). 서버가 정렬해 상위 100명 + 내 순위만 내려줌 (전체 사용자를 받지 않음).
// 순서: 레벨 → 누적 경험치 → 사용자 ID 고정 순서 (전적은 순위에 쓰지 않음).
// 표시: 순위 · 팝건 계급 아이콘 · 닉네임 · 레벨 · 팀전 승/패 · 개인전 1등 횟수 (킬·데스·승률·캐릭터 그림 없음).
// 1~3위 금·은·동, 내 줄 강조, 아래 '내 랭킹' 고정. 열 때마다 새로 조회, 불러오는 중 / 빈 목록 / 실패(다시 시도) 상태 (aria-live).
import type { RankingResult, RankRow } from '../../net/shared/ranking';
import { rankName } from '../../net/shared/progression';
import { popgunImg } from '../popgun';
import { el, type LobbyHost, type LobbyPanel } from './lobbyDom';

export class RankingPanel implements LobbyPanel {
  readonly id = 'ranking';
  readonly title = '랭킹';
  private request = 0;

  constructor(private readonly host: LobbyHost) {}

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
    if (res.rows.length === 0) list.append(this.state('empty', '아직 공식 경기 기록이 없어요 · 팀전·개인전을 마치면 순위에 올라가요'));
    for (const r of res.rows) list.append(this.row(r));
    if (res.total > res.rows.length) list.append(el('p', 'lb-rank-more', `상위 ${res.rows.length}명 표시 · 전체 ${res.total.toLocaleString()}명`));
    mine.append(el('span', 'lb-rank-mine-label', '내 랭킹'));
    if (res.mine) mine.append(this.row(res.mine, true));
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

// RANKING: 전체 유저 랭킹 (전체 · TDM · FFA). 서버가 정렬해 상위 100명 + 내 순위만 내려줌 (전체 사용자를 받지 않음).
// 표시: 순위 · 팝건 계급 아이콘 · 닉네임 · 레벨 · 전적 (캐릭터 그림 없음). 1~3위 금·은·동, 내 줄 강조, 아래 '내 랭킹' 고정.
// 열 때마다·탭을 바꿀 때마다 새로 조회. 불러오는 중 / 빈 목록 / 실패(다시 시도) 상태를 따로 보여 줌 (aria-live).
import type { RankingResult, RankKind, RankRow } from '../../net/shared/ranking';
import { rankName } from '../../net/shared/progression';
import { popgunImg } from '../popgun';
import { el, type LobbyHost, type LobbyPanel } from './lobbyDom';

const TABS: Array<{ id: RankKind; label: string; hint: string }> = [
  { id: 'all', label: '전체', hint: 'TDM·FFA 공식 경기 종합 점수 (TDM 승 30·무 10, FFA 순위 0~30, 킬 1점)' },
  { id: 'tdm', label: 'TDM', hint: '승리 수 → 승률 → 킬 순' },
  { id: 'ffa', label: 'FFA', hint: '누적 킬 → 1위 횟수 → 1위 비율 순' },
];

/** 랭킹 종류별 전적 글자 */
function record(kind: RankKind, r: RankRow): string {
  const s = r.s;
  if (kind === 'tdm') return `${s.tw}승 ${s.tl}패 ${s.td}무`;
  if (kind === 'ffa') return `${s.fm}경기 · 1위 ${s.f1} · ${s.fk}킬`;
  return `${s.pt.toLocaleString()}점 · ${s.m}경기`;
}

export class RankingPanel implements LobbyPanel {
  readonly id = 'ranking';
  readonly title = '랭킹';
  private kind: RankKind = 'all';
  private body: HTMLElement | null = null;
  private request = 0;

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    this.body = body;
    body.textContent = '';
    const wrap = el('div', 'lb-rank');
    const tabs = el('div', 'lb-rank-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '랭킹 종류');
    for (const t of TABS) {
      const b = el('button', `lb-btn lb-rank-tab${t.id === this.kind ? ' lb-active' : ''}`, t.label);
      b.type = 'button';
      b.id = `lb-rank-tab-${t.id}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t.id === this.kind));
      b.setAttribute('aria-controls', 'lb-rank-panel');
      b.tabIndex = t.id === this.kind ? 0 : -1;
      b.addEventListener('click', () => this.select(t.id));
      b.addEventListener('keydown', (e) => {
        // 탭 사이 ← → 이동
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const i = TABS.findIndex((x) => x.id === this.kind);
        const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
        this.select(next.id);
        (wrap.querySelector(`#lb-rank-tab-${next.id}`) as HTMLButtonElement | null)?.focus();
      });
      tabs.append(b);
    }
    const hint = el('p', 'lb-rank-hint', TABS.find((t) => t.id === this.kind)!.hint);
    const panel = el('div', 'lb-rank-panel');
    panel.id = 'lb-rank-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `lb-rank-tab-${this.kind}`);
    const head = el('div', 'lb-rank-row lb-rank-head');
    head.append(el('span', 'lb-rank-pos', '순위'), el('span', 'lb-rank-icon-col', '계급'), el('span', 'lb-rank-nick', '닉네임'), el('span', 'lb-rank-lv', '레벨'), el('span', 'lb-rank-rec', '전적'));
    const list = el('div', 'lb-rank-list');
    list.setAttribute('aria-live', 'polite');
    const mine = el('div', 'lb-rank-mine');
    panel.append(head, list);
    wrap.append(tabs, hint, panel, mine);
    body.append(wrap);
    void this.load(list, mine);
  }

  private select(kind: RankKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    if (this.body) this.render(this.body);
  }

  private async load(list: HTMLElement, mine: HTMLElement): Promise<void> {
    const id = ++this.request;
    const kind = this.kind;
    list.textContent = '';
    list.append(this.state('loading', '랭킹을 불러오는 중…'));
    mine.textContent = '';
    let res: RankingResult;
    try {
      res = await this.host.ranking(kind);
    } catch {
      res = { ok: false, reason: 'error', kind, rows: [], mine: null, total: 0 };
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
    if (res.rows.length === 0) list.append(this.state('empty', '아직 공식 경기 기록이 없어요 · TDM·FFA 경기를 마치면 순위에 올라가요'));
    for (const r of res.rows) list.append(this.row(kind, r));
    mine.append(el('span', 'lb-rank-mine-label', '내 랭킹'));
    if (res.mine) mine.append(this.row(kind, res.mine, true));
    if (res.total > res.rows.length) list.append(el('p', 'lb-rank-more', `상위 ${res.rows.length}명 표시 · 전체 ${res.total.toLocaleString()}명`));
  }

  private row(kind: RankKind, r: RankRow, mineBar = false): HTMLElement {
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
    row.append(pos, icon, nick, lv, el('span', 'lb-rank-rec', record(kind, r)));
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

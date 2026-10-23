// 매치 결과 화면 (연습전·멀티 공용): 종료 배너 → 화면 덮기 → 3D 결과 무대(ResultStage) + 참가자 카드·제목·버튼.
// 결과 하나(ResultData.key)는 한 번만 띄움 — 같은 결과가 다시 와도(주기 갱신·재접속) 그대로, 닫은 결과는 다시 열지 않음.
import type { ResultData, ResultEntry } from '../../result/resultData';
import type { ResultStage } from '../../result/ResultStage';
import { CHARACTERS } from '../../config/characters';
import './result.css';

export interface ResultHost {
  /** 연습전: 같은 규칙으로 다시 (클릭 안에서 포인터 잠금 요청) */
  replay(): void;
  /** 멀티: 방 대기실로 (재대전 준비). 실패하면 false */
  toRoom(): Promise<boolean>;
  /** 메인 로비로 (멀티는 방을 나감) */
  toMainLobby(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const CROWN_SVG =
  '<svg viewBox="0 0 64 44" aria-hidden="true"><path d="M6 38 2 10l16 12L32 2l14 20 16-12-4 28z" fill="#ffd45e" stroke="#c98a12" stroke-width="3" stroke-linejoin="round"/><rect x="6" y="34" width="52" height="8" rx="3" fill="#ffc531" stroke="#c98a12" stroke-width="3"/><circle cx="32" cy="22" r="4" fill="#ff8fb4"/><circle cx="17" cy="27" r="3" fill="#6f9bff"/><circle cx="47" cy="27" r="3" fill="#68cfac"/></svg>';

interface Card {
  entry: ResultEntry;
  card: HTMLElement;
  crown: HTMLElement | null;
}

export class ResultScreen {
  private readonly root = el('div', 'pb-result');
  private readonly finishEl = el('div', 'pb-res-finish');
  private readonly wipe = el('div', 'pb-res-wipe');
  private readonly head = el('div', 'pb-res-head');
  private readonly cardsEl = el('div', 'pb-res-cards');
  private readonly bar = el('div', 'pb-res-bar');
  private readonly note = el('div', 'pb-res-note');
  private cards: Card[] = [];
  private data: ResultData | null = null;
  /** 이미 띄웠던(닫은 것 포함) 결과 키 */
  private readonly seen = new Set<string>();
  private token = 0;
  private busy = false;
  /** 경기장 대신 결과 무대를 그리는 중 */
  stageOn = false;
  private width = 1;
  private height = 1;
  /** 카드 줄 위쪽 y (px) */
  private cardRowY = 0;

  constructor(
    private readonly container: HTMLElement,
    readonly stage: ResultStage,
    private readonly host: ResultHost,
  ) {
    this.root.hidden = true;
    this.root.append(this.head, this.cardsEl, this.bar, this.note, this.finishEl, this.wipe);
    container.appendChild(this.root);
  }

  /** 결과 화면이 떠 있음 (배너·전환 포함) */
  get open(): boolean {
    return this.data !== null;
  }

  /** 지금 떠 있는 결과 키 */
  get key(): string | null {
    return this.data?.key ?? null;
  }

  /** 결과 띄우기. 같은 결과(키)를 이미 띄웠으면 아무 일 없음 */
  show(data: ResultData): void {
    if (this.seen.has(data.key)) return;
    this.seen.add(data.key);
    this.close();
    this.data = data;
    void this.run(data, ++this.token);
  }

  /** 방을 나감: 본 결과 기록을 비움 → 결과 단계인 방에 다시 들어가면 결과를 다시 보여 줌 */
  forgetSeen(): void {
    this.seen.clear();
  }

  /** 즉시 닫기 (무대 리소스 해제) */
  close(): void {
    this.token++;
    this.data = null;
    this.busy = false;
    this.setStage(false);
    this.stage.clear();
    this.root.hidden = true;
    this.root.className = 'pb-result';
    this.cards = [];
    this.cardsEl.textContent = '';
    this.head.textContent = '';
    this.bar.textContent = '';
    this.note.textContent = '';
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.stage.resize(width, height);
    if (this.stageOn) this.layoutBand();
  }

  /** 캐릭터 구간 = 제목 아래(왕관 자리 포함) ~ 카드 줄 위. 카드 줄은 버튼 바로 위 */
  private layoutBand(): void {
    const headBottom = this.head.offsetTop + this.head.offsetHeight;
    const barTop = this.bar.offsetTop || this.height - 60;
    const cardH = this.cards[0]?.card.offsetHeight ?? 64;
    // 카드 위 MVP 리본(약 16px)·간격
    this.cardRowY = barTop - cardH - 14;
    const crown = this.cards.some((c) => c.crown) ? 34 : 14;
    const gap = Math.max(0, ...this.cards.map((c) => c.card.offsetWidth)) + 8;
    this.stage.setBand(headBottom + crown, this.cardRowY - 16, this.height, gap);
  }

  /** 매 프레임 (무대가 떠 있을 때): 무대 진행 + 카드·왕관 위치 */
  update(dt: number): void {
    if (!this.stageOn) return;
    this.stage.update(dt);
    const anchors = this.stage.anchors(this.width, this.height);
    for (const a of anchors) {
      const c = this.cards.find((x) => x.entry.id === a.entry.id);
      if (!c) continue;
      const on = a.shown > 0.35;
      // 카드는 한 줄 (버튼 위), 가로는 캐릭터 발밑
      c.card.style.translate = `${a.footX.toFixed(1)}px ${this.cardRowY.toFixed(1)}px`;
      c.card.classList.toggle('pb-res-in', on);
      if (c.crown) {
        c.crown.style.translate = `${a.headX.toFixed(1)}px ${a.headY.toFixed(1)}px`;
        c.crown.classList.toggle('pb-res-in', a.shown >= 1);
      }
    }
  }

  // ---------------------------------------------------------------- 진행

  private async run(data: ResultData, token: number): Promise<void> {
    this.root.hidden = false;
    this.root.className = `pb-result pb-res-${data.layout} pb-res-o-${data.outcome}`;
    // 무대는 배너가 떠 있는 동안 미리 만듦 (모델은 게임 캐시)
    const built = this.stage.build(data);
    this.finishEl.textContent = data.reason === 'score' ? 'FINISH!' : 'TIME UP!';
    this.root.classList.add('pb-res-banner');
    await sleep(1100);
    if (token !== this.token) return;
    this.root.classList.add('pb-res-cover');
    await sleep(380);
    // 캐릭터 불러오기가 늦어도 최대 2.5초까지만 기다림 (못 불러온 자리는 카드만)
    await Promise.race([built, sleep(2500)]);
    if (token !== this.token) return;
    this.root.classList.remove('pb-res-banner');
    this.renderHead(data);
    this.renderCards(data);
    this.renderBar(data);
    this.layoutBand();
    this.setStage(true);
    this.update(0);
    this.root.classList.add('pb-res-shown');
    this.root.classList.remove('pb-res-cover');
  }

  private setStage(on: boolean): void {
    this.stageOn = on;
    // 무대가 보일 때는 게임 HUD·조작 버튼 등 다른 화면 요소를 숨김 (멀티 메뉴는 위에 뜰 수 있게 남김)
    this.container.classList.toggle('pb-result-on', on);
  }

  private renderHead(d: ResultData): void {
    const h = this.head;
    h.textContent = '';
    const title = el('div', 'pb-res-title', { win: 'VICTORY!', lose: 'DEFEAT', draw: 'DRAW' }[d.outcome]);
    h.append(title);
    if (d.teamScore) {
      const sc = el('div', 'pb-res-score');
      const side = (team: 'BLUE' | 'RED') => {
        const s = el('div', `pb-res-team pb-res-team-${team.toLowerCase()}${d.winnerTeam === team ? ' pb-res-team-win' : ''}`);
        s.append(el('span', 'pb-res-team-name', `${team} TEAM`), el('b', 'pb-res-team-score', String(d.teamScore![team])));
        return s;
      };
      sc.append(side('BLUE'), el('span', 'pb-res-vs', ':'), side('RED'));
      h.append(sc);
    }
    const why = d.reason === 'score' ? `${d.goal}킬 달성` : '시간 종료';
    const extra = d.layout === 'tdm' ? (d.winnerTeam ? ` · ${d.winnerTeam} TEAM 승리` : ' · 무승부') : d.draw ? ' · 공동 1위' : '';
    h.append(el('div', 'pb-res-sub', `${d.label} · ${why}${extra}`));
  }

  private renderCards(d: ResultData): void {
    this.cardsEl.textContent = '';
    this.cards = [];
    for (const e of d.entries) {
      const card = el('div', 'pb-res-card');
      if (e.me) card.classList.add('pb-res-me');
      if (e.mvp) card.classList.add('pb-res-mvp');
      if (e.win) card.classList.add('pb-res-win');
      if (e.left) card.classList.add('pb-res-left');
      if (e.team) card.classList.add(`pb-res-card-${e.team.toLowerCase()}`);
      const slotFront = d.layout === 'ffa' ? d.entries.indexOf(e) < 3 : e.win || d.draw;
      if (!slotFront) card.classList.add('pb-res-back');
      if (e.mvp) card.append(el('span', 'pb-res-mvp-tag', 'MVP'));
      const top = el('div', 'pb-res-card-top');
      if (d.layout === 'ffa') top.append(el('span', `pb-res-rank pb-res-rank-${Math.min(4, e.rank)}`, `${e.rank}`));
      const name = el('b', 'pb-res-nick', e.nick);
      top.append(name);
      if (e.me) top.append(el('span', 'pb-res-you', '나'));
      card.append(top);
      const left = e.left === 'quit' ? ' · 나감' : e.left === 'drop' ? ' · 끊김' : '';
      card.append(el('div', 'pb-res-char', `${CHARACTERS[e.char].name}${left}`));
      const kd = el('div', 'pb-res-kd');
      kd.append(el('span', 'pb-res-k', `K ${e.k}`), el('span', 'pb-res-d', `D ${e.d}`));
      card.append(kd);
      this.cardsEl.append(card);
      let crown: HTMLElement | null = null;
      if (d.layout === 'ffa' && e.rank === 1) {
        crown = el('div', 'pb-res-crown');
        crown.innerHTML = CROWN_SVG;
        this.cardsEl.append(crown);
      }
      this.cards.push({ entry: e, card, crown });
    }
  }

  private renderBar(d: ResultData): void {
    this.bar.textContent = '';
    this.note.textContent = '';
    const btn = (label: string, cls: string, fn: () => Promise<void> | void) => {
      const b = el('button', `pb-res-btn ${cls}`, label);
      b.type = 'button';
      b.onclick = async () => {
        if (this.busy) return;
        this.busy = true;
        this.bar.classList.add('pb-res-busy');
        try {
          await fn();
        } finally {
          this.busy = false;
          this.bar.classList.remove('pb-res-busy');
        }
      };
      return b;
    };
    if (d.practice) {
      this.bar.append(
        btn('다시 플레이', 'pb-res-primary', () => this.host.replay()),
        btn('메인 로비', 'pb-res-ghost', () => this.host.toMainLobby()),
      );
    } else {
      this.bar.append(
        btn('대기실로', 'pb-res-primary', async () => {
          if (await this.host.toRoom()) this.close();
          else this.note.textContent = '대기실로 돌아가지 못했어요. 잠시 후 다시 눌러 주세요';
        }),
        btn('메인 로비', 'pb-res-ghost', () => this.host.toMainLobby()),
      );
    }
  }
}

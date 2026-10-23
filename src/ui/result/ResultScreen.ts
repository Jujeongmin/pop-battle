// 매치 결과 화면 (연습전·멀티 공용): 종료 배너 → 화면 덮기 → 3D 결과 무대(ResultStage)
// + 위: 제목·스코어보드(순위·닉네임 전체·K/D·MVP) / 가운데: 캐릭터 머리 위 이름표 / 아래: 버튼.
// 결과 하나(ResultData.key)는 한 번만 띄움 — 같은 결과가 다시 와도(주기 갱신·재접속) 그대로, 닫은 결과는 다시 열지 않음.
import type { ResultData, ResultEntry } from '../../result/resultData';
import type { ResultStage } from '../../result/ResultStage';
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

/** 캐릭터 머리 위 이름표 (+ 1위 왕관) */
interface Plate {
  entry: ResultEntry;
  plate: HTMLElement;
  crown: HTMLElement | null;
}

/** 순위 메달 (1~3위 금·은·동, 그 밖 회색) */
function medal(rank: number, cls = ''): HTMLElement {
  return el('span', `pb-res-medal pb-res-medal-${Math.min(4, rank)} ${cls}`.trim(), String(rank));
}

export class ResultScreen {
  private readonly root = el('div', 'pb-result');
  private readonly finishEl = el('div', 'pb-res-finish');
  private readonly wipe = el('div', 'pb-res-wipe');
  private readonly head = el('div', 'pb-res-head');
  private readonly platesEl = el('div', 'pb-res-plates');
  private readonly bar = el('div', 'pb-res-bar');
  private readonly note = el('div', 'pb-res-note');
  private plates: Plate[] = [];
  private data: ResultData | null = null;
  /** 이미 띄웠던(닫은 것 포함) 결과 키 */
  private readonly seen = new Set<string>();
  private token = 0;
  private busy = false;
  /** 경기장 대신 결과 무대를 그리는 중 */
  stageOn = false;
  private width = 1;
  private height = 1;

  constructor(
    private readonly container: HTMLElement,
    readonly stage: ResultStage,
    private readonly host: ResultHost,
  ) {
    this.root.hidden = true;
    this.root.append(this.platesEl, this.head, this.bar, this.note, this.finishEl, this.wipe);
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
    this.plates = [];
    this.platesEl.textContent = '';
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

  /** 캐릭터 구간 = 스코어보드 아래(이름표·왕관 자리 포함) ~ 버튼 위. 가로 간격은 이름표가 겹치지 않을 만큼 */
  private layoutBand(): void {
    const headBottom = this.head.offsetTop + this.head.offsetHeight;
    const barTop = this.bar.offsetTop || this.height - 60;
    const plateH = Math.max(0, ...this.plates.map((p) => p.plate.offsetHeight));
    const crown = this.plates.some((p) => p.crown) ? 30 : 0;
    const gap = Math.max(0, ...this.plates.map((p) => p.plate.offsetWidth)) + 10;
    this.stage.setBand(headBottom + plateH + crown + 8, barTop - 10, this.height, gap);
  }

  /** 매 프레임 (무대가 떠 있을 때): 무대 진행 + 이름표·왕관을 머리 위에 */
  update(dt: number): void {
    if (!this.stageOn) return;
    this.stage.update(dt);
    const anchors = this.stage.anchors(this.width, this.height);
    for (const a of anchors) {
      const p = this.plates.find((x) => x.entry.id === a.entry.id);
      if (!p) continue;
      const x = a.headX.toFixed(1);
      p.plate.style.translate = `${x}px ${a.headY.toFixed(1)}px`;
      p.plate.classList.toggle('pb-res-in', a.shown > 0.6);
      if (p.crown) {
        p.crown.style.translate = `${x}px ${(a.headY - p.plate.offsetHeight - 2).toFixed(1)}px`;
        p.crown.classList.toggle('pb-res-in', a.shown >= 1);
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
    this.renderPlates(data);
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
    h.append(el('div', 'pb-res-title', { win: 'VICTORY!', lose: 'DEFEAT', draw: 'DRAW' }[d.outcome]));
    const why = d.reason === 'score' ? `${d.goal}킬 달성` : '시간 종료';
    const extra = d.layout === 'tdm' ? (d.winnerTeam ? ` · ${d.winnerTeam} TEAM 승리` : ' · 무승부') : d.draw ? ' · 공동 1위' : '';
    h.append(el('div', 'pb-res-sub', `${d.label} · ${why}${extra}`), this.board(d));
  }

  /**
   * 스코어보드 한 판 (가로로 넓고 낮게): 칸마다 순위 메달 · 닉네임 전체 · K/D · MVP.
   * FFA = 순위 순서 / TDM = [BLUE 점수 · 두 명] vs [두 명 · RED 점수], 이긴 팀 금테
   */
  private board(d: ResultData): HTMLElement {
    const board = el('div', `pb-res-board pb-res-board-${d.layout}`);
    const cell = (e: ResultEntry) => {
      const c = el('div', 'pb-res-cell');
      if (e.me) c.classList.add('pb-res-me');
      if (e.left) c.classList.add('pb-res-left');
      if (e.rank === 1 && d.layout === 'ffa') c.classList.add('pb-res-first');
      const top = el('div', 'pb-res-cell-top');
      // 결과판은 닉네임 전체: 긴 이름(9자 이상)은 글자를 조금 줄여 칸에 맞춤
      const nick = el('b', e.nick.length > 8 ? 'pb-res-nick pb-res-nick-long' : 'pb-res-nick', e.nick);
      nick.title = e.nick;
      top.append(medal(e.rank), nick);
      const bottom = el('div', 'pb-res-cell-bottom');
      bottom.append(el('span', 'pb-res-k', `K ${e.k}`), el('span', 'pb-res-d', `D ${e.d}`));
      if (e.mvp) bottom.append(el('span', 'pb-res-mvp-tag', 'MVP'));
      if (e.me) bottom.append(el('span', 'pb-res-you', '나'));
      if (e.left) bottom.append(el('span', 'pb-res-gone', e.left === 'quit' ? '나감' : '끊김'));
      c.append(top, bottom);
      return c;
    };
    if (d.layout === 'tdm' && d.teamScore) {
      for (const team of ['BLUE', 'RED'] as const) {
        const side = el('div', `pb-res-side pb-res-side-${team.toLowerCase()}${d.winnerTeam === team ? ' pb-res-side-win' : ''}`);
        const score = el('div', 'pb-res-side-score');
        score.append(el('span', '', `${team}`), el('b', '', String(d.teamScore[team])));
        const cells = d.entries.filter((e) => (e.team ?? 'BLUE') === team).map(cell);
        if (team === 'BLUE') side.append(score, ...cells);
        else side.append(...cells, score);
        board.append(side);
        if (team === 'BLUE') board.append(el('span', 'pb-res-vs', ':'));
      }
    } else {
      for (const e of d.entries) board.append(cell(e));
    }
    return board;
  }

  /** 머리 위 이름표: 순위 메달 + 닉네임(길면 줄임, 전체는 스코어보드) + MVP. FFA 1위는 왕관 */
  private renderPlates(d: ResultData): void {
    this.platesEl.textContent = '';
    this.plates = [];
    for (const e of d.entries) {
      const plate = el('div', 'pb-res-plate');
      if (e.me) plate.classList.add('pb-res-me');
      if (e.team) plate.classList.add(`pb-res-plate-${e.team.toLowerCase()}`);
      const nick = el('b', 'pb-res-plate-nick', e.nick);
      plate.append(medal(e.rank), nick);
      if (e.mvp) plate.append(el('span', 'pb-res-mvp-tag', 'MVP'));
      this.platesEl.append(plate);
      let crown: HTMLElement | null = null;
      if (d.layout === 'ffa' && e.rank === 1) {
        crown = el('div', 'pb-res-crown');
        crown.innerHTML = CROWN_SVG;
        this.platesEl.append(crown);
      }
      this.plates.push({ entry: e, plate, crown });
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

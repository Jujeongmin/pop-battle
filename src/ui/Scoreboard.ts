// 인게임 실시간 상황판 (매치 중 PC Tab 누르는 동안 / 모바일 상단 점수판 터치로 열고 닫기). 게임은 멈추지 않음.
// 데이터는 Game이 매 프레임 넘김 (연습전 = 로컬 MatchStats, 멀티 = 서버 기록 그대로) → 바뀐 게 없으면 DOM을 다시 만들지 않음.
// TDM = RED 왼쪽 · BLUE 오른쪽 두 칸(팀마다 킬 많은 순), FFA = 1~8위 한 줄 순위표(결과 화면과 같은 순위 규칙).
// 표시: 닉네임 · 킬 · 데스만 (K/D 비율·캐릭터 이름·그림 없음), 내 줄은 은은한 바탕색.
import { rankList } from '../result/resultData';
import { levelBadge } from './popgun';

export interface ScoreRow {
  id: string;
  name: string;
  k: number;
  d: number;
  me: boolean;
  team: 'BLUE' | 'RED' | null;
  /** 매치 중 나감 (기록은 결과 화면처럼 남김) */
  left: boolean;
  /** 같은 킬·데스일 때 순서 (자리·등록 순) */
  order: number;
  /** 플레이어 레벨 (봇은 null → 계급 표시 없음) */
  level: number | null;
}

export interface ScoreboardData {
  teams: boolean;
  /** 모드 이름 (상단) */
  label: string;
  /** 남은 초 (null = 제한 없음) */
  timeLeft: number | null;
  blue: number;
  red: number;
  /** 목표 킬 (0 = 없음) */
  goal: number;
  rows: ScoreRow[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const byScore = (a: ScoreRow, b: ScoreRow) => b.k - a.k || a.d - b.d || a.order - b.order;

export class Scoreboard {
  readonly root = el('div', 'scoreboard hidden');
  private readonly card = el('div', 'sb-card');
  private openState = false;
  private key = '';
  /** 닫기 요청 (모바일: 닫기 버튼·판 터치) */
  onClose: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root.appendChild(this.card);
    // 판 위 터치는 아래 조작(시점 회전·사격)으로 내려가지 않고 닫기만
    this.root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClose?.();
    });
    parent.appendChild(this.root);
  }

  get open(): boolean {
    return this.openState;
  }

  setOpen(on: boolean): void {
    if (on === this.openState) return;
    this.openState = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) this.key = '';
  }

  /** 열려 있을 때만 그림 (내용이 바뀐 경우에만 DOM 갱신) */
  update(d: ScoreboardData): void {
    if (!this.openState) return;
    const time = d.timeLeft === null ? '' : formatTime(d.timeLeft);
    const key = [d.teams, d.label, time, d.blue, d.red, d.goal, ...d.rows.map((r) => `${r.id}:${r.name}:${r.k}:${r.d}:${r.me}:${r.team}:${r.left}:${r.level}`)].join('|');
    if (key === this.key) return;
    this.key = key;
    this.render(d, time);
  }

  private render(d: ScoreboardData, time: string): void {
    const c = this.card;
    c.textContent = '';
    c.classList.toggle('sb-tdm', d.teams);
    const head = el('div', 'sb-head');
    head.append(el('span', 'sb-mode', d.label));
    if (d.teams) {
      const score = el('span', 'sb-score');
      score.append(el('b', 'sb-red-text', String(d.red)), el('i', '', ':'), el('b', 'sb-blue-text', String(d.blue)));
      head.append(score);
    } else {
      const top = d.rows.reduce((m, r) => Math.max(m, r.k), 0);
      head.append(el('span', 'sb-score', d.goal > 0 ? `1위 ${top} / ${d.goal}킬` : `1위 ${top}킬`));
    }
    if (time) head.append(el('span', 'sb-time', time));
    head.append(el('span', 'sb-close', '닫기'));
    c.append(head);

    if (d.teams) {
      const teams = el('div', 'sb-teams');
      // RED 왼쪽 · BLUE 오른쪽
      for (const team of ['RED', 'BLUE'] as const) {
        const box = el('section', `sb-team sb-team-${team.toLowerCase()}`);
        const title = el('div', 'sb-team-title');
        title.append(el('span', '', `${team} TEAM`), el('b', '', String(team === 'RED' ? d.red : d.blue)));
        box.append(title, this.header(false));
        for (const r of d.rows.filter((x) => x.team === team).sort(byScore)) box.append(this.row(r, null));
        teams.append(box);
      }
      c.append(teams);
    } else {
      const list = el('div', 'sb-list');
      const sorted = [...d.rows].sort(byScore);
      const ranks = rankList(sorted);
      list.append(this.header(true));
      sorted.forEach((r, i) => list.append(this.row(r, ranks[i]!)));
      c.append(list);
    }
  }

  private header(rank: boolean): HTMLElement {
    const h = el('div', `sb-row sb-row-head${rank ? '' : ' sb-no-rank'}`);
    if (rank) h.append(el('span', 'sb-rank', '#'));
    h.append(el('span', 'sb-name', '닉네임'), el('span', 'sb-k', 'K'), el('span', 'sb-d', 'D'));
    return h;
  }

  private row(r: ScoreRow, rank: number | null): HTMLElement {
    const row = el('div', `sb-row${rank === null ? ' sb-no-rank' : ''}${r.me ? ' sb-me' : ''}${r.left ? ' sb-left' : ''}`);
    if (rank !== null) row.append(el('span', `sb-rank sb-rank-${Math.min(rank, 4)}`, String(rank)));
    const name = el('span', 'sb-name');
    if (r.level !== null) name.append(levelBadge(r.level, 'popgun-badge sb-level'));
    name.append(el('span', 'sb-nick', r.name));
    if (r.left) name.append(el('em', '', '나감'));
    row.append(name, el('span', 'sb-k', String(r.k)), el('span', 'sb-d', String(r.d)));
    return row;
  }
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

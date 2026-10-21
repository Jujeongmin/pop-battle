// CHARACTER: 6종 선택 (선택하면 가운데 3D 캐릭터가 바로 바뀜) + 체력·이동속도 게이지 (같은 최대 기준, 수치 없음).
// 크기·히트박스는 표시하지 않음 — 체형 차이는 3D 모델로 비교. 값은 기존 캐릭터 설정을 그대로 읽음 (밸런스 변경 없음)
import { button, el, ICON, type LobbyCharacter, type LobbyHost, type LobbyPanel } from './lobbyDom';

/** 게이지 최대 기준 (모든 캐릭터 같은 기준으로 비교) */
const HP_MAX = 130;
const SPEED_MAX = 1.15;

export class CharacterPanel implements LobbyPanel {
  readonly id = 'character';
  readonly title = 'CHARACTER';
  private note: HTMLElement | null = null;
  private hpBar: HTMLElement | null = null;
  private speedBar: HTMLElement | null = null;
  private nameEl: HTMLElement | null = null;
  private roleEl: HTMLElement | null = null;
  private cards: HTMLButtonElement[] = [];

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    const list = this.host.characters();
    const info = el('div', 'lb-char-info');
    this.nameEl = el('b', 'lb-char-name');
    this.roleEl = el('span', 'lb-char-role');
    const gauges = el('div', 'lb-gauges');
    const gauge = (label: string, cls: string) => {
      const row = el('div', `lb-gauge ${cls}`);
      const track = el('div', 'lb-gauge-track');
      const fill = el('div', 'lb-gauge-fill');
      track.appendChild(fill);
      row.append(el('span', 'lb-gauge-label', label), track);
      gauges.appendChild(row);
      return fill;
    };
    this.hpBar = gauge('HP', 'lb-g-hp');
    this.speedBar = gauge('SPEED', 'lb-g-speed');
    info.append(this.nameEl, this.roleEl, gauges);
    body.appendChild(info);

    const grid = el('div', 'lb-char-grid');
    this.cards = list.map((c) => {
      const b = button('', 'lb-char-card', () => void this.pick(c), `<i class="lb-swatch"></i><b></b>${c.locked ? `<span class="lb-lock">${ICON.lock}</span>` : ''}`);
      b.dataset.id = c.id;
      b.style.setProperty('--c', c.color);
      b.querySelector('b')!.textContent = c.name;
      b.classList.toggle('locked', c.locked);
      b.title = c.locked ? `${c.name} · 잠김` : c.name;
      grid.appendChild(b);
      return b;
    });
    body.appendChild(grid);
    this.note = el('p', 'lb-note');
    body.appendChild(this.note);
    // 처음 열 때 게이지가 0에서 차오르게 (다음 프레임에 값 적용)
    this.show(list.find((c) => c.id === this.host.currentCharacter()) ?? list[0]!, true);
  }

  private async pick(c: LobbyCharacter): Promise<void> {
    if (!c.selectable) {
      this.show(c, false);
      this.note!.textContent = `${c.name}은(는) 잠긴 상위 캐릭터예요 · 해금은 다음 단계에서 열려요`;
      return;
    }
    this.show(c, false);
    this.note!.textContent = '불러오는 중…';
    const ok = await this.host.selectCharacter(c.id);
    this.note!.textContent = ok ? '' : '지금은 캐릭터를 바꿀 수 없어요';
    this.mark();
  }

  /** 게이지·이름 표시 (선택 표시는 실제 선택된 캐릭터 기준) */
  private show(c: LobbyCharacter, first: boolean): void {
    this.nameEl!.textContent = c.name;
    this.nameEl!.style.setProperty('--c', c.color);
    this.roleEl!.textContent = c.locked ? `${c.role} · 잠김` : c.role;
    const hp = `${Math.min(100, (c.maxHp / HP_MAX) * 100).toFixed(1)}%`;
    const sp = `${Math.min(100, (c.speed / SPEED_MAX) * 100).toFixed(1)}%`;
    const apply = () => {
      this.hpBar!.style.width = hp;
      this.speedBar!.style.width = sp;
    };
    if (first) requestAnimationFrame(() => requestAnimationFrame(apply));
    else apply();
    this.mark();
  }

  private mark(): void {
    const cur = this.host.currentCharacter();
    for (const b of this.cards) b.classList.toggle('selected', b.dataset.id === cur);
  }
}

// LOADOUT: 주무기 선택 (라이플·샷건·스나이퍼, 고르면 가운데 캐릭터가 바로 들고 있음) + 고정 보조·근접무기. 스킨은 준비 중
import { weaponIconSvg } from '../KillFeed';
import { button, comingSoon, el, type LobbyHost, type LobbyPanel, type LobbyWeapon } from './lobbyDom';

export class LoadoutPanel implements LobbyPanel {
  readonly id = 'loadout';
  readonly title = 'LOADOUT';

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    body.appendChild(el('div', 'lb-section', '1 · 주무기'));
    const grid = el('div', 'lb-weapon-grid');
    const cards: HTMLButtonElement[] = [];
    const mark = () => {
      const cur = this.host.currentPrimary();
      for (const c of cards) {
        const selected = c.dataset.id === cur;
        c.classList.toggle('lb-selected', selected);
        c.setAttribute('aria-pressed', String(selected));
      }
    };
    for (const w of this.host.primaryWeapons()) {
      const b = button('', 'lb-weapon', () => {
        this.host.selectPrimary(w.id);
        mark();
      }, this.weaponHtml(w, '주무기'));
      b.dataset.id = w.id;
      b.setAttribute('aria-pressed', 'false');
      cards.push(b);
      grid.appendChild(b);
    }
    body.appendChild(grid);
    mark();
    const fixed = this.host.fixedWeapons();
    body.appendChild(el('div', 'lb-section', '2 · 보조무기 / 3 · 근접무기 (고정)'));
    const row = el('div', 'lb-weapon-grid lb-two');
    for (const [w, slot] of [[fixed.secondary, '보조무기'], [fixed.melee, '근접무기']] as const) {
      const d = el('div', 'lb-weapon lb-fixed');
      d.innerHTML = this.weaponHtml(w, slot);
      row.appendChild(d);
    }
    body.appendChild(row);
    body.appendChild(comingSoon('무기 스킨', '무기 색·꾸미기는 정비소 단계에서 열려요. 무기 능력치는 바뀌지 않아요.'));
  }

  private weaponHtml(w: LobbyWeapon, slot: string): string {
    const name = document.createElement('b');
    name.textContent = w.name;
    return `<span class="lb-weapon-slot">${slot}</span><span class="lb-weapon-icon">${weaponIconSvg(w.id)}</span>${name.outerHTML}`;
  }
}

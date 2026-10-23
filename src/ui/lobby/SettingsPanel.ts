// SETTINGS: 실제로 적용되는 항목만 슬라이더 (사운드 크기·마우스 감도·모바일 터치), 그래픽은 준비 중. 값은 이 기기에 저장
import { button, el, slider, type LobbyHost, type LobbyPanel } from './lobbyDom';
import { nicknameEditor } from './nicknameUi';

export class SettingsPanel implements LobbyPanel {
  readonly id = 'settings';
  readonly title = '설정';

  /** 마지막으로 본 탭 (다시 열면 그대로) */
  private tab: 'general' | 'pc' | 'touch' | null = null;

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    // 탭으로 나눔 (화면 밀도 낮춤): 일반(닉네임·사운드·그래픽) · PC 조작 · 모바일 터치. 처음엔 터치 기기면 터치 탭
    const touchDevice = matchMedia('(hover: none) and (pointer: coarse)').matches;
    this.tab ??= touchDevice ? 'touch' : 'general';
    const tabs = el('div', 'lb-settings-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '설정 종류');
    const left = el('div', 'lb-settings-col');
    const right = el('div', 'lb-settings-col');
    const touchCol = el('div', 'lb-settings-col');
    const pages: Record<'general' | 'pc' | 'touch', HTMLElement> = { general: left, pc: right, touch: touchCol };
    const labels: Record<'general' | 'pc' | 'touch', string> = { general: '일반', pc: 'PC 조작', touch: '모바일 터치' };
    const buttons = new Map<string, HTMLButtonElement>();
    const select = (id: 'general' | 'pc' | 'touch') => {
      this.tab = id;
      for (const [k, b] of buttons) {
        const on = k === id;
        b.classList.toggle('lb-active', on);
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        pages[k as 'general' | 'pc' | 'touch'].hidden = !on;
      }
    };
    for (const id of ['general', 'pc', 'touch'] as const) {
      const b = button(labels[id], 'lb-settings-tab', () => select(id));
      b.id = `lb-settings-tab-${id}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', `lb-settings-page-${id}`);
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const order = ['general', 'pc', 'touch'] as const;
        const next = order[(order.indexOf(id) + (e.key === 'ArrowRight' ? 1 : 2)) % 3]!;
        select(next);
        buttons.get(next)?.focus();
      });
      buttons.set(id, b);
      tabs.append(b);
      const page = pages[id];
      page.id = `lb-settings-page-${id}`;
      page.setAttribute('role', 'tabpanel');
      page.setAttribute('aria-labelledby', b.id);
    }
    const cols = el('div', 'lb-settings-cols lb-settings-tabbed');
    cols.append(left, right, touchCol);
    body.append(tabs, cols);
    left.appendChild(el('div', 'lb-section', '닉네임'));
    const nickname = el('div', 'lb-settings-nickname');
    const current = el('p', 'lb-settings-nickname-current');
    const name = el('b', '', this.host.playerName());
    current.append(el('span', '', '현재 닉네임'), name);
    // 변경 창: 저장(서버 확인)·취소. 실패하면 이전 닉네임 그대로, 안내만 표시
    const popup = el('div', 'lb-nick-popup');
    popup.hidden = true;
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', '닉네임 변경');
    const close = (): void => {
      popup.hidden = true;
      change.hidden = false;
      change.focus();
    };
    const cancel = button('취소', 'lb-nick-cancel', close);
    const editor = nicknameEditor(this.host, {
      buttonLabel: '저장',
      initialValue: this.host.nickname() ?? '',
      requireChange: true,
      extraButton: cancel,
      onSuccess: (value) => {
        name.textContent = value;
        window.setTimeout(close, 700);
      },
    });
    popup.append(el('b', 'lb-nick-popup-title', '새 닉네임'), editor.root);
    const change = button('변경', 'lb-nick-change', () => {
      editor.reset(this.host.nickname() ?? '');
      popup.hidden = false;
      change.hidden = true;
      editor.input.focus();
      editor.input.select();
    });
    current.append(change);
    nickname.append(current, popup);
    left.appendChild(nickname);

    const s = this.host.settings();
    left.appendChild(el('div', 'lb-section', '사운드'));
    for (const x of s.sound) left.appendChild(slider(x));
    right.appendChild(el('div', 'lb-section', '조작 (PC)'));
    for (const x of s.controls) right.appendChild(slider(x));
    const keys = el('div', 'lb-key-guide');
    for (const [key, action] of [
      ['WASD', '이동'],
      ['W×2', '달리기'],
      ['SHIFT', '슬라이딩'],
      ['SPACE', '점프'],
      ['LMB', '사격'],
      ['RMB', '조준'],
      ['R', '재장전'],
      ['1·2·3 / 휠', '무기 교체'],
      ['ESC', '일시정지'],
      ['TAB', '메뉴'],
    ] as const) {
      const item = el('span', 'lb-key-item');
      item.append(el('kbd', '', key), el('small', '', action));
      keys.appendChild(item);
    }
    right.appendChild(keys);
    touchCol.appendChild(el('div', 'lb-section', '모바일 터치'));
    for (const x of s.touch) touchCol.appendChild(slider(x));
    // 그래픽 설정은 아직 없음 → 큰 비활성 카드 대신 짧은 보조 문구
    left.appendChild(el('p', 'lb-settings-note', '그래픽 품질 설정은 준비 중이에요.'));
    select(this.tab);
  }
}

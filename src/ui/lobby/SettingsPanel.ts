// SETTINGS: 실제로 적용되는 항목만 슬라이더 (사운드 크기·마우스 감도·모바일 터치), 그래픽은 준비 중. 값은 이 기기에 저장
import { fullscreenAvailable, isExpanded, onExpandChange, setExpanded } from '../FullscreenPrompt';
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
    // 확장 화면: 스위치 = 실제 상태 (Verse8 바깥 확장 포함), 누르면 바로 전환·선택 기억, 안 되면 이유 한 줄
    left.appendChild(el('div', 'lb-section', '화면'));
    const expandNote = el('p', 'lb-settings-note lb-expand-note');
    expandNote.setAttribute('role', 'status');
    let refresh: (() => void) | null = null;
    const row = slider({
      label: '확장 화면으로 플레이',
      min: 0,
      max: 1,
      step: 1,
      toggle: true,
      get: () => (isExpanded() ? 1 : 0),
      set: (v) => {
        expandNote.textContent = '';
        void setExpanded(v >= 0.5).then((msg) => {
          expandNote.textContent = msg;
          refresh?.();
        });
      },
      format: (v) => (v >= 0.5 ? '켬' : '끔'),
      bind: (r) => (refresh = r),
    });
    // 바깥에서 확장·해제하면 스위치도 즉시 (패널이 다시 그려져 떨어지면 해제)
    const off = onExpandChange(() => {
      if (!row.isConnected) return off();
      expandNote.textContent = '';
      refresh?.();
    });
    left.append(row, expandNote);
    if (!fullscreenAvailable()) expandNote.textContent = '게임 안 확장은 이 화면에서 지원되지 않아요 · Verse8 화면의 확장 버튼을 써 주세요';
    // 그래픽 설정은 아직 없음 → 작은 비활성 줄 (슬라이더 줄과 같은 모양, 조작 불가)
    const gfx = el('div', 'lb-slider lb-slider-off lb-set-soon');
    gfx.setAttribute('aria-disabled', 'true');
    gfx.append(el('span', 'lb-slider-label', '그래픽 품질'), el('span', 'lb-set-soon-text', '다음 업데이트'), el('span', 'lb-slider-val', '준비 중'));
    left.appendChild(gfx);
    this.groupGeneral(left);
    select(this.tab);
  }

  /** 일반 탭: 제목(lb-section)마다 카드로 묶고 넓은 화면에서 2열 (닉네임·화면 | 사운드) */
  private groupGeneral(page: HTMLElement): void {
    const groups = new Map<string, HTMLElement>();
    let cur: HTMLElement | null = null;
    for (const child of [...page.children]) {
      if (child.classList.contains('lb-section')) {
        cur = el('section', 'lb-set-group');
        groups.set(child.textContent ?? '', cur);
      }
      cur?.append(child);
    }
    const a = el('div', 'lb-set-stack');
    const b = el('div', 'lb-set-stack');
    for (const k of ['닉네임', '화면']) if (groups.has(k)) a.append(groups.get(k)!);
    for (const [k, g] of groups) if (k !== '닉네임' && k !== '화면') b.append(g);
    page.textContent = '';
    page.classList.add('lb-settings-general');
    page.append(a, b);
  }
}

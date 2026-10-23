// SETTINGS: 실제로 적용되는 항목만 슬라이더 (사운드 크기·마우스 감도·모바일 터치), 그래픽은 준비 중. 값은 이 기기에 저장
import { button, comingSoon, el, slider, type LobbyHost, type LobbyPanel } from './lobbyDom';
import { nicknameEditor } from './nicknameUi';

export class SettingsPanel implements LobbyPanel {
  readonly id = 'settings';
  readonly title = '설정';

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    // 두 열 (넓은 화면): 왼쪽 닉네임·사운드, 오른쪽 조작·터치·그래픽. 좁으면 한 열로 이어짐
    const cols = el('div', 'lb-settings-cols');
    const left = el('div', 'lb-settings-col');
    const right = el('div', 'lb-settings-col');
    cols.append(left, right);
    body.appendChild(cols);
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
    right.appendChild(el('div', 'lb-section', '모바일 터치'));
    for (const x of s.touch) right.appendChild(slider(x));
    left.appendChild(comingSoon('그래픽', '품질 설정은 다음 단계에서 열려요'));
  }
}

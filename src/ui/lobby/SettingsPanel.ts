// SETTINGS: 실제로 적용되는 항목만 슬라이더 (사운드 크기·마우스 감도·모바일 터치), 그래픽은 준비 중. 값은 이 기기에 저장
import { comingSoon, el, slider, type LobbyHost, type LobbyPanel } from './lobbyDom';
import { nicknameEditor } from './nicknameUi';

export class SettingsPanel implements LobbyPanel {
  readonly id = 'settings';
  readonly title = 'SETTINGS';

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    body.appendChild(el('div', 'lb-section', '닉네임'));
    const nickname = el('div', 'lb-settings-nickname');
    const current = el('p', 'lb-settings-nickname-current');
    current.append(el('span', '', '현재 닉네임'), el('b', '', this.host.playerName()));
    const editor = nicknameEditor(this.host, {
      buttonLabel: '변경',
      initialValue: this.host.nickname() ?? '',
      onSuccess: (value) => { current.querySelector('b')!.textContent = value; },
    });
    nickname.append(current, editor.root);
    body.appendChild(nickname);

    const s = this.host.settings();
    body.appendChild(el('div', 'lb-section', '사운드'));
    for (const x of s.sound) body.appendChild(slider(x));
    body.appendChild(el('div', 'lb-section', '조작 (PC)'));
    for (const x of s.controls) body.appendChild(slider(x));
    const keys = el('div', 'lb-key-guide');
    for (const [key, action] of [
      ['WASD', '이동'],
      ['W×2', '달리기'],
      ['SHIFT', '슬라이딩'],
      ['SPACE', '점프'],
      ['LMB', '사격'],
      ['RMB', '조준'],
      ['R', '처음 위치로 (로비) · 재장전 (매치)'],
      ['1·2·3 / 휠', '무기 교체'],
      ['ESC', '일시정지'],
    ] as const) {
      const item = el('span', 'lb-key-item');
      item.append(el('kbd', '', key), el('small', '', action));
      keys.appendChild(item);
    }
    body.appendChild(keys);
    body.appendChild(el('div', 'lb-section', '모바일 터치'));
    for (const x of s.touch) body.appendChild(slider(x));
    body.appendChild(comingSoon('그래픽', '그림자·해상도 품질 설정은 다음 단계에서 열려요.'));
  }
}

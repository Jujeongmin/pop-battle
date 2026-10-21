// SETTINGS: 실제로 적용되는 항목만 슬라이더 (사운드 크기·마우스 감도·모바일 터치), 그래픽은 준비 중. 값은 이 기기에 저장
import { comingSoon, el, slider, type LobbyHost, type LobbyPanel } from './lobbyDom';

export class SettingsPanel implements LobbyPanel {
  readonly id = 'settings';
  readonly title = 'SETTINGS';

  constructor(private readonly host: LobbyHost) {}

  render(body: HTMLElement): void {
    const s = this.host.settings();
    body.appendChild(el('div', 'lb-section', '사운드'));
    for (const x of s.sound) body.appendChild(slider(x));
    body.appendChild(el('div', 'lb-section', '조작 (PC)'));
    for (const x of s.controls) body.appendChild(slider(x));
    const keys = el('p', 'lb-note');
    keys.textContent = 'WASD 이동 · W 두 번 달리기 · Shift 슬라이딩 · Space 점프 · 좌클릭 사격 · 우클릭 조준 · R 재장전 · 1/2/3·휠 무기 · Esc 일시정지';
    body.appendChild(keys);
    body.appendChild(el('div', 'lb-section', '모바일 터치'));
    for (const x of s.touch) body.appendChild(slider(x));
    body.appendChild(comingSoon('그래픽', '그림자·해상도 품질 설정은 다음 단계에서 열려요.'));
  }
}

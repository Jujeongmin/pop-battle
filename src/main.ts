import './style.css';
import { CAMERA, CHARACTER, MOVEMENT } from './config/gameConfig';
import { RIFLE, RIFLE_MOUNT } from './config/weapons';
import { Game } from './core/Game';
import { installUiDebug } from './ui/UiDebug';
import { installScreenRotation } from './core/screenRotation';
import { installTranslator } from './i18n/translate';

const app = document.getElementById('app')!;
// 이미지·글자를 끌어 옮기지 못하게 (Firefox는 CSS user-drag가 없어 이벤트로). 입력칸은 그대로
document.addEventListener('dragstart', (e) => {
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
});
// 세로로 든 터치 기기에서도 가로형으로 (게임을 만들기 전에 #app 크기를 정해 둠)
installScreenRotation(app);
// 언어 (설정 > 일반 > 언어): 영어면 화면 글자를 표시 직전에 사전으로 바꿈. 게임 UI가 만들어지기 전에 감시 시작
installTranslator(document.body);
const loading = document.getElementById('loading');

const game = new Game(app);
// UI 진단 (Ctrl+Alt+U, 콘솔 __uiDebug()): 로컬·Verse8 에디터 화면 차이 확인용, 배포 빌드에도 포함
installUiDebug(app);
game
  .init((text) => {
    if (loading) loading.textContent = text;
  })
  .then(() => loading?.remove())
  .catch((err: unknown) => {
    console.error(err);
    if (!loading) return;
    loading.classList.add('error');
    loading.textContent = `로드 실패: ${err instanceof Error ? err.message : String(err)}`;
  });

if (import.meta.env.DEV) {
  // 개발 중 브라우저 콘솔에서 상태 확인용
  // 설정값도 같은 모듈 인스턴스로 노출 (콘솔에서 실시간 튜닝)
  Object.assign(window, { __game: game, __cfg: { CAMERA, CHARACTER, MOVEMENT, RIFLE, RIFLE_MOUNT } });
}

if (import.meta.hot) {
  // 모듈 교체 시 이전 게임 리소스를 해제하고 새로 고침.
  // 해제 중 예외가 나면 Vite가 accept(새로 고침)를 건너뛰어 멈춘 화면이 남는다 → 예외를 삼키고 반드시 새로 고침
  import.meta.hot.dispose(() => {
    try {
      game.dispose();
    } catch (err) {
      console.warn('[hmr] 게임 해제 중 오류 (새로 고침으로 정리됨)', err);
    }
  });
  import.meta.hot.accept(() => location.reload());
}

import './style.css';
import { CAMERA, CHARACTER, MOVEMENT } from './config/gameConfig';
import { RIFLE, RIFLE_MOUNT } from './config/weapons';
import { Game } from './core/Game';
import { installUiDebug } from './ui/UiDebug';
import { installScreenRotation } from './core/screenRotation';
import { installTranslator } from './i18n/translate';
import { LoadProgress } from './core/loadProgress';
import { LoadingScreen, type LoadFailKind } from './ui/loading/LoadingScreen';

const app = document.getElementById('app')!;
// 이미지·글자를 끌어 옮기지 못하게 (Firefox는 CSS user-drag가 없어 이벤트로). 입력칸은 그대로
document.addEventListener('dragstart', (e) => {
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
});
// 세로로 든 터치 기기에서도 가로형으로 (게임을 만들기 전에 #app 크기를 정해 둠)
installScreenRotation(app);
// 언어 (설정 > 일반 > 언어): 영어면 화면 글자를 표시 직전에 사전으로 바꿈. 게임 UI가 만들어지기 전에 감시 시작
installTranslator(document.body);
// 첫 로딩 화면 (index.html에 처음부터 있음): 진행률·단계·오류·사라지기
const loadingEl = document.getElementById('loading');
const loading = loadingEl ? new LoadingScreen(loadingEl) : null;
// 바 앞부분(data-boot-share)은 게임 코드 받기 — 여기까지 왔으면 다 받음
const progress = new LoadProgress((value, stage) => loading?.update(value, stage), Number(loadingEl?.dataset.bootShare) || 0);
let loaded = false;
const failLoad = (err: unknown, kind?: LoadFailKind): void => {
  console.error(err);
  if (!loaded) loading?.fail(err, kind);
};
// 로딩 중 동적 청크를 못 받으면(배포 교체·연결 끊김) 다시 시도 안내
window.addEventListener('vite:preloadError', (e) => {
  if (loaded) return;
  e.preventDefault();
  failLoad((e as Event & { payload?: unknown }).payload ?? e, 'net');
});

let game: Game | null = null;
try {
  game = new Game(app);
} catch (err) {
  // WebGL 렌더러를 못 만든 경우 (오래된 브라우저·하드웨어 가속 꺼짐)
  failLoad(err, 'gl');
}
if (game) {
  const g = game;
  const canvas = app.querySelector('canvas');
  const onLost = (): void => failLoad(new Error('WebGL context lost during loading'), 'lost');
  canvas?.addEventListener('webglcontextlost', onLost);
  // UI 진단 (Ctrl+Alt+U, 콘솔 __uiDebug()): 로컬·Verse8 에디터 화면 차이 확인용, 배포 빌드에도 포함
  installUiDebug(app);
  g.init(progress)
    .then(() => {
      loaded = true;
      canvas?.removeEventListener('webglcontextlost', onLost);
      return loading?.finish();
    })
    .catch((err: unknown) => failLoad(err));
}

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
      game?.dispose();
    } catch (err) {
      console.warn('[hmr] 게임 해제 중 오류 (새로 고침으로 정리됨)', err);
    }
  });
  import.meta.hot.accept(() => location.reload());
}

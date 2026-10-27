import { defineConfig } from 'vite';

export default defineConfig({
  // Verse8 등 하위 경로 배포를 위해 상대 경로로 빌드
  base: './',
  // UI 진단(Ctrl+Alt+U)에 보이는 빌드 시각 → 에디터·배포본이 어느 빌드인지 구분
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  server: { port: 5210, strictPort: true },
  build: {
    target: 'es2022',
    // rapier 청크(wasm이 base64로 들어 있음)가 약 4.3MB
    chunkSizeWarningLimit: 4500,
    rolldownOptions: {
      output: {
        // 라이브러리를 게임 코드와 다른 파일로: 게임만 고쳐 다시 배포해도 라이브러리 파일 이름(해시)이 그대로라
        // 재방문 플레이어는 바뀐 게임 코드만 새로 받음. 모두 첫 화면에 필요해 index.html이 함께 미리 받음 (지연 로딩 없음)
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /node_modules[\\/]@dimforge[\\/]/ },
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
            { name: 'vendor', test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
});

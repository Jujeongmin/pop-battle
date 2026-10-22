import { defineConfig } from 'vite';

export default defineConfig({
  // Verse8 등 하위 경로 배포를 위해 상대 경로로 빌드
  base: './',
  // UI 진단(Ctrl+Alt+U)에 보이는 빌드 시각 → 에디터·배포본이 어느 빌드인지 구분
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  server: { port: 5210, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});

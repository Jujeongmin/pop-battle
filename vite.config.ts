import { defineConfig } from 'vite';

export default defineConfig({
  // Verse8 등 하위 경로 배포를 위해 상대 경로로 빌드
  base: './',
  server: { port: 5210, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});

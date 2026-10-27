import { defineConfig, type Plugin } from 'vite';

/**
 * 첫 로딩 화면의 '게임 파일 받기' 진행률: 처음 받는 JS 청크(입구 + 정적 import) 크기를 #loading data-boot에 적어 둠.
 * index.html 안쪽 스크립트가 청크마다 다 받았는지(Resource Timing)를 보고 크기 비율로 진행 바를 채움 (배포 빌드만)
 */
function loadingBootSizes(): Plugin {
  return {
    name: 'pop-loading-boot-sizes',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        const sizes: Record<string, number> = {};
        const visit = (file: string): void => {
          const c = bundle[file];
          if (!c || c.type !== 'chunk' || file in sizes) return;
          sizes[file] = c.code.length;
          for (const dep of c.imports) visit(dep);
        };
        for (const [file, c] of Object.entries(bundle)) if (c.type === 'chunk' && c.isEntry) visit(file);
        const attr = JSON.stringify(sizes).replace(/"/g, '&quot;');
        return html.replace('<div id="loading" ', `<div id="loading" data-boot="${attr}" `);
      },
    },
  };
}

export default defineConfig({
  // Verse8 등 하위 경로 배포를 위해 상대 경로로 빌드
  base: './',
  // UI 진단(Ctrl+Alt+U)에 보이는 빌드 시각 → 에디터·배포본이 어느 빌드인지 구분
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  server: { port: 5210, strictPort: true },
  plugins: [loadingBootSizes()],
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

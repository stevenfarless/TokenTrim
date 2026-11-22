import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base so the build works from any GitHub Pages sub-path
// (https://<user>.github.io/<repo>/) as well as from a custom domain.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // The tiktoken rank tables and the ONNX runtime are large by nature.
    chunkSizeWarningLimit: 6000,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // registered explicitly in src/main.ts
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        id: './',
        name: 'TokenTrim',
        short_name: 'TokenTrim',
        description: 'Compress long LLM prompts into fewer tokens. Runs fully offline in your browser.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0d1218',
        theme_color: '#0d1218',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell, JS chunks (including the worker and tiktoken ranks), CSS,
        // icons and the single-thread ONNX Runtime WASM binary used by iOS.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,webmanifest,wasm}'],
        // The 27 MB "asyncify" ONNX build is only used for WebGPU on desktop.
        // It is cached on first use by the runtime rule below instead.
        globIgnores: ['**/*asyncify*'],
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // Same-origin .onnx / .wasm / .mjs / .json (e.g. the WebGPU WASM build,
            // or model files if you self-host them under /models/).
            urlPattern: ({ url, sameOrigin }) => sameOrigin && /\.(?:onnx|wasm|mjs|json)$/i.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'tokentrim-assets',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 40 },
            },
          },
          // Hugging Face model files are deliberately NOT routed through Workbox.
          // Transformers.js writes them to Cache Storage under the key
          // "transformers-cache" (see src/worker/compressor.worker.ts). Caching them
          // here as well would store the ~180 MB model twice, and it would miss the
          // very first download because the service worker may not control the page yet.
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
});

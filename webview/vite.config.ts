import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    minify: 'esbuild',
    esbuild: {
      drop: ['console', 'debugger'],
    },
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/index.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    proxy: {
      // Dev-mode fallback for the vendored TokenTracker dashboard: when the
      // webview runs in a plain browser (no host bridge), dashboard traffic
      // goes to a locally running `tokentracker serve` instance instead.
      '/tt-dev': {
        // Keep in sync with useTokenTrackerServer.ts TT_DEV_PREVIEW_PORT.
        target: 'http://127.0.0.1:7680',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/tt-dev/, ''),
      },
    },
  },
});

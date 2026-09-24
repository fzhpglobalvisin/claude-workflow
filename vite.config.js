import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API (node server/index.js) listens on :4000; Vite proxies /api (incl. the SSE stream) to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // reachable from phones on the same Wi-Fi for field-team testing
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
});

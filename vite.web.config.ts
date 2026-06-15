import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Standalone web build of the renderer (no Electron). Output goes to `dist-web/`,
 * which the web server (`src/server/index.ts`) serves. The Electron build is
 * unaffected and still uses `electron.vite.config.ts`.
 */
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  // Match the Electron dev-server port so the web UI never collides with
  // CK Player 2.0's Vite server (5173). The API/WS server runs on 8788.
  server: { port: 5273, strictPort: true, host: true },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});

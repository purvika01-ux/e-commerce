import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The API port, taken from the PORT line of server/.env so the proxy follows the server.
 * Only that one line is read; nothing else from the server's env reaches the client build.
 */
function apiPort(): number {
  try {
    const env = readFileSync(new URL('../server/.env', import.meta.url), 'utf8');
    const port = Number(/^\s*PORT\s*=\s*(\d+)\s*$/m.exec(env)?.[1]);
    return Number.isInteger(port) && port > 0 ? port : 4000;
  } catch {
    return 4000;
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Keep the browser's Host header: the server's CSRF check requires Origin to match Host,
    // and the string shorthand would rewrite Host to the API address (changeOrigin: true).
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort()}`, changeOrigin: false } },
  },
});

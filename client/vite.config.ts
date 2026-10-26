import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Keep the browser's Host header: the server's CSRF check requires Origin to match Host,
    // and the string shorthand would rewrite Host to 127.0.0.1:4000 (changeOrigin: true).
    proxy: { '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false } },
  },
});

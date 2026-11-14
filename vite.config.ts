import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/dashboard',
  publicDir: 'public',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/dashboard', import.meta.url)),
    },
  },
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    // During `npm run dev:ui`, forward API calls to `wrangler dev` (port 8787).
    proxy: {
      '/api': 'http://localhost:8787',
      '/v1': 'http://localhost:8787',
    },
  },
});

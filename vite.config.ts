import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/dashboard',
  publicDir: 'public',
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

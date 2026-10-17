/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative base so the built `dist/` runs from any path (file://, subfolder, CDN).
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Party Mode: the browser talks to the standalone party server (`npm run party:server`).
  server: {
    proxy: { '/api/party': 'http://127.0.0.1:8787' },
    // The party server's saved state holds the recorded shuffles, i.e. every live player's cards,
    // and it lives in the project root that this dev server serves. Never serve it (or its backup,
    // lock and set-aside copies), whatever the path or `/@fs/` prefix. These are added to Vite's own
    // defaults (.env, keys, .git), which `fs.deny` would otherwise replace.
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.party-state.json*', '**/.party-data/**'] },
  },
  test: {
    globals: true,
    // The engine (src/game) is pure TypeScript and runs in plain Node.
    // jsdom is only required for the few component tests that touch the DOM.
    environment: 'jsdom',
    testTimeout: 20000,
    // Serial by design: the simulation labs each run 50k-round sweeps and would
    // otherwise contend for the same cores, which makes the whole run slower and
    // the per-file timings meaningless.
    //
    // A consequence worth knowing: this repo's full suite takes several minutes,
    // and part-way through Vitest can emit `Timeout calling "onTaskUpdate"`. That
    // is a *worker RPC* timeout — the main thread waiting on a worker that is
    // busy — not a test failure. Every test still reports its real result; the
    // runner just flags the stall. Switching to `pool: 'forks'` was tried and is
    // materially worse (process-spawn overhead across 26 files), so the default
    // `threads` pool is kept and the warning treated as an environment artefact
    // of the long labs rather than a defect in the suite.
    pool: 'threads',
    fileParallelism: false,
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: [
        'src/arena/**/*.ts',
        'src/casino/**/*.ts',
        'src/game/**/*.ts',
        'src/party/**/*.ts',
      ],
      reporter: ['text', 'html'],
    },
  },
});

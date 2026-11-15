// vitest.config.ts
// Standalone test config: the tested modules (layout, loadPack) are pure TS
// with no IWSDK imports, so tests must not load vite.config.ts — the iwsdk
// plugin there takes a workspace lock that conflicts with a running dev session.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});

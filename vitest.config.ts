import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Vitest's 5 s default is a transform budget here, not a logic budget: the
    // heavy renderer suites call vi.resetModules() then `await import(...)` a
    // component with a large import graph inside the test body, so the FIRST
    // assertion pays a cold transform of that whole graph. A full run measures
    // 601 files / 5,956 tests, 2:03 wall measured 2026-10-04, so on a loaded
    // machine those files time out non-deterministically (observed:
    // EpicDetail.terminalMode.test.tsx failing on one run and passing on the
    // next with no code change). Raised globally rather than per-file — the
    // shape is common to every resetModules+dynamic-import suite, and a real
    // hang still fails, just 10 s later.
    testTimeout: 15_000,
    // Persists transformed modules under node_modules/.experimental-vitest-cache
    // between runs instead of re-transforming all 601 files every time (Vitest
    // 4.1.6 `experimental.fsModuleCache`). CI restores that directory via
    // actions/cache (see .github/workflows/ci.yml) so each shard starts warm.
    experimental: {
      fsModuleCache: true,
    },
    include: [
      'tests/unit/**/*.spec.ts',
      'src/renderer/**/*.test.ts',
      'src/renderer/**/*.test.tsx',
      'src/renderer/**/*.spec.ts',
      'src/**/__tests__/**/*.test.cjs',
      'src/**/__tests__/**/*.spec.cjs',
      'scripts/**/__tests__/**/*.test.cjs',
      'web/**/__tests__/**/*.test.cjs',
    ],
    globals: true,
    globalSetup: ['tests/setup/schedulerSandbox.globalSetup.cjs'],
    setupFiles: ['tests/setup/schedulerSandbox.cjs'],
  },
})

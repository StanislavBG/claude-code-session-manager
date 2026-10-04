import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

// Loaded via createRequire (not a static import) so Vite's config bundler
// leaves this .cjs file alone instead of re-bundling its `require('node:fs')`
// calls into a dynamic import, which built-in modules reject.
const { listPureTests } = createRequire(import.meta.url)('./scripts/list-pure-tests.cjs')

// Decision rule (PRD perf-vitest-projects-isolation-split): measured 2026-10-04,
// warm-cache runs of this project's own 64-file pure subset averaged ~2.8s real
// / ~2.1s vitest "Duration" with `--isolate` forced on, vs ~1.6s real / ~1.0s
// Duration under `--project pure` (isolate: false) — a ~40% wall-time saving on
// that subset, well over the 10% keep-it threshold, so the split is kept.
const PURE_TESTS = listPureTests()

const SHARED = {
  environment: 'node' as const,
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
  globals: true,
  // The pure project still needs the sandbox HOME env (SM_SCHEDULER_HOME etc.)
  // even with isolate: false, since src modules read it at import time.
  globalSetup: ['tests/setup/schedulerSandbox.globalSetup.cjs'],
  setupFiles: ['tests/setup/schedulerSandbox.cjs'],
}

const ALL_INCLUDE = [
  'tests/unit/**/*.spec.ts',
  'src/renderer/**/*.test.ts',
  'src/renderer/**/*.test.tsx',
  'src/renderer/**/*.spec.ts',
  'src/**/__tests__/**/*.test.cjs',
  'src/**/__tests__/**/*.spec.cjs',
  'scripts/**/__tests__/**/*.test.cjs',
  'web/**/__tests__/**/*.test.cjs',
]

export default defineConfig({
  test: {
    // Persists transformed modules under node_modules/.experimental-vitest-cache
    // between runs instead of re-transforming all 601 files every time (Vitest
    // 4.1.6 `experimental.fsModuleCache`). CI restores that directory via
    // actions/cache (see .github/workflows/ci.yml) so each shard starts warm.
    experimental: {
      fsModuleCache: true,
    },
    projects: [
      {
        test: {
          ...SHARED,
          name: 'isolated',
          include: ALL_INCLUDE,
          exclude: PURE_TESTS,
        },
      },
      {
        test: {
          ...SHARED,
          name: 'pure',
          isolate: false,
          include: PURE_TESTS,
        },
      },
    ],
  },
})

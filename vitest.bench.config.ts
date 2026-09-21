import { defineConfig } from 'vitest/config'

// `npm run bench:renderer` only — deliberately NOT part of vitest.config.ts's
// include, so it never runs under `npm run test:unit`. No sandbox setup: the
// benches touch no scheduler state.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/bench/**/*.bench.test.tsx'],
    testTimeout: 120_000,
    globals: true,
    disableConsoleIntercept: true,
  },
})

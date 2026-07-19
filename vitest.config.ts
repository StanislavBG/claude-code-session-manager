import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.spec.ts',
      'src/renderer/**/*.test.ts',
      'src/main/__tests__/scheduler-committed-in-window.test.cjs',
      'src/main/__tests__/pty-write-result.test.cjs',
    ],
    globals: true,
  },
})

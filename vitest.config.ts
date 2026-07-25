import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.spec.ts',
      'src/renderer/**/*.test.ts',
      'src/main/__tests__/scheduler-committed-in-window.test.cjs',
      'src/main/__tests__/pty-write-result.test.cjs',
      'src/main/__tests__/web-remote-e2e-pinning.test.cjs',
      'src/main/__tests__/docEdit.test.cjs',
      'src/main/__tests__/queueHistory.test.cjs',
      'src/main/__tests__/queueOpsAutoArchive.test.cjs',
      'src/main/__tests__/prdParserHighWater.test.cjs',
      'src/main/__tests__/broadcastCoalescer.test.cjs',
    ],
    globals: true,
  },
})

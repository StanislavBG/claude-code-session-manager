import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts', 'src/renderer/**/*.test.ts'],
    globals: false,
  },
})

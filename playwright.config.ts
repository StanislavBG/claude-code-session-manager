import { defineConfig } from '@playwright/test'

export default defineConfig({
  testMatch: ['e2e/**/*.spec.{mjs,ts}', 'tests/e2e/**/*.spec.ts', 'tests/smoke/**/*.spec.ts'],
  timeout: 240_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
})

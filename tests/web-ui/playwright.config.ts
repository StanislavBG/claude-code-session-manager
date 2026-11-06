import { defineConfig } from '@playwright/test'

// Real Chromium only (never Electron): `npx playwright test -c tests/web-ui/playwright.config.ts`.
export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.ts'],
  timeout: 240_000,
  workers: 1,
  reporter: [['list']],
})

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testMatch: ['tests/e2e/**/*.spec.{mjs,ts}', 'tests/smoke/**/*.spec.ts'],
  // Exclude stale agent worktrees (they hold duplicate spec copies). The rotted
  // cycle-1 e2e/*.spec.mjs (live-transcript, history-dashboard, new-session,
  // overview-billing, broadcast) were DELETED — they asserted removed UI; the
  // maintained tests/e2e/*.ts suite is the signal. tests/e2e/chat-restart.spec.mjs is the one .mjs spec.
  testIgnore: ['**/.claude/worktrees/**', 'web-remote/**', 'web/remote-app/**'],
  timeout: 240_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
})

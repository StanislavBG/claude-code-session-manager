/**
 * Smoke test: Overview's Plan & Usage section renders real data from
 * /api/oauth/usage (requires ~/.claude/.credentials.json to be present).
 */
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TABS_JSON = path.join(process.env.HOME, '.config', 'session-manager', 'tabs.json')

test.beforeEach(() => {
  if (fs.existsSync(TABS_JSON)) {
    fs.copyFileSync(TABS_JSON, TABS_JSON + '.bak')
    fs.unlinkSync(TABS_JSON)
  }
})

test.afterEach(() => {
  if (fs.existsSync(TABS_JSON + '.bak')) {
    fs.copyFileSync(TABS_JSON + '.bak', TABS_JSON)
    fs.unlinkSync(TABS_JSON + '.bak')
  }
})

test('Overview shows Plan & Usage with live data', async () => {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development', SM_E2E: '1' },
    timeout: 30_000,
  })

  const win = await app.firstWindow()
  const logs = []
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  await win.waitForSelector('text=Claude Session Manager', { timeout: 20_000 })
  await win.waitForSelector('.bg-green-500', { timeout: 20_000 })

  // Verify the IPC path works (independent of rendering).
  const direct = await win.evaluate(() => window.api.billing.fetch())
  console.log('[overview] billing ipc result:', JSON.stringify(direct).slice(0, 300))
  expect(direct?.ok).toBe(true)
  expect(direct?.data?.usage?.five_hour).toBeTruthy()

  // Navigate to the Overview tab via the left nav (first matching button).
  await win.locator('nav button:has-text("Overview")').first().click()

  // Wait for the Plan & Usage heading (renders as soon as Overview mounts;
  // independent of the ~/.claude scan).
  await expect(win.locator('text=Plan & Usage')).toBeVisible({ timeout: 15_000 })

  // Wait for the bar (billing fetch resolves).
  await expect(win.locator('text=5-hour window')).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('text=Weekly window')).toBeVisible({ timeout: 5_000 })

  const snapshot = await win.evaluate(() => document.body.innerText)
  console.log('[overview] snapshot (first 1KB):\n' + snapshot.slice(0, 1000))

  await app.close()
})

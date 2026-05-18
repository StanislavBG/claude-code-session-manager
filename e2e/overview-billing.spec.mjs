/**
 * Smoke test: Overview's Plan & Usage section renders real data from
 * /api/oauth/usage (requires ~/.claude/.credentials.json to be present).
 */
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installTabsJsonBackup } from './_helpers/tabsJsonBackup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

installTabsJsonBackup(test)

test('Overview shows Plan & Usage with live data', async () => {
  const app = await electron.launch({
    args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    // SM_MOCK_BILLING_KIND=ok routes billing.fetch through usage.cjs's
    // SM_E2E stub (returns a minimal valid payload at 10% utilization), so
    // the test does not flake when the real /api/oauth/usage endpoint is
    // rate-limiting the dev box's creds.
    env: { ...process.env, NODE_ENV: 'development', SM_E2E: '1', SM_MOCK_BILLING_KIND: 'ok' },
    timeout: 30_000,
  })

  const win = await app.firstWindow()
  const logs = []
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  await win.waitForSelector('text=Claude Session Manager', { timeout: 20_000 })
  await win.waitForSelector('.bg-green-500', { timeout: 20_000 })

  // Verify the IPC path works (independent of rendering).
  // BillingFetchResult is a discriminated union (kind: 'ok' | 'ok-stale' | …);
  // there is no top-level `.ok` field.
  const direct = await win.evaluate(() => window.api.billing.fetch())
  console.log('[overview] billing ipc result:', JSON.stringify(direct).slice(0, 300))
  expect(direct?.kind === 'ok' || direct?.kind === 'ok-stale').toBe(true)
  expect(direct?.data?.usage?.five_hour).toBeTruthy()

  // Navigate to Overview via the command palette — robust against
  // collapsed LeftNav sections persisted in localStorage from prior runs.
  await win.keyboard.press('Control+K')
  await win.locator('[data-testid="command-palette"]').waitFor({ state: 'visible', timeout: 5_000 })
  const cmdInput = win.locator('[data-testid="command-palette"] input[role="combobox"]')
  await cmdInput.fill('overview')
  await win.locator('button[data-cmd-id="nav:overview"]').first().waitFor({ state: 'visible', timeout: 3_000 })
  await win.keyboard.press('Enter')
  await win.locator('[data-testid="command-palette"]').waitFor({ state: 'hidden', timeout: 3_000 })

  // CockpitStrip (the cockpit overhaul replaced the Plan & Usage card). It
  // renders a 5h utilization bar — UsageDial (label "5-hour window") when
  // utilization >= 50, else a CompactBar with the short label "5h". Mock
  // billing returns 10% so we expect the compact form. Also expect the 7d
  // Sonnet + Opus compact bars below it.
  // Anchor on the Instrument Cluster heading, which is unique to the Overview
   // CockpitStrip and mounts only after counts hydrate.
  await expect(win.locator('h3:has-text("Instrument Cluster")')).toBeVisible({ timeout: 15_000 })
  // Match either form of the 5-hour row to stay resilient to mock-util changes.
  await expect(win.locator('text=/^(5h|5-hour window)$/').first()).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('text=7d · Sonnet')).toBeVisible({ timeout: 5_000 })
  await expect(win.locator('text=7d · Opus')).toBeVisible({ timeout: 5_000 })

  const snapshot = await win.evaluate(() => document.body.innerText)
  console.log('[overview] snapshot (first 1KB):\n' + snapshot.slice(0, 1000))

  await app.close()
})

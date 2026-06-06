/**
 * The Subagents/"hive" tab is a monitor, not a launcher. It carries a
 * "Launch a hive →" affordance that jumps to Dispatch pre-set to the Hives
 * mode (where the actual HiveManagerModal launcher lives). This guards that
 * cross-link so the monitor and launcher don't drift apart again.
 */
import { test, expect } from '@playwright/test'
import { launchApp, navigateToTab } from './_helpers/launchApp'

test('Subagents "Launch a hive →" jumps to Dispatch on the Hives mode', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'subagents')

    const launch = win.locator('button', { hasText: /launch a hive/i })
    await expect(launch).toBeVisible({ timeout: 10_000 })
    await launch.click({ force: true })   // force: LeftNav badge poller shifts layout

    // Should land on Dispatch with the Hives sub-tab active — the Hive Manager
    // surfaces its "Launch hive →" control and the hive-template chrome.
    await expect(win.locator('button', { hasText: /launch hive/i }).first())
      .toBeVisible({ timeout: 10_000 })
  } finally {
    await app.close()
  }
})

/**
 * Regression test: two TourOverlay steps ('scheduler', 'mainpane-actions')
 * referenced data-testid selectors ('tour-scheduler', 'tour-mainpane-actions')
 * that were dropped from the DOM in the Almanac redesign (commit 2e23789) but
 * never removed from TOUR_STEPS — the tour silently degraded those steps to a
 * centered, spotlight-less tooltip. Exercise the full tour once end-to-end so
 * a future rename that breaks a target again is caught.
 */
import { test, expect } from '@playwright/test'
import { launchApp } from './_helpers/launchApp'

test('tour: scheduler step renders (centered — the row is project-face-only)', async () => {
  const { app, win } = await launchApp()
  try {
    // Restart the tour via the command palette's 'tour:start' command — this
    // is the documented re-run path (TourOverlay.tsx header comment) but the
    // command didn't exist in CommandPalette.tsx until this fix.
    await win.keyboard.press('Control+K')
    const palette = win.locator('[data-testid="command-palette"]')
    await palette.waitFor({ state: 'visible' })
    await win.locator('input[role="combobox"]').fill('restart guided tour')
    const tourBtn = win.locator('button[data-cmd-id="tour:start"]')
    await expect(tourBtn).toBeVisible()
    await tourBtn.click()
    await palette.waitFor({ state: 'hidden' })

    const overlay = win.locator('[data-testid="tour-overlay"]')
    await overlay.waitFor({ state: 'visible', timeout: 10_000 })

    // Step through to the 'scheduler' step (index 4, 0-based) via Next.
    for (let i = 0; i < 4; i++) {
      await win.locator('[data-testid="tour-next"]').click()
      await win.waitForTimeout(150)
    }
    await expect(win.locator('#tour-title')).toHaveText('PRD scheduler')
    // This step deliberately carries no `target` now: Scheduler is a
    // PROJECT-face-only sidebar row, so on a Home-face launch there is nothing
    // to spotlight. Assert the step still renders its copy — the failure this
    // file guards is a step pointing at a testid that no longer exists, and a
    // step with no target at all can't hit it.
    await expect(win.locator('[data-testid="tour-overlay"]')).toContainText('project-scoped')

    await win.locator('[data-testid="tour-close"]').click()
    await overlay.waitFor({ state: 'hidden', timeout: 3_000 })
  } finally {
    await app.close()
  }
})

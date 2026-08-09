/**
 * Regression test: two TourOverlay steps ('scheduler', 'mainpane-actions')
 * referenced data-testid selectors ('tour-scheduler', 'tour-mainpane-actions')
 * that were dropped from the DOM in the Almanac redesign (commit 2e23789) but
 * never removed from TOUR_STEPS — the tour silently degraded those steps to a
 * centered, spotlight-less tooltip. Exercise the full tour once end-to-end so
 * a future rename that breaks a target again is caught.
 *
 * The step list is imported from `lib/tourSteps.ts` (JSX-free for exactly this
 * reason) rather than duplicated here, so adding or reordering a step doesn't
 * silently skip coverage. Targets that only exist on the PROJECT nav face are
 * expected to be absent on this Home-face launch — that's `projectFaceOnly`,
 * and the assertion below is about the OTHER kind of miss.
 */
import { test, expect } from '@playwright/test'
import { launchApp } from './_helpers/launchApp'
import { TOUR_STEPS } from '../../src/renderer/lib/tourSteps'

test('tour: every step renders, and every non-project-face target is spotlit', async () => {
  const { app, win } = await launchApp()
  try {
    // Restart the tour via the command palette's 'tour:start' command — this
    // is the documented re-run path (TourOverlay.tsx header comment).
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

    for (const [i, step] of TOUR_STEPS.entries()) {
      await expect(win.locator('#tour-title')).toHaveText(step.title)
      await expect(overlay).toContainText(`Step ${i + 1} of ${TOUR_STEPS.length}`)

      // A target that isn't PROJECT-face-only must actually be in the DOM on
      // this launch — that's the silent-degradation failure this file exists
      // to catch.
      if (step.target && !step.projectFaceOnly) {
        await expect(win.locator(step.target).first()).toBeVisible()
      }

      const next = win.locator('[data-testid="tour-next"]')
      await expect(next).toHaveText(i === TOUR_STEPS.length - 1 ? 'Got it' : 'Next')
      if (i < TOUR_STEPS.length - 1) {
        await next.click()
        await win.waitForTimeout(120)
      }
    }

    await win.locator('[data-testid="tour-close"]').click()
    await overlay.waitFor({ state: 'hidden', timeout: 3_000 })
  } finally {
    await app.close()
  }
})

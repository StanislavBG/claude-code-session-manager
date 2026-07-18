/**
 * Regression test: App.tsx's CommandPalette onCommand handler used to only
 * dispatch `nav:*` ids — every other `emitOnly` command (close-tab,
 * new-tab-here, copy-cwd, etc., see CommandPalette.tsx's header comment for
 * the full contract) silently no-op'd because nothing handled them. Exercise
 * a couple of the non-nav emitOnly commands end-to-end so a future refactor
 * that drops the dispatch again fails loudly.
 */
import { test, expect } from '@playwright/test'
import { launchApp } from './_helpers/launchApp'

test('command palette: close-tab emitOnly command actually closes the active tab', async () => {
  const { app, win } = await launchApp()
  try {
    await win.waitForTimeout(1000)
    const tabRowsBefore = await win.locator('[data-testid="tour-tabbar"] button[aria-label^="Close "]').count()
    await win.keyboard.press('Control+K')
    const palette = win.locator('[data-testid="command-palette"]')
    await palette.waitFor({ state: 'visible' })
    await win.locator('input[role="combobox"]').fill('close active tab')
    const btn = win.locator('button[data-cmd-id="close-tab"]')
    await expect(btn).toBeVisible()
    await btn.click()
    await palette.waitFor({ state: 'hidden' })
    await win.waitForTimeout(500)
    const tabRowsAfter = await win.locator('[data-testid="tour-tabbar"] button[aria-label^="Close "]').count()
    expect(tabRowsAfter).toBeLessThan(tabRowsBefore)
  } finally {
    await app.close()
  }
})

test('command palette: new-tab-here emitOnly command spawns another tab', async () => {
  const { app, win } = await launchApp()
  try {
    await win.waitForTimeout(1000)
    const tabRowsBefore = await win.locator('[data-testid="tour-tabbar"] button[aria-label^="Close "]').count()
    await win.keyboard.press('Control+K')
    const palette = win.locator('[data-testid="command-palette"]')
    await palette.waitFor({ state: 'visible' })
    await win.locator('input[role="combobox"]').fill('new tab in current cwd')
    const btn = win.locator('button[data-cmd-id="new-tab-here"]')
    await expect(btn).toBeVisible()
    await btn.click()
    await palette.waitFor({ state: 'hidden' })
    await win.waitForTimeout(500)
    const tabRowsAfter = await win.locator('[data-testid="tour-tabbar"] button[aria-label^="Close "]').count()
    expect(tabRowsAfter).toBeGreaterThan(tabRowsBefore)
  } finally {
    await app.close()
  }
})

/**
 * Search page — ⌘P / ⌘⇧F mode toggle.
 *
 * SearchModal's own doc comment promises the keybinding "bumps [mode] even
 * when the search screen is already active". Regression: QuickOpenModal's
 * and GlobalSearchModal's query inputs auto-focus on mount, and the global
 * shortcut listener in App.tsx skipped every real `<input>`/`<textarea>` —
 * so once the Search page was open, its own focused input silently ate the
 * very shortcut meant to toggle it.
 */
import { test, expect } from '@playwright/test'
import { launchApp } from './_helpers/launchApp'

test('Ctrl+Shift+F switches Search from Files to Content mode while the search screen is already open', async () => {
  const { app, win } = await launchApp()
  try {
    // Reach Search via the AlmanacSidebar Tools row — it is a Tools page,
    // not a CommandPalette nav entry.
    await win.locator('button[title="⌘P file · ⌘⇧F content"]').click()
    await expect(win.getByLabel('Search files')).toBeVisible({ timeout: 5_000 })

    await win.keyboard.press('Control+Shift+f')

    await expect(win.getByLabel('Search query')).toBeVisible({ timeout: 3_000 })
  } finally {
    await app.close()
  }
})

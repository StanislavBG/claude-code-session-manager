/**
 * ProjectsWorkspace — navigating to the Projects tab renders the split pane
 * (file-tree region + editor region), and the Navigate/Files toggle no longer
 * exists in the sidebar.
 */
import { test, expect } from '@playwright/test'
import { launchApp, navigateToTab } from './_helpers/launchApp'

test('Projects tab renders split pane and has no nav/files toggle', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'projects')

    // Both panes must be present in the DOM
    await expect(win.locator('[data-testid="projects-file-tree-pane"]')).toBeVisible({ timeout: 5000 })
    await expect(win.locator('[data-testid="projects-editor-pane"]')).toBeVisible({ timeout: 5000 })

    // The Navigate/Files toggle must no longer exist
    const toggle = win.locator('button[aria-pressed]', { hasText: /Navigate|Files/ })
    await expect(toggle).toHaveCount(0)
  } finally {
    await app.close()
  }
})

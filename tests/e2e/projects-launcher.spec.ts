/**
 * Projects workspace compact launcher.
 *
 * Verifies the launcher trigger renders in the left pane, opens a dropdown
 * when clicked, and lists at least one known project from the local
 * ~/.claude/projects history.
 */
import { test, expect } from '@playwright/test'
import { launchApp, navigateToTab } from './_helpers/launchApp'

test('projects launcher trigger opens list with at least one project', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'projects')

    const workspace = win.locator('[data-testid="projects-workspace"]')
    await workspace.waitFor({ state: 'visible', timeout: 10_000 })

    const trigger = win.locator('[data-testid="projects-launcher-trigger"]')
    await expect(trigger).toBeVisible()

    await trigger.click()

    const list = win.locator('[data-testid="projects-launcher-list"]')
    await expect(list).toBeVisible({ timeout: 3_000 })

    // Expect at least one project row in the list. The scan of ~/.claude/projects
    // is async, so allow generous time for the first row to populate.
    const rows = list.locator('[data-testid="projects-launcher-row"]')
    await expect(rows.first()).toBeVisible({ timeout: 25_000 })
  } finally {
    await app.close()
  }
})

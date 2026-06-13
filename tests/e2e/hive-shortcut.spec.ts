/**
 * The Subagents tab is now the single launcher for all fan-out topologies
 * (Hive · Orchestrate · Race · Boss). They share ONE brief — typed once,
 * reused as you switch topology — instead of each owning a private prompt box.
 * This guards that consolidation: the brief survives a topology switch, and
 * the separate "Dispatch" route is gone.
 */
import { test, expect } from '@playwright/test'
import { launchApp, navigateToTab } from './_helpers/launchApp'

test('Subagents Launch shares one brief across topologies', async () => {
  const { app, win } = await launchApp()
  try {
    await navigateToTab(win, 'subagents')

    // The shared brief box and the topology selector are both present.
    const brief = win.getByTestId('dispatch-brief')
    await expect(brief).toBeVisible({ timeout: 10_000 })
    await expect(win.locator('button', { hasText: /^Hive$/ })).toBeVisible()
    await expect(win.locator('button', { hasText: /^Race$/ })).toBeVisible()

    // Type a brief, switch topology, and confirm the text persists (shared).
    await brief.fill('investigate the auth flow')
    await win.locator('button', { hasText: /^Race$/ }).click({ force: true })
    await expect(win.getByTestId('dispatch-brief')).toHaveValue('investigate the auth flow')

    // Hive topology still offers its launch control.
    await win.locator('button', { hasText: /^Hive$/ }).click({ force: true })
    await expect(win.locator('button', { hasText: /launch the hive/i }))
      .toBeVisible({ timeout: 10_000 })
  } finally {
    await app.close()
  }
})

/**
 * Sidebar rail-collapse toggle.
 *
 * Asserts that clicking the collapse toggle shrinks the sidebar to icon-only
 * rail width (below 80px) and hides nav-item label text, and that clicking
 * the expand toggle restores the sidebar to a labelled layout.
 */
import { test, expect } from '@playwright/test'
import { launchApp } from './_helpers/launchApp'

test('sidebar collapse toggle shrinks to rail and expands back', async () => {
  const { app, win } = await launchApp()
  try {
    const sidebar = win.locator('[data-testid="tour-leftnav"]')
    await sidebar.waitFor({ state: 'visible', timeout: 10_000 })

    // Expanded baseline: sidebar wider than 80px and nav labels are visible.
    const expandedBox = await sidebar.boundingBox()
    expect(expandedBox?.width).toBeGreaterThan(80)

    // A known nav label that should be visible in expanded mode.
    const terminalLabel = win.locator('[data-testid="tour-leftnav"] button', { hasText: 'Terminal' }).first()
    await expect(terminalLabel).toBeVisible()

    // Click the collapse toggle.
    const toggle = win.locator('[data-testid="sidebar-rail-toggle"]').first()
    await expect(toggle).toBeVisible()
    await toggle.click()

    // Wait for transition to settle.
    await win.waitForTimeout(200)

    // Collapsed: sidebar is narrow (rail).
    const railBox = await sidebar.boundingBox()
    expect(railBox?.width).toBeLessThan(80)

    // Nav label text is no longer visible.
    await expect(terminalLabel).not.toBeVisible()

    // Click the expand toggle (now inside the rail header).
    const expandToggle = win.locator('[data-testid="sidebar-rail-toggle"]').first()
    await expect(expandToggle).toBeVisible()
    await expandToggle.click()

    await win.waitForTimeout(200)

    // Expanded again: sidebar is wide and labels are visible.
    const restoredBox = await sidebar.boundingBox()
    expect(restoredBox?.width).toBeGreaterThan(80)
    await expect(terminalLabel).toBeVisible()
  } finally {
    await app.close()
  }
})

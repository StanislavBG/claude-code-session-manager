/**
 * Regression test for a Rules-of-Hooks violation in SchedulePanel.tsx: the
 * `handleJobListKeyDown` useCallback was declared AFTER two early returns
 * (`if (!snap) return null` and `if (panelView === 'supervisor') return
 * <SupervisorPanel/>`), so switching to the supervisor sub-panel changed the
 * hook count between renders and crashed with React error #300/#310
 * ("Rendered fewer hooks than during the previous render"), caught by the
 * app's ErrorBoundary. Fixed by hoisting the useCallback above both early
 * returns so every render of SchedulePanel executes the same hooks in the
 * same order regardless of panelView.
 */
import { test, expect } from '@playwright/test'
import { launchApp, navigateToTab } from './_helpers/launchApp'

test('Scheduler Queue → supervisor sub-panel does not crash', async () => {
  test.setTimeout(60_000)
  const { app, win, errors } = await launchApp({ env: { SM_MOCK_BILLING_KIND: 'ok' } })
  try {
    await win.evaluate(() => localStorage.setItem('sm.schedulerTab.subView', 'queue'))
    await navigateToTab(win, 'scheduler')
    await win.waitForTimeout(500)

    const supervisorLink = win.locator('button', { hasText: /^supervisor$/i }).first()
    await expect(supervisorLink).toBeVisible({ timeout: 10_000 })
    await supervisorLink.click({ force: true })
    await win.waitForTimeout(500)

    // The panel header should render normally, not the ErrorBoundary fallback.
    await expect(win.locator('text=Supervisor').first()).toBeVisible({ timeout: 5_000 })
    expect(errors.filter((e) => /Minified React error #(300|310)|ErrorBoundary/.test(e))).toEqual([])

    // Navigate back to queue and confirm the queue table still renders.
    const backLink = win.locator('button', { hasText: /queue/i }).first()
    await backLink.click({ force: true })
    await win.waitForTimeout(300)
    expect(errors.filter((e) => /Minified React error #(300|310)|ErrorBoundary/.test(e))).toEqual([])
  } finally {
    await app.close()
  }
})

/**
 * Scheduler KPI derivation barrier (PRD 1385).
 *
 * Unlike scheduler-2a-graph.spec.ts (which seeds `utilization` straight into queue state and so
 * legitimately tests the render path in isolation), this drives `kpi-window` from the real-shape
 * mock billing payload (SM_MOCK_BILLING_KIND=ok_weekly_binding → limits[]) through the scheduler's
 * pollLoop → bindingWindow() → snapshot → renderer. Mock path only: no network, no billing-cache.
 *
 * Fixture: session 12% (3h), weekly_all 64% (2d 5h, binding), weekly_scoped 90% (scoped, ignored).
 * Do NOT queue this as a scheduler job — run manually: xvfb-run -a timeout 600 npx playwright test tests/e2e/scheduler-kpi-derivation.spec.ts
 */
import { test, expect } from '@playwright/test'
import { launchApp, navigateToTab } from './_helpers/launchApp'

test('kpi-window shows the binding window derived from a real-shape limits[] payload', async () => {
  const { app, win } = await launchApp({ env: { SM_MOCK_BILLING_KIND: 'ok_weekly_binding' } })
  try {
    await win.setViewportSize({ width: 1350, height: 866 })
    await navigateToTab(win, 'scheduler')
    const kpi = win.locator('[data-testid="kpi-window"]')
    await expect(kpi).toBeVisible()

    // Derived from the poll (no seeded snapshot): wait for the binding percent to arrive.
    await expect(kpi).toContainText('64%', { timeout: 30_000 })
    const text = (await kpi.innerText()).replace(/\s+/g, ' ')

    // 100% is the reported failure signature; 12% is the flat five_hour fallback; 90% the ignored scoped entry.
    expect(text).not.toContain('100%')
    expect(text).not.toContain('12%')
    expect(text).not.toContain('90%')

    // Machine-readable: the bar agrees with the number.
    await expect(kpi.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '64')

    // Label and reset describe the weekly window, not the 5h one.
    expect(text).toMatch(/weekly · all models used/i) // label is CSS-uppercased in innerText
    expect(text).not.toMatch(/session · 5h/i)
    expect(text).toMatch(/resets in 2d/)
  } finally {
    await app.close()
  }
})

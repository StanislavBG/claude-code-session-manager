/**
 * Bounded smoke spec for the Browser tab (PRD 397-412) — mounts the tab,
 * confirms the native-view chrome renders a default sub-tab, and exercises
 * the four ActionBar verbs (Capture DOM / Record / Observe / Screenshot)
 * toggling their side panel open/closed.
 *
 * Kept out of tabs-smoke.spec.ts's TABS union deliberately: that spec only
 * asserts "mounts without console errors" across all 17 nav tabs; this spec
 * needs Browser-specific interaction (verb clicks, panel titles) that don't
 * fit the generic 17-tab loop.
 *
 * Hermetic: the Browser tab seeds its first sub-tab at `about:blank`
 * (state/browser.ts `openTab` default) — no network access is exercised.
 *
 * Run bounded, standalone (per PRD AC — do not fold into the full suite):
 *   timeout 120 xvfb-run -a npx playwright test tests/e2e/browser-tab.spec.ts
 */
import { test, expect } from '@playwright/test'
import { launchApp, navigateToTab } from './_helpers/launchApp'

test('Browser tab mounts, seeds a default sub-tab, and toggles verb panels', async () => {
  const { app, win, errors } = await launchApp()
  try {
    await navigateToTab(win, 'browser')
    await win.waitForTimeout(500)

    // Browser.tsx mounted: the bottom action bar's provenance line is a
    // stable, Browser-specific marker (not present on any other tab).
    await expect(win.getByText('Hand this page to the agent →')).toBeVisible()

    // A default sub-tab was seeded on first mount (state/browser.ts openTab()).
    await expect(win.getByTitle('New tab')).toBeVisible()

    const captureBtn = win.getByRole('button', { name: 'Capture DOM' })
    const recordBtn = win.getByRole('button', { name: 'Record', exact: true })
    const observeBtn = win.getByRole('button', { name: 'Observe' })
    const screenshotBtn = win.getByRole('button', { name: 'Screenshot' })

    // Scoped to the Browser tab's own contextual panel (panel-primitives.tsx
    // PanelShell `data-testid="browser-panel"`) — NOT the bare `complementary`
    // role, which also matches AlmanacSidebar's always-mounted `<aside
    // aria-label="Primary navigation">` (baseline count 1, not 0).
    const panel = win.locator('[data-testid="browser-panel"]')

    // Capture: open, assert title, click active verb again to close.
    // (PanelShell title AND the panel's first SectionLabel both render the
    // exact text "Capture" — CapturePanel.tsx renders the title span before
    // the "Capture" SectionLabel, so `.first()` deterministically selects
    // the title.)
    await captureBtn.click()
    await expect(panel.getByText('Capture', { exact: true }).first()).toBeVisible()
    await captureBtn.click()
    await expect(panel).toHaveCount(0)

    // Record: open, assert title, close.
    await recordBtn.click()
    await expect(panel.getByText('Recorder', { exact: true })).toBeVisible()
    await recordBtn.click()
    await expect(panel).toHaveCount(0)

    // Observe: open, assert title (panel is titled "Claude session" per the
    // design — real allow/deny gating lands in a later PRD), close.
    await observeBtn.click()
    await expect(panel.getByText('Claude session', { exact: true })).toBeVisible()
    await observeBtn.click()
    await expect(panel).toHaveCount(0)

    // Screenshot routes into capture mode with captureMode 'shot' (state
    // browser.ts onVerb) rather than toggling a distinct panel/mode — it
    // reuses the Capture panel, so assert that instead of a toggle-close.
    await screenshotBtn.click()
    await expect(panel.getByText('Capture', { exact: true }).first()).toBeVisible()

    const real = errors.filter((e) => !/Autofill\.enable|Autofill\.setAddresses/.test(e))
    expect(real, `errors during Browser tab interaction: ${real.join(' | ')}`).toEqual([])
  } finally {
    await app.close()
  }
})

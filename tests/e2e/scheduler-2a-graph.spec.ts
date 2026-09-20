/**
 * Scheduler 2A redesign e2e (PRD sched2a-density-audit-and-e2e).
 *
 * Seeds a queue snapshot through the REAL renderer subscription: the main process pushes a
 * `schedule:state` event to the window (the same channel scheduler.cjs broadcasts on), so the
 * renderer store hydrates exactly as in production without needing an on-disk project registered
 * in the sandboxed HOME. The Scheduler scopes to the active tab's cwd, which launchApp opens on ROOT,
 * so every seeded job carries `cwd: ROOT`.
 *
 * Asserts: six KPI cells · plan band expand/collapse · stage-footer disclosure · WHOLE GRAPH brush
 * moves the stage window · Graph / List / Critical path segmented control · measured (real layout)
 * density: PRD row height and vertical space above the first row.
 *
 * Do NOT queue this as a scheduler job — run it manually: xvfb-run -a timeout 600 npx playwright test tests/e2e/scheduler-2a-graph.spec.ts
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, navigateToTab, ROOT } from './_helpers/launchApp'

const N_STAGES = 12
const PER_STAGE = 8

function seedJobs() {
  const jobs: Record<string, unknown>[] = []
  for (let i = 0; i < N_STAGES * PER_STAGE; i++) {
    const stage = Math.floor(i / PER_STAGE)
    const running = i === 0
    jobs.push({
      slug: `e2e-${String(i).padStart(3, '0')}`, title: `E2E PRD ${i}`, status: running ? 'running' : 'pending', cwd: ROOT,
      parallelGroup: 1, estimateMinutes: null, bodyPreview: '', runId: null, exitCode: null, error: null, epicId: 'e2e-epic',
      startedAt: running ? new Date(Date.now() - 60_000).toISOString() : null, finishedAt: null,
      dependsOn: stage === 0 ? [] : [`e2e-${String(i - PER_STAGE).padStart(3, '0')}`],
    })
  }
  return jobs
}

function snapshot() {
  return {
    config: { enabled: true, offsetMinutes: 0, defaultCwd: ROOT, firePolicy: 'when-available', utilizationThreshold: 90, schemaVersion: 1, supervisor: { enabled: false } },
    jobs: seedJobs(), lastTick: null, scheduledFor: null, lastRunAt: null, nextReset: null, paused: null, utilization: 12,
    effectiveConcurrency: { cap: 3, free: 2, source: 'config' },
  }
}

async function push(app: ElectronApplication) {
  const snap = snapshot()
  await app.evaluate(({ BrowserWindow }, s) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('schedule:state', s)
  }, snap)
}

/** Re-push until the plan graph is on screen — a real scheduler broadcast may briefly overwrite the seed. */
async function seedAndOpen(app: ElectronApplication, win: Page) {
  await navigateToTab(win, 'scheduler')
  await expect.poll(async () => { await push(app); return win.locator('[data-testid="plan-band"]').count() }, { timeout: 15_000 }).toBeGreaterThan(0)
}

test.describe('Scheduler 2A graph', () => {
  test('KPI band, plan band, stage footer, brush, mode control, density', async () => {
    const { app, win } = await launchApp()
    try {
      await win.setViewportSize({ width: 1350, height: 866 })
      await win.mouse.move(2, 2) // keep the LEARN hover popover closed
      await seedAndOpen(app, win)

      // Six KPI cells.
      for (const id of ['kpi-window', 'kpi-slots', 'kpi-ready', 'kpi-needs-you', 'kpi-done', 'kpi-concurrency']) {
        await expect(win.locator(`[data-testid="${id}"]`)).toBeVisible()
      }
      await expect(win.locator('[data-testid="scheduler-kpi-band"] > [data-testid^="kpi-"]')).toHaveCount(6)

      // Plan band expands and collapses.
      const band = win.locator('[data-testid="plan-band"]').first()
      const toggle = band.locator('[data-testid="plan-toggle"]')
      await expect(band.locator('[data-testid="stage-column"]').first()).toBeVisible()
      await toggle.click()
      await expect(band.locator('[data-testid="stage-column"]')).toHaveCount(0)
      await toggle.click()
      await expect(band.locator('[data-testid="stage-column"]').first()).toBeVisible()

      // Measured density (real layout): PRD row ≤ 32px; five header bands ≤ 210px above the first PRD row.
      const row = band.locator('[data-testid="prd-row"] > button').first()
      const rowH = (await row.boundingBox())!.height
      expect(rowH).toBeLessThanOrEqual(32)
      const h = async (loc: ReturnType<Page['locator']>) => (await loc.first().boundingBox())!.height
      const five =
        (await h(win.locator('[data-testid="queue-health-header"]'))) +
        (await h(win.locator('[data-testid="scheduler-kpi-band"]'))) +
        (await h(win.locator('[data-testid="scheduler-plans-toolbar"]'))) +
        (await h(band.locator('[data-testid="plan-header"]'))) +
        (await h(band.locator('[data-testid="plan-minimap"]')))
      expect(five).toBeLessThanOrEqual(212) // 210 + 2px of 1px rules
      expect(await band.locator('[data-testid="stage-column"]').count()).toBeGreaterThanOrEqual(5)

      // A stage column's disclosure footer expands.
      const footer = band.locator('[data-testid="stage-footer"]').first()
      await expect(footer).toBeVisible()
      const before = await footer.locator('xpath=..').locator('[data-testid="prd-row"]').count()
      await footer.click()
      await expect(footer).toHaveAttribute('aria-expanded', 'true')
      expect(await footer.locator('xpath=..').locator('[data-testid="prd-row"]').count()).toBeGreaterThan(before)

      // WHOLE GRAPH brush moves the stage window.
      const range = band.locator('[data-testid="plan-minimap-range"]')
      const rangeBefore = await range.textContent()
      const dots = band.locator('[data-testid="plan-minimap-dots"]')
      const box = (await dots.boundingBox())!
      await win.mouse.click(box.x + box.width - 2, box.y + box.height / 2)
      await expect(range).not.toHaveText(rangeBefore!)

      // Graph / List / Critical path segmented control.
      await win.locator('[data-testid="plan-mode-list"]').click()
      await expect(win.locator('[data-testid="backlog-epic-section"]').first()).toBeVisible()
      await expect(win.locator('[data-testid="plan-graph"]')).toHaveCount(0)
      await win.locator('[data-testid="plan-mode-critical"]').click()
      await expect(win.locator('[data-testid="critical-path"]').first()).toBeVisible()
      await win.locator('[data-testid="plan-mode-graph"]').click()
      await expect(win.locator('[data-testid="plan-graph"]')).toBeVisible()
    } finally {
      await app.close()
    }
  })
})

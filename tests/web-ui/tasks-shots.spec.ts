import { test, expect, chromium, type Page } from '@playwright/test'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureWebCss } from './webCss.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). Mounts the real Scheduler TasksView (tasks-entry.tsx) with CSS
// from the built web renderer (dist-web/app.css) over a stub window.api.tasks holding 7 Tasks
// across 2 pipelines / 3 runs, and writes the list and the drill-down (TaskDetail) in light and
// dark at the main-area size (1592x1040). The app ships a single light palette, so "dark" =
// Chromium dark colour-scheme emulation plus an inverted render (as project-home-library-shots).
// Output goes to test-results/tasks/ (gitignored) — never a tracked path.
const root = path.resolve(__dirname, '../..')
const OUT = path.join(root, 'test-results/tasks')
const VIEWPORT = { width: 1592, height: 1040 }
const DETAIL_ROW = 'tasks-row-tk-7f3a91' // the Task whose stored output is truncated

/** The structure every shot must show; `detail` = the drill-down panel is open. */
async function assertShot(page: Page, detail: boolean) {
  await expect(page.getByTestId('tasks-view')).toBeVisible()
  await expect(page.getByTestId('tasks-badge-direct')).toBeVisible()
  await expect(page.getByTestId('tasks-badge-direct')).toHaveCount(1)
  const sw = page.getByTestId('tasks-switch')
  await expect(sw).toBeVisible()
  await expect(sw).toBeChecked()
  await expect(page.locator('[data-testid^="tasks-row-"]')).toHaveCount(7)
  await expect(page.locator('[data-testid^="tasks-group-"]')).toHaveCount(2)
  await expect(page.getByText(/^run /)).toHaveCount(3)
  for (const s of ['rate_limited', 'slot_timeout', 'error']) {
    await expect(page.getByTestId('tasks-status-chip').filter({ hasText: new RegExp(`^${s}\\b`) })).toHaveCount(1)
  }
  if (detail) {
    const panel = page.getByTestId('task-detail')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Task tk-7f3a91')
    await expect(panel.getByTestId('task-detail-output-truncated')).toBeVisible()
    await expect(panel.getByTestId('task-detail-output')).toContainText('Burrow in 60 seconds')
  } else {
    await expect(page.getByTestId('task-detail')).toHaveCount(0)
  }
}

/** Drill-down open: every chip/badge sits inside the list column with >=4px to its right edge; no row overflows. */
async function assertRowsFit(page: Page, scheme: string) {
  const col = await page.getByTestId('tasks-list').boundingBox()
  expect(col, `${scheme}: tasks-list box`).not.toBeNull()
  const right = col!.x + col!.width
  for (const id of ['tasks-status-chip', 'tasks-badge-direct']) {
    const items = await page.getByTestId(id).all()
    expect(items.length, `${scheme}: ${id} count`).toBeGreaterThan(0)
    for (const [i, el] of items.entries()) {
      const b = await el.boundingBox()
      expect(b, `${scheme}: ${id}[${i}] box`).not.toBeNull()
      expect(b!.x, `${scheme}: ${id}[${i}] left`).toBeGreaterThanOrEqual(col!.x)
      expect(b!.y, `${scheme}: ${id}[${i}] top`).toBeGreaterThanOrEqual(col!.y)
      expect(b!.x + b!.width, `${scheme}: ${id}[${i}] right edge`).toBeLessThanOrEqual(right - 4)
    }
  }
  const overflow = await page.$$eval('button[data-testid^="tasks-row-"]', (els) =>
    els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => `${e.getAttribute('data-testid')} ${e.scrollWidth}>${e.clientWidth}`))
  expect(overflow, `${scheme}: rows overflowing`).toEqual([])
}

test('Scheduler Tasks screenshots: list + detail, light + dark, at 1592x1040', async () => {
  const css = ensureWebCss(root)
  const bundle = (await build({
    entryPoints: [path.join(__dirname, 'tasks-entry.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text

  fs.mkdirSync(OUT, { recursive: true })
  const names = ['tasks-list-light', 'tasks-list-dark', 'tasks-detail-light', 'tasks-detail-dark']
  for (const n of names) fs.rmSync(path.join(OUT, `${n}.png`), { force: true }) // a stale PNG must not pass
  const browser = await chromium.launch() // never Electron
  const pageErrors: string[] = []
  const unmodelled: string[] = []
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme, timezoneId: 'America/Los_Angeles', locale: 'en-US' })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => pageErrors.push(`${scheme}: ${e.message}`))
      page.on('console', (m) => { if (m.text().startsWith('[stub-api]')) unmodelled.push(m.text()) })
      await page.route('http://fx.test/**', (r) =>
        r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body class="bg-bg"><div id="root"></div></body></html>` }),
      )
      await page.goto('http://fx.test/')
      await page.addScriptTag({ content: bundle })
      if (scheme === 'dark') await page.addStyleTag({ content: 'html{filter:invert(1) hue-rotate(180deg)}' })

      await assertShot(page, false)
      await page.waitForTimeout(300) // fonts settle
      await page.screenshot({ path: path.join(OUT, `tasks-list-${scheme}.png`) })
      const swClosed = await page.getByTestId('tasks-switch').boundingBox()

      await page.getByTestId(DETAIL_ROW).click()
      await expect(page.getByTestId(DETAIL_ROW)).toHaveAttribute('aria-pressed', 'true')
      await assertShot(page, true)
      await page.waitForTimeout(300)
      const swOpen = await page.getByTestId('tasks-switch').boundingBox()
      expect(swClosed, `${scheme}: switch box (closed)`).not.toBeNull()
      expect(swOpen, `${scheme}: switch box (open)`).not.toBeNull()
      expect([swOpen!.x, swOpen!.y], `${scheme}: switch moved when the drill-down opened`).toEqual([swClosed!.x, swClosed!.y])
      await assertRowsFit(page, scheme)
      await page.screenshot({ path: path.join(OUT, `tasks-detail-${scheme}.png`) })
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
  expect(pageErrors).toEqual([])
  expect(unmodelled).toEqual([])
  for (const n of names) {
    const f = path.join(OUT, `${n}.png`)
    expect(fs.existsSync(f), `${n}.png was not written`).toBe(true)
    expect(fs.statSync(f).size).toBeGreaterThan(10_000)
    const png = fs.readFileSync(f)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([VIEWPORT.width, VIEWPORT.height])
  }
})

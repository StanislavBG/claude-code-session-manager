import { test, expect, chromium, type Page } from '@playwright/test'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureWebCss } from './webCss.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). Mounts the real Scheduler JobRow + PrdStatusPill
// (scheduler-cancelled-entry.tsx) with CSS from the built web renderer (dist-web/app.css) over a
// stub window.api, for a cancelled 'failed' job, a cancelled 'needs_review' job and a real
// failure, and writes light + dark PNGs at the main-area size (1592x1040). "Dark" = Chromium dark
// colour-scheme emulation plus an inverted render (as tasks-shots). Output goes to
// test-results/scheduler-cancelled/ (gitignored) — never a tracked path.
const root = path.resolve(__dirname, '../..')
const OUT = path.join(root, 'test-results/scheduler-cancelled')
const VIEWPORT = { width: 1592, height: 1040 }
const CASES = [
  { id: 'cancelled-failed', label: 'Status: cancelled', cancelled: true },
  { id: 'cancelled-needs-review', label: 'Status: cancelled', cancelled: true },
  { id: 'real-failure', label: 'Status: failed', cancelled: false },
] as const

async function assertRows(page: Page, scheme: string) {
  await expect(page.getByTestId('cancelled-rows')).toBeVisible()
  await expect(page.locator('[data-job-row]')).toHaveCount(3)
  await expect(page.locator('[data-job-row][data-job-cancelled="true"]')).toHaveCount(2)
  for (const c of CASES) {
    const box = page.getByTestId(`cancelled-case-${c.id}`)
    const row = box.locator('[data-job-row]')
    await expect(row, `${scheme}: ${c.id} row`).toHaveCount(1)
    // JobRow badge (SchBadge) — the row button's own status element.
    await expect(row.getByRole('status'), `${scheme}: ${c.id} JobRow badge`).toHaveAttribute('aria-label', c.label)
    // PrdStatusPill fed by prdStatusFor(job).
    await expect(box.getByTestId('cancelled-case-pill').getByRole('status'), `${scheme}: ${c.id} PrdStatusPill`).toHaveAttribute('aria-label', c.label)
    if (c.cancelled) await expect(row, `${scheme}: ${c.id} cancelled flag`).toHaveAttribute('data-job-cancelled', 'true')
    else await expect(row, `${scheme}: ${c.id} must not be flagged cancelled`).not.toHaveAttribute('data-job-cancelled', /.*/)
  }
}

test('Scheduler cancelled rows: JobRow + PrdStatusPill tell a cancel from a failure, light + dark, at 1592x1040', async () => {
  const css = ensureWebCss(root)
  const bundle = (await build({
    entryPoints: [path.join(__dirname, 'scheduler-cancelled-entry.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text

  fs.mkdirSync(OUT, { recursive: true })
  const names = ['scheduler-cancelled-light', 'scheduler-cancelled-dark']
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

      await assertRows(page, scheme)
      await page.waitForTimeout(300) // fonts settle
      await page.screenshot({ path: path.join(OUT, `scheduler-cancelled-${scheme}.png`) })
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

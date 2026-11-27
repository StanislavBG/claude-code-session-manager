import { test, expect, chromium, type Page } from '@playwright/test'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureWebCss } from './webCss.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). The Guild Hall canvas was only ever exercised in jsdom (no
// getContext); this mounts the real Home page (guild-hall-entry.tsx) over a stub window.api and
// writes guild-hall-empty / guild-hall-populated / guild-hall-quest-board, light + dark, at the
// main-area size 1592x1040. "Dark" = Chromium dark colour-scheme emulation plus an inverted render
// (the app ships one light palette; same as tasks-shots). Output: test-results/guild-hall/ (gitignored).
const root = path.resolve(__dirname, '../..')
const OUT = path.join(root, 'test-results/guild-hall')
const VIEWPORT = { width: 1592, height: 1040 }
const NAMES = ['guild-hall-empty', 'guild-hall-populated', 'guild-hall-quest-board']
const CAPTION = 'No one is out adventuring'

/** Distinct non-transparent colours sampled from the canvas backing store. */
async function canvasStats(page: Page) {
  return page.getByTestId('world-canvas').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')!
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    const colours = new Set<number>()
    let opaque = 0
    for (let i = 0; i < data.length; i += 4 * 7) {
      if (data[i + 3] > 0) opaque++
      colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
    }
    return { w: c.width, h: c.height, opaque, colours: colours.size }
  })
}

test('Guild Hall screenshots: empty, populated, quest board, light + dark, at 1592x1040', async () => {
  const css = ensureWebCss(root)
  const bundle = (await build({
    entryPoints: [path.join(__dirname, 'guild-hall-entry.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text

  fs.mkdirSync(OUT, { recursive: true })
  const files = NAMES.flatMap((n) => ['light', 'dark'].map((s) => `${n}-${s}.png`))
  for (const f of files) fs.rmSync(path.join(OUT, f), { force: true }) // a stale PNG must not pass
  const browser = await chromium.launch() // never Electron
  const pageErrors: string[] = []
  const unmodelled: string[] = []
  try {
    for (const scheme of ['light', 'dark'] as const) {
      for (const world of ['empty', 'populated'] as const) {
        const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme, deviceScaleFactor: 1, timezoneId: 'America/Los_Angeles', locale: 'en-US' })
        const page = await ctx.newPage()
        page.on('pageerror', (e) => pageErrors.push(`${scheme}/${world}: ${e.message}`))
        page.on('console', (m) => { if (m.text().startsWith('[stub-api]')) unmodelled.push(`${scheme}/${world}: ${m.text()}`) })
        await page.route('http://fx.test/**', (r) =>
          r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body class="bg-bg"><div id="root"></div></body></html>` }),
        )
        await page.goto(`http://fx.test/#${world}`)
        // Spy on fillText before the app draws: records every string the canvas paints.
        await page.addInitScript(() => {
          const w = window as any
          w.__fillTexts = []
          w.__fillYs = {}
          const orig = CanvasRenderingContext2D.prototype.fillText
          CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, ...rest: number[]) {
            w.__fillTexts.push(String(text))
            w.__fillYs[String(text)] = rest[1]
            return (orig as any).call(this, text, ...rest)
          }
        })
        await page.reload()
        await page.addScriptTag({ content: bundle })
        if (scheme === 'dark') await page.addStyleTag({ content: 'html{filter:invert(1) hue-rotate(180deg)}' })

        await expect(page.getByTestId('guild-hall')).toBeVisible()
        const canvas = page.getByTestId('world-canvas')
        await expect(canvas).toBeVisible()
        await expect.poll(async () => (await canvasStats(page)).w, { message: 'canvas backing store sized' }).toBeGreaterThan(1000)
        const texts = () => page.evaluate(() => (window as any).__fillTexts as string[])

        if (world === 'empty') {
          await expect(page.getByTestId('guild-hall-slots')).toHaveText('0 of 5 slots busy')
          await expect.poll(texts, { message: 'empty caption drawn' }).toContain(CAPTION)
          // The caption pixels: the centre of the canvas is not a flat ground tile.
          const s = await canvasStats(page)
          expect(s.opaque).toBeGreaterThan(0)
          await page.waitForTimeout(300)
          await page.screenshot({ path: path.join(OUT, `guild-hall-empty-${scheme}.png`) })
        } else {
          await expect(page.getByTestId('guild-hall-slots')).toHaveText('5 of 5 slots busy')
          await expect(page.getByTestId('quest-board-toggle')).toContainText('Quest board (2)')
          // Group labels for dev-lead (3), architect (1), unknown (1) are painted; the empty caption is not.
          await expect.poll(async () => (await texts()).length, { message: 'group labels drawn' }).toBeGreaterThanOrEqual(3)
          const drawn = (await texts()).join('|')
          expect(drawn).not.toContain(CAPTION)
          expect(drawn).toContain('dev-lead')
          expect(drawn).toContain('architect')
          // All three groups sit below the overlay bar: label baselines are under the bar's bottom edge.
          const barBottom = await page.locator('header').first().evaluate((h) => h.getBoundingClientRect().bottom)
          const ys = await page.evaluate(() => (window as any).__fillYs as Record<string, number>)
          const labelYs = Object.entries(ys).filter(([t]) => /×\d+$/.test(t))
          expect(labelYs.length, `${scheme}: three group labels`).toBeGreaterThanOrEqual(3)
          for (const [t, y] of labelYs) expect(y, `${scheme}: ${t} hidden under the bar`).toBeGreaterThan(barBottom)
          const s = await canvasStats(page)
          expect(s.opaque, `${scheme}: populated canvas is blank`).toBeGreaterThan(0)
          expect(s.colours, `${scheme}: populated canvas has a single flat colour`).toBeGreaterThan(4)
          await page.waitForTimeout(300)
          await page.screenshot({ path: path.join(OUT, `guild-hall-populated-${scheme}.png`) })

          await page.getByTestId('quest-board-toggle').click()
          const board = page.getByTestId('quest-board')
          await expect(board).toBeVisible()
          await expect(board).toContainText('Needs you')
          await expect(board).toContainText('Pick a name for the new idea')
          await page.waitForTimeout(300)
          await page.screenshot({ path: path.join(OUT, `guild-hall-quest-board-${scheme}.png`) })
        }
        await ctx.close()
      }
    }
  } finally {
    await browser.close()
  }
  expect(pageErrors).toEqual([])
  expect(unmodelled).toEqual([])
  for (const f of files) {
    const file = path.join(OUT, f)
    expect(fs.existsSync(file), `${f} was not written`).toBe(true)
    expect(fs.statSync(file).size).toBeGreaterThan(10_000)
    const png = fs.readFileSync(file)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([VIEWPORT.width, VIEWPORT.height])
  }
})

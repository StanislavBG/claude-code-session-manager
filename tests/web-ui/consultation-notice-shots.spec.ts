import { test, expect, chromium, type Page } from '@playwright/test'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureWebCss } from './webCss.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). Mounts the real ConsultationNotice immediately followed by the real
// AlmanacFooter, in the flex column App.tsx uses (empty flex-1 body, strip, footer), over a stub
// window.api. Scenes: "shown" (no stored dismissal), "dismissed" (click ×), "stored" (already
// dismissed for this version: no strip). Output: test-results/consultation-notice/ (gitignored).
const root = path.resolve(__dirname, '../..')
const OUT = path.join(root, 'test-results/consultation-notice')
const VIEWPORT = { width: 1280, height: 800 }
const TEXT = 'Want to chat? Book a free consultation.'
const PNGS = ['shown-light', 'shown-dark', 'dismissed-light', 'dismissed-dark'].map((n) => `${n}.png`)

const ENTRY = String.raw`
import { createRoot } from 'react-dom/client'
import { ConsultationNotice } from '../../src/renderer/components/ConsultationNotice'
import { AlmanacFooter } from '../../src/renderer/components/layout/AlmanacFooter'

const scene = new URLSearchParams(location.search).get('scene') || 'shown'
window.__writes = []
window.__reads = 0
const noop = () => () => {}

const api = {
  config: {
    readJson: async () => {
      const result = scene === 'stored'
        ? { exists: true, data: { consultationNoticeDismissedVersion: '0.0.0' } }
        : { exists: false }
      window.__reads++
      return result
    },
    writeJson: async (p, data) => { window.__writes.push({ path: p, data }) },
    onChanged: noop, watch: () => {}, unwatch: () => {},
  },
  schedule: {
    state: async () => ({ paused: null }),
    onState: noop,
    onStall: noop,
    sessionSlots: async () => ({ total: 5, inUse: 0, holders: [] }),
    onSessionSlots: noop,
  },
  billing: { fetch: async () => ({ kind: 'error' }), onUpdate: noop },
  updater: { status: async () => ({ state: 'idle' }), onStatus: noop, check: async () => null },
  sessions: { load: async () => ({ tabs: [], activeTabId: null }), save: async () => {} },
}

// Anything not modelled resolves harmlessly and is logged so the spec fails on it.
function fallback(target, p) {
  return new Proxy(target, {
    get(t, k) {
      if (typeof k === 'symbol' || k in t) {
        const v = t[k]
        return v && typeof v === 'object' ? fallback(v, p + '.' + String(k)) : v
      }
      console.log('[stub-api] ' + (p + '.' + String(k)).replace(/^\./, ''))
      return fallback(async () => undefined, p + '.' + String(k))
    },
  })
}
window.api = fallback(api, '')

createRoot(document.getElementById('root')).render(
  <div style={{ height: '100vh' }} className="flex flex-col text-fg">
    <div className="flex-1" />
    <ConsultationNotice />
    <AlmanacFooter onNavigate={() => {}} />
  </div>,
)
`

async function open(browser: import('@playwright/test').Browser, css: string, bundle: string, scene: string, scheme: 'light' | 'dark', errors: string[]) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${scene}/${scheme}: pageerror ${e.message}`))
  page.on('console', (m) => { if (m.text().startsWith('[stub-api]')) errors.push(`${scene}/${scheme}: ${m.text()}`) })
  await page.route('http://fx.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body class="bg-bg"><div id="root"></div></body></html>` }),
  )
  await page.goto(`http://fx.test/?scene=${scene}`)
  await page.addScriptTag({ content: bundle })
  if (scheme === 'dark') await page.addStyleTag({ content: 'html{filter:invert(1) hue-rotate(180deg)}' })
  await expect(page.getByTestId('footer-version')).toBeVisible()
  return { ctx, page }
}

async function shoot(page: Page, name: string, written: string[]) {
  await page.waitForTimeout(250)
  const file = path.join(OUT, name)
  await page.screenshot({ path: file })
  written.push(file)
}

test('Consultation notice: sits above the footer, shows its text, dismisses; light + dark', async () => {
  const css = ensureWebCss(root)
  const bundle = (await build({
    stdin: { contents: ENTRY, resolveDir: __dirname, sourcefile: 'consultation-notice-entry.jsx', loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text

  fs.mkdirSync(OUT, { recursive: true })
  for (const f of PNGS) fs.rmSync(path.join(OUT, f), { force: true }) // a stale PNG must not pass
  const written: string[] = []
  const errors: string[] = []
  const browser = await chromium.launch() // never Electron
  try {
    for (const scheme of ['light', 'dark'] as const) {
      // Scene "shown"
      {
        const { ctx, page } = await open(browser, css, bundle, 'shown', scheme, errors)
        const strip = page.getByTestId('consultation-notice')
        await expect(strip).toBeVisible()
        await expect(strip).toHaveText(TEXT)
        await expect(page.getByTestId('consultation-notice-dismiss')).toBeVisible()
        // The strip's row (parent of the testid span) is the in-flow element above the footer.
        const row = strip.locator('xpath=..')
        await expect(row).toHaveText(`${TEXT}×`)
        expect(await row.evaluate((el) => getComputedStyle(el).position)).toBe('static')
        expect(await strip.evaluate((el) => getComputedStyle(el).position)).toBe('static')
        const footerRow = page.getByTestId('footer-version').locator('xpath=..')
        const rb = (await row.boundingBox())!
        const fb = (await footerRow.boundingBox())!
        expect(rb.y + rb.height, 'strip bottom vs footer top').toBeLessThanOrEqual(fb.y + 1)
        expect(Math.abs(rb.y + rb.height - fb.y), 'strip sits directly above the footer').toBeLessThanOrEqual(1)
        await shoot(page, `shown-${scheme}.png`, written)

        // Scene "dismissed"
        await page.getByTestId('consultation-notice-dismiss').click()
        await expect(page.getByTestId('consultation-notice')).toHaveCount(0)
        await expect(page.getByTestId('footer-version')).toBeVisible()
        await expect.poll(() => page.evaluate(() => (window as any).__writes as { data: { consultationNoticeDismissedVersion?: string } }[]))
          .toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ consultationNoticeDismissedVersion: '0.0.0' }) })]))
        await shoot(page, `dismissed-${scheme}.png`, written)
        await ctx.close()
      }
      // Stored dismissal: no strip at all.
      {
        const { ctx, page } = await open(browser, css, bundle, 'stored', scheme, errors)
        await expect.poll(() => page.evaluate(() => (window as any).__reads)).toBeGreaterThan(0)
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        await expect(page.getByTestId('consultation-notice')).toHaveCount(0)
        await expect(page.getByTestId('footer-version')).toBeVisible()
        await ctx.close()
      }
    }
  } finally {
    await browser.close()
  }
  expect(errors, 'page errors or unmodelled api calls').toEqual([])
  expect(written).toHaveLength(4)
  for (const f of written) {
    expect(fs.existsSync(f), f).toBe(true)
    expect(fs.statSync(f).size, f).toBeGreaterThan(1024)
  }
})

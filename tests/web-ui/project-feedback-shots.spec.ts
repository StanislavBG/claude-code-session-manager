import { test, expect, chromium, type Page } from '@playwright/test'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outDirFor, FEEDBACK_SHOTS } from './shotsOutDir.ts'
import { ensureWebCss } from './webCss.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real Chromium (never Electron). Mounts the real Project Home ▸ Feedback tab (ProjectHomeKeyButtons
// + ProjectFeedback, laid out as ProjectHome lays it out) with CSS from the built web renderer
// (dist-web/app.css) over a stub window.api.siteFeedback, and writes four scenes in light and dark:
//   not-linked     — the relay reports not_linked: the card asks to pair with bilko.run
//   widget-snippet — the owner fills the form and presses Create widget: snippet box + widget row
//   inbox-list     — one widget + 4 inbox items (bug / feature / other, mixed statuses)
//   report-detail  — the newest item opened: annotated screenshot, marks, page, console, network
// The app ships a single light palette, so "dark" = Chromium dark colour-scheme emulation plus an
// inverted render (as project-home-library-shots). Output folder (./shotsOutDir.ts, unit-tested by
// tests/unit/library-shots-out-dir.spec.ts), the same convention as every screenshot spec:
//   default              test-results/project-feedback/ (gitignored), so a normal run never dirties the tree
//   SM_UPDATE_SHOTS=1    throws: this spec has no tracked evidence folder (none is committed)
//   SM_SHOTS_OUT=<path>  that folder instead (wins over SM_UPDATE_SHOTS)
const root = path.resolve(__dirname, '../..')
const OUT = outDirFor(root, FEEDBACK_SHOTS)
const VIEWPORT = { width: 1280, height: 900 }
// The opened report is long (screenshot, marks, page, console, network): give it a taller frame.
const DETAIL_VIEWPORT = { width: 1280, height: 1600 }
const SCENES = ['not-linked', 'widget-snippet', 'inbox-list', 'report-detail'] as const
type Scene = (typeof SCENES)[number]

// The bundle entry, inline so the spec stays one file. `?scene=` picks the stub's data.
const ENTRY = String.raw`
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectFeedback } from '../../src/renderer/components/tabs/projecthome/ProjectFeedback'
import { selectSiteFeedback, useSiteFeedback } from '../../src/renderer/state/siteFeedback'
import { ProjectHomeKeyButtons, libraryKeyStats } from '../../src/renderer/components/tabs/projecthome/projectpages/ProjectHomeKeyButtons'

const CWD = '/home/user/Projects/three-winds'
const scene = new URLSearchParams(location.search).get('scene') || 'inbox-list'
const now = Date.now()
const iso = (agoMin) => new Date(now - agoMin * 60_000).toISOString()
const SNIPPET = '<script src="https://bilko.run/fw/v1.js" data-box="bx_7Hq2mR9wLk" data-fp="sha256:4f1c9a0e7b2d" async></script>'

const widget = {
  boxId: 'bx_7Hq2mR9wLk', projectCwd: CWD, fingerprint: 'sha256:4f1c9a0e7b2d', createdAt: iso(60 * 26),
  snippet: SNIPPET, label: 'three-winds', allowedOrigins: ['https://threewinds.example', 'http://localhost:5173'],
  state: 'open', pending: 2, hint: null,
}
const meta = (hostId, agoMin, status, origin, epicId = null) => ({
  hostId, boxId: widget.boxId, receivedAt: iso(agoMin), origin, status, statusNote: null, epicId, statusChangedAt: iso(agoMin),
})
const items = [
  { ...meta('FB-7K2QD', 14, 'open', 'https://threewinds.example'), title: 'Checkout button overlaps the cart total on mobile', type: 'bug',
    reporter: { id: 'u_381', name: 'Dana Ortiz', email: null } },
  { ...meta('FB-3M9XA', 95, 'in_progress', 'https://threewinds.example', 'ep_51c2'), title: 'Let me save a route for later', type: 'feature', reporter: null },
  { ...meta('FB-1P4ZT', 60 * 7, 'open', 'http://localhost:5173'), title: 'Map tiles flicker when zooming out quickly', type: 'bug', reporter: null },
  { ...meta('FB-0C8RB', 60 * 30, 'resolved', 'https://threewinds.example'), title: 'Typo in the About page footer', type: 'other',
    reporter: { id: 'u_112', name: null, email: 'sam@example.com' } },
]

const detail = {
  meta: meta('FB-7K2QD', 14, 'open', 'https://threewinds.example'),
  imagePaths: { screenshot: '/fx/FB-7K2QD/screenshot.png', annotated: '/fx/FB-7K2QD/annotated.png' },
  report: {
    schemaVersion: 1, clientReportId: 'c_9a8b7c', project: 'three-winds', type: 'bug',
    title: items[0].title,
    details: 'On an iPhone-sized window the orange Checkout button sits on top of the cart total, so I cannot read what I am paying.\nScrolling does not move it.',
    createdAt: iso(15),
    page: { url: 'https://threewinds.example/cart?step=review', title: 'Your cart · Three Winds',
      viewport: { width: 390, height: 844, devicePixelRatio: 3, scrollX: 0, scrollY: 412 } },
    screenshot: { part: 'screenshot', annotatedPart: 'annotated', width: 390, height: 844, scale: 1 },
    marks: [
      { kind: 'element', n: 1, x: 24, y: 610, w: 342, h: 56, color: '#a83818', note: 'This button covers the total',
        element: { selector: 'button.checkout-cta', tag: 'button', text: 'Checkout' } },
      { kind: 'pin', n: 2, x: 300, y: 640, color: '#f4b942', note: 'The total should be here' },
      { kind: 'text', x: 40, y: 200, text: 'Fine on desktop', color: '#1a1612' },
    ],
    console: [
      { level: 'error', message: "TypeError: Cannot read properties of undefined (reading 'total')", source: 'https://threewinds.example/assets/cart.js:118',
        stack: 'at renderTotal (cart.js:118)\nat Cart (cart.js:64)', timestamp: iso(15), count: 3 },
    ],
    network: [
      { method: 'GET', url: 'https://threewinds.example/api/cart/summary', status: 500, durationMs: 182, timestamp: iso(15) },
    ],
    user: { id: 'u_381', name: 'Dana Ortiz' },
    client: { widgetVersion: '1.0.0' },
  },
}

// A phone-sized page with the reported overlap and the two marks drawn in.
const shot = (annotated) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844" font-family="sans-serif">' +
  '<rect width="390" height="844" fill="#f7f3ea"/><rect width="390" height="64" fill="#2e5a3e"/>' +
  '<text x="20" y="40" fill="#fff" font-size="20" font-weight="700">Three Winds</text>' +
  '<text x="20" y="110" fill="#1a1612" font-size="22" font-weight="700">Your cart</text>' +
  [0, 1, 2].map((i) => '<rect x="20" y="' + (140 + i * 110) + '" width="350" height="90" rx="10" fill="#fff" stroke="#e3dccb"/>' +
    '<text x="40" y="' + (180 + i * 110) + '" fill="#1a1612" font-size="16">Trail map ' + (i + 1) + '</text>' +
    '<text x="300" y="' + (180 + i * 110) + '" fill="#1a1612" font-size="16">$' + (12 + i * 4) + '.00</text>').join('') +
  '<text x="230" y="645" fill="#1a1612" font-size="18" font-weight="700">Total $48.00</text>' +
  '<rect x="24" y="610" width="342" height="56" rx="12" fill="#e2702c"/><text x="160" y="645" fill="#fff" font-size="18" font-weight="700">Checkout</text>' +
  (annotated
    ? '<rect x="20" y="606" width="350" height="64" rx="14" fill="none" stroke="#a83818" stroke-width="4"/>' +
      '<circle cx="20" cy="606" r="13" fill="#a83818"/><text x="15" y="611" fill="#fff" font-size="14" font-weight="700">1</text>' +
      '<circle cx="300" cy="640" r="13" fill="#f4b942"/><text x="295" y="645" fill="#1a1612" font-size="14" font-weight="700">2</text>' +
      '<text x="40" y="128" fill="#1a1612" font-size="15" font-style="italic">Fine on desktop</text>'
    : '') +
  '</svg>')

let widgets = scene === 'not-linked' || scene === 'widget-snippet' ? [] : [widget]
const inbox = scene === 'not-linked' || scene === 'widget-snippet' ? [] : items
const ok = (x) => Promise.resolve({ ok: true, ...x })

const siteFeedback = {
  widgetList: () => ok(scene === 'not-linked'
    ? { widgets: [], relayError: { ok: false, error: 'not_linked', message: 'This desktop is not linked to a bilko.run account' } }
    : { widgets }),
  widgetCreate: ({ label, allowedOrigins }) => {
    widgets = [{ ...widget, label, allowedOrigins, pending: 0, createdAt: new Date().toISOString() }]
    return ok({ boxId: widget.boxId, fingerprint: widget.fingerprint, snippet: SNIPPET })
  },
  widgetUpdate: ({ boxId, state }) => ok({ widget: { boxId, state } }),
  widgetDelete: ({ boxId }) => ok({ boxId }),
  widgetSnippet: () => ok({ boxId: widget.boxId, fingerprint: widget.fingerprint, snippet: SNIPPET }),
  inboxList: ({ status }) => ok({ items: status ? inbox.filter((i) => i.status === status) : inbox }),
  inboxGet: ({ hostId }) => hostId === detail.meta.hostId ? ok({ item: detail }) : Promise.resolve({ ok: false, error: 'not_found', message: 'No such item' }),
  inboxImage: ({ which }) => ok({ dataUrl: shot(which !== 'screenshot') }),
  inboxSetStatus: ({ hostId, status }) => ok({ meta: { ...detail.meta, hostId, status } }),
  inboxLinkEpic: ({ hostId, epicId }) => ok({ meta: { ...detail.meta, hostId, epicId } }),
  inboxRemove: ({ hostId }) => ok({ hostId }),
  drainNow: () => ok({ stored: 0, duplicates: 0, rejected: 0, goneBoxes: [], heldBoxes: [] }),
}

// Anything the tab reaches for that the fixture doesn't model resolves harmlessly — and is
// logged, so a new dependency shows up in the spec's console capture instead of crashing the mount.
function fallback(target, p) {
  return new Proxy(target, {
    get(t, k) {
      if (typeof k === 'symbol' || k in t) {
        const v = t[k]
        return v && typeof v === 'object' ? fallback(v, p + '.' + String(k)) : v
      }
      console.warn('[stub-api] unmodelled window.api' + p + '.' + String(k))
      return fallback(async () => undefined, p + '.' + String(k))
    },
  })
}
window.api = fallback({ siteFeedback }, '')

const empty = libraryKeyStats([], undefined)
function Shell() {
  const [tab, setTab] = useState('feedback')
  const feedbackItems = useSiteFeedback(selectSiteFeedback(CWD)).items
  const openCount = feedbackItems.filter((it) => it.status === 'open').length
  return (
    <div style={{ height: '100vh' }} className="flex min-h-0 flex-col gap-[18px] overflow-hidden px-[28px] pt-[22px] pb-[20px] text-fg">
      <ProjectHomeKeyButtons tab={tab} onTabChange={setTab} pages={empty} videos={empty} findingsCount={null} feedbackOpenCount={openCount} />
      <ProjectFeedback cwd={CWD} />
    </div>
  )
}
createRoot(document.getElementById('root')).render(<Shell />)
`

/** Drive the page into `scene` and assert the structure the PNG must show. */
async function setUp(page: Page, scene: Scene) {
  const card = page.getByTestId('feedback-widget-card')
  await expect(page.locator('[data-testid="project-home-section"][data-tab="feedback"]')).toBeVisible()
  if (scene === 'not-linked') {
    await expect(card).toHaveAttribute('data-state', 'not-linked')
    await expect(page.getByTestId('feedback-widget-open-pairing')).toBeVisible()
    await expect(page.getByTestId('project-feedback-inbox-meta')).toHaveText('No feedback yet')
    return
  }
  await expect(card).toHaveAttribute('data-state', 'linked')
  if (scene === 'widget-snippet') {
    await expect(page.getByTestId('project-feedback-widgets-meta')).toHaveText('No widget for this project yet')
    await page.getByTestId('feedback-widget-sites-input').fill('https://threewinds.example\nhttp://localhost:5173')
    await page.getByTestId('feedback-widget-create-submit').click()
    await expect(page.getByTestId('feedback-widget-snippet')).toContainText('data-box="bx_7Hq2mR9wLk"')
    await expect(page.getByTestId('feedback-widget-row')).toHaveCount(1)
    await expect(page.getByTestId('feedback-widget-label')).toHaveText('three-winds')
    await expect(page.getByTestId('feedback-widget-sites')).toHaveText('https://threewinds.example, http://localhost:5173')
    return
  }
  await expect(page.getByTestId('feedback-widget-row')).toHaveCount(1)
  await expect(page.getByTestId('site-feedback-row')).toHaveCount(4)
  await expect(page.getByTestId('project-feedback-inbox-meta')).toHaveText('4 items · 2 open')
  await expect(page.getByTestId('site-feedback-row-title').first()).toHaveText('Checkout button overlaps the cart total on mobile')
  if (scene === 'inbox-list') {
    await expect(page.getByTestId('site-feedback-detail')).toHaveCount(0)
    return
  }
  await page.locator('[data-testid="site-feedback-row"][data-host-id="FB-7K2QD"]').click()
  const d = page.getByTestId('site-feedback-detail')
  await expect(d).toBeVisible()
  await expect(page.getByTestId('site-feedback-detail-title')).toHaveText('Checkout button overlaps the cart total on mobile')
  await expect(page.getByTestId('site-feedback-screenshot-img')).toHaveAttribute('data-which', 'annotated')
  await expect(page.getByTestId('site-feedback-mark')).toHaveCount(3)
  await expect(page.getByTestId('site-feedback-page-url')).toHaveText('https://threewinds.example/cart?step=review')
  // Open both collapsibles so the shot shows the captured console + network entries.
  await page.locator('[data-testid="site-feedback-console"] summary').click()
  await page.locator('[data-testid="site-feedback-network"] summary').click()
  await expect(page.getByTestId('site-feedback-console-entry')).toHaveCount(1)
  await expect(page.getByTestId('site-feedback-network-entry')).toHaveCount(1)
  await page.getByTestId('site-feedback-screenshot-img').evaluate((img: HTMLImageElement) => img.decode())
  // The section scrolls inside the shell: start the shot at the Inbox heading so the selected row
  // and the detail below it are both in frame.
  await page.getByTestId('project-feedback-inbox').evaluate((el) => {
    const scroller = el.closest('[data-testid="project-home-section"]') as HTMLElement
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  })
}

test('Project Home ▸ Feedback screenshots: 4 scenes, light + dark', async () => {
  const css = ensureWebCss(root)
  const bundle = (await build({
    stdin: { contents: ENTRY, resolveDir: __dirname, sourcefile: 'project-feedback-entry.jsx', loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0"' },
  })).outputFiles[0].text

  fs.mkdirSync(OUT, { recursive: true })
  const written: string[] = []
  const browser = await chromium.launch() // never Electron
  try {
    for (const scheme of ['light', 'dark'] as const) {
      for (const scene of SCENES) {
        const ctx = await browser.newContext({ viewport: scene === 'report-detail' ? DETAIL_VIEWPORT : VIEWPORT, colorScheme: scheme })
        const page = await ctx.newPage()
        const errors: string[] = []
        page.on('pageerror', (e) => errors.push(String(e)))
        page.on('console', (m) => { if (m.type() === 'warning' && m.text().startsWith('[stub-api]')) errors.push(m.text()) })
        await page.route('http://fx.test/**', (r) =>
          r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body class="bg-bg"><div id="root"></div></body></html>` }),
        )
        await page.goto(`http://fx.test/?scene=${scene}`)
        await page.addScriptTag({ content: bundle })
        if (scheme === 'dark') await page.addStyleTag({ content: 'html{filter:invert(1) hue-rotate(180deg)}' })
        await setUp(page, scene)
        await page.waitForTimeout(250)
        const file = path.join(OUT, `feedback-${scene}-${scheme}.png`)
        await page.screenshot({ path: file })
        written.push(file)
        expect(errors, `${scene}/${scheme}: page errors or unmodelled api calls`).toEqual([])
        await ctx.close()
      }
    }
  } finally {
    await browser.close()
  }
  expect(written).toHaveLength(8)
  for (const f of written) expect(fs.statSync(f).size, f).toBeGreaterThan(10_000)
  console.log(`[project-feedback-shots] wrote ${written.length} PNGs to ${OUT}`)
})

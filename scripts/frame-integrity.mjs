#!/usr/bin/env node
// Frame-integrity check: boots the REAL renderer in plain Playwright Chromium against a Vite dev
// server with a fixture window.api. NO Electron — a second Electron instance kills live scheduler
// jobs. Browses Settings (General, Permissions, Hooks, Raw) and the doc editor (preview, split) the
// way a user does, and fails if any element other than a page-shell / known scroller scrolled, or
// the sidebar / page header moved. Also reports nested scrollers inside the visible dockview panel.
//
// Usage: node scripts/frame-integrity.mjs   (npm run check:frame)
// Exit 0 = every scenario PASS; exit 1 = at least one FAIL line names the offending element.
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = path.join(root, 'src/renderer')
const HTML_URL = '/__frame-integrity.html'
const STUB_URL = '/__frame-integrity-stub.js'
const STUB_ID = '\0frame-integrity-stub.js'
const HOME = '/home/u'
const DOC = `${HOME}/proj/doc.md`
const VIEWPORTS = [[1400, 900], [900, 650]]
const WAIT = 20_000

// ---------------------------------------------------------------- virtual fixture (Vite plugin)
const fixtureHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>frame integrity</title></head>
  <body class="bg-bg text-fg font-sans antialiased">
    <div id="root"></div>
    <script type="module" src="${STUB_URL}"></script>
  </body>
</html>`

const abs = (p) => JSON.stringify(path.join(root, p))
// Builds window.api from the preload surface table; fixture answers for the channels the boot path
// and the browsed pages read, [] for every other invoke. Exposes the layout/editor stores.
const stubCode = `
import rows from ${abs('src/preload/apiSurface.json')}
const HOME = ${JSON.stringify(HOME)}
const settingsJson = { permissions: { allow: ['Bash(ls:*)'] }, model: 'opus', hooks: {}, enabledPlugins: { a: true }, env: { FOO: '1' } }
const md = Array.from({ length: 30 }, (_, i) => '## Section ' + (i + 1) + '\\n\\n' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(8) + '\\n').join('\\n')
const invoke = {
  'app:home-dir': () => HOME,
  'app:cwd': () => HOME + '/proj',
  'app:version': () => '0.0.0-frame',
  'app:is-e2e': () => false,
  'sessions:load': () => ({ tabs: [], activeTabId: null }),
  'layout:load': () => null,
  'config:read-json': (p) =>
    p === HOME + '/.claude/settings.json'
      ? { exists: true, raw: JSON.stringify(settingsJson, null, 2), data: settingsJson, parseError: null, mtimeMs: Date.now(), error: null }
      : { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null },
  'config:read-text': () => ({ exists: false, text: '', mtimeMs: 0, error: null, truncated: false }),
  'config:exists': () => false,
  'schedule:session-slots': () => ({ total: 4, inUse: 0, holders: [], min: 1, max: 8, default: 4, envOverride: false }),
  'models:catalog': () => ({ effortLevels: ['low', 'medium', 'high'], models: [], aliases: [] }),
  'files:read': () => ({ ok: true, text: md, error: null, size: md.length }),
}
const api = {}
for (const r of rows) {
  const ns = (api[r.ns] ??= {})
  if (r.kind === 'invoke') ns[r.method] = (...args) => { const h = invoke[r.channel]; return Promise.resolve(h ? h(...args) : []) }
  else if (r.kind === 'send') ns[r.method] = () => {}
  else ns[r.method] = () => () => {}
}
window.api = api
const [layout, editor] = await Promise.all([import(${abs('src/renderer/state/layout.ts')}), import(${abs('src/renderer/state/editor.ts')})])
window.__layout = layout.useLayout
window.__editor = editor.useEditor
await import(${abs('src/renderer/main.tsx')})
`

const fixturePlugin = {
  name: 'frame-integrity-fixture',
  resolveId(id) { return id === STUB_URL ? STUB_ID : null },
  load(id) { return id === STUB_ID ? stubCode : null },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== HTML_URL) return next()
      try {
        const html = await server.transformIndexHtml(HTML_URL, fixtureHtml)
        res.setHeader('Content-Type', 'text/html')
        res.end(html)
      } catch (e) { next(e) }
    })
  },
}

// ---------------------------------------------------------------- in-page probes
// Allowlist: the page shell's two scrollers, the MarkdownPreview scroller, the DocOutline root,
// and anything inside Monaco.
function installProbes() {
  const ALLOW = [
    '[data-testid="page-shell-content"]',
    '[data-testid="page-shell-subnav"]',
    'div.h-full.overflow-auto.overscroll-contain.bg-bg', // MarkdownPreview scroller
    'div.w-56.shrink-0.overflow-auto', // DocOutline root
  ]
  const isMonaco = (el) => !!el.closest?.('.monaco-editor, .monaco-diff-editor')
  const allowed = (el) => isMonaco(el) || ALLOW.some((s) => el.matches(s))
  const desc = (el) => {
    if (el === document.documentElement) return 'html'
    if (el === document.body) return 'body'
    const t = el.getAttribute('data-testid')
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean).slice(0, 6).join('.')
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${t ? `[data-testid=${t}]` : ''}${cls ? '.' + cls : ''}`
  }
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round) }
  const overlay = () => [...document.querySelectorAll('.dv-render-overlay')].find((e) => getComputedStyle(e).visibility === 'visible') ?? null
  window.__fi = {
    // Every non-allowlisted element that is scrolled.
    strayScroll() {
      const out = []
      for (const el of [document.documentElement, document.body, ...document.querySelectorAll('body *')]) {
        if ((el.scrollTop || el.scrollLeft) && !allowed(el)) out.push(`${desc(el)} scrollTop=${Math.round(el.scrollTop)} scrollLeft=${Math.round(el.scrollLeft)}`)
      }
      return out
    },
    frame(headerSel) {
      const hdr = headerSel === 'doc-header'
        ? [...document.querySelectorAll('span')].find((e) => e.textContent === 'doc.md')
        : [...document.querySelectorAll(headerSel)].find((e) => e.getClientRects().length && overlay()?.contains(e))
      return { sidebar: box(document.querySelector('[data-testid="tour-leftnav"]')), header: box(hdr) }
    },
    // Allowlisted, visible scrollers that have range — the ones a user wheels.
    scrollers() {
      const out = []
      document.querySelectorAll('[data-fi-scroller]').forEach((e) => e.removeAttribute('data-fi-scroller'))
      let i = 0
      for (const el of document.querySelectorAll(ALLOW.join(','))) {
        if (isMonaco(el) || !el.getClientRects().length) continue
        if (el.scrollHeight - el.clientHeight > 1 || el.scrollWidth - el.clientWidth > 1) {
          el.setAttribute('data-fi-scroller', String(i))
          out.push({ idx: i++, d: desc(el) })
        }
      }
      // No shell scroller with range (e.g. a page not on PageShell): wheel the panel itself.
      const ov = overlay()
      if (!out.length && ov) { ov.setAttribute('data-fi-scroller', String(i)); out.push({ idx: i, d: 'the visible .dv-render-overlay' }) }
      return out
    },
    // Nested scrollers (a scroller with range containing another with range) in the visible overlay.
    nested() {
      const ov = overlay()
      if (!ov) return ['(no visible .dv-render-overlay)']
      const sc = []
      for (const el of ov.querySelectorAll('*')) {
        if (isMonaco(el)) continue
        const cs = getComputedStyle(el)
        if (cs.textOverflow === 'ellipsis') continue
        const y = /(auto|scroll|hidden)/.test(cs.overflowY), x = /(auto|scroll|hidden)/.test(cs.overflowX)
        const ry = el.scrollHeight - el.clientHeight, rx = el.scrollWidth - el.clientWidth
        if ((y && ry > 1) || (x && rx > 1)) sc.push({ el, d: `${desc(el)} ov=${cs.overflowX}/${cs.overflowY} rangeY=${ry} rangeX=${rx}` })
      }
      const out = []
      for (const a of sc) for (const b of sc) if (a !== b && a.el.contains(b.el)) out.push(`OUTER ${a.d} > INNER ${b.d}`)
      return out
    },
  }
}

// ---------------------------------------------------------------- driver
const server = await createServer({
  configFile: path.join(root, 'vite.config.ts'),
  root: rendererRoot,
  plugins: [fixturePlugin],
  server: { port: 0, strictPort: false },
  logLevel: 'error',
})
await server.listen()
const port = server.httpServer.address().port
const browser = await chromium.launch()
const results = []
const nestedReport = []

const record = (name, problems) => {
  results.push({ name, ok: problems.length === 0 })
  if (problems.length === 0) console.log(`PASS ${name}`)
  else { console.log(`FAIL ${name}`); for (const p of problems) console.log(`     ${p}`) }
}

async function boot(w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  page.on('pageerror', (e) => console.error(`[page error ${w}x${h}]`, e.message.split('\n')[0]))
  await page.goto(`http://localhost:${port}${HTML_URL}`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="tour-leftnav"]').first().waitFor({ state: 'visible', timeout: 90_000 })
  await page.waitForTimeout(1200)
  const skip = page.getByText('Skip tour', { exact: true })
  if (await skip.count()) await skip.first().click().catch(() => {})
  const ok = page.getByRole('button', { name: 'OK', exact: true })
  if (await ok.count()) await ok.first().click().catch(() => {})
  await page.evaluate(installProbes)
  return page
}

// Measures after every user action; collects every stray scroll / frame move.
function checker(page, headerSel) {
  const problems = []
  let base = null
  const seen = new Set()
  const add = (p) => { if (!seen.has(p)) { seen.add(p); problems.push(p) } }
  return {
    problems,
    async baseline() {
      await page.waitForTimeout(500)
      base = await page.evaluate((s) => window.__fi.frame(s), headerSel)
      if (!base.sidebar) add('sidebar [data-testid=tour-leftnav] not found')
      if (!base.header) add(`page header ${headerSel} not found`)
      for (const s of await page.evaluate(() => window.__fi.strayScroll())) add(`at baseline: ${s}`)
    },
    async check(label) {
      await page.waitForTimeout(450)
      for (const s of await page.evaluate(() => window.__fi.strayScroll())) add(`after ${label}: scrolled ${s}`)
      const now = await page.evaluate((s) => window.__fi.frame(s), headerSel)
      for (const k of ['sidebar', 'header']) {
        if (base?.[k] && JSON.stringify(now[k]) !== JSON.stringify(base[k])) add(`after ${label}: ${k} moved ${JSON.stringify(base[k])} -> ${JSON.stringify(now[k])}`)
      }
    },
  }
}

// The LearningPanel popover opens by default on a fresh profile and can sit over the wheel point;
// wheeling it scrolls the popover, not the frame — close it so it can't stand in for a scroller.
async function closePopovers(page) {
  const open = page.locator('button[title="Close learning panel"][aria-expanded="true"]')
  for (let i = await open.count(); i > 0; i--) await open.first().dispatchEvent('click')
  await page.waitForTimeout(200)
}

async function wheelScrollers(page, c) {
  const list = await page.evaluate(() => window.__fi.scrollers())
  for (const s of list) {
    const loc = page.locator(`[data-fi-scroller="${s.idx}"]`)
    const b = await loc.boundingBox()
    if (!b) continue
    await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 120))
    for (let k = 0; k < 30; k++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(15) }
    await c.check(`wheel past end of ${s.d}`)
    for (let k = 0; k < 30; k++) { await page.mouse.wheel(0, -900); await page.waitForTimeout(15) }
    await c.check(`wheel past start of ${s.d}`)
  }
}

async function nestedFor(page, label) {
  for (const n of await page.evaluate(() => window.__fi.nested())) nestedReport.push(`${label}: ${n}`)
}

// The Settings page header is the PageShell header; a tree without PageShell falls back to the
// panel's first heading/toolbar row so a regression still gets measured, not just "not found".
const SETTINGS_HEADER = '[data-testid="page-shell-header"], .dv-render-overlay h1, .dv-render-overlay h2'

async function settingsScenarios(page, vp) {
  await page.locator('[data-testid="tour-leftnav"]').getByText('Settings', { exact: true }).first().click()
  await page.locator('[data-testid="page-shell"], nav button[title^="jump to"]').first().waitFor({ state: 'visible', timeout: WAIT })
  await page.waitForTimeout(800)
  for (const view of ['General', 'Permissions', 'Hooks', 'Raw']) {
    const name = `settings/${view} @${vp}`
    try {
      // View tabs live in the Panel toolbar above the PageShell.
      await page.getByRole('button', { name: view, exact: true }).locator('visible=true').first().dispatchEvent('click')
      await page.waitForTimeout(900)
      await closePopovers(page)
      const c = checker(page, SETTINGS_HEADER)
      await c.baseline()
      const rail = page.locator('[data-testid="page-shell-subnav"]:visible button, nav button[title^="jump to"]:visible')
      const n = await rail.count()
      for (let i = 0; i < n; i++) {
        const title = (await rail.nth(i).getAttribute('title')) ?? (await rail.nth(i).innerText()).trim()
        await rail.nth(i).dispatchEvent('click')
        await page.waitForTimeout(500)
        await c.check(`rail click ${i} (${title})`)
      }
      await wheelScrollers(page, c)
      await nestedFor(page, name)
      record(`${name} (${n} rail entries)`, c.problems)
    } catch (e) {
      record(name, [`driver error: ${e.message.split('\n')[0]}`])
    }
  }
}

async function editorScenarios(page, vp) {
  await page.evaluate(() => window.__layout.getState().openPanel('editor'))
  await page.waitForTimeout(1200)
  await page.evaluate((p) => window.__editor.getState().openFile(p), DOC)
  await page.locator('span', { hasText: /^doc\.md$/ }).first().waitFor({ state: 'visible', timeout: WAIT })
  await page.waitForTimeout(1500)
  for (const mode of ['preview', 'split']) {
    const name = `editor/${mode} @${vp}`
    try {
      await page.getByRole('button', { name: mode, exact: true }).first().dispatchEvent('click')
      await page.locator('nav button', { hasText: /^Section 30$/ }).first().waitFor({ state: 'attached', timeout: WAIT })
      await page.waitForTimeout(900)
      await closePopovers(page)
      const c = checker(page, 'doc-header')
      await c.baseline()
      for (const h of ['Section 28', 'Section 30', 'Section 2', 'Section 15', 'Section 1']) {
        await page.locator('nav button', { hasText: new RegExp(`^${h}$`) }).first().dispatchEvent('click')
        await page.waitForTimeout(500)
        await c.check(`outline click ${h}`)
      }
      await wheelScrollers(page, c)
      await nestedFor(page, name)
      record(name, c.problems)
    } catch (e) {
      record(name, [`driver error: ${e.message.split('\n')[0]}`])
    }
  }
}

try {
  for (const [w, h] of VIEWPORTS) {
    const vp = `${w}x${h}`
    const page = await boot(w, h)
    await settingsScenarios(page, vp)
    await editorScenarios(page, vp)
    await page.close()
  }
} catch (e) {
  results.push({ name: 'driver', ok: false })
  console.log(`FAIL driver: ${e.message.split('\n')[0]}`)
} finally {
  await browser.close()
  await server.close()
}

if (nestedReport.length) {
  console.log(`\nNested scrollers inside the visible .dv-render-overlay (${nestedReport.length}, report only):`)
  for (const n of nestedReport) console.log(`  NESTED ${n}`)
} else console.log('\nNested scrollers inside the visible .dv-render-overlay: none')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`)
process.exit(failed.length || results.length === 0 ? 1 : 0)

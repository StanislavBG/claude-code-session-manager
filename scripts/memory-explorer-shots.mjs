#!/usr/bin/env node
// Dev-only: screenshot the Memory Explorer preview (src/renderer/preview/) in plain Chromium
// against a Vite dev server — no Electron. Writes 13 PNGs + compare.html vs the Claude Design renders.
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'memory-explorer-shots'))
const refDir = path.join(root, 'session-manager-operations/design-mocks/memory-explorer/renders')
const WAIT = 10_000
mkdirSync(outDir, { recursive: true })

const server = await createServer({
  configFile: path.join(root, 'vite.config.ts'),
  root: path.join(root, 'src/renderer'),
  server: { port: 0, strictPort: false },
  logLevel: 'warn',
})
await server.listen()
const port = server.httpServer.address().port
const browser = await chromium.launch()
const failures = []
const shots = []

try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 } })
  page.on('pageerror', (e) => console.error('[page error]', e.message))
  await page.goto(`http://localhost:${port}/preview/memory-explorer.html`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]))

  const t = (id) => page.getByTestId(id)
  const click = (id) => t(id).click({ timeout: WAIT })
  const see = (loc) => loc.first().waitFor({ state: 'visible', timeout: WAIT })

  // Each state: run the actions that reach it, wait for its target element, then screenshot.
  const state = async (name, reach, target) => {
    try {
      await reach()
      await see(target())
      await page.waitForTimeout(350)
    } catch (e) {
      failures.push(`${name}: ${e.message.split('\n')[0]}`)
      console.error(`FAIL ${name}`)
    }
    const file = `${name}.png`
    await page.screenshot({ path: path.join(outDir, file) })
    shots.push(file)
    console.log(`shot ${file}`)
  }
  const step = async (fn) => { try { await fn() } catch (e) { failures.push(`step: ${e.message.split('\n')[0]}`) } }

  const BILKO = 'mx-list-row-bilko_run_marketing_repo.md'
  await state('01-browse-all-stale-selected',
    async () => { await see(t(BILKO)); await click(BILKO) },
    () => t('mx-reader-stale'))
  await state('02-fix-proposed',
    () => click('mx-reader-fix'), () => t('mx-reader-apply'))
  await step(() => click('mx-reader-discard'))
  await state('03-source',
    () => click('mx-reader-mode-source'), () => page.locator('pre, textarea').filter({ hasText: 'node_type' }))
  await step(() => click('mx-reader-mode-read'))
  await state('04-more-menu',
    () => click('mx-reader-more'), () => page.getByText('Delete…', { exact: true }))
  await state('05-delete-dialog',
    () => page.getByText('Delete…', { exact: true }).click({ timeout: WAIT }), () => page.getByText('Delete this memory?'))
  await step(() => t('mx-delete-dialog').getByText('Cancel', { exact: true }).click({ timeout: WAIT }))
  await state('06-new-memory',
    () => click('mx-list-new'), () => t('mx-editor'))
  await step(() => click('mx-editor-cancel'))
  await state('07-ask-idle',
    () => click('mx-nav-ask'), () => t('mx-ask'))
  await state('08-ask-answered',
    async () => { await t('mx-ask-input').fill('why idle'); await click('mx-ask-send') },
    () => t('mx-ask-cite-meter_429_idles_scheduler'))
  await state('09-clusters',
    () => click('mx-nav-clusters'), () => t('mx-cluster-sched'))
  await state('10-stale-queue',
    () => click('mx-nav-stale'), () => t('mx-list'))
  await state('11-palette',
    () => click('mx-search-trigger'), () => t('mx-palette-input'))
  await step(() => page.keyboard.press('Escape'))
  await state('12-learn',
    () => click('mx-learn'), () => t('mx-learn-popover'))
  await step(() => click('mx-learn-close'))
  await state('13-empty-subagent',
    () => click('mx-nav-agent:docs-writer'), () => t('mx-scope-card').getByText('SUBAGENT'))
} finally {
  await browser.close()
  await server.close()
}

const cell = (title, src) =>
  `<div><h3>${title}</h3><img src="${src}" width="660"></div>`
writeFileSync(path.join(outDir, 'compare.html'),
  `<!doctype html><meta charset="utf-8"><title>Memory Explorer: reference vs preview</title>
<style>body{font:13px sans-serif;background:#222;color:#eee;margin:16px}section{margin:0 0 28px}
.row{display:flex;gap:12px}h2{margin:0 0 6px}h3{margin:0 0 4px;font-weight:400;color:#aaa}img{display:block;border:1px solid #555}</style>
${shots.map((f) => `<section><h2>${f}</h2><div class="row">${cell('reference', pathToFileURL(path.join(refDir, f)).href)}${cell('preview', f)}</div></section>`).join('\n')}`)

console.log(`output: ${outDir}`)
if (failures.length) {
  console.error(`FAILED states:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`ok: ${shots.length} states, ${path.join(outDir, 'compare.html')}`)

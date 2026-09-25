#!/usr/bin/env node
// dev/sheet.mjs — render a dev page (dev/<name>.js defining window.SHEET) to a PNG.
//
//   node dev/sheet.mjs cast                → out/preview/dev-cast.png (contact sheet of SHEET.times)
//   node dev/sheet.mjs cast --full         → one full 1920x1080 PNG per time
//   node dev/sheet.mjs cast --cols 3 --width 640
// Prints page errors and per-frame draw time (ms) so slow art is caught early.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '../serve.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const name = args[0]
if (!name) { console.error('usage: node dev/sheet.mjs <name> [--full] [--cols N] [--width PX]'); process.exit(2) }
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const outDir = join(ROOT, 'out/preview')
mkdirSync(outDir, { recursive: true })
const { port, close } = await serve(0)
const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-accelerated-2d-canvas'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
const errors = []
page.on('pageerror', (e) => errors.push('[page error] ' + e.message))
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push('[console ' + m.type() + '] ' + m.text()))
await page.goto(`http://127.0.0.1:${port}/dev/sheet.html?page=${encodeURIComponent(name)}`)
await page.waitForFunction(() => document.documentElement.dataset.ready, null, { timeout: 30000 })
const ok = await page.evaluate(() => document.documentElement.dataset.ready)
if (ok !== '1') { console.error(errors.join('\n') || 'dev page failed to load (no window.SHEET?)'); await browser.close(); close(); process.exit(1) }
const times = await page.evaluate(() => window.SHEET.times || [0])
if (args.includes('--full')) {
  const canvas = await page.$('#stage')
  for (const t of times) {
    const ms = await page.evaluate((t) => { const c = document.getElementById('stage').getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, 1920, 1080); const a = performance.now(); SHEET.draw(c, t); return performance.now() - a }, t)
    const p = join(outDir, `dev-${name}-${t.toFixed(2)}.png`)
    writeFileSync(p, await canvas.screenshot({ type: 'png' }))
    console.log(`${p}  draw ${ms.toFixed(0)} ms`)
  }
} else {
  const cols = Number(opt('cols', times.length <= 4 ? 2 : 3))
  const width = Number(opt('width', times.length <= 4 ? 900 : 620))
  const res = await page.evaluate(([ts, cols, width]) => {
    const W = 1920, H = 1080, h = Math.round((width * H) / W), pad = 8
    const rows = Math.ceil(ts.length / cols)
    const sheet = document.createElement('canvas')
    sheet.width = cols * (width + pad) + pad
    sheet.height = rows * (h + pad + 26) + pad
    const sg = sheet.getContext('2d')
    sg.fillStyle = '#222'; sg.fillRect(0, 0, sheet.width, sheet.height)
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H
    const tg = tmp.getContext('2d')
    const ms = []
    ts.forEach((t, i) => {
      tg.setTransform(1, 0, 0, 1, 0, 0); tg.clearRect(0, 0, W, H)
      const a = performance.now(); SHEET.draw(tg, t); ms.push(performance.now() - a)
      const x = pad + (i % cols) * (width + pad), y = pad + Math.floor(i / cols) * (h + pad + 26)
      sg.drawImage(tmp, x, y + 26, width, h)
      sg.fillStyle = '#fff'; sg.font = '18px monospace'; sg.fillText('t=' + t.toFixed(2) + '  ' + ms[i].toFixed(0) + 'ms', x + 4, y + 19)
    })
    return { url: sheet.toDataURL('image/png'), ms }
  }, [times, cols, width])
  const p = join(outDir, `dev-${name}.png`)
  writeFileSync(p, Buffer.from(res.url.split(',')[1], 'base64'))
  console.log(`${p}  (${times.length} frames, draw ms max ${Math.max(...res.ms).toFixed(0)}, mean ${(res.ms.reduce((a, b) => a + b, 0) / res.ms.length).toFixed(0)})`)
}
if (errors.length) console.error(errors.join('\n'))
await browser.close()
close()

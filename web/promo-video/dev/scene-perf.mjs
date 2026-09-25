#!/usr/bin/env node
// dev/scene-perf.mjs — real raster cost of one scene's frames (or the whole film).
//
//   node dev/scene-perf.mjs s3-agents            every 15-fps frame of the scene (incl. transition frames)
//   node dev/scene-perf.mjs s3-agents --step 3   every 3rd frame
//   node dev/scene-perf.mjs --all --step 5
// Forces a raster flush after each drawFrame (getImageData 1x1) so deferred painting is counted.
// Prints mean / p90 / max ms and the 5 slowest frames. Budget: mean ≤ 250 ms, max ≤ 600 ms.
import { chromium } from 'playwright'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '../serve.mjs'
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const id = args[0] && !args[0].startsWith('--') ? args[0] : null
const step = Number(opt('step', 1))
const { port, close } = await serve(0)
const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-accelerated-2d-canvas'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
const errors = []
page.on('pageerror', (e) => errors.push('[page error] ' + e.message))
page.on('console', (m) => (m.type() === 'error') && errors.push('[console] ' + m.text()))
await page.goto(`http://127.0.0.1:${port}/index.html?render=1&cc=1`)
await page.waitForFunction(() => document.documentElement.dataset.ready)
const res = await page.evaluate(([id, step]) => {
  const tl = PROMO.timeline, fps = PROMO.fps
  let a = 0, b = tl.duration
  if (id) { const sc = tl.scenes.find((s) => s.id === id); if (!sc) return { err: 'no scene ' + id }; a = Math.max(0, sc.start - 0.4); b = Math.min(tl.duration, sc.end + 0.4) }
  const ctx = document.getElementById('stage').getContext('2d')
  PROMO.drawFrame(a); ctx.getImageData(0, 0, 1, 1) // warm caches
  const out = []
  for (let f = Math.ceil(a * fps); f < b * fps; f += step) {
    const t = f / fps, s = performance.now()
    PROMO.drawFrame(t); ctx.getImageData(0, 0, 1, 1)
    out.push([t, performance.now() - s])
  }
  return { out }
}, [id, step])
if (res.err) { console.error(res.err); process.exit(1) }
const ms = res.out.map((x) => x[1]).sort((x, y) => x - y)
const mean = ms.reduce((p, c) => p + c, 0) / ms.length
console.log(`${id || 'film'}: ${ms.length} frames  mean ${mean.toFixed(0)} ms  p90 ${ms[Math.floor(ms.length * 0.9)].toFixed(0)} ms  max ${ms[ms.length - 1].toFixed(0)} ms`)
console.log('slowest:', res.out.sort((x, y) => y[1] - x[1]).slice(0, 5).map(([t, m]) => `t=${t.toFixed(2)} ${m.toFixed(0)}ms`).join('  '))
if (errors.length) console.error(errors.slice(0, 10).join('\n'))
await browser.close(); close()

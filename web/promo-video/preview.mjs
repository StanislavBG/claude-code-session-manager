#!/usr/bin/env node
// preview.mjs — look at frames without rendering the whole video.
//
//   node preview.mjs --scene s3-agents --n 8          contact sheet of 8 frames across one scene
//   node preview.mjs --times 1,2.5,4.2                contact sheet of chosen global times
//   node preview.mjs --times 12.4 --full              full-size 1920x1080 PNG per time
//   node preview.mjs --all --n 24                     sheet across the whole film
//   node preview.mjs --timeline                       print scenes, VO lines, sfx cues
//   node preview.mjs --audio-stats                    render the mix; print loudness per second
//   add --cc 0 to hide captions. Output → out/preview/. Page errors are printed.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './serve.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf('--' + k)
  return i >= 0 ? args[i + 1] : d
}
const flag = (k) => args.includes('--' + k)
const outDir = join(ROOT, 'out/preview')
mkdirSync(outDir, { recursive: true })

const { port, close } = await serve(0)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
const errors = []
page.on('pageerror', (e) => errors.push('[page error] ' + e.message))
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push('[console ' + m.type() + '] ' + m.text()))
await page.goto(`http://127.0.0.1:${port}/index.html?render=1&cc=${opt('cc', '1')}`)
await page.waitForFunction(() => document.documentElement.dataset.ready)

const tl = await page.evaluate(() => PROMO.timeline)
let times = []
let label = 'sheet'
if (opt('times')) {
  times = opt('times').split(',').map(Number)
  label = 't' + times.map((t) => t.toFixed(1)).join('_')
} else if (opt('scene')) {
  const sc = tl.scenes.find((s) => s.id === opt('scene'))
  if (!sc) throw new Error('no scene ' + opt('scene') + ' — have: ' + tl.scenes.map((s) => s.id).join(', '))
  const n = Number(opt('n', 8))
  for (let i = 0; i < n; i++) times.push(sc.start + ((sc.end - sc.start) * (i + 0.5)) / n)
  label = sc.id
} else if (flag('all')) {
  const n = Number(opt('n', 24))
  for (let i = 0; i < n; i++) times.push((tl.duration * (i + 0.5)) / n)
  label = 'all'
}

if (flag('timeline')) {
  const sfx = await page.evaluate(() => PROMO.allSfx())
  for (const s of tl.scenes) {
    console.log(`${s.id.padEnd(22)} ${s.start.toFixed(2).padStart(6)} → ${s.end.toFixed(2).padStart(6)}  (${(s.end - s.start).toFixed(2)}s) mood=${s.mood || 'full'}`)
    for (const v of s.vo || []) console.log(`    VO ${v.start.toFixed(2)}+${v.duration.toFixed(2)}  "${v.text}"`)
    for (const e of sfx.filter((e) => e.t >= s.start && e.t < s.end)) console.log(`    sfx ${e.t.toFixed(2)} ${e.type}`)
  }
  console.log(`duration ${tl.duration.toFixed(2)}s  bpm ${tl.bpm.toFixed(1)}  logoTime ${tl.logoTime.toFixed(2)}`)
}

if (times.length) {
  if (flag('full')) {
    const canvas = await page.$('#stage')
    for (const t of times) {
      await page.evaluate((t) => PROMO.drawFrame(t), t)
      const p = join(outDir, `frame-${t.toFixed(2)}.png`)
      writeFileSync(p, await canvas.screenshot({ type: 'png' }))
      console.log(p)
    }
  } else {
    const cols = Number(opt('cols', times.length <= 4 ? 2 : 4))
    const width = Number(opt('width', times.length <= 4 ? 900 : 560))
    const url = await page.evaluate(([ts, c, w]) => PROMO.contactSheet(ts, c, w), [times, cols, width])
    const p = join(outDir, `${label}.png`)
    writeFileSync(p, Buffer.from(url.split(',')[1], 'base64'))
    console.log(p)
  }
}

if (flag('audio-stats')) {
  const stats = await page.evaluate(async () => {
    const b64 = await PROMO.renderAudioWav()
    const bin = atob(b64)
    const n = (bin.length - 44) / 4
    const view = new DataView(new ArrayBuffer(bin.length))
    for (let i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i))
    const out = []
    for (let s = 0; s < Math.ceil(n / 48000); s++) {
      let sum = 0
      let peak = 0
      const a = s * 48000
      const b = Math.min(n, a + 48000)
      for (let i = a; i < b; i++) {
        const v = view.getInt16(44 + i * 4, true) / 32768
        sum += v * v
        peak = Math.max(peak, Math.abs(v))
      }
      out.push({ s, rmsDb: 10 * Math.log10(sum / (b - a) + 1e-12), peak })
    }
    return out
  })
  for (const s of stats) console.log(`${String(s.s).padStart(3)}s  rms ${s.rmsDb.toFixed(1)} dB  peak ${s.peak.toFixed(2)}  ${'#'.repeat(Math.max(0, Math.round((s.rmsDb + 40) / 1.2)))}`)
}

for (const e of errors) console.error(e)
await browser.close()
close()
if (errors.some((e) => e.includes('page error'))) process.exit(1)

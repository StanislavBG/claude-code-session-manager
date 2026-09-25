#!/usr/bin/env node
// render.mjs — deterministic frame-by-frame render of the promo to MP4.
//
//   node render.mjs                              → out/session-manager-promo.mp4 (captions burned in)
//   node render.mjs --cc 0 --out out/clean.mp4   → no captions
//   node render.mjs --no-voice --out out/music-only.mp4
//   node render.mjs --workers 6 --from 10 --to 20 (partial, for checking a section)
//
// Pipeline: static server → N headless Chromium pages each draw interleaved
// frames (PROMO.drawFrame is a pure function of t) → PNGs piped in order into
// ffmpeg → the soundtrack rendered by the SAME page code via OfflineAudioContext.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './serve.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf('--' + k)
  return i >= 0 ? args[i + 1] : d
}
const flag = (k) => args.includes('--' + k)
const out = resolve(ROOT, opt('out', 'out/session-manager-promo.mp4'))
const cc = opt('cc', '1') !== '0'
const voice = !flag('no-voice')
const workers = Number(opt('workers', 6))
const OUT_FPS = Number(opt('out-fps', 30))

mkdirSync(dirname(out), { recursive: true })
const { port, close } = await serve(0)
// one browser PROCESS per worker: pages sharing a browser stall on screenshots
// once they are backgrounded (element screenshots hung forever in testing)
const LAUNCH = { args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...(process.env.PROMO_CHROME_ARGS ?? '--disable-gpu --disable-accelerated-2d-canvas').split(' ').filter(Boolean)] }
const browsers = []
const url = `http://127.0.0.1:${port}/index.html?render=1&cc=${cc ? 1 : 0}`

async function openPage() {
  const browser = await chromium.launch(LAUNCH)
  browsers.push(browser)
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => console.error('[page error]', e.message))
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.error('[console]', m.text()))
  await page.goto(url)
  await page.waitForFunction(() => document.documentElement.dataset.ready)
  const st = await page.evaluate(() => document.documentElement.dataset.ready)
  if (st !== '1') throw new Error('page failed to boot')
  return page
}

const pages = await Promise.all(Array.from({ length: workers }, openPage))
const duration = await pages[0].evaluate(() => PROMO.duration)
const fps = await pages[0].evaluate(() => PROMO.fps)
const from = Number(opt('from', 0))
const to = Math.min(Number(opt('to', duration)), duration)
const first = Math.floor(from * fps)
const last = Math.ceil(to * fps) // exclusive
const total = last - first
console.log(`rendering ${total} frames (${from.toFixed(2)}–${to.toFixed(2)}s @ ${fps} fps) on ${workers} workers → ${out}`)

// soundtrack
const wavPath = out.replace(/\.mp4$/, '') + '.wav'
const t0 = Date.now()
if (!voice) await pages[0].evaluate(() => PROMO.setVoice(false))
const b64 = await pages[0].evaluate(() => PROMO.renderAudioWav())
writeFileSync(wavPath, Buffer.from(b64, 'base64'))
console.log(`audio: ${wavPath} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

const ff = spawn(
  'ffmpeg',
  [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-ss', String(from), '-t', String(to - from), '-i', wavPath,
    '-vf', `fps=${OUT_FPS},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-tune', 'animation',
    // no loudnorm here: audio.js already masters the mix to -16 LUFS / -1.5 dBTP with its own
    // limiter; a second single-pass loudnorm re-gained it +0.9 dB and AAC overshot to -0.7 dBTP
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
    '-movflags', '+faststart', '-shortest',
    out,
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] }
)
const ffDone = new Promise((ok, bad) => ff.on('close', (c) => (c === 0 ? ok() : bad(new Error('ffmpeg exit ' + c)))))

// interleaved workers + in-order writer
const done = new Map()
let next = first
let wrote = 0
const tStart = Date.now()
async function flush() {
  while (done.has(next)) {
    const buf = done.get(next)
    done.delete(next)
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
    next++
    wrote++
    if (wrote % 30 === 0 || wrote === total) {
      const el = (Date.now() - tStart) / 1000
      process.stdout.write(`\r  ${wrote}/${total} frames  ${(wrote / el).toFixed(1)} fps  eta ${((total - wrote) / (wrote / el)).toFixed(0)}s   `)
    }
  }
}
let flushing = Promise.resolve()
await Promise.all(
  pages.map(async (page, w) => {
    for (let f = first + w; f < last; f += workers) {
      // backpressure: don't run too far ahead of the writer
      while (f - next > workers * 8) await new Promise((r) => setTimeout(r, 15))
      await page.evaluate((t) => PROMO.drawFrame(t), f / fps)
      done.set(f, await page.screenshot({ type: 'jpeg', quality: 95, clip: { x: 0, y: 0, width: 1920, height: 1080 }, animations: 'allow', caret: 'initial', timeout: 60000 }))
      flushing = flushing.then(flush)
    }
  })
)
await flushing
ff.stdin.end()
await ffDone
process.stdout.write('\n')
await Promise.all(browsers.map((b) => b.close()))
close()
console.log(`done: ${out}`)

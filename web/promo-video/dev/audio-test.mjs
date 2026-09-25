#!/usr/bin/env node
// dev/audio-test.mjs — render and MEASURE the synthesized soundtrack (js/audio.js).
//
//   node dev/audio-test.mjs                    synthetic 56 s plan (BRIEF moods, logo ≈ 50, narration
//                                              from vo/*.wav or babble stand-ins, two cameos, one cue of
//                                              EVERY sfx type) + every sfx alone + ffmpeg stats + spectrograms
//   node dev/audio-test.mjs --cameo x.wav      use a real clip for Pip's cameo instead of the stand-in
//   node dev/audio-test.mjs --groups           also print the loudness of each music group per mood
//   node dev/audio-test.mjs --quick            skip the per-sfx renders
//   node dev/audio-test.mjs --real             ALSO render the real film (index.html + timeline.json + scenes'
//                                              sfx through the engine) → out/audio-real.wav + stats per scene
//
// Writes out/audio-test.wav (full mix), out/audio-test-music.wav (music only, ducked as in the mix),
// out/audio-test-sfx.wav (every sfx type in a row), out/audio-test-spec.png + -music-spec.png.
// Exit code 1 if anything is non-finite, silent, or the true peak is above −1 dBFS.
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '../serve.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'out')
mkdirSync(OUT, { recursive: true })
const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf('--' + k)
  return i >= 0 ? args[i + 1] : d
}
const flag = (k) => args.includes('--' + k)
const problems = []

/** run ffmpeg over a file with an audio filter; filter logs come back on stderr */
function ffStatsOut(file, af) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-af', af, '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000 })
  return (r.stderr || '') + (r.stdout || '')
}
function ffErr(argv) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...argv], { encoding: 'utf8', timeout: 120000 })
  return r.status === 0 ? '' : String(r.stderr || 'ffmpeg failed')
}
function ebur(file) {
  const s = ffStatsOut(file, 'ebur128=peak=true')
  const sum = s.slice(s.lastIndexOf('Summary:'))
  const num = (re) => {
    const m = sum.match(re)
    return m ? +m[1] : NaN
  }
  return { I: num(/I:\s+(-?[\d.]+) LUFS/), LRA: num(/LRA:\s+(-?[\d.]+) LU/), TP: num(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/) }
}
function astats(file, a, b) {
  const s = ffStatsOut(file, `atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},astats=measure_perchannel=none`)
  const pick = (k) => {
    const m = s.match(new RegExp(k + ':\\s+(-?[\\d.]+|-inf)'))
    return m ? (m[1] === '-inf' ? -Infinity : +m[1]) : NaN
  }
  return { rms: pick('RMS level dB'), peak: pick('Peak level dB') }
}

// ---------- render in the browser ----------
const { port, close } = await serve(0, ROOT)
const browser = await chromium.launch({ args: ['--disable-gpu'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push('[page error] ' + e.message))
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push('[console ' + m.type() + '] ' + m.text()))
page.setDefaultTimeout(600000)
await page.goto(`http://127.0.0.1:${port}/dev/audio.html`)
await page.waitForFunction(() => document.documentElement.dataset.ready, null, { timeout: 30000 })
if ((await page.evaluate(() => document.documentElement.dataset.ready)) !== '1') throw new Error('dev/audio.html failed to load: ' + errors.join('\n'))

const voDir = join(ROOT, 'vo')
const voFiles = existsSync(voDir)
  ? readdirSync(voDir)
      .filter((f) => f.endsWith('.wav') && !/cameo|pip|yay|ooh|check|tada/i.test(f))
      .sort()
      .map((f) => 'vo/' + f)
  : []
const cameoPath = opt('cameo')
const cameoB64 = cameoPath ? readFileSync(cameoPath).toString('base64') : null
console.log(`narration clips: ${voFiles.length ? voFiles.join(', ') : '(none — babble stand-ins)'}   cameo: ${cameoPath || 'stand-in'}`)

const types = await page.evaluate(() => AUDIO.SFX_TYPES)
console.log(`SFX_TYPES (${types.length}): ${types.join(' ')}`)

const full = await page.evaluate((cfg) => TEST.render(cfg), { voFiles, cameoB64 })
const fullWav = join(OUT, 'audio-test.wav')
writeFileSync(fullWav, Buffer.from(full.wav, 'base64'))
console.log(`\nfull mix → ${fullWav}  (renderMix ${(full.ms / 1000).toFixed(2)} s for 56 s, ${full.sfxCount} cues, finite=${full.finite})`)
if (!full.finite) problems.push('full mix has non-finite samples')

const music = await page.evaluate((cfg) => TEST.render(cfg), { voFiles, cameoB64, planExtra: { mute: ['vo', 'sfx', 'cameo'] } })
const musicWav = join(OUT, 'audio-test-music.wav')
writeFileSync(musicWav, Buffer.from(music.wav, 'base64'))

// duck depth: the same music with and without narration spans, pre-master (same scale)
const rawDucked = await page.evaluate((cfg) => TEST.render(cfg), { voFiles, cameoB64, planExtra: { mute: ['vo', 'sfx', 'cameo'], normalize: false } })
const rawDry = await page.evaluate((cfg) => TEST.render(cfg), { voFiles, cameoB64, planExtra: { vo: [], sfx: [], normalize: false } })
writeFileSync(join(OUT, 'audio-test-raw-ducked.wav'), Buffer.from(rawDucked.wav, 'base64'))
writeFileSync(join(OUT, 'audio-test-raw-dry.wav'), Buffer.from(rawDry.wav, 'base64'))

// pre-master stem levels (no normalisation): voice vs music vs sfx
const stems = {}
for (const [name, mute] of [['voice', ['music', 'sfx']], ['music(ducked)', ['vo', 'sfx', 'cameo']], ['sfx', ['music', 'vo', 'cameo']]]) {
  const r = await page.evaluate((cfg) => TEST.render(cfg), { voFiles, cameoB64, planExtra: { mute, normalize: false } })
  stems[name] = r.loud
}

let sfx = null
if (!flag('quick')) {
  sfx = await page.evaluate(() => TEST.sfxAll())
  writeFileSync(join(OUT, 'audio-test-sfx.wav'), Buffer.from(sfx.wav, 'base64'))
}
let groups = null
if (flag('groups')) groups = await page.evaluate(() => TEST.groups({ voFiles: [] }))

// the real film, through the engine
let real = null
if (flag('real')) {
  const p2 = await browser.newPage()
  const warn = []
  p2.on('pageerror', (e) => warn.push('[page error] ' + e.message))
  p2.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && warn.push(m.text()))
  await p2.goto(`http://127.0.0.1:${port}/index.html?render=1&cc=0`)
  await p2.waitForFunction(() => document.documentElement.dataset.ready, null, { timeout: 60000 })
  const t0 = Date.now()
  const wav = await p2.evaluate(() => PROMO.renderAudioWav())
  const ms = Date.now() - t0
  const tl = await p2.evaluate(() => PROMO.timeline)
  const cues = await p2.evaluate(() => PROMO.allSfx())
  const info = await p2.evaluate(() => AUDIO.renderMix.last && { music: AUDIO.renderMix.last.music, limiter: AUDIO.renderMix.last.limiter, masterGainDb: AUDIO.renderMix.last.masterGainDb, voMaxGrDb: AUDIO.renderMix.last.voMaxGrDb })
  writeFileSync(join(OUT, 'audio-real.wav'), Buffer.from(wav, 'base64'))
  real = { ms, tl, cues, info, warn }
  await p2.close()
}
await browser.close()
close()

// ---------- measure with ffmpeg ----------
const E = ebur(fullWav)
const EM = ebur(musicWav)
const li = full.info
console.log(`\nmaster: +${li.masterGainDb.toFixed(1)} dB to target, limiter max GR ${li.limiter.maxGrDb.toFixed(2)} dB active ${li.limiter.activePct.toFixed(2)} % of samples, voice compressor max GR ${li.voMaxGrDb.toFixed(1)} dB`)
console.log(`\nLOUDNESS  full mix: I ${E.I} LUFS  LRA ${E.LRA} LU  true peak ${E.TP} dBFS   |  music-only: I ${EM.I} LUFS  TP ${EM.TP} dBFS`)
if (!(E.TP <= -1)) problems.push(`true peak ${E.TP} dBFS > -1`)
console.log('pre-master stems (BS.1770, page-side):')
for (const [k, v] of Object.entries(stems)) console.log(`  ${k.padEnd(14)} I ${v.integrated.toFixed(1)} LUFS   short-max ${v.shortMax.toFixed(1)}   peak ${v.peakDb.toFixed(1)} dBFS`)

console.log('\nPER MOOD SECTION (astats RMS / peak dBFS)            full mix          music only')
for (const m of full.moods) {
  const a = astats(fullWav, m.start, m.end)
  const b = astats(musicWav, m.start, m.end)
  console.log(`  ${m.id.padEnd(20)} ${m.mood.padEnd(8)} ${m.start.toFixed(2).padStart(6)}–${m.end.toFixed(2).padEnd(6)}   ${a.rms.toFixed(1).padStart(6)} / ${a.peak.toFixed(1).padStart(5)}     ${b.rms.toFixed(1).padStart(6)} / ${b.peak.toFixed(1).padStart(5)}`)
}
const mi = full.info.music
if (mi) {
  const chaos = mi.secs.find((s) => s.mood === 'chaos')
  if (chaos && chaos.resume) {
    const a = chaos.resume - mi.beat
    const q = astats(musicWav, a + 0.12, chaos.resume - 0.02)
    const pre = astats(musicWav, a - 0.8, a - 0.05)
    console.log(`\nsilent beat after chaos ${a.toFixed(2)}–${chaos.resume.toFixed(2)} s: music RMS ${q.rms.toFixed(1)} dB (chaos just before: ${pre.rms.toFixed(1)} dB)`)
    if (!(q.rms < pre.rms - 15)) problems.push('the silent beat after chaos is not silent enough')
  }
  if (mi.button) {
    const b = astats(musicWav, mi.button - 0.25, mi.button - 0.03)
    const c = astats(musicWav, mi.button, mi.button + 0.4)
    const z = astats(fullWav, 56 - 0.08, 56)
    console.log(`button ending at ${mi.button.toFixed(2)} s (logo hit ${mi.logoTime.toFixed(2)}): breath before ${b.rms.toFixed(1)} dB, button ${c.rms.toFixed(1)} dB, last 80 ms ${z.rms.toFixed(1)} dB`)
    if (!(z.rms < -50)) problems.push('the film does not ring out to silence')
  }
}
// ducking depth: dry vs ducked music over the same speech windows
if (full.info.duckSpans && full.info.duckSpans.length) {
  const dd = []
  for (const [a, b] of full.info.duckSpans) {
    if (b - a < 0.8) continue
    const x = astats(join(OUT, 'audio-test-raw-dry.wav'), a + 0.3, b - 0.2).rms
    const y = astats(join(OUT, 'audio-test-raw-ducked.wav'), a + 0.3, b - 0.2).rms
    dd.push(x - y)
  }
  console.log(`duck depth under narration (dry − ducked, same windows): ${dd.map((d) => d.toFixed(1)).join(' ')} dB`)
  if (dd.some((d) => d < 8.5 || d > 11)) problems.push('duck depth outside 8.5–11 dB')
}
// ducking: music RMS inside the narration spans vs in the gaps
if (full.info.duckSpans && full.info.duckSpans.length) {
  const inS = []
  const gaps = []
  const sp = full.info.duckSpans
  for (let i = 0; i < sp.length; i++) {
    const [a, b] = sp[i]
    if (b - a > 0.8) inS.push(astats(musicWav, a + 0.3, b - 0.2).rms)
    const nx = sp[i + 1]
    if (nx && nx[0] - b > 0.9) gaps.push(astats(musicWav, b + 0.55, nx[0] - 0.05).rms)
  }
  const avg = (x) => x.filter(Number.isFinite).reduce((s, v) => s + v, 0) / Math.max(1, x.filter(Number.isFinite).length)
  console.log(`ducking: ${sp.length} merged narration spans; music RMS under speech ${avg(inS).toFixed(1)} dB vs gaps ${avg(gaps).toFixed(1)} dB (${gaps.length} gaps)`)
}

if (sfx) {
  console.log('\nEVERY SFX ALONE (mix scale, pre-master; target short-max ≈ −21.5 + off)')
  console.log('  type          ms  finite  active  tail   shortMax  peak   off')
  for (const r of sfx.rows) {
    const bad = !r.finite || r.activeMs < 5
    if (bad) problems.push(`sfx ${r.type} is ${r.finite ? 'silent' : 'non-finite'}`)
    console.log(`  ${r.type.padEnd(12)} ${String(r.ms).padStart(4)}  ${r.finite ? 'yes' : 'NO '}   ${String(r.activeMs).padStart(5)}  ${String(r.tailMs).padStart(5)}   ${r.shortMax.toFixed(1).padStart(6)}  ${r.peakDb.toFixed(1).padStart(6)}  ${String(r.off).padStart(3)}${bad ? '  <-- PROBLEM' : ''}`)
  }
  writeFileSync(join(OUT, 'audio-test-sfx.txt'), sfx.marks.map((m) => `${m.t}\t${m.type}`).join('\n') + '\n')
  console.log(`  → out/audio-test-sfx.wav (index: out/audio-test-sfx.txt)`)
}
if (groups) {
  console.log('\nMUSIC GROUP BALANCE (raw integrated LUFS per section)')
  const secs = Object.keys(groups.uke)
  console.log('  group ' + secs.map((s) => s.padStart(14)).join(''))
  for (const [g, v] of Object.entries(groups)) console.log('  ' + g.padEnd(6) + secs.map((s) => String(v[s]).padStart(14)).join(''))
}

// spectrograms
for (const [src, png] of [[fullWav, 'audio-test-spec.png'], [musicWav, 'audio-test-music-spec.png']]) {
  const e = ffErr(['-y', '-i', src, '-lavfi', 'showspectrumpic=s=1800x640:legend=1:fscale=log:scale=log:drange=96:mode=combined', join(OUT, png)])
  if (e && !existsSync(join(OUT, png))) problems.push('spectrogram failed: ' + e.slice(0, 200))
  else console.log(`spectrogram → out/${png}`)
}

if (real) {
  const rw = join(OUT, 'audio-real.wav')
  const R = ebur(rw)
  console.log(`\nREAL FILM (${real.tl.duration.toFixed(2)} s, bpm ${real.tl.bpm.toFixed(2)}, logo ${real.tl.logoTime.toFixed(2)}) → out/audio-real.wav  [renderAudioWav ${(real.ms / 1000).toFixed(1)} s]`)
  console.log(`  I ${R.I} LUFS  LRA ${R.LRA} LU  true peak ${R.TP} dBFS   master +${real.info.masterGainDb.toFixed(1)} dB, limiter max GR ${real.info.limiter.maxGrDb.toFixed(2)} dB (${real.info.limiter.activePct.toFixed(2)} %), voice comp max GR ${real.info.voMaxGrDb.toFixed(1)} dB`)
  if (!(R.TP <= -1)) problems.push(`real film true peak ${R.TP} dBFS > -1`)
  for (const sc of real.tl.scenes) {
    const a = astats(rw, sc.start, sc.end)
    const n = real.cues.filter((c) => c.t >= sc.start && c.t < sc.end)
    console.log(`  ${sc.id.padEnd(20)} ${String(sc.mood).padEnd(8)} ${sc.start.toFixed(2).padStart(6)}–${sc.end.toFixed(2).padEnd(6)} RMS ${a.rms.toFixed(1).padStart(6)} peak ${a.peak.toFixed(1).padStart(5)}  cues: ${n.map((c) => c.type).join(' ')}`)
  }
  const known = new Set(types)
  const unknown = [...new Set(real.cues.map((c) => c.type).filter((t) => !known.has(t)))]
  if (unknown.length) problems.push('scenes use unknown sfx types: ' + unknown.join(', '))
  const mi2 = real.info.music
  if (mi2) console.log(`  music: logo hit ${mi2.logoTime?.toFixed(2)}, button ${mi2.button?.toFixed(2)} (${(real.tl.duration - mi2.button).toFixed(2)} s before the end)`)
  for (const w of real.warn) console.error('  [real] ' + w)
  const e = ffErr(['-y', '-i', rw, '-lavfi', 'showspectrumpic=s=1800x640:legend=1:fscale=log:scale=log:drange=96:mode=combined', join(OUT, 'audio-real-spec.png')])
  if (!e) console.log('  spectrogram → out/audio-real-spec.png')
}

for (const e of errors) console.error(e)
if (errors.some((e) => e.includes('page error'))) problems.push('page errors')
if (problems.length) {
  console.error('\nPROBLEMS:\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log('\nOK — no problems found')

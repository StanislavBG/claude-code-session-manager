#!/usr/bin/env node
// build-timeline.mjs — script/script.json → voice clips (narration + cameos) → timeline.json (+ scene <script> tags).
//
//   node build-timeline.mjs              TTS only the clips whose words/voice/speed/pitch changed, then lay out
//   node build-timeline.mjs --no-tts     never run TTS (fails if a clip is missing)
//   node build-timeline.mjs --force-tts  re-synthesize every clip
//   node build-timeline.mjs --reprocess  keep the raw TTS, redo the ffmpeg trim/pitch/level pass
//
// The voice drives the clock: each scene lasts max(minDur, narration + tail, last cameo + cameoTail),
// so scene art never races ahead of (or lags behind) the voice.
//
// TTS: Kokoro-82M via tts/kokoro_say.py through `uv` (free, local) → vo/raw/<id>.wav (cache).
// Post: ffmpeg (always -nostdin): [rubberband pitch for cameos] → trim leading/trailing silence →
// level to a common loudness → short fades → vo/<id>.wav (narration) / vo/cameo-<id>.wav (cameos).
//
// script/script.json:
// {
//   "voice": "af_heart", "speed": 1.0,          narrator defaults
//   "lineGap": 0.3, "voLead": 0.45, "tail": 0.45, "cameoTail": 0.35, "bpm": 104,
//   "loudness": -20,                             per-clip mean level target (dBFS); null = leave as is
//   "scenes": [{
//     "id": "s2-one-console", "file": "js/scenes/s2-one-console.js",
//     "mood": "full", "transition": "tape",     transition INTO this scene (wipe|drop|tape|pan|tilt|none)
//     "minDur": 7, "voLead": 0.45, "tail": 0.45, "lineGap": 0.3, "cameoTail": 0.35, "voice"?, "speed"?,
//     "lines": [ "plain text" | { "text": caption, "say"?: spoken text, "voice"?, "speed"?, "gap"?: s before it } ],
//     "cameos": [{ "id", "text", "say"?, "voice", "speed", "pitch", "formant": "preserved"|"shifted",
//                  "at": 0.35 | { "after": "vo", "offset" } | { "word", "nth", "offset" }
//                        | { "with": otherCameoId, "offset" } (starts offset after it starts)
//                        | { "after": otherCameoId, "offset" } (starts offset after it ends),
//                  "snap"?: "beat"|"half"|"bar", "gain", "pan", "fadeIn"?: s (softer onset) }],
//     "logoAt": 1.0 | "vo"                     (last scene) local time of the logo hit; "vo" = narration start
//   }]
// }
// Cameos never overlap narration: one placed before the narration pushes the narration later, one that
// would land on a narration clip is moved past it (with a warning), and the scene tail grows to fit.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, rmSync, mkdtempSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const FORCE_TTS = args.includes('--force-tts')
const NO_TTS = args.includes('--no-tts')
const REPROCESS = FORCE_TTS || args.includes('--reprocess')
const script = JSON.parse(readFileSync(join(ROOT, 'script/script.json'), 'utf8'))
const VO_DIR = join(ROOT, 'vo')
const RAW_DIR = join(VO_DIR, 'raw')
mkdirSync(RAW_DIR, { recursive: true })

const TRIM = Object.assign({ threshold: -45, lead: 0.02, tail: 0.07, fadeIn: 0.008, fadeOut: 0.03 }, script.trim || {})
const LOUDNESS = script.loudness === undefined ? -20 : script.loudness
const PEAK_CEIL = -1.5
const CAMEO_GAP = script.cameoGap ?? 0.15 // min silence between a cameo and a narration clip
const PROC_VERSION = 2 // bump when the ffmpeg pass changes

// ---------------------------------------------------------------- 1. collect clips
const norm = (ln) => (typeof ln === 'string' ? { text: ln } : ln)
const clips = [] // every clip to exist in vo/
const seen = new Set()
for (const sc of script.scenes) {
  ;(sc.lines || []).map(norm).forEach((ln, i) => {
    const id = `${sc.id}-${i + 1}`
    clips.push({
      id,
      kind: 'narration',
      scene: sc.id,
      text: ln.text,
      say: ln.say || ln.text,
      voice: ln.voice || sc.voice || script.voice || 'af_heart',
      speed: ln.speed ?? sc.speed ?? script.speed ?? 1,
      pitch: 1,
      formant: 'preserved',
      file: `${id}.wav`,
    })
  })
  for (const c of sc.cameos || []) {
    if (!c.id || !c.text) throw new Error(`cameo in ${sc.id} needs id + text`)
    if (seen.has(c.id)) throw new Error('duplicate cameo id ' + c.id)
    seen.add(c.id)
    clips.push({
      id: `cameo-${c.id}`,
      kind: 'cameo',
      scene: sc.id,
      text: c.text,
      say: c.say || c.text,
      voice: c.voice || script.voice || 'af_heart',
      speed: c.speed ?? 1,
      pitch: c.pitch ?? 1,
      formant: c.formant || 'preserved',
      fadeIn: c.fadeIn,
      file: `cameo-${c.id}.wav`,
    })
  }
}
const rawKey = (c) => JSON.stringify([c.say, c.voice, c.speed])
const procKey = (c) => JSON.stringify([PROC_VERSION, c.say, c.voice, c.speed, c.pitch, c.formant, c.fadeIn ?? null, TRIM, LOUDNESS])

// ---------------------------------------------------------------- 2. raw TTS (Kokoro), cached per clip
const rawIndexPath = join(RAW_DIR, 'index.json')
const rawIndex = existsSync(rawIndexPath) ? JSON.parse(readFileSync(rawIndexPath, 'utf8')) : {}
const needRaw = clips.filter((c) => FORCE_TTS || rawIndex[c.id]?.key !== rawKey(c) || !existsSync(join(RAW_DIR, c.id + '.wav')))
let model = rawIndex.__model || 'kokoro'
if (needRaw.length) {
  if (NO_TTS) throw new Error('--no-tts but these clips need TTS: ' + needRaw.map((c) => c.id).join(', '))
  const tmp = mkdtempSync(join(tmpdir(), 'sm-promo-tts-'))
  const batch = needRaw.map((c) => ({ id: c.id, text: c.say, voice: c.voice, speed: c.speed }))
  writeFileSync(join(tmp, 'lines.json'), JSON.stringify(batch, null, 2))
  console.log(`TTS: ${needRaw.length} clip(s) via Kokoro…`)
  execFileSync('uv', ['run', '--quiet', join(ROOT, 'tts/kokoro_say.py'), '--script', join(tmp, 'lines.json'), '--outdir', tmp], {
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 600000,
  })
  const man = JSON.parse(readFileSync(join(tmp, 'manifest.json'), 'utf8'))
  model = man.model
  for (const c of needRaw) {
    copyFileSync(join(tmp, c.id + '.wav'), join(RAW_DIR, c.id + '.wav'))
    rawIndex[c.id] = { key: rawKey(c), text: c.say, voice: c.voice, speed: c.speed }
  }
  rawIndex.__model = model
  writeFileSync(rawIndexPath, JSON.stringify(rawIndex, null, 2) + '\n')
  rmSync(tmp, { recursive: true, force: true })
} else console.log('TTS: raw clips up to date')

// ---------------------------------------------------------------- 3. ffmpeg pass: pitch → trim → level → fades
function ffmpeg(argv) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-y', ...argv], { encoding: 'utf8', timeout: 120000 })
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + argv.join(' ') + '\n' + (r.stderr || '').slice(-1500))
  return r.stderr || ''
}
function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 30000 })
  return parseFloat(r.stdout)
}
/** [voiceStart, voiceEnd] of a clip: first/last non-silent sample (silencedetect). */
function voicedSpan(file) {
  const dur = probeDuration(file)
  const log = ffmpeg(['-i', file, '-af', `silencedetect=noise=${TRIM.threshold}dB:d=0.03`, '-f', 'null', '-'])
  const starts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => +m[1])
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1])
  let a = 0
  let b = dur
  if (starts.length && starts[0] <= 0.005 && ends.length) a = ends[0]
  const lastStart = starts[starts.length - 1]
  if (starts.length && (ends.length < starts.length || ends[ends.length - 1] >= dur - 0.01) && lastStart > a) b = lastStart
  return { dur, a, b }
}
function levels(file, s, e) {
  const log = ffmpeg(['-i', file, '-af', `atrim=start=${s}:end=${e},volumedetect`, '-f', 'null', '-'])
  const mean = +(log.match(/mean_volume: (-?[\d.]+) dB/) || [])[1]
  const max = +(log.match(/max_volume: (-?[\d.]+) dB/) || [])[1]
  return { mean, max }
}
function processClip(c) {
  const raw = join(RAW_DIR, c.id + '.wav')
  const out = join(VO_DIR, c.file)
  let src = raw
  let tmp = null
  if (c.pitch !== 1) {
    tmp = join(tmpdir(), `sm-promo-${process.pid}-${c.id}.wav`)
    ffmpeg(['-i', raw, '-af', `rubberband=pitch=${c.pitch}:formant=${c.formant}:pitchq=quality`, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', tmp])
    src = tmp
  }
  const { dur, a, b } = voicedSpan(src)
  const s = Math.max(0, a - TRIM.lead)
  const e = Math.min(dur, b + TRIM.tail)
  const lv = levels(src, s, e)
  let gainDb = 0
  if (LOUDNESS !== null && Number.isFinite(lv.mean)) {
    gainDb = Math.max(-12, Math.min(12, LOUDNESS - lv.mean))
    if (Number.isFinite(lv.max)) gainDb = Math.min(gainDb, PEAK_CEIL - lv.max)
  }
  const len = e - s
  const af = [
    `atrim=start=${s.toFixed(4)}:end=${e.toFixed(4)}`,
    'asetpts=PTS-STARTPTS',
    `volume=${gainDb.toFixed(2)}dB`,
    `afade=t=in:st=0:d=${c.fadeIn ?? TRIM.fadeIn}`,
    `afade=t=out:st=${Math.max(0, len - TRIM.fadeOut).toFixed(4)}:d=${TRIM.fadeOut}`,
  ].join(',')
  ffmpeg(['-i', src, '-af', af, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', out])
  if (tmp) rmSync(tmp, { force: true })
  const duration = +probeDuration(out).toFixed(3)
  return { rawDuration: +dur.toFixed(3), trim: [+s.toFixed(3), +e.toFixed(3)], gainDb: +gainDb.toFixed(2), meanDb: lv.mean, duration }
}

const manifestPath = join(VO_DIR, 'manifest.json')
const oldMan = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { clips: [] }
const oldById = new Map((oldMan.clips || []).map((c) => [c.id, c]))
const rawFresh = new Set(needRaw.map((c) => c.id))
const manClips = []
let processed = 0
for (const c of clips) {
  const prev = oldById.get(c.id)
  let info
  if (!REPROCESS && !rawFresh.has(c.id) && prev && prev.key === procKey(c) && existsSync(join(VO_DIR, c.file))) info = prev
  else {
    info = processClip(c)
    processed++
    console.log(`  ${c.file.padEnd(28)} ${String(info.duration.toFixed(2)).padStart(5)}s  (raw ${info.rawDuration.toFixed(2)}s, ${info.gainDb >= 0 ? '+' : ''}${info.gainDb} dB)  "${c.say}"`)
  }
  manClips.push(Object.assign({}, info, { id: c.id, kind: c.kind, file: c.file, text: c.say, voice: c.voice, speed: c.speed, pitch: c.pitch, formant: c.formant, key: procKey(c) }))
}
writeFileSync(
  manifestPath,
  JSON.stringify({ model, sample_rate: 24000, trim: TRIM, loudness: LOUDNESS, clips: manClips, total_duration: +manClips.reduce((a, c) => a + c.duration, 0).toFixed(3) }, null, 2) + '\n'
)
if (!processed) console.log('ffmpeg: processed clips up to date')
const clipById = new Map(manClips.map((c) => [c.id, c]))
// prune clips no longer in the script (only files this script owns)
const keep = new Set(manClips.map((c) => c.file))
for (const f of readdirSync(VO_DIR)) if (f.endsWith('.wav') && !keep.has(f)) unlinkSync(join(VO_DIR, f))
for (const f of readdirSync(RAW_DIR)) if (f.endsWith('.wav') && !clipById.has(f.replace(/\.wav$/, ''))) unlinkSync(join(RAW_DIR, f))
for (const id of Object.keys(rawIndex)) if (id !== '__model' && !clipById.has(id)) delete rawIndex[id]
writeFileSync(rawIndexPath, JSON.stringify(rawIndex, null, 2) + '\n')
if (existsSync(join(VO_DIR, 'lines.json'))) unlinkSync(join(VO_DIR, 'lines.json'))

// ---------------------------------------------------------------- 4. lay out scenes
// word timing estimate — MUST match engine.js wordTimes()
const weight = (s) => s.replace(/[^a-z0-9]/gi, '').length + 2 * (s.match(/[,.!?;:—]/g) || []).length
const cleanWord = (w) => w.replace(/[^a-z0-9'-]/gi, '').toLowerCase()
function wordTimes(vo) {
  const out = []
  for (const v of vo) {
    const words = (v.say || v.text).split(/\s+/).filter(Boolean)
    const total = words.reduce((a, w) => a + weight(w) + 1, 0)
    let at = v.start
    for (const w of words) {
      const d = ((weight(w) + 1) / total) * v.duration
      out.push({ word: cleanWord(w), start: at, end: at + d })
      at += d
    }
  }
  return out
}
const SNAP = { beat: 1, half: 0.5, bar: 4 }
const snapUp = (s, beat, mode) => {
  if (!mode || !beat) return s
  const step = beat * (SNAP[mode] || 1)
  return Math.ceil((s - 0.02) / step) * step
}
const r3 = (x) => +x.toFixed(3)

function layout(beat) {
  const warn = []
  let t = 0
  const scenes = []
  for (const sc of script.scenes) {
    const start = t
    const lines = (sc.lines || []).map(norm)
    const gapDefault = sc.lineGap ?? script.lineGap ?? 0.3
    let at = start + (sc.voLead ?? script.voLead ?? 0.45)
    const vo = lines.map((ln, i) => {
      const c = clipById.get(`${sc.id}-${i + 1}`)
      if (i > 0) at += ln.gap ?? gapDefault
      const v = { file: 'vo/' + c.file, start: at, duration: c.duration, text: ln.text }
      if (ln.say && ln.say !== ln.text) v.say = ln.say
      at += c.duration
      return v
    })
    const voEnd = () => (vo.length ? vo[vo.length - 1].start + vo[vo.length - 1].duration : start)
    const cams = []
    const defs = sc.cameos || []
    // (a) numeric cameos, in time order; one that sits before the narration pushes the narration later
    for (const c of defs.filter((c) => typeof c.at === 'number').sort((x, y) => x.at - y.at)) {
      const d = clipById.get('cameo-' + c.id).duration
      const s = snapUp(start + Math.max(0, c.at), beat, c.snap)
      if (vo.length && s < vo[0].start && s + d + CAMEO_GAP > vo[0].start) {
        const push = s + d + CAMEO_GAP - vo[0].start
        for (const v of vo) v.start += push
      }
      cams.push({ c, s, d })
    }
    // (b) cameos anchored to the narration
    for (const c of defs.filter((c) => typeof c.at !== 'number')) {
      const d = clipById.get('cameo-' + c.id).duration
      const a = c.at || { after: 'vo' }
      let s
      if (a.word) {
        const hits = wordTimes(vo).filter((w) => w.word === cleanWord(a.word))
        const h = hits[a.nth || 0]
        if (!h) warn.push(`${sc.id}: cameo ${c.id} word "${a.word}" not found — placed after the narration`)
        s = (h ? h.start : voEnd()) + (a.offset ?? 0)
      } else if (a.with || (a.after && a.after !== 'vo')) {
        const ref = a.with || a.after
        const prev = cams.find((x) => x.c.id === ref)
        if (!prev) throw new Error(`${sc.id}: cameo ${c.id} refers to unknown/later cameo ${ref}`)
        s = (a.with ? prev.s : prev.s + prev.d) + (a.offset ?? 0)
      } else s = voEnd() + (a.offset ?? 0.25)
      cams.push({ c, s: snapUp(s, beat, c.snap), d })
    }
    // (c) never on top of narration: move a colliding cameo past the clip it hits
    for (const cm of cams) {
      for (let guard = 0; guard < 20; guard++) {
        const hit = vo.find((v) => cm.s < v.start + v.duration + CAMEO_GAP && cm.s + cm.d + CAMEO_GAP > v.start)
        if (!hit) break
        const ns = snapUp(hit.start + hit.duration + CAMEO_GAP, beat, cm.c.snap)
        warn.push(`${sc.id}: cameo ${cm.c.id} overlapped "${hit.text}" — moved ${cm.s.toFixed(2)} → ${ns.toFixed(2)}`)
        cm.s = ns
      }
    }
    const lastCam = cams.reduce((m, x) => Math.max(m, x.s + x.d), start)
    let end = Math.max(start + (sc.minDur ?? 4), voEnd() + (sc.tail ?? script.tail ?? 0.45), cams.length ? lastCam + (sc.cameoTail ?? script.cameoTail ?? 0.35) : 0)
    if (script.snapCuts) end = snapUp(end, beat, script.snapCuts)
    scenes.push({
      id: sc.id,
      file: sc.file,
      start: r3(start),
      end: r3(end),
      mood: sc.mood || 'full',
      transition: sc.transition || 'wipe',
      vo: vo.map((v) => Object.assign(v, { start: r3(v.start) })),
      cameos: cams
        .sort((x, y) => x.s - y.s)
        .map(({ c, s, d }) => ({ id: c.id, text: c.text, file: 'vo/' + clipById.get('cameo-' + c.id).file, start: r3(s), duration: d, gain: c.gain ?? 1, pan: c.pan ?? 0 })),
    })
    t = end
  }
  const lastDef = script.scenes[script.scenes.length - 1]
  const last = scenes[scenes.length - 1]
  const logoTime = lastDef.logoAt === 'vo' && last.vo.length ? last.vo[0].start : last.start + (typeof lastDef.logoAt === 'number' ? lastDef.logoAt : 1)
  // tempo nudged (a hair) so a whole number of bars lands exactly on the logo
  const targetBpm = script.bpm || 104
  const bars = Math.max(1, Math.round(logoTime / (240 / targetBpm)))
  const bpm = (bars * 240) / logoTime
  return { scenes, duration: r3(t), logoTime: r3(logoTime), bpm, warn }
}

// beat-snapped cameos/cuts move the logo, which moves the tempo, which moves the grid: iterate to a fixed point
let beat = 60 / (script.bpm || 104)
let L = layout(beat)
for (let pass = 0; pass < 8; pass++) {
  const nb = 60 / L.bpm
  if (Math.abs(nb - beat) < 1e-6) break
  beat = nb
  L = layout(beat)
}
const timeline = {
  generated: 'build-timeline.mjs from script/script.json',
  duration: L.duration,
  bpm: +L.bpm.toFixed(4),
  beat: +(60 / L.bpm).toFixed(5),
  logoTime: L.logoTime,
  scenes: L.scenes,
}
writeFileSync(join(ROOT, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n')

// ---------------------------------------------------------------- 5. scene script tags in index.html
const idx = join(ROOT, 'index.html')
const html = readFileSync(idx, 'utf8')
const tags = script.scenes.map((s) => `  <script src="${s.file}"></script>`).join('\n')
const next = html.replace(/(<!-- SCENES:BEGIN[^>]*-->)[\s\S]*?(\s*<!-- SCENES:END -->)/, `$1\n${tags}$2`)
if (next !== html) writeFileSync(idx, next)
for (const s of script.scenes) if (!existsSync(join(ROOT, s.file))) console.warn(`! missing scene file ${s.file}`)

// ---------------------------------------------------------------- 6. report
for (const w of L.warn) console.warn('! ' + w)
const words = clips.filter((c) => c.kind === 'narration').reduce((a, c) => a + c.say.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length, 0)
for (const s of timeline.scenes) {
  console.log(`${s.id.padEnd(20)} ${s.start.toFixed(2).padStart(6)} → ${s.end.toFixed(2).padStart(6)}  (${(s.end - s.start).toFixed(2)}s)  ${s.mood.padEnd(7)} in:${s.transition}`)
  const items = [...s.vo.map((v) => ({ t: v.start, d: v.duration, s: `VO  "${v.text}"` })), ...s.cameos.map((c) => ({ t: c.start, d: c.duration, s: `cameo ${c.id} "${c.text}"` }))].sort((a, b) => a.t - b.t)
  for (const it of items) console.log(`      ${it.t.toFixed(2).padStart(6)} → ${(it.t + it.d).toFixed(2).padStart(6)}  ${it.s}`)
}
console.log(`total ${timeline.duration.toFixed(2)}s · ${words} VO words · ${timeline.bpm.toFixed(2)} bpm · logo at ${timeline.logoTime.toFixed(2)}s`)
if (timeline.duration > 60 && !args.includes('--allow-long')) {
  console.error(`✗ total ${timeline.duration}s exceeds the 60 s hard cap`)
  process.exit(1)
}

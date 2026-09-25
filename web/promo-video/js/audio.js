/* audio.js — the whole soundtrack of "Pip and the Paper Moon", synthesized.
 *
 * AUDIO.renderMix(plan) renders music + sound effects + voice-over into ONE stereo
 * AudioBuffer. The live player plays that buffer and render.mjs writes it to WAV
 * (AUDIO.toWav), so what you hear in the browser is what ships in the MP4.
 * No samples: every instrument and effect is synthesized here in plain JS DSP
 * (Karplus-Strong strings, modal bells, additive felt piano, formant kazoo,
 * filtered-noise paper) and mixed into stems, with JS dynamics (voice compressor,
 * soft caps, a look-ahead limiter); WebAudio (OfflineAudioContext) only adds the
 * room reverb and EQ. All
 * randomness is seeded through K.rng, so the same plan gives the same bytes.
 *
 * ── Public API ──────────────────────────────────────────────────────────────
 *   AUDIO.SR                    48000
 *   AUDIO.renderMix(plan)       → Promise<AudioBuffer> (stereo, SR, plan.duration s)
 *   AUDIO.toWav(buffer)         → ArrayBuffer (16-bit PCM WAV, TPDF-dithered)
 *   AUDIO.SFX_TYPES             string[] — every valid sfx `type`
 *   AUDIO.SFX_META              { type: { desc, params, off, dur? } }
 *   AUDIO.renderSfx(type, o)    → Promise<AudioBuffer> one cue alone, at mix scale (dev/tests)
 *   AUDIO.loudness(buf|[L,R])   → { integrated, shortMax, peakDb } (BS.1770 LUFS; dev/tests)
 *
 * ── plan contract ───────────────────────────────────────────────────────────
 *   duration   seconds (the buffer length)
 *   bpm        tempo (default 104). Beat grid = beat0 + k·60/bpm (beat0 default 0),
 *              the same grid the engine's info.nextBeat() uses.
 *   logoTime   global time of the finale's full-band hit ("Session Manager").
 *   moods      [{ start, end, mood, hit?, dip? }] one per scene, contiguous:
 *     chaos    detuned toy piano stumbling through the motif, off-beat kazoo honks,
 *              a too-fast ticking clock; stops dead on the beat nearest the cut, then
 *              ONE BEAT OF SILENCE (the tape-rip gag) before the groove drops in.
 *     full     the band: ukulele strums (D-DU-UDU, light swing), pizzicato bass,
 *              glock motif, claps on 2 & 4, shaker, box-kick. Consecutive full
 *              scenes vary: #1 base, #2 pizzicato takes the melody, #3 toy piano
 *              doubles the glock, #4 staccato bass.
 *     night    lullaby: motif at half-time on music box + felt piano over a warm
 *              pad, soft woodblock tick-tock on the beat; the last bar (or `dip`
 *              [a, b], global s) drops to near-silence ("pauses").
 *     sunrise  upward glock glissando from the cut, then the full band re-enters on
 *              the next downbeat with an accent (phrase restarts at bar 1); if cameos open
 *              the scene (the "Check!"s) the downbeat waits for them (≤ 2.2 s).
 *     build    driving 8th strums + bass, doubled claps (2, 2&, 4, 4&), snare roll
 *              crescendo into a full-band hit at `hit` (default: logoTime when the
 *              next scene is the finale, else the section end) + slide-whistle lift.
 *     finale   full-band hit exactly at logoTime, the motif restated once, then a
 *              button ending (one ukulele strum + glock ding) ~1 s before the end,
 *              ringing out to silence.
 *     soft     (legacy) the band without percussion.
 *              Every other scene cut gets a harp + glock swirl (descending into night).
 *   vo         [{ start, buffer: AudioBuffer, kind: 'narration'|'cameo' (default
 *              narration), gain? (1), pan? (0) }]. Each clip is loudness-matched
 *              (BS.1770; cameos 1 dB hotter) before gain. Music ducks 10 dB under narration
 *              speech (spans detected from the audio, merged when < 0.7 s apart). Cameos never
 *              duck the music; the music only gets a −5 dB presence carve at 2.4 kHz while a
 *              cameo speaks, so "Ta-da!" / "Check!" / "Ooh!" read over the band.
 *   sfx        [{ t, type, gain?, pitch?, pan?, dur?, note? }] — every cue is
 *              loudness-normalised so gain 1 sits ≈ 6 dB under the voice (beds and
 *              UI ticks lower, see SFX_META.off), then × gain. pitch multiplies the
 *              cue's pitch, pan −1..1, dur stretches sustained cues, note = MIDI note
 *              for pitched cues (pluck/plink/letterPop).
 *   optional   beat0 (0), targetLufs (-16), music (true), normalize (true: master stage =
 *              loudness-normalise + 2 dB soft-clip knee + −1.5 dBTP look-ahead limiter + end fade; false = pre-master
 *              levels, for tests), mute ['music'|'sfx'|'vo'|'cameo'] (muted narration still
 *              ducks), solo [music group names] (tests: raw group levels).
 *
 * ── Storyboard cue → SFX type → params ──────────────────────────────────────
 *  s1  paper rustle bed ................ rustle     { dur: 5, gain: 0.8 }
 *      scattered keyboard-clatter bursts clatter    { dur: 0.5, pan }
 *      sticky-note flutters ............ flutter    { pan, pitch 0.9–1.2 }
 *      pencil scribble ................. pencil     { dur: 0.6 }
 *      googly-eye rattle + boing ....... rattle, boing
 *      washi tape rip (transition) ..... tapeRip    { t: cut − 0.1 }
 *  s2  glue-stick thwack ............... thwack
 *      paper whooshes (terminals fly) .. whoosh / swoosh { pan, dur }
 *      three ascending plinks .......... plink      { pitch: 1, 1.26, 1.5 } (or note)
 *      card flip 'fwip' x2 ............. flip
 *      typewriter clack (Terminal face). typewriter { dur: 0.6 } / clack
 *      sticky-note slap ................ slap
 *  s3  card-fan riffle ................. riffle
 *      sticker peel zip ................ peel
 *      sticker press 'thup' ............ thup
 *      rubber-stamp thunk .............. stamp
 *      envelope slide .................. envelope
 *      squishy button 'bloop' .......... bloop  (+ kazooTada on the press)
 *  s4  window-blind paper slide ........ blind      { dur: 0.8 }
 *      paper tear x5 ................... tear       (x5, pitch jitter)
 *      soft crickets bed ............... crickets   { dur }
 *      conveyor clickety-clack ......... conveyor   { dur }
 *      tiny hammer taps ................ tap        { pitch }
 *      gauge creak ..................... creak      { dur: 0.5 }
 *      sign flip clack ................. signFlip
 *      one gentle snore ................ snore
 *  s5  wind-up alarm bell ding ......... alarm      { dur: 0.8 }
 *      blind roll-up snap .............. blindUp
 *      kazoo rooster crow .............. rooster
 *      stamp thuds cascade x4 .......... stamp      (x4, pitch 1.1, 1, 0.95, 0.9)
 *      sticky-note flutter ............. flutter
 *  s6  paper swipe ..................... swish / swoosh
 *      leaf rustle ..................... rustle     { dur: 0.5, pitch: 1.3 }
 *      paper unfold (3 crinkles) ....... crinkle    (x3)
 *      pencil scratch .................. scratch
 *      postage-stamp thump ............. thump
 *      paper-airplane whoosh ........... whoosh     { dur: 0.8 } (+ toyRun)
 *      soft 'gulp' pop into the bubble . gulp
 *  s7  thumbtack 'tick' x4 ............. tack       (x4)
 *      card flap lift .................. flap
 *      button tap ...................... button
 *      yarn twang ...................... twang
 *      rubber-stamp thunk .............. stamp
 *      paper crumple ................... crumple    (+ bwomp)
 *      basket swish .................... swish      (+ plink or ding)
 *  s8  button clunk .................... clunk
 *      paper-scrap flurry .............. flurry     { dur: 1 }
 *      glue squelch x3 ................. squelch    (x3)
 *      frame snap ...................... frameSnap
 *      tiny cartoon footsteps .......... footsteps  { dur }
 *      push-pin thunk .................. pin        (+ bandHit if the hit should be musical)
 *      small crowd claps ............... claps      { dur: 1.2 }
 *      sparkle chime ................... sparkle / chime
 *  s9  collage whoosh cascade .......... whoosh     (x3, pan L→R)
 *      letter-drop pops (rhythmic) ..... letterPop  { pitch or note }
 *      washi slap ...................... slap
 *      typewriter clacks + carriage .... typewriter, carriage
 *      luggage-tag swing creak ......... creak      { pitch: 1.3 }
 *      final bright 'ding' + paper pop . ding, pop
 *  any page turn / swipe ............... swirl      { dir: 1 | -1 } (music-style harp swirl)
 *  also: snareRoll, toyRun, bandHit, kazooTada, honk, bwomp, cuckoo, slideUp, slideDown,
 *        sparkle, chime, blip, shutter, applause, zzz, paper, snip, tape, typing, pluck, tick, tock.
 *  engine transitions: wipe → swoosh, drop → slideDown, tape → tape (tapeRip is the sharper rip),
 *        pan → whoosh, tilt → slideUp. Every SFX is high-passed at 55 Hz, loudness-matched,
 *        and soft-capped at −5 dBFS per cue before the mix. Full list: AUDIO.SFX_META.
 */
(function () {
  'use strict'
  const SR = 48000
  const TAU = Math.PI * 2
  const VO_LUFS = -18 // every narration clip is matched to this before its gain (pre-master)
  const CAMEO_LUFS = -17 // cameos are exclamations: a touch hotter than narration, then × gain
  const MUSIC_LUFS = -21 // the unducked music bed, integrated over the film (pre-master)
  const SFX_REF = -21.5 // 200 ms-window max loudness of an SFX at gain 1 (≈ 6 dB under speech peaks)
  const SFX_PEAK = -5 // sample-peak ceiling of one cue at gain 1 (pre-master)
  const DUCK = Math.pow(10, -10 / 20)
  const TARGET_LUFS = -16 // final mix before the renderer's loudnorm (I=-15)
  const CEIL = Math.pow(10, -1.5 / 20) // limiter ceiling (≈ true peak, interpolated detection)

  const midi = (m) => 440 * Math.pow(2, (m - 69) / 12)
  const db = (d) => Math.pow(10, d / 20)
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
  const lerp = (a, b, p) => a + (b - a) * p
  const rngOf = (...k) => K.rng('audio', ...k)
  const ns = (s) => Math.max(1, Math.round(s * SR))

  // ════════════════════════════ tiny DSP toolkit ════════════════════════════
  function noise(n, r) {
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = r() * 2 - 1
    return x
  }
  const LP = 0
  const BP = 1
  const HP = 2
  /** TPT state-variable filter. fc = Hz or (tSeconds) => Hz. BP is unity-gain at centre. */
  function svf(x, fc, q = 0.707, mode = LP) {
    const n = x.length
    const y = new Float32Array(n)
    const k = 1 / q
    let ic1 = 0
    let ic2 = 0
    let a1 = 0
    let a2 = 0
    let a3 = 0
    const set = (f) => {
      const g = Math.tan((Math.PI * clamp(f, 16, SR * 0.46)) / SR)
      a1 = 1 / (1 + g * (g + k))
      a2 = g * a1
      a3 = g * a2
    }
    const dyn = typeof fc === 'function'
    set(dyn ? fc(0) : fc)
    for (let i = 0; i < n; i++) {
      if (dyn && (i & 31) === 0) set(fc(i / SR))
      const v0 = x[i]
      const v3 = v0 - ic2
      const v1 = a1 * ic1 + a2 * v3
      const v2 = ic2 + a2 * ic1 + a3 * v3
      ic1 = 2 * v1 - ic1
      ic2 = 2 * v2 - ic2
      if (ic1 < 1e-20 && ic1 > -1e-20) ic1 = 0 // flush denormals
      if (ic2 < 1e-20 && ic2 > -1e-20) ic2 = 0
      y[i] = mode === LP ? v2 : mode === BP ? k * v1 : v0 - k * v1 - v2
    }
    return y
  }
  /** multiply x in place by fn(tSeconds) */
  function env(x, fn) {
    for (let i = 0; i < x.length; i++) x[i] *= fn(i / SR)
    return x
  }
  const AD = (a, tau) => (t) => (t < a ? t / a : Math.exp(-(t - a) / tau))
  const ASR = (a, hold, rel) => (t) => (t < a ? t / a : t < a + hold ? 1 : Math.max(0, 1 - (t - a - hold) / rel))
  const ex = (tau) => (t) => Math.exp(-t / tau)
  function blep(t, dt) {
    if (t < dt) {
      t /= dt
      return t + t - t * t - 1
    }
    if (t > 1 - dt) {
      t = (t - 1) / dt
      return t * t + t + t + 1
    }
    return 0
  }
  /** oscillator: f = Hz or (t) => Hz; type sin | tri | saw | sqr (band-limited saw/sqr) */
  function osc(n, f, type = 'sin', ph = 0) {
    const y = new Float32Array(n)
    const dyn = typeof f === 'function'
    let p = ph % 1
    let dt = (dyn ? f(0) : f) / SR
    for (let i = 0; i < n; i++) {
      if (dyn && (i & 7) === 0) dt = f(i / SR) / SR
      let v
      if (type === 'sin') v = Math.sin(TAU * p)
      else if (type === 'tri') v = 4 * Math.abs(p - 0.5) - 1
      else if (type === 'saw') v = 2 * p - 1 - blep(p, dt)
      else v = (p < 0.5 ? 1 : -1) + blep(p, dt) - blep((p + 0.5) % 1, dt)
      y[i] = v
      p += dt
      if (p >= 1) p -= 1
    }
    return y
  }
  const chirp = (len, f, e, type = 'sin', ph = 0) => env(osc(ns(len), f, type, ph), e)
  const burst = (len, r, fc, q, mode, e) => env(svf(noise(ns(len), r), fc, q, mode), e)
  /** sum parts [[arr, gain, atSeconds]] into a buffer of len seconds */
  function sum(len, parts) {
    const y = new Float32Array(ns(len))
    for (const [x, g = 1, at = 0] of parts) mixIn(y, x, g, at)
    return y
  }
  function mixIn(dst, src, g = 1, at = 0) {
    const o = Math.round(at * SR)
    const a = Math.max(0, -o)
    const b = Math.min(src.length, dst.length - o)
    for (let i = a; i < b; i++) dst[i + o] += src[i] * g
    return dst
  }
  function peakOf(x) {
    let p = 0
    for (let i = 0; i < x.length; i++) {
      const v = Math.abs(x[i])
      if (v > p) p = v
    }
    return p
  }
  function normPeak(x, to = 1) {
    const p = peakOf(x)
    if (p > 0) for (let i = 0; i < x.length; i++) x[i] *= to / p
    return x
  }
  /** drop the silent tail (below −80 dB of peak) and fade the last 5 ms */
  function trim(x) {
    const p = peakOf(x) * 1e-4
    let e = x.length
    while (e > 1 && Math.abs(x[e - 1]) < p) e--
    const y = x.slice(0, Math.min(x.length, e + 64))
    const f = Math.min(y.length, ns(0.005))
    for (let i = 0; i < f; i++) y[y.length - 1 - i] *= i / f
    return y
  }
  /** variable-rate resampling: rate(t) (1 = unchanged) */
  function warp(x, rate) {
    const out = []
    let p = 0
    while (p < x.length - 1) {
      const k = p | 0
      const fr = p - k
      out.push(x[k] + (x[k + 1] - x[k]) * fr)
      p += rate(out.length / SR)
    }
    return Float32Array.from(out)
  }
  function resample(x, ratio) {
    // ratio = srcRate / SR
    if (Math.abs(ratio - 1) < 1e-9) return x
    const n = Math.floor((x.length - 1) / ratio)
    const y = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const p = i * ratio
      const k = p | 0
      const fr = p - k
      y[i] = x[k] + ((x[k + 1] ?? x[k]) - x[k]) * fr
    }
    return y
  }
  /** paper crackle: Poisson grains of noise. rate grains/s (or fn of t), amp(t), grain 0.2–1.6 ms */
  function crackle(len, r, rate, amp = () => 1, { g0 = 0.2, g1 = 1.6, pow = 2 } = {}) {
    const n = ns(len)
    const x = new Float32Array(n)
    let t = 0
    for (;;) {
      const rt = Math.max(1, typeof rate === 'function' ? rate(t) : rate)
      t += -Math.log(1 - r() * 0.999) / rt
      if (t >= len) break
      const i0 = Math.floor(t * SR)
      const a = Math.pow(r(), pow) * amp(t) * (r() < 0.5 ? -1 : 1)
      const gl = Math.max(2, Math.round(((g0 + r() * (g1 - g0)) * SR) / 1000))
      for (let j = 0; j < gl && i0 + j < n; j++) x[i0 + j] += a * (r() * 2 - 1) * Math.exp((-3 * j) / gl)
    }
    return x
  }
  /** decaying sine partials [[ratio, amp, t60]] with random phase + optional strike noise */
  function modal(f, partials, len, r, { attack = 0.0015, strike = 0, strikeFc = 5000, strikeTau = 0.0025 } = {}) {
    const n = ns(len)
    const y = new Float32Array(n)
    for (const [ratio, amp, t60] of partials) {
      const fr = f * ratio
      if (fr > SR * 0.45) continue
      const w = (TAU * fr) / SR
      const c = 2 * Math.cos(w)
      const ph = r() * TAU
      let s1 = Math.sin(ph)
      let s0 = Math.sin(ph - w)
      const dec = Math.pow(0.001, 1 / (t60 * SR))
      let a = amp
      const m = Math.min(n, ns(t60 * 1.1))
      for (let i = 0; i < m; i++) {
        y[i] += a * s1
        const s2 = c * s1 - s0
        s0 = s1
        s1 = s2
        a *= dec
      }
    }
    const na = ns(attack)
    for (let i = 0; i < na && i < n; i++) y[i] *= i / na
    if (strike > 0) mixIn(y, burst(Math.min(len, strikeTau * 8), r, strikeFc, 0.8, BP, ex(strikeTau)), strike)
    return y
  }
  /** Karplus-Strong plucked string (allpass-tuned). bright 0..1, pick = pluck position 0..0.5 */
  function ks(f, { len = 1.6, t60 = 1.2, bright = 0.5, pick = 0.2, seed = 0 } = {}) {
    const r = rngOf('ks', Math.round(f * 100), seed, bright)
    const n = ns(len)
    const y = new Float32Array(n)
    const P = SR / f - 0.5
    let N = Math.floor(P)
    let d = P - N
    if (d < 0.25) {
      N -= 1
      d += 1
    }
    const C = (1 - d) / (1 + d)
    const g = Math.pow(0.001, 1 / (t60 * f))
    const line = new Float32Array(N)
    const a = 0.04 + 0.92 * bright * bright
    let lp = 0
    let mean = 0
    const exc = new Float32Array(N)
    for (let i = 0; i < N * 3; i++) {
      lp += a * (r() * 2 - 1 - lp)
      if (i >= N * 2) exc[i - N * 2] = lp // settle the filter first
    }
    for (let i = 0; i < N; i++) mean += exc[i]
    mean /= N
    const pk = Math.max(1, Math.round(pick * N))
    let pm = 0
    for (let i = 0; i < N; i++) {
      line[i] = exc[i] - mean - (i >= pk ? exc[i - pk] - mean : 0)
      pm = Math.max(pm, Math.abs(line[i]))
    }
    for (let i = 0; i < N; i++) line[i] /= pm || 1
    let idx = 0
    let prev = 0
    let apx = 0
    let apy = 0
    for (let i = 0; i < n; i++) {
      const v = line[idx]
      y[i] = v
      const s = g * 0.5 * (v + prev)
      prev = v
      const o = C * s + apx - C * apy
      apx = s
      apy = o
      line[idx] = o
      if (++idx === N) idx = 0
    }
    return y
  }
  /** BS.1770 K-weighting (48 kHz coefficients) */
  function kw(x) {
    const y = new Float32Array(x.length)
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    let z1 = 0
    let z2 = 0
    let w1 = 0
    let w2 = 0
    for (let i = 0; i < x.length; i++) {
      const v = x[i]
      let s = 1.53512485958697 * v - 2.69169618940638 * x1 + 1.19839281085285 * x2 + 1.69065929318241 * y1 - 0.73248077421585 * y2
      if (s < 1e-20 && s > -1e-20) s = 0
      x2 = x1
      x1 = v
      y2 = y1
      y1 = s
      let o = s - 2 * z1 + z2 + 1.99004745483398 * w1 - 0.99007225036621 * w2
      if (o < 1e-20 && o > -1e-20) o = 0
      z2 = z1
      z1 = s
      w2 = w1
      w1 = o
      y[i] = o
    }
    return y
  }
  /** { integrated (gated LUFS), shortMax (max 200 ms-window LUFS), peakDb } of channel arrays */
  function loudnessOf(chans, win = 0.2) {
    const n = chans[0].length
    const cs = new Float64Array(n + 1) // prefix sum of K-weighted power (all channels)
    const k = chans.map(kw)
    for (let i = 0; i < n; i++) {
      let p = 0
      for (let c = 0; c < k.length; c++) p += k[c][i] * k[c][i]
      cs[i + 1] = cs[i] + p
    }
    const ms = (a, len) => (cs[Math.min(n, a + len)] - cs[a]) / len
    const lu = (m) => -0.691 + 10 * Math.log10(m + 1e-20)
    // gated integrated: 400 ms blocks, 75 % overlap
    const bl = ns(0.4)
    const hop = ns(0.1)
    const blocks = []
    for (let a = 0; a + bl <= n; a += hop) blocks.push(ms(a, bl))
    if (!blocks.length && n) blocks.push(ms(0, n))
    const abs = blocks.filter((m) => lu(m) > -70)
    let integrated = -Infinity
    if (abs.length) {
      const rel = lu(abs.reduce((a, b) => a + b, 0) / abs.length) - 10
      const g = abs.filter((m) => lu(m) > rel)
      if (g.length) integrated = lu(g.reduce((a, b) => a + b, 0) / g.length)
    }
    const w = Math.max(1, Math.min(n, ns(win)))
    let best = 0
    for (let a = 0; a + w <= n; a += 48) best = Math.max(best, ms(a, w))
    let pk = 0
    for (const c of chans) pk = Math.max(pk, peakOf(c))
    return { integrated, shortMax: lu(best), peakDb: 20 * Math.log10(pk + 1e-20) }
  }
  /** RBJ biquad in place (type 'hp' | 'peak' | 'lp'), direct form I */
  function biq(x, type, f, gainDb = 0, q = 0.707) {
    const w = (TAU * f) / SR
    const c = Math.cos(w)
    const al = Math.sin(w) / (2 * q)
    const A = Math.pow(10, gainDb / 40)
    let b0, b1, b2, a0, a1, a2
    if (type === 'hp') [b0, b1, b2, a0, a1, a2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al]
    else if (type === 'lp') [b0, b1, b2, a0, a1, a2] = [(1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al]
    else [b0, b1, b2, a0, a1, a2] = [1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A]
    b0 /= a0
    b1 /= a0
    b2 /= a0
    a1 /= a0
    a2 /= a0
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < x.length; i++) {
      const v = x[i]
      let y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      if (y < 1e-20 && y > -1e-20) y = 0 // flush denormals (silence would crawl otherwise)
      x2 = x1
      x1 = v
      y2 = y1
      y1 = y
      x[i] = y
    }
    return x
  }
  /** soft ceiling: transparent below cap·10^(−knee/20) (default cap/2), then a tanh knee that never exceeds cap */
  function softCap(x, cap, kneeDb = 6) {
    const a = cap * Math.pow(10, -kneeDb / 20)
    const b = cap - a
    for (let i = 0; i < x.length; i++) {
      const v = x[i]
      const m = v < 0 ? -v : v
      if (m > a) x[i] = (v < 0 ? -1 : 1) * (a + b * Math.tanh((m - a) / b))
    }
    return x
  }
  /** stereo-linked feed-forward compressor (RMS detector, soft knee, no auto make-up) */
  function compress(L, R, { thr = -20, ratio = 2, knee = 6, att = 0.005, rel = 0.12, rms = 0.01 } = {}) {
    const aD = Math.exp(-1 / (rms * SR))
    const aA = Math.exp(-1 / (att * SR))
    const aR = Math.exp(-1 / (rel * SR))
    const sl = 1 / ratio - 1
    let m = 0
    let gr = 0
    let maxGr = 0
    for (let i = 0; i < L.length; i++) {
      m = aD * m + (1 - aD) * 0.5 * (L[i] * L[i] + R[i] * R[i])
      if (m < 1e-30) m = 0
      const over = 10 * Math.log10(m + 1e-12) - thr
      const t = over <= -knee / 2 ? 0 : over < knee / 2 ? (-sl * (over + knee / 2) ** 2) / (2 * knee) : -sl * over
      gr = t > gr ? aA * gr + (1 - aA) * t : aR * gr + (1 - aR) * t
      if (gr < 1e-9) gr = 0
      if (gr > maxGr) maxGr = gr
      const g = Math.pow(10, -gr / 20)
      L[i] *= g
      R[i] *= g
    }
    return maxGr
  }

  // ════════════════════════════ instrument banks ════════════════════════════
  // Notes are rendered once per page (pure functions of their key) and cached.
  const BANK = new Map()
  function bank(key, make) {
    let v = BANK.get(key)
    if (!v) {
      v = make()
      BANK.set(key, v)
    }
    return v
  }
  /** nylon ukulele string: KS + small wooden body (layer 0 soft .. 2 hard) */
  const ukeN = (m, layer = 1, v = 0) =>
    bank(`uke${m}.${layer}.${v}`, () => {
      const f = midi(m)
      const x = ks(f, { len: 2.2, t60: 1.5 * Math.pow(262 / f, 0.3), bright: [0.32, 0.5, 0.7][layer], pick: 0.19 + v * 0.03, seed: v })
      const body = svf(x, 270, 1.4, BP)
      const body2 = svf(x, 560, 2.2, BP)
      for (let i = 0; i < x.length; i++) x[i] += 0.55 * body[i] + 0.3 * body2[i]
      return trim(normPeak(svf(x, 6500, 0.6, LP)))
    })
  /** pizzicato double-bass / cello */
  const pizzN = (m) =>
    bank(`pizz${m}`, () => {
      const f = midi(m)
      const x = ks(f, { len: 1.3, t60: 0.62, bright: 0.3, pick: 0.27, seed: 3 })
      const b = svf(x, 140, 1.1, BP)
      for (let i = 0; i < x.length; i++) x[i] += 0.5 * b[i]
      const thump = chirp(0.06, f, ex(0.018))
      mixIn(x, thump, 0.35)
      return trim(normPeak(svf(x, 2400, 0.7, LP)))
    })
  /** high pizzicato (viola range) for the melody variation */
  const pizzHiN = (m) =>
    bank(`pzh${m}`, () => {
      const f = midi(m)
      const x = ks(f, { len: 1, t60: 0.45, bright: 0.38, pick: 0.22, seed: 5 })
      const b = svf(x, 420, 1.3, BP)
      for (let i = 0; i < x.length; i++) x[i] += 0.4 * b[i]
      return trim(normPeak(svf(x, 4200, 0.7, LP)))
    })
  const harpN = (m) =>
    bank(`harp${m}`, () => {
      const f = midi(m)
      return trim(normPeak(svf(ks(f, { len: 2.6, t60: 2.2 * Math.pow(262 / f, 0.25), bright: 0.58, pick: 0.12, seed: 7 }), 7000, 0.6, LP)))
    })
  /** glockenspiel bar: free-free bar partials + mallet tick */
  const glockN = (m) =>
    bank(`glk${m}`, () => {
      const f = midi(m)
      const k = Math.pow(1047 / f, 0.35)
      const p = [
        [1, 1, 2.4 * k],
        [2.756, 0.3, 0.6 * k],
        [5.404, 0.12, 0.2 * k],
        [8.933, 0.05, 0.09 * k],
      ]
      return trim(normPeak(modal(f, p, 2.8 * k + 0.2, rngOf('glk', m), { strike: 0.22, strikeFc: 6500 })))
    })
  /** music box comb tine: bright ping + shimmer (two slightly detuned tines) */
  const mboxN = (m) =>
    bank(`mbox${m}`, () => {
      const f = midi(m)
      const r = rngOf('mbox', m)
      const a = modal(f, [[1, 1, 2.2], [2.0, 0.05, 0.8], [5.93, 0.26, 0.22], [9.9, 0.07, 0.08]], 2.5, r, { strike: 0.35, strikeFc: 7200, strikeTau: 0.0015 })
      mixIn(a, modal(f * 1.0016, [[1, 1, 2.0]], 2.4, r), 0.32)
      return trim(normPeak(a))
    })
  /** toy piano rod: clanky inharmonic partials */
  const toyN = (m) =>
    bank(`toy${m}`, () => {
      const f = midi(m)
      return trim(normPeak(modal(f, [[1, 1, 1.1], [2.01, 0.34, 0.5], [3.93, 0.22, 0.2], [6.27, 0.12, 0.09]], 1.4, rngOf('toy', m), { strike: 0.32, strikeFc: 3800 })))
    })
  /** felt piano: soft hammer, two detuned strings, dark tone */
  const feltN = (m) =>
    bank(`felt${m}`, () => {
      const f = midi(m)
      const r = rngOf('felt', m)
      const B = 0.00035
      const base = 3.4 * Math.pow(262 / f, 0.4)
      const p = []
      for (let h = 1; h <= 8; h++) {
        const ratio = h * Math.sqrt(1 + B * h * h)
        const amp = Math.pow(h, -1.25) / (1 + Math.pow((h * f) / 1100, 2))
        const t60 = base / (1 + 0.55 * (h - 1))
        p.push([ratio, amp, t60], [ratio * 1.0007, amp * 0.6, t60 * 1.35])
      }
      const x = modal(f, p, base + 0.3, r, { attack: 0.004 })
      mixIn(x, burst(0.08, r, 320, 0.7, LP, ex(0.012)), 0.25 * peakOf(x))
      return trim(normPeak(x))
    })
  const clapN = (v) =>
    bank(`clap${v}`, () => {
      const r = rngOf('clap', v)
      const x = new Float32Array(ns(0.3))
      const offs = [0, 0.006 + r() * 0.004, 0.014 + r() * 0.005, 0.022 + r() * 0.006]
      offs.forEach((o, j) => {
        const last = j === offs.length - 1
        mixIn(x, env(noise(ns(last ? 0.25 : 0.02), r), ex(last ? 0.04 : 0.003)), last ? 0.85 : 0.65 + r() * 0.35, o)
      })
      const a = svf(x, 1100 + r() * 400, 1.1, BP)
      const b = svf(x, 2500 + r() * 600, 1.6, BP)
      for (let i = 0; i < a.length; i++) a[i] += 0.35 * b[i]
      return trim(normPeak(a))
    })
  const shakerN = (v) =>
    bank(`shk${v}`, () => {
      const r = rngOf('shk', v)
      return trim(normPeak(env(svf(svf(noise(ns(0.12), r), 6200 + r() * 1200, 0.9, BP), 3000, 0.7, HP), (t) => (t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) / 0.03)))))
    })
  const kickN = () =>
    bank('kick', () => {
      const r = rngOf('kick')
      const b = chirp(0.3, (t) => 58 + 64 * Math.exp(-t / 0.026), ex(0.075))
      mixIn(b, burst(0.03, r, 1800, 0.8, BP, ex(0.003)), 0.25)
      mixIn(b, burst(0.08, r, 260, 1.2, BP, ex(0.02)), 0.4)
      return trim(normPeak(svf(b, 45, 0.7, HP)))
    })
  const snareN = (v) =>
    bank(`snr${v}`, () => {
      const r = rngOf('snr', v)
      const body = chirp(0.2, (t) => 185 + 30 * Math.exp(-t / 0.01), ex(0.045))
      mixIn(body, chirp(0.1, 330, ex(0.025), 'sin', r()), 0.45)
      const w = svf(svf(noise(ns(0.3), r), 1700, 0.7, HP), 5200, 0.55, BP)
      env(w, ex(0.075 + r() * 0.02))
      return trim(normPeak(sum(0.3, [[body, 0.55], [w, 1]])))
    })
  /** woodblock: tick (hi) / tock (lo) */
  const blockN = (f) =>
    bank(`blk${f}`, () => trim(normPeak(modal(f, [[1, 1, 0.07], [2.43, 0.35, 0.04], [4.1, 0.12, 0.02]], 0.14, rngOf('blk', f), { attack: 0.0004, strike: 0.25, strikeFc: 3000, strikeTau: 0.001 }))))
  /** brittle mantel-clock tick */
  const clockN = (hi) =>
    bank(`clk${hi}`, () => {
      const f = hi ? 2900 : 2200
      const r = rngOf('clk', hi)
      const x = modal(f, [[1, 1, 0.025], [1.73, 0.6, 0.018], [2.91, 0.4, 0.012]], 0.06, r, { attack: 0.0003 })
      mixIn(x, burst(0.01, r, 5500, 0.8, BP, ex(0.0008)), 0.9)
      return trim(normPeak(x))
    })
  const tambN = () =>
    bank('tamb', () => {
      const r = rngOf('tamb')
      const n = ns(0.55)
      const y = new Float32Array(n)
      for (let j = 0; j < 7; j++) {
        const f = 5200 + r() * 5200
        const tau = 0.08 + r() * 0.14
        const ph = r() * TAU
        const am = 30 + r() * 22
        for (let i = 0; i < n; i++) {
          const t = i / SR
          y[i] += Math.sin(ph + TAU * f * t) * Math.exp(-t / tau) * (0.6 + 0.4 * Math.sin(TAU * am * t)) * 0.3
        }
      }
      mixIn(y, burst(0.45, r, 7800, 0.7, BP, ex(0.11)), 0.7)
      const a = ns(0.0015)
      for (let i = 0; i < a; i++) y[i] *= i / a
      return trim(normPeak(y))
    })

  // ═══════════════════════════ voice-ish synths ═════════════════════════════
  /** kazoo: buzzy saw+square through vocal formants, rasp, scoop & vibrato.
   *  notes [[at, dur, midi, { scoop, fall, vib }]] */
  function kazoo(notes, r, { vib = 0.32, rasp = 0.3 } = {}) {
    const end = notes.reduce((a, x) => Math.max(a, x[0] + x[1]), 0) + 0.08
    const n = ns(end)
    const s = new Float32Array(n)
    const amp = new Float32Array(n)
    let ph = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      let nt = notes[0]
      for (const x of notes) if (x[0] <= t) nt = x
      const [at, dur, m, op = {}] = nt
      const u = Math.max(0, t - at)
      let p = m - (op.scoop ?? 0.8) * Math.exp(-u / 0.03)
      if (op.fall) p -= op.fall * Math.pow(clamp((u - dur * 0.45) / (dur * 0.55), 0, 1), 2)
      p += (op.vib ?? vib) * Math.sin(TAU * 5.8 * u) * clamp((u - 0.08) / 0.12, 0, 1)
      const dt = midi(p) / SR
      const saw = 2 * ph - 1 - blep(ph, dt)
      const sq = (ph < 0.5 ? 1 : -1) + blep(ph, dt) - blep((ph + 0.5) % 1, dt)
      s[i] = Math.tanh(1.5 * (saw * 0.8 + sq * 0.3))
      ph += dt
      if (ph >= 1) ph -= 1
      amp[i] = t < at ? 0 : u < 0.014 ? u / 0.014 : u < dur ? 1 - 0.12 * clamp((u - 0.1) / Math.max(0.1, dur), 0, 1) : Math.max(0, 1 - (u - dur) / 0.035)
    }
    const f1 = svf(s, 720, 2.6, BP)
    const f2 = svf(s, 1320, 3.6, BP)
    const f3 = svf(s, 2750, 5, BP)
    const hi = svf(s, 1800, 0.7, HP)
    const rn = normPeak(svf(noise(n, r), 85, 0.7, LP))
    const y = new Float32Array(n)
    for (let i = 0; i < n; i++) y[i] = (f1[i] + 0.7 * f2[i] + 0.45 * f3[i] + 0.1 * hi[i]) * amp[i] * (1 + rasp * rn[i])
    return normPeak(svf(y, 280, 0.7, HP), 0.9)
  }
  /** slide whistle: sine + breath; f(t) Hz, len s */
  function slideWhistle(len, f, r, e = ASR(0.03, len - 0.1, 0.07)) {
    const n = ns(len)
    const x = osc(n, f, 'sin')
    const h = osc(n, (t) => 2 * f(t), 'sin')
    const b = svf(noise(n, r), (t) => f(t) * 1.5, 1.2, BP)
    for (let i = 0; i < n; i++) x[i] = (x[i] + 0.06 * h[i] + 0.12 * b[i]) * e(i / SR)
    return x
  }
  /** pad: detuned saws (L/R) through a slow, warm low-pass. → [L, R] */
  function padBuf(len, notes, r, { attack = 0.8, release = 1.2, cutoff = 640 } = {}) {
    const n = ns(len + release)
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    notes.forEach((m) => {
      const f = midi(m)
      mixIn(L, osc(n, f * Math.pow(2, -7 / 1200), 'saw', r()), 1)
      mixIn(R, osc(n, f * Math.pow(2, 7 / 1200), 'saw', r()), 1)
      mixIn(L, osc(n, f * Math.pow(2, 3 / 1200), 'saw', r()), 0.5)
      mixIn(R, osc(n, f * Math.pow(2, -3 / 1200), 'saw', r()), 0.5)
    })
    const fc = (t) => cutoff + 110 * Math.sin(TAU * 0.18 * t)
    const out = [svf(svf(L, fc, 0.55, LP), 2400, 0.5, LP), svf(svf(R, fc, 0.55, LP), 2400, 0.5, LP)]
    const e = (t) => (t < attack ? Math.pow(Math.sin(((t / attack) * Math.PI) / 2), 2) : t < len ? 1 : Math.exp(-(t - len) / (release / 4)))
    out.forEach((c) => env(c, e))
    return out
  }

  // ═══════════════════════════════ mixer ════════════════════════════════════
  /** stereo stem + reverb-send stem */
  const stem = (n) => ({ n, L: new Float32Array(n), R: new Float32Array(n), sL: new Float32Array(n), sR: new Float32Array(n) })
  /** add src (mono Float32Array or [L, R]) at t seconds. pan −1..1 (constant power for mono),
   *  send = reverb amount, rate = playback-rate (pitch), cut = seconds before a fade (fade s). */
  function put(S, src, t, gain, pan = 0, send = 0, { rate = 1, cut = Infinity, fade = 0.015 } = {}) {
    if (!(gain > 0)) return
    const st = Array.isArray(src)
    const len = st ? src[0].length : src.length
    const cutN = Math.floor(cut * SR)
    const fadeN = Math.max(1, Math.floor(fade * SR))
    const outLen = Math.min(Math.floor((len - 1) / rate), cutN + fadeN)
    const o = Math.round(t * SR)
    pan = clamp(pan, -1, 1)
    let gl
    let gr
    if (st) {
      gl = gain * (pan > 0 ? 1 - pan : 1)
      gr = gain * (pan < 0 ? 1 + pan : 1)
    } else {
      gl = gain * Math.cos(((pan + 1) * Math.PI) / 4)
      gr = gain * Math.sin(((pan + 1) * Math.PI) / 4)
    }
    const a = Math.max(0, -o)
    const b = Math.min(outLen, S.n - o)
    const A = st ? src[0] : src
    const B = st ? src[1] : src
    for (let i = a; i < b; i++) {
      let vl
      let vr
      if (rate === 1) {
        vl = A[i]
        vr = B[i]
      } else {
        const p = i * rate
        const k = p | 0
        const fr = p - k
        vl = A[k] + (A[k + 1] - A[k]) * fr
        vr = st ? B[k] + (B[k + 1] - B[k]) * fr : vl
      }
      const e = i > cutN ? Math.max(0, 1 - (i - cutN) / fadeN) : 1
      const j = i + o
      const l = vl * gl * e
      const rr = vr * gr * e
      S.L[j] += l
      S.R[j] += rr
      if (send) {
        S.sL[j] += l * send
        S.sR[j] += rr * send
      }
    }
  }
  // music groups: gain, reverb send, base pan
  const GROUPS = {
    uke: { g: 0.34, send: 0.16, pan: -0.2 },
    bass: { g: 0.62, send: 0.04, pan: 0.03 },
    bell: { g: 0.225, send: 0.34, pan: 0.22 },
    keys: { g: 0.34, send: 0.26, pan: 0.12 },
    harp: { g: 0.22, send: 0.4, pan: 0 },
    perc: { g: 0.38, send: 0.1, pan: 0 },
    pad: { g: 0.02, send: 0.45, pan: 0 },
    lead: { g: 0.26, send: 0.2, pan: -0.08 },
  }
  function musicMixer(n, solo) {
    const S = stem(n)
    S.put = (group, src, t, vel, pan = 0, opt) => {
      if (solo && !solo.includes(group)) return
      const G = GROUPS[group]
      put(S, src, t, vel * G.g, G.pan + pan, G.send, opt)
    }
    return S
  }

  // ═══════════════════════════════ the score ════════════════════════════════
  // F major, 104 BPM. Ukulele shapes in string order G C E A (re-entrant), bass
  // notes [root, third, fifth], pad voicings.
  const CHORD = {
    F: { uke: [69, 60, 65, 69], bass: [41, 45, 48], pad: [53, 57, 60, 65] },
    Dm: { uke: [69, 62, 65, 69], bass: [38, 41, 45], pad: [50, 57, 62, 65] },
    Bb: { uke: [70, 62, 65, 70], bass: [46, 50, 41], pad: [50, 53, 58, 62] },
    C: { uke: [67, 60, 64, 72], bass: [48, 52, 43], pad: [52, 55, 60, 64] },
    C7: { uke: [67, 60, 64, 70], bass: [48, 52, 43], pad: [52, 55, 58, 64] },
  }
  // The motif: [beat, midi, beats]. Phrase A asks (ends on the dominant), B answers.
  const MOTIF_A = [
    { ch: ['F'], mel: [[0, 81, 0.5], [0.5, 84, 0.5], [1, 89, 1], [2, 88, 0.5], [2.5, 86, 0.5], [3, 84, 1]] },
    { ch: ['Dm'], mel: [[0, 86, 0.5], [0.5, 89, 0.5], [1, 93, 1], [2, 91, 0.5], [2.5, 89, 0.5], [3, 86, 1]] },
    { ch: ['Bb'], mel: [[0, 86, 0.5], [0.5, 84, 0.5], [1, 82, 0.5], [1.5, 86, 0.5], [2, 89, 1.5], [3.5, 86, 0.5]] },
    { ch: ['C'], mel: [[0, 84, 0.5], [0.5, 86, 0.5], [1, 88, 0.5], [1.5, 91, 0.5], [2, 88, 2]] },
  ]
  const MOTIF_B = [
    MOTIF_A[0],
    MOTIF_A[1],
    { ch: ['Bb', 'C'], mel: [[0, 86, 0.5], [0.5, 89, 0.5], [1, 86, 0.5], [1.5, 82, 0.5], [2, 84, 0.5], [2.5, 88, 0.5], [3, 91, 1]] },
    { ch: ['F'], mel: [[0, 89, 2], [2, 84, 0.5], [2.5, 81, 0.5], [3, 77, 1]] },
  ]
  const CADENCE = [[0, 79, 0.5], [0.5, 81, 0.5], [1, 82, 0.5], [1.5, 84, 0.5], [2, 88, 1.6]]
  // strum pattern per 8th slot: D - D U - U D U
  const STRUM = { 0: ['D', 1], 2: ['D', 0.72], 3: ['U', 0.5], 5: ['U', 0.55], 6: ['D', 0.7], 7: ['U', 0.48] }
  const UKE_PAN = [-0.28, -0.22, -0.14, -0.08]
  const MOODS = new Set(['chaos', 'full', 'night', 'sunrise', 'build', 'finale', 'soft'])

  function normMoods(plan) {
    const src = plan.moods && plan.moods.length ? plan.moods : [{ start: 0, end: plan.duration, mood: 'full' }]
    const secs = src
      .map((m) => Object.assign({}, m, { mood: MOODS.has(m.mood) ? m.mood : 'full' }))
      .sort((a, b) => a.start - b.start)
    secs[0].start = Math.min(secs[0].start, 0)
    secs[secs.length - 1].end = Math.max(secs[secs.length - 1].end, plan.duration)
    return secs
  }
  const chordAt = (bar, pos) => (bar.ch.length > 1 && pos >= 2 ? bar.ch[1] : bar.ch[0])
  function hum(amt, ...k) {
    return (rngOf('hum', ...k)() - 0.5) * 2 * amt
  }

  function scoreMusic(plan, M) {
    const dur = plan.duration
    const bpm = plan.bpm > 0 ? plan.bpm : 104
    const beat = 60 / bpm
    const b0 = plan.beat0 || 0
    const X = {
      dur,
      beat,
      bar: 4 * beat,
      sw: 0.08 * beat, // light swing on the off-beat 8ths
      gridAt: (t) => b0 + Math.ceil((t - b0) / beat - 1e-6) * beat,
      nearBeat: (t) => b0 + Math.round((t - b0) / beat) * beat,
      secs: normMoods(plan),
      chokes: [],
    }
    const secs = X.secs
    X.secAt = (t) => {
      for (const s of secs) if (t < s.end) return s
      return secs[secs.length - 1]
    }
    X.nextOf = (s) => secs[secs.indexOf(s) + 1]
    const fin = secs.find((s) => s.mood === 'finale')
    if (fin) {
      const want = Number.isFinite(plan.logoTime) ? plan.logoTime : fin.start + 0.2
      X.L = clamp(want, fin.start - 1, Math.max(fin.start, dur - 1.6))
    }
    const segs = []
    let cur = null
    let fullIdx = -1
    const close = () => {
      if (cur) segs.push(cur)
      cur = null
    }
    secs.forEach((s, i) => {
      const prev = secs[i - 1]
      if (s.mood === 'full' || s.mood === 'soft') s.variant = ++fullIdx % 4
      if (s.mood === 'chaos') {
        close()
        let stop = X.nearBeat(s.end - beat * 0.5)
        if (stop <= s.start + beat) stop = s.end
        chaos(M, s.start, stop, X)
        s.resume = stop + beat
        X.chokes.push([stop, stop + beat])
      } else if (s.mood === 'night') {
        close()
        night(M, s, X)
      } else if (s.mood === 'sunrise') {
        close()
        // the band lands on the first beat after any cameo that opens the scene ("Check!" x3)
        let want = s.start + Math.min(0.5, (s.end - s.start) * 0.3)
        for (const v of plan.vo || []) {
          if (v && v.kind === 'cameo' && v.buffer && v.start < s.start + 1.6 && v.start >= s.start - 0.2) want = Math.max(want, v.start + v.buffer.duration - 0.12)
        }
        const D = X.gridAt(Math.min(want, s.start + 2.2))
        gliss(M, s.start, D)
        cur = { anchor: D, end: s.end, accent: true }
      } else if (s.mood === 'finale') {
        if (cur) cur.end = Math.max(cur.end, X.L)
        close()
      } else {
        if (!cur) {
          const fromChaos = prev && prev.mood === 'chaos'
          cur = { anchor: fromChaos ? prev.resume : X.gridAt(s.start), end: s.end, accent: fromChaos }
        } else cur.end = s.end
      }
    })
    close()
    for (const sg of segs) band(M, sg, X)
    if (fin) finale(M, X)
    // a harp/glock swirl on every other cut
    for (let i = 1; i < secs.length; i++) {
      const s = secs[i]
      const p = secs[i - 1]
      if (p.mood === 'chaos' || s.mood === 'sunrise' || s.mood === 'finale') continue
      swirl(M, s.start, s.mood === 'night' ? -1 : 1, s.mood === 'night' ? 0.8 : 1)
    }
    return X
  }

  // ---- ukulele / bass voices with string damping ----
  function strum(list, t, shape, dir, vel, layer, key) {
    const order = dir === 'D' ? [0, 1, 2, 3] : [3, 2, 1]
    const spread = dir === 'D' ? 0.013 : 0.009
    order.forEach((s, j) => {
      list.push({ t: t + j * spread + hum(0.002, key, s), s, m: shape[s], v: vel * (dir === 'U' ? 0.8 : 1) * (1 - 0.04 * j), layer, key })
    })
  }
  function renderUke(M, list, hardEnd) {
    list.sort((a, b) => a.t - b.t)
    const next = [Infinity, Infinity, Infinity, Infinity]
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      e.cut = Math.min(1.8, next[e.s] - e.t - 0.004, hardEnd - e.t)
      next[e.s] = e.t
    }
    for (const e of list) if (e.cut > 0) M.put('uke', ukeN(e.m, e.layer, (e.s + Math.round(e.t * 7)) % 2), e.t, e.v, UKE_PAN[e.s], { cut: e.cut, fade: 0.018 })
  }
  function renderBass(M, list, hardEnd, group = 'bass', N = pizzN) {
    list.sort((a, b) => a.t - b.t)
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      const nx = list[i + 1] ? list[i + 1].t : Infinity
      const cut = Math.min(e.d, nx - e.t - 0.005, hardEnd - e.t)
      if (cut > 0) M.put(group, N(e.m), e.t, e.v, e.pan || 0, { cut, fade: 0.03 })
    }
  }
  function clapPair(M, t, v, key) {
    M.put('perc', clapN(Math.floor(rngOf('cv', key)() * 8)), t + hum(0.002, key, 'c1'), v, -0.38)
    M.put('perc', clapN(8 + Math.floor(rngOf('cv2', key)() * 8)), t + 0.011 + hum(0.002, key, 'c2'), v * 0.85, 0.38)
  }

  /** the band, bar by bar over one segment { anchor, end, bars?, accent, skipFirstStrum } */
  function band(M, sg, X) {
    const { beat, bar, sw } = X
    const bars = sg.bars || []
    if (!sg.bars) {
      for (let k = 0; ; k++) {
        const t0 = sg.anchor + k * bar
        if (t0 >= sg.end - 0.05) break
        const m = (Math.floor(k / 4) % 2 === 0 ? MOTIF_A : MOTIF_B)[k % 4]
        bars.push({ t0, beats: 4, ch: m.ch, mel: m.mel, phraseEnd: k % 4 === 3, phraseStart: k % 4 === 0, k })
      }
    }
    const end = sg.end
    const builds = X.secs
      .filter((s) => s.mood === 'build' && s.end > sg.anchor - 0.01 && s.start < end)
      .map((s) => {
        const nx = X.nextOf(s)
        const H = Number.isFinite(s.hit) ? s.hit : nx && nx.mood === 'finale' ? X.L : s.end
        return { s, H }
      })
    const uke = []
    const bass = []
    const mel = []
    for (const B of bars) {
      const nextRoot = CHORD[(bars[bars.indexOf(B) + 1] || B).ch[0]].bass[0]
      for (let q = 0; q < B.beats * 2; q++) {
        const pos = q / 2
        const t = B.t0 + pos * beat + (q % 2 ? sw : 0)
        if (t < sg.anchor - 1e-6 || t >= end - 0.03) continue
        const sec = X.secAt(t)
        const bd = builds.find((b) => t >= b.s.start - 1e-6 && t < b.H - 0.02)
        const mood = bd ? 'build' : sec.mood === 'soft' ? 'soft' : 'full'
        const vi = sec.mood === 'full' ? sec.variant || 0 : 0
        const ch = CHORD[chordAt(B, pos)]
        const prog = bd ? clamp((t - bd.s.start) / Math.max(0.5, bd.H - bd.s.start), 0, 1) : 0
        const key = `${B.t0.toFixed(3)}:${q}`
        const q8 = q % 8
        // ukulele
        let st = null
        if (mood === 'build') st = [q % 2 ? 'U' : 'D', (q % 2 ? 0.5 : 0.78) + 0.22 * prog]
        else if (mood === 'soft') st = q8 === 0 ? ['D', 0.8] : q8 === 4 ? ['D', 0.62] : null
        else st = STRUM[q8] || null
        if (st && B.phraseEnd && q === 7 && mood !== 'build') st = null
        if (st && sg.skipFirstStrum && B === bars[0] && q === 0) st = null
        if (st) {
          const layer = st[1] > 0.9 ? 2 : st[1] > 0.6 ? 1 : 0
          strum(uke, t + hum(0.004, key, 'u'), ch.uke, st[0], st[1] * (1 + hum(0.07, key, 'uv')) * (vi === 1 ? 0.85 : 1), layer, key)
        }
        // pizzicato bass
        const [root, third, fifth] = ch.bass
        const appr = (B.k || 0) % 2 ? nextRoot - 1 : nextRoot + 2
        let bn = null
        if (mood === 'build') bn = [q % 2 ? root + 12 : root, 0.4 * beat, q % 2 ? 0.6 : 0.95]
        else if (mood === 'soft') bn = q === 0 ? [root, 1.8 * beat, 0.8] : null
        else if (vi === 1) bn = q8 % 2 === 0 ? [[root, third, fifth, appr][q8 / 2], 0.85 * beat, q8 === 0 ? 0.95 : 0.78] : null
        else if (vi === 3) bn = { 0: [root, 0.3 * beat, 0.95], 1: [root, 0.25 * beat, 0.5], 3: [fifth, 0.3 * beat, 0.75], 4: [root, 0.3 * beat, 0.85], 6: [fifth, 0.3 * beat, 0.7], 7: [appr, 0.25 * beat, 0.6] }[q8] || null
        else bn = { 0: [root, 0.9 * beat, 0.95], 4: [fifth, 0.9 * beat, 0.8], 7: (B.k || 0) % 2 ? [appr, 0.4 * beat, 0.6] : null }[q8] || null
        if (bn) bass.push({ t: t + hum(0.003, key, 'b'), m: bn[0], d: bn[1], v: bn[2] * (1 + hum(0.06, key, 'bv')) })
        // percussion
        if (mood !== 'soft') {
          if (q8 === 2 || q8 === 6) clapPair(M, t, 0.78, key)
          if (mood === 'build' && (q8 === 3 || q8 === 7)) clapPair(M, t, 0.45 + 0.35 * prog, key + 'd')
          M.put('perc', shakerN(q % 4), t + hum(0.004, key, 's'), (q % 2 ? 0.34 : 0.22) * (mood === 'build' ? 1.2 : 1), 0.45)
          if (q8 === 0 || q8 === 4 || (mood === 'build' && q % 2 === 0)) M.put('perc', kickN(), t, q8 === 0 ? 0.55 : 0.38)
          if (mood !== 'build' && B.phraseEnd && (q8 === 6 || q8 === 7)) M.put('perc', blockN(q8 === 6 ? 1500 : 1900), t, 0.5, -0.3)
          if (B.phraseStart && q === 0 && mood !== 'build') M.put('perc', tambN(), t, 0.3, 0.3)
          if (mood === 'build' && (q8 === 2 || q8 === 6) && prog < 0.6) M.put('perc', snareN(q % 3), t, 0.4 + 0.3 * prog, 0.08)
        }
      }
      // melody
      for (const [p, m, len] of B.mel) {
        const t = B.t0 + p * beat + (p % 1 ? sw : 0)
        if (t < sg.anchor - 1e-6 || t >= end - 0.03) continue
        const sec = X.secAt(t)
        const bd = builds.find((b) => t >= b.s.start - 1e-6 && t < b.H - 0.02)
        const vi = sec.mood === 'full' ? sec.variant || 0 : 0
        const acc = p === 0 ? 1.08 : 1
        const ring = sg.bars ? { cut: Math.max(0.05, Math.min(len * beat + 0.9, end + 0.15 - t)), fade: 0.05 } : { cut: len * beat + 1.2, fade: 0.3 }
        const key = `m${t.toFixed(3)}`
        const tt = t + hum(0.003, key)
        if (vi === 1) {
          // pizzicato takes the melody; glock only sparkles on the long notes
          mel.push({ t: tt, m: m - 24, d: len * beat * 0.9, v: 0.9 * acc })
          if (len >= 1) M.put('bell', glockN(m + 12), tt, 0.32, 0.1, ring)
        } else {
          M.put('bell', glockN(m), tt, 0.85 * acc * (1 + hum(0.05, key, 'v')), 0, ring)
          if (vi === 2 || bd) M.put('keys', toyN(m - 12), tt + 0.006, 0.42 * acc, -0.05, ring)
          if (sec.mood === 'sunrise') M.put('bell', mboxN(m), tt + 0.004, 0.3, 0.3, ring)
        }
      }
    }
    // build: snare roll crescendo + slide-whistle lift into each hit
    for (const b of builds) {
      const H = b.H
      const r0 = Math.max(b.s.start, H - 1.5 * bar)
      let t = X.gridAt(r0)
      let i = 0
      while (t < H - 0.02) {
        const u = clamp((t - r0) / Math.max(0.3, H - r0), 0, 1)
        M.put('perc', snareN(i % 6), t, (0.16 + 0.8 * Math.pow(u, 1.6)) * (i % 2 ? 0.85 : 1), 0.08 + hum(0.1, 'roll', i))
        t += H - t < beat ? beat / 8 : beat / 4
        i++
      }
      const sl = beat * 1.5
      M.put('lead', slideWhistle(sl, (x) => 520 * Math.pow(1600 / 520, x / sl), rngOf('sw', H), ASR(0.05, sl - 0.1, 0.05)), H - sl, 0.34, 0.15)
      if (H < end - 0.05) bandHit(M, H, 1)
    }
    if (sg.accent) {
      M.put('bell', glockN(89), sg.anchor + 0.004, 0.9, 0.1)
      M.put('bell', glockN(96), sg.anchor + 0.02, 0.5, 0.25)
      M.put('perc', tambN(), sg.anchor, 0.55, 0.3)
    }
    renderUke(M, uke, end + 0.12)
    renderBass(M, bass, end + 0.12)
    renderBass(M, mel, end + 0.12, 'keys', pizzHiN)
  }

  /** full-band stab: strum + octave strum + bass + kick + tambourine + claps + glock triad */
  function bandHit(M, t, g = 1) {
    CHORD.F.uke.forEach((m, j) => M.put('uke', ukeN(m, 2, j % 2), t + j * 0.011, 1.05 * g, UKE_PAN[j], { cut: 1.6 }))
    CHORD.F.uke.forEach((m, j) => M.put('uke', ukeN(m + 12, 2, (j + 1) % 2), t + 0.018 + j * 0.01, 0.4 * g, 0.3, { cut: 1.1 }))
    M.put('bass', pizzN(41), t, 1.0 * g)
    M.put('bass', pizzN(53), t + 0.005, 0.35 * g)
    M.put('perc', kickN(), t, 1.0 * g)
    M.put('perc', tambN(), t, 0.85 * g, 0.3)
    clapPair(M, t, 0.9 * g, 'hit' + t.toFixed(3))
    ;[89, 93, 96].forEach((m, j) => M.put('bell', glockN(m), t + j * 0.018, 0.75 * g, j * 0.12))
  }

  /** s1: comic chaos, stops dead at `stop` */
  const TOY_GESTURES = [
    // [u 0..1, notes, vel, cents]
    [0.04, [81], 0.8, -35], [0.09, [84], 0.6, 25], [0.155, [89, 88], 0.9, 40], [0.26, [86], 0.5, -20], [0.3, [84], 0.6, -45],
    [0.4, [77, 78], 0.85, 30], [0.465, [93], 0.5, -25], [0.495, [91], 0.45, 35], [0.525, [89], 0.5, -15], [0.555, [86], 0.5, 45],
    [0.655, [72, 73, 76], 0.9, -30], [0.735, [84], 0.6, 20], [0.765, [81], 0.55, -40], [0.795, [84], 0.6, 10], [0.825, [81], 0.55, -30],
    [0.9, [89, 90], 0.8, 35], [0.955, [65, 66, 71], 1, -25],
  ]
  const HONKS = [
    // [u, midi, dur, fall]
    [0.12, 67, 0.16, 0.6], [0.345, 70, 0.14, 0.4], [0.585, 63, 0.3, 3], [0.705, 72, 0.12, 0.5], [0.87, 69, 0.24, 2.5],
  ]
  function chaos(M, a, stop, X) {
    const D = Math.max(0.5, stop - a)
    const U = (u) => a + u * D
    const cut = (t) => ({ cut: Math.max(0.01, stop - t), fade: 0.02 })
    // a clock that ticks too fast (and speeds up)
    let t = a + 0.05
    let i = 0
    while (t < stop - 0.04) {
      M.put('perc', clockN(i % 2 === 0), t, i % 2 ? 1.3 : 1.7, 0.42, cut(t))
      t += lerp(0.3, 0.19, (t - a) / D)
      i++
    }
    // detuned toy piano stumbling through the motif
    for (const [u, notes, vel, cents] of TOY_GESTURES) {
      notes.forEach((m, j) => {
        const tt = U(u) + j * 0.012
        M.put('keys', toyN(m), tt, vel * 0.85, -0.3 + j * 0.1, Object.assign({ rate: Math.pow(2, (cents + j * 13) / 1200) }, cut(tt)))
      })
    }
    // off-beat kazoo honks
    for (const [u, m, d, fall] of HONKS) M.put('lead', kazoo([[0, d, m, { fall, scoop: 1.4, vib: 0.2 }]], rngOf('honk', u)), U(u), 0.95, 0.22, cut(U(u)))
    // lopsided bass plonks
    for (const [u, m, c] of [[0.2, 41, -30], [0.52, 40, 20], [0.8, 36, -15]]) M.put('bass', pizzN(m), U(u), 0.7, 0, Object.assign({ rate: Math.pow(2, c / 1200) }, cut(U(u))))
  }

  /** s4: the lullaby at half-time, then a near-silent dip */
  function night(M, s, X) {
    const { beat } = X
    const a = X.gridAt(s.start + 0.05)
    const dip = Array.isArray(s.dip) ? s.dip : [s.end - Math.min(4 * beat, 0.35 * (s.end - s.start)), s.end]
    const hb = 8 * beat
    const names = ['F', 'Dm', 'Bb', 'C']
    const r = rngOf('pad', s.start)
    for (let k = 0; a + k * hb < dip[0] - 0.2; k++) {
      const t0 = a + k * hb
      const t1 = Math.min(t0 + hb, dip[0])
      const ch = CHORD[names[k % 4]]
      const ps = k === 0 ? s.start - 0.1 : t0
      M.put('pad', padBuf(t1 + 0.35 - ps, ch.pad, r, { attack: k === 0 ? 0.7 : 0.3, release: 0.9 }), ps, 1)
      for (const [p, m, len] of MOTIF_A[k % 4].mel) {
        const t = t0 + p * 2 * beat
        if (t >= dip[0] - 0.1) continue
        M.put('bell', mboxN(m), t, 0.9, 0.1)
        M.put('keys', feltN(m - 12), t + 0.012, 0.5, -0.12, { cut: len * 2 * beat + 0.4, fade: 0.25 })
      }
      M.put('keys', feltN(ch.bass[0] + 12), t0, 0.55, -0.2, { cut: hb, fade: 0.4 })
      M.put('keys', feltN(ch.bass[2] + 12), t0 + 2 * beat, 0.32, -0.15, { cut: hb, fade: 0.4 })
    }
    // the dip: a whisper of pad + one music-box twinkle
    M.put('pad', padBuf(Math.max(0.3, dip[1] - dip[0] + 0.15), CHORD.Bb.pad, r, { attack: 0.25, release: 0.6, cutoff: 480 }), dip[0] - 0.15, 0.22)
    M.put('bell', mboxN(84), dip[0] + 0.05, 0.35, 0.25)
    // soft woodblock tick-tock on the beat
    for (let t = a, i = 0; t < dip[0] - 0.05; t += beat, i++) M.put('perc', blockN(i % 2 ? 880 : 1150), t, 0.3, i % 2 ? 0.28 : -0.28)
  }

  /** s5: upward glock glissando from a, landing on the downbeat D */
  function gliss(M, a, D) {
    const scale = [77, 79, 81, 82, 84, 86, 88, 89, 91, 93, 94, 96, 98, 100, 101]
    const span = Math.max(0.25, D - a - 0.05)
    scale.forEach((m, i) => {
      const u = i / (scale.length - 1)
      const t = a + span * Math.pow(u, 0.85)
      M.put('bell', glockN(m), t, 0.3 + 0.45 * u, -0.45 + 0.9 * u, { cut: 0.9, fade: 0.4 })
      if (i % 2 === 0) M.put('harp', harpN(m - 12), t, 0.35 + 0.3 * u, -0.3 + 0.6 * u)
    })
  }

  /** harp swirl on a cut (dir 1 up, −1 down into night) */
  const SWIRL = [65, 67, 69, 72, 74, 77, 79, 81, 84]
  function swirlInto(put, c, dir = 1, vel = 1) {
    const notes = dir > 0 ? SWIRL : SWIRL.slice().reverse()
    const span = dir > 0 ? 0.3 : 0.55
    const t0 = dir > 0 ? c - 0.26 : c - 0.12
    notes.forEach((m, i) => put('harp', harpN(m), t0 + (span * i) / (notes.length - 1), vel * (0.45 + (0.55 * i) / notes.length), -0.55 + (1.1 * i) / notes.length))
    put('bell', glockN(dir > 0 ? 96 : 84), t0 + span + 0.03, 0.42 * vel, 0.35)
  }
  const swirl = (M, c, dir, vel) => swirlInto(M.put, c, dir, vel)

  /** s9: hit at L, the motif once, button ending ~1 s before the end */
  function finale(M, X) {
    const { beat, dur } = X
    const L = X.L
    let m = Math.round((dur - 1.0 - L) / beat)
    while (m > 1 && L + m * beat > dur - 0.6) m--
    m = Math.max(1, m)
    const Bt = L + m * beat
    const planC = m >= 12 ? [['F', 4], ['Bb', 4], ['C7', m - 8]] : m >= 6 ? [['F', 4], ['C7', m - 4]] : m >= 3 ? [['F', m - 2], ['C7', 2]] : [['F', m]]
    const bars = []
    let t0 = L
    planC.forEach(([ch, beats], i) => {
      let mel
      if (ch === 'F') mel = MOTIF_A[0].mel.filter((n) => n[0] < beats)
      else if (ch === 'Bb') mel = MOTIF_A[2].mel
      else {
        mel = CADENCE.map(([p, mm, l]) => [p + (beats - 4), mm, l]).filter((n) => n[0] >= 0)
        if (beats > 4) mel.unshift([0, 84, 1])
      }
      bars.push({ t0, beats, ch: [ch], mel, phraseEnd: false, phraseStart: false, k: i })
      t0 += beats * beat
    })
    band(M, { anchor: L, end: Bt - 0.22 * beat, bars, skipFirstStrum: true }, X)
    bandHit(M, L, 1.1)
    // the button: one strum + a glock ding, left to ring
    CHORD.F.uke.forEach((mm, j) => M.put('uke', ukeN(mm, 2, j % 2), Bt + j * 0.016, 1.0, UKE_PAN[j], { cut: 2.4, fade: 0.5 }))
    M.put('bell', glockN(89), Bt + 0.012, 1.0, 0.15)
    M.put('bell', glockN(96), Bt + 0.03, 0.4, 0.3)
    M.put('bass', pizzN(41), Bt, 0.85)
    X.button = Bt
  }

  // ═══════════════════════════════ SFX ══════════════════════════════════════
  // Each generator: (o, r) => mono Float32Array | [L, R]. o = { pitch, dur, pan, note, dir }
  // Level is normalised afterwards (SFX_REF + meta.off + gain), so generators only shape.
  const SFX = {}
  const META = {}
  function def(name, meta, fn) {
    SFX[name] = fn
    META[name] = Object.assign({ off: 0, send: 0.14, params: 'gain, pitch, pan' }, meta)
  }
  const tick = (r, fc = 4000, tau = 0.0015) => burst(tau * 8, r, fc, 0.9, BP, ex(tau))
  const ping = (f, tau, r, len = tau * 7) => chirp(len, f, AD(0.0005, tau), 'sin', r())
  /** equal-power pan a mono buffer to [L, R] with pan(t) */
  function panSweep(x, pan) {
    const L = new Float32Array(x.length)
    const R = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) {
      const p = clamp(pan(i / SR), -1, 1)
      L[i] = x[i] * Math.cos(((p + 1) * Math.PI) / 4)
      R[i] = x[i] * Math.sin(((p + 1) * Math.PI) / 4)
    }
    return [L, R]
  }
  /** mix mono events with their own pans into a stereo pair */
  function stereoOf(len, parts) {
    const S = stem(ns(len))
    for (const [x, g, t, pan] of parts) put(S, x, t, g, pan)
    return [S.L, S.R]
  }
  const pitchMidi = (o, m) => (o.note != null ? o.note : m + 12 * Math.log2(o.pitch))

  // ---- paper ----
  def('rustle', { desc: 'paper rustle bed (or a short leaf rustle)', params: 'dur (1.2), gain, pitch, pan', off: -7, dur: 1.2 }, (o, r) => {
    const d = o.dur || 1.2
    const p = o.pitch
    const fade = Math.min(0.2, d / 4)
    const e = (t) => clamp(t / fade, 0, 1) * clamp((d - t) / fade, 0, 1)
    const walk = (k) => {
      const rr = rngOf('walk', k, d)
      const pts = Array.from({ length: Math.ceil(d * 3) + 2 }, () => rr())
      return (t) => {
        const x = t * 3
        const i = Math.floor(x)
        const f = x - i
        return lerp(pts[i], pts[i + 1], f * f * (3 - 2 * f))
      }
    }
    const ch = (k) => {
      const w = walk(k)
      const c = svf(crackle(d, r, (t) => 40 + 160 * w(t), (t) => 0.4 + 0.6 * w(t), { g0: 0.3, g1: 2.2 }), 1300 * p, 0.6, HP)
      const bed = svf(noise(ns(d), r), 2300 * p, 0.55, BP)
      for (let i = 0; i < c.length; i++) c[i] = (c[i] + bed[i] * 0.07 * (0.4 + w(i / SR))) * e(i / SR)
      return c
    }
    return [ch('L'), ch('R')]
  })
  def('paper', { desc: 'short dry paper crackle', params: 'dur (0.35), gain, pan', dur: 0.35 }, (o, r) => {
    const d = o.dur || 0.35
    return env(svf(crackle(d, r, 420), 1800, 0.7, HP), (t) => clamp(t / 0.02, 0, 1) * clamp((d - t) / 0.08, 0, 1))
  })
  def('crinkle', { desc: 'one quick crinkle (use x3 for an unfold)', params: 'gain, pitch, pan' }, (o, r) =>
    env(svf(crackle(0.16, r, 1100, AD(0.006, 0.05), { g0: 0.2, g1: 1.2, pow: 1.6 }), 1500 * o.pitch, 0.7, HP), AD(0.004, 0.06))
  )
  def('crumple', { desc: 'paper crumpled into a ball', params: 'dur (0.65), gain, pan', dur: 0.65 }, (o, r) => {
    const d = o.dur || 0.65
    const shape = (t) => Math.sin(Math.PI * clamp(t / d, 0, 1)) ** 0.7
    const c = crackle(d, r, (t) => 250 + 1400 * shape(t), shape, { g0: 0.3, g1: 2.6, pow: 1.5 })
    const x = svf(svf(c, 700, 0.7, HP), 7000, 0.7, LP)
    const body = env(svf(noise(ns(d), r), 480, 0.8, LP), (t) => 0.25 * shape(t))
    return sum(d, [[x, 1], [body, 1]])
  })
  def('tear', { desc: 'short paper tear (x5 for a rhythmic run)', params: 'dur (0.2), gain, pitch, pan', dur: 0.2 }, (o, r) => {
    const d = o.dur || 0.2
    const fib = crackle(d, r, 520, () => 1, { g0: 0.2, g1: 0.7, pow: 1.3 })
    const tone = svf(noise(ns(d), r), (t) => (2100 + 1100 * (t / d)) * o.pitch, 1.1, BP)
    const e = (t) => clamp(t / 0.008, 0, 1) * clamp((d - t) / 0.015, 0, 1) * (0.7 + 0.3 * Math.sin((t / d) * 9))
    return env(sum(d, [[svf(fib, 1500, 0.7, HP), 1], [tone, 0.45]]), e)
  })
  def('tapeRip', { desc: 'washi-tape rip (the chaos→groove transition)', params: 'dur (0.26), gain, pitch, pan', dur: 0.26 }, (o, r) => {
    const d = o.dur || 0.26
    const rate = (t) => (170 - 80 * (t / d)) * o.pitch
    const am = crackle(d, r, (t) => rate(t) * 4, () => 1, { g0: 0.4, g1: 1.4, pow: 1 })
    const tone = svf(noise(ns(d), r), (t) => (2800 - 1300 * (t / d)) * o.pitch, 1.0, BP)
    const e = (t) => clamp(t / 0.005, 0, 1) * clamp((d - t) / 0.02, 0, 1)
    const x = new Float32Array(tone.length)
    for (let i = 0; i < x.length; i++) x[i] = (tone[i] * (0.35 + Math.abs(am[i]) * 2.5) + am[i] * 0.4) * e(i / SR)
    return svf(x, 700, 0.7, HP)
  })
  def('tape', { desc: 'tape pulled off the roll (slow sticky rrrip)', params: 'dur (0.32), gain, pan', dur: 0.32 }, (o, r) => {
    const d = o.dur || 0.32
    const x = svf(noise(ns(d), r), 1400 * o.pitch, 0.8, BP)
    const c = crackle(d, r, (t) => 55 - 25 * (t / d), () => 1, { g0: 1, g1: 3, pow: 0.8 })
    return env(sum(d, [[x, 0.5], [svf(c, 900, 0.7, HP), 1]]), (t) => clamp(t / 0.01, 0, 1) * clamp((d - t) / 0.04, 0, 1))
  })
  def('flutter', { desc: 'sticky-note flutter (fast paper flaps, slowing)', params: 'dur (0.4), gain, pitch, pan', dur: 0.4 }, (o, r) => {
    const d = o.dur || 0.4
    const n = ns(d)
    const air = svf(noise(n, r), 1900 * o.pitch, 0.7, BP)
    const y = new Float32Array(n)
    let ph = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      ph += (lerp(30, 13, t / d) * o.pitch) / SR
      const fl = Math.exp(-(ph % 1) / 0.12)
      y[i] = air[i] * fl * clamp((d - t) / 0.08, 0, 1) * clamp(t / 0.01, 0, 1)
    }
    return sum(d, [[y, 1], [svf(crackle(d, r, 90, (t) => 1 - t / d), 2500, 0.7, HP), 0.5]])
  })
  def('flap', { desc: 'card flap lifting (soft air + paper tick)', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.22, [
      [burst(0.2, r, (t) => (600 + 5000 * t) * o.pitch, 0.7, BP, (t) => Math.sin(Math.PI * clamp(t / 0.18, 0, 1))), 0.8],
      [tick(r, 3200), 0.5],
    ])
  )
  def('flip', { desc: "card flip 'fwip'", params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.2, [
      [burst(0.14, r, (t) => (900 + 26000 * t) * o.pitch, 1.4, BP, (t) => Math.sin(Math.PI * clamp(t / 0.13, 0, 1)) ** 1.5), 1],
      [tick(r, 3600), 0.4, 0.125],
    ])
  )
  def('riffle', { desc: 'card-fan riffle (thumb through a deck)', params: 'dur (0.45), gain, pitch, pan', dur: 0.45 }, (o, r) => {
    const d = o.dur || 0.45
    const parts = [[burst(d, r, 2600 * o.pitch, 0.6, BP, (t) => 0.12 * Math.sin(Math.PI * clamp(t / d, 0, 1))), 1]]
    const k = 16
    for (let i = 0; i < k; i++) {
      const u = i / (k - 1)
      const t = d * (0.5 - 0.5 * Math.cos(Math.PI * u)) * 0.92
      parts.push([burst(0.03, r, (2400 + r() * 1200) * o.pitch, 1.5, BP, ex(0.004)), 0.5 + 0.5 * Math.sin(Math.PI * u), t])
    }
    return sum(d + 0.05, parts)
  })
  def('peel', { desc: 'sticker peel zip (rising)', params: 'dur (0.3), gain, pitch, pan', dur: 0.3 }, (o, r) => {
    const d = o.dur || 0.3
    const n = ns(d)
    const src = svf(noise(n, r), (t) => (900 + 2600 * (t / d)) * o.pitch, 1.1, BP)
    const y = new Float32Array(n)
    let ph = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      ph += lerp(160, 420, t / d) / SR
      y[i] = src[i] * (0.3 + 0.7 * Math.exp(-(ph % 1) / 0.25)) * clamp(t / 0.03, 0, 1) * clamp((d - t) / 0.012, 0, 1) * (0.5 + 0.5 * (t / d))
    }
    return sum(d + 0.03, [[y, 1], [tick(r, 3000), 0.3, d - 0.005]])
  })
  def('envelope', { desc: 'envelope sliding under a door', params: 'dur (0.5), gain, pan', dur: 0.5 }, (o, r) => {
    const d = o.dur || 0.5
    const fr = svf(noise(ns(d), rngOf('envj')), 30, 0.7, LP)
    normPeak(fr)
    const x = svf(noise(ns(d), r), 1500 * o.pitch, 0.6, BP)
    const hiss = svf(noise(ns(d), r), 3000, 0.7, LP)
    const e = (t) => clamp(t / 0.06, 0, 1) * clamp((d - t) / 0.08, 0, 1)
    for (let i = 0; i < x.length; i++) x[i] = (x[i] + 0.25 * hiss[i]) * e(i / SR) * (0.75 + 0.25 * fr[i])
    return sum(d + 0.04, [[x, 1], [tick(r, 2600, 0.002), 0.5, d - 0.02]])
  })
  def('swish', { desc: 'basket-net / paper swish', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.34, [
      [burst(0.32, r, (t) => (4600 - 5000 * t) * o.pitch, 0.8, BP, (t) => (t < 0.06 ? t / 0.06 : Math.exp(-(t - 0.06) / 0.07))), 1],
      [burst(0.3, r, 6000, 0.7, HP, (t) => (t < 0.05 ? t / 0.05 : Math.exp(-(t - 0.05) / 0.05))), 0.35],
    ])
  )
  def('swoosh', { desc: 'paper swipe whoosh with a stereo pan sweep (engine uses it on every cut)', params: 'dur (0.5), gain, pitch, pan (start side; sweeps to −pan)', dur: 0.5, ownPan: true }, (o, r) => {
    const d = o.dur || 0.5
    const p = o.pitch
    const x = svf(noise(ns(d), r), (t) => (t < d * 0.55 ? 350 * Math.pow(2800 / 350, t / (d * 0.55)) : 2800 * Math.pow(900 / 2800, (t - d * 0.55) / (d * 0.45))) * p, 1.1, BP)
    env(x, (t) => Math.sin(Math.PI * clamp(t / d, 0, 1)) ** 1.6)
    mixIn(x, svf(crackle(d * 0.6, r, 80), 2200, 0.7, HP), 0.35, d * 0.2)
    const p0 = o.pan == null ? 0.7 : o.pan
    return panSweep(x, (t) => lerp(p0, -p0, t / d))
  })
  def('whoosh', { desc: 'bigger airy whoosh (paper airplane, collage fly-in)', params: 'dur (0.7), gain, pitch, pan (start side; sweeps to −pan)', dur: 0.7, ownPan: true }, (o, r) => {
    const d = o.dur || 0.7
    const p = o.pitch * 0.8
    const x = svf(noise(ns(d), r), (t) => (t < d * 0.5 ? 300 * Math.pow(2200 / 300, t / (d * 0.5)) : 2200 * Math.pow(700 / 2200, (t - d * 0.5) / (d * 0.5))) * p, 0.8, BP)
    const low = svf(noise(ns(d), r), 380, 0.7, LP)
    for (let i = 0; i < x.length; i++) x[i] = (x[i] + 0.5 * low[i]) * Math.sin(Math.PI * clamp(i / SR / d, 0, 1)) ** 1.4
    const p0 = o.pan == null ? -0.6 : o.pan
    return panSweep(x, (t) => lerp(p0, -p0, t / d))
  })
  def('flurry', { desc: 'paper-scrap flurry (many scraps flying past)', params: 'dur (1), gain, pan', dur: 1, off: -3 }, (o, r) => {
    const d = o.dur || 1
    const parts = []
    const k = Math.round(8 + d * 14)
    for (let i = 0; i < k; i++) {
      const t = r() * (d - 0.2)
      const kind = r()
      const src = kind < 0.4 ? SFX.flutter({ pitch: 0.9 + r() * 0.5, dur: 0.18 + r() * 0.15 }, r) : kind < 0.7 ? SFX.crinkle({ pitch: 0.8 + r() * 0.6 }, r) : SFX.flip({ pitch: 0.8 + r() * 0.7 }, r)
      parts.push([src, 0.4 + r() * 0.6, t, (r() * 2 - 1) * 0.7])
    }
    const air = burst(d, r, 1500, 0.5, BP, (t) => 0.25 * Math.sin(Math.PI * clamp(t / d, 0, 1)))
    parts.push([air, 1, 0, 0])
    return stereoOf(d + 0.1, parts)
  })

  // ---- pencil, keys, typewriter ----
  def('pencil', { desc: 'pencil scribble (back-and-forth strokes)', params: 'dur (0.6), gain, pan', dur: 0.6 }, (o, r) => {
    const d = o.dur || 0.6
    const n = ns(d)
    const up = svf(noise(n, r), 3700 * o.pitch, 1.0, BP)
    const dn = svf(noise(n, r), 2800 * o.pitch, 1.0, BP)
    const grain = svf(crackle(d, r, 600, () => 1, { g0: 0.1, g1: 0.4 }), 4000, 0.7, HP)
    const y = new Float32Array(n)
    let ph = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      ph += (8.5 + 2.5 * Math.sin(t * 7.3)) / SR
      const s = Math.abs(Math.sin(Math.PI * ph)) ** 0.6
      const odd = Math.floor(ph) % 2
      y[i] = ((odd ? up[i] : dn[i]) * 0.8 + grain[i] * 0.5) * s * clamp(t / 0.02, 0, 1) * clamp((d - t) / 0.05, 0, 1)
    }
    return y
  })
  def('scratch', { desc: 'one decisive pencil strike-through', params: 'dur (0.28), gain, pitch, pan', dur: 0.28 }, (o, r) => {
    const d = o.dur || 0.28
    const x = svf(noise(ns(d), r), (t) => (2600 + 1800 * (t / d)) * o.pitch, 1.2, BP)
    const g = svf(crackle(d, r, 700, () => 1, { g0: 0.1, g1: 0.4 }), 4200, 0.7, HP)
    for (let i = 0; i < x.length; i++) x[i] = (x[i] + 0.6 * g[i]) * clamp(i / SR / 0.02, 0, 1) * clamp((d - i / SR) / 0.05, 0, 1)
    return sum(d + 0.02, [[x, 1], [tick(r, 3500), 0.35, d - 0.01]])
  })
  const keyHit = (r, big = 1, f = 2600 + r() * 1400) =>
    sum(0.06, [
      [burst(0.03, r, f, 1.2, BP, ex(0.0035)), 1],
      [burst(0.02, r, 5500, 0.8, HP, ex(0.0012)), 0.5],
      [modal(1100 + r() * 500, [[1, 1, 0.025], [2.3, 0.4, 0.012]], 0.04, r, { attack: 0.0003 }), 0.35],
      [chirp(0.04, (t) => (340 + r() * 90) * (1 - (0.2 * t) / 0.04), ex(0.008), 'sin', r()), 0.12 * big],
    ])
  def('typing', { desc: 'soft keyboard typing burst', params: 'dur (0.8), gain, pan', dur: 0.8, off: -4 }, (o, r) => {
    const d = o.dur || 0.8
    const parts = []
    for (let t = 0; t < d; t += 0.06 + r() * 0.07) parts.push([keyHit(r), 0.6 + r() * 0.4, t])
    return sum(d + 0.08, parts)
  })
  def('clatter', { desc: 'frantic keyboard clatter burst', params: 'dur (0.5), gain, pan', dur: 0.5, off: -2 }, (o, r) => {
    const d = o.dur || 0.5
    const parts = []
    for (let t = 0; t < d; t += 0.025 + r() * 0.045) {
      parts.push([keyHit(r, 1.3), 0.5 + r() * 0.5, t])
      if (r() < 0.2) parts.push([keyHit(r, 1.2), 0.5, t + 0.012])
    }
    parts.push([sum(0.12, [[chirp(0.1, 150, ex(0.03)), 0.7], [burst(0.1, r, 900, 1.2, BP, ex(0.02)), 0.6]]), 0.9, d * (0.3 + r() * 0.4)])
    return sum(d + 0.12, parts)
  })
  const typebar = (r, g = 1) =>
    sum(0.09, [
      [burst(0.02, r, 3800, 0.8, HP, ex(0.0018)), 1],
      [modal(1750 + r() * 250, [[1, 1, 0.05], [1.66, 0.6, 0.035], [2.37, 0.4, 0.02]], 0.08, r), 0.45 * g],
      [chirp(0.06, 210, ex(0.015), 'sin', r()), 0.18],
    ])
  def('typewriter', { desc: 'typewriter keystrokes (metal type-bars on the platen)', params: 'dur (0.8), gain, pan', dur: 0.8, off: -2 }, (o, r) => {
    const d = o.dur || 0.8
    const parts = []
    for (let t = 0; t < d; t += 0.09 + r() * 0.07) parts.push([typebar(r), 0.6 + r() * 0.4, t])
    return sum(d + 0.1, parts)
  })
  def('clack', { desc: 'single typewriter/wooden clack', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.1, [
      [typebar(r, 0.5), 0.6],
      [modal(700 * o.pitch, [[1, 1, 0.04], [2.3, 0.5, 0.025]], 0.06, r, { attack: 0.0003 }), 0.7],
    ])
  )
  def('carriage', { desc: 'typewriter carriage return: ratchet zip + bell ding', params: 'gain, pitch, pan' }, (o, r) => {
    const parts = []
    let t = 0
    let i = 0
    while (t < 0.34) {
      parts.push([burst(0.02, r, (2600 + 1400 * (t / 0.34)) * o.pitch, 1.4, BP, ex(0.003)), 0.5 + 0.2 * r(), t])
      t += lerp(0.034, 0.016, t / 0.34)
      i++
    }
    parts.push([burst(0.36, r, 1100, 0.8, BP, (t) => 0.15 * clamp(t / 0.05, 0, 1) * clamp((0.36 - t) / 0.05, 0, 1)), 1, 0])
    parts.push([modal(2350 * o.pitch, [[1, 1, 0.9], [2.0, 0.3, 0.5], [2.76, 0.25, 0.3], [5.4, 0.08, 0.1]], 1.0, r, { strike: 0.2, strikeFc: 6000 }), 0.8, 0.38])
    return sum(1.4, parts)
  })

  // ---- knocks, thumps, stamps ----
  def('thud', { desc: 'soft paper-padded thud', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.25, [
      [chirp(0.22, (t) => (82 + 90 * Math.exp(-t / 0.03)) * o.pitch, ex(0.07)), 1],
      [burst(0.04, r, 900, 1, BP, ex(0.008)), 0.35],
      [svf(crackle(0.12, r, 300, ex(0.04)), 1800, 0.7, HP), 0.4],
      [burst(0.1, r, 400, 0.8, LP, ex(0.02)), 0.4],
    ])
  )
  def('thump', { desc: 'postage-stamp thump (tight, small)', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.14, [
      [chirp(0.12, (t) => (125 + 90 * Math.exp(-t / 0.015)) * o.pitch, ex(0.04)), 1],
      [burst(0.05, r, 800, 0.8, LP, ex(0.02)), 0.5],
      [tick(r, 2600, 0.002), 0.35],
    ])
  )
  def('stamp', { desc: 'rubber-stamp thunk (x4 for a cascade)', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.28, [
      [chirp(0.25, (t) => (118 + 50 * Math.exp(-t / 0.02)) * o.pitch, ex(0.07)), 1],
      [burst(0.1, r, 450 * o.pitch, 2, BP, ex(0.035)), 0.9],
      [modal(620 * o.pitch, [[1, 1, 0.08], [2.2, 0.4, 0.04]], 0.1, r, { attack: 0.0004 }), 0.35],
      [svf(crackle(0.07, r, 500, ex(0.025)), 2000, 0.7, HP), 0.3],
    ])
  )
  def('thwack', { desc: 'cartoon glue-stick thwack', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.3, [
      [burst(0.06, r, 1600 * o.pitch, 0.9, BP, ex(0.012)), 1],
      [chirp(0.25, (t) => (85 + 60 * Math.exp(-t / 0.03)) * o.pitch, ex(0.08)), 0.9],
      [burst(0.12, r, 700 * o.pitch, 1.2, BP, ex(0.04)), 0.5],
      [chirp(0.08, (t) => (900 - 5000 * t) * o.pitch, ex(0.025), 'tri'), 0.12],
    ])
  )
  def('slap', { desc: 'sticky-note / washi slap', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.12, [
      [burst(0.05, r, 1200 * o.pitch, 0.8, BP, ex(0.01)), 1],
      [svf(crackle(0.06, r, 900, ex(0.02)), 2200, 0.7, HP), 0.6],
      [chirp(0.06, 160 * o.pitch, ex(0.022)), 0.35],
    ])
  )
  def('thup', { desc: "sticker press 'thup' (soft, muffled)", params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.1, [
      [chirp(0.08, (t) => (180 + 80 * Math.exp(-t / 0.012)) * o.pitch, ex(0.025)), 1],
      [burst(0.05, r, 900, 0.7, LP, ex(0.015)), 0.6],
    ])
  )
  def('tack', { desc: "thumbtack 'tick' (tiny metal + cork)", params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.08, [
      [tick(r, 5000, 0.0012), 1],
      [ping(5200 * o.pitch, 0.008, r), 0.35],
      [chirp(0.05, 260 * o.pitch, ex(0.015)), 0.35],
    ])
  )
  def('pin', { desc: 'push-pin thunk into the gallery wall', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.22, [
      [tick(r, 4600, 0.0015), 0.9],
      [ping(4300 * o.pitch, 0.012, r), 0.3],
      [chirp(0.2, (t) => (120 + 50 * Math.exp(-t / 0.02)) * o.pitch, ex(0.055)), 1],
      [burst(0.07, r, 900, 0.8, LP, ex(0.025)), 0.5],
      [svf(crackle(0.05, r, 600, ex(0.02)), 2200, 0.7, HP), 0.3],
    ])
  )
  def('tap', { desc: 'tiny hammer tap (metallic tick)', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.08, [
      [modal(3200 * o.pitch, [[1, 1, 0.05], [1.59, 0.5, 0.03], [2.44, 0.25, 0.015]], 0.07, r, { attack: 0.0002 }), 0.8],
      [modal(900 * o.pitch, [[1, 1, 0.025]], 0.04, r), 0.4],
      [tick(r, 5000, 0.001), 0.6],
    ])
  )
  def('frameSnap', { desc: 'picture frame snapping shut', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.3, [
      [modal(1200 * o.pitch, [[1, 1, 0.03], [2.1, 0.6, 0.02]], 0.05, r, { attack: 0.0002, strike: 0.6, strikeFc: 3000 }), 0.8],
      [modal(1450 * o.pitch, [[1, 1, 0.03], [2.3, 0.6, 0.02]], 0.05, r, { attack: 0.0002, strike: 0.6, strikeFc: 3400 }), 1, 0.035],
      [ping(3200 * o.pitch, 0.06, r), 0.1, 0.035],
      [chirp(0.06, 150, ex(0.02)), 0.4, 0.035],
    ])
  )
  def('clunk', { desc: 'chunky button clunk', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.16, [
      [chirp(0.12, 280 * o.pitch, ex(0.035)), 1],
      [chirp(0.12, 175 * o.pitch, ex(0.05)), 0.6],
      [burst(0.03, r, 1500, 1, BP, ex(0.005)), 0.6],
      [tick(r, 3000, 0.0015), 0.25, 0.03],
      [tick(r, 3300, 0.0012), 0.15, 0.055],
    ])
  )
  def('button', { desc: 'button tap (press + release click)', params: 'gain, pitch, pan', off: -1 }, (o, r) =>
    sum(0.12, [
      [burst(0.02, r, 2800 * o.pitch, 2, BP, ex(0.003)), 1],
      [chirp(0.03, 900 * o.pitch, ex(0.008)), 0.5],
      [burst(0.02, r, 3400 * o.pitch, 2, BP, ex(0.0025)), 0.55, 0.07],
    ])
  )
  def('bloop', { desc: "squishy button 'bloop'", params: 'gain, pitch, pan' }, (o, r) => {
    const f = (t) => (t < 0.06 ? 520 - 280 * (t / 0.06) : 240 + 200 * Math.sin(clamp((t - 0.06) / 0.12, 0, 1) * Math.PI * 0.5)) * o.pitch
    return sum(0.22, [
      [svf(chirp(0.2, f, AD(0.004, 0.07)), 1400, 0.9, LP), 1],
      [burst(0.04, r, 700, 1.4, LP, ex(0.012)), 0.3],
    ])
  })
  def('squelch', { desc: 'glue squelch (wet, cartoon)', params: 'gain, pitch, pan' }, (o, r) => {
    const d = 0.24
    const x = svf(noise(ns(d), r), (t) => (t < 0.08 ? 300 + 1100 * (t / 0.08) : 1400 - 900 * clamp((t - 0.08) / 0.12, 0, 1)) * o.pitch, 7, LP)
    env(x, (t) => clamp(t / 0.01, 0, 1) * clamp((d - t) / 0.06, 0, 1))
    return sum(0.26, [
      [x, 0.6],
      [chirp(0.04, (t) => (420 + 6000 * t) * o.pitch, AD(0.002, 0.012)), 0.4, 0.05],
      [chirp(0.04, (t) => (380 + 7000 * t) * o.pitch, AD(0.002, 0.01)), 0.3, 0.13],
    ])
  })
  def('gulp', { desc: "soft 'gulp' pop into a speech bubble", params: 'gain, pitch, pan' }, (o, r) =>
    svf(
      sum(0.2, [
        [chirp(0.1, (t) => (900 - 7000 * t) * o.pitch, AD(0.004, 0.035)), 1],
        [chirp(0.09, (t) => (700 - 5000 * t) * o.pitch, AD(0.004, 0.03)), 0.6, 0.06],
        [burst(0.05, r, 600, 0.9, LP, ex(0.015)), 0.3],
      ]),
      2200,
      0.7,
      LP
    )
  )
  def('pop', { desc: 'round paper pop', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.16, [
      [chirp(0.15, (t) => (t < 0.022 ? 380 * Math.pow(1150 / 380, t / 0.022) : 1150 - 330 * Math.min(1, (t - 0.022) / 0.07)) * o.pitch, AD(0.0015, 0.035)), 1],
      [tick(r, 3500), 0.35],
    ])
  )
  def('letterPop', { desc: 'letter-drop pop (tonal; step pitch or note for a rhythmic run)', params: 'gain, pitch | note, pan' }, (o, r) => {
    const f0 = o.note != null ? midi(o.note) : 700 * o.pitch
    return sum(0.14, [
      [chirp(0.12, (t) => f0 * (t < 0.018 ? 0.75 + 0.5 * (t / 0.018) : 1.25 - 0.1 * Math.min(1, (t - 0.018) / 0.05)), AD(0.0015, 0.045)), 1],
      [svf(crackle(0.03, r, 800, ex(0.01)), 2500, 0.7, HP), 0.35],
    ])
  })
  def('blip', { desc: 'tiny UI blip', params: 'gain, pitch, pan', off: -3 }, (o) => svf(chirp(0.08, 1320 * o.pitch, AD(0.002, 0.025), 'sqr'), 3500, 0.7, LP))
  def('shutter', { desc: 'camera shutter click-clack', params: 'gain, pan' }, (o, r) =>
    sum(0.14, [
      [burst(0.04, r, 3000, 1, BP, ex(0.005)), 1],
      [burst(0.06, r, 2200, 1, BP, ex(0.008)), 0.8, 0.07],
    ])
  )
  def('snip', { desc: 'scissors snip-snip', params: 'gain, pitch, pan' }, (o, r) => {
    const one = () =>
      sum(0.1, [
        [burst(0.04, r, 4200 * o.pitch, 2, BP, ex(0.008)), 1],
        [ping(3100 * o.pitch, 0.02, r), 0.12],
        [ping(4700 * o.pitch, 0.015, r), 0.08],
        [burst(0.05, r, 1500, 1, BP, ex(0.012)), 0.4],
      ])
    return sum(0.2, [[one(), 1], [one(), 0.8, 0.085]])
  })

  // ---- mechanical / household ----
  def('rattle', { desc: 'googly-eye rattle (pupil bouncing in its dome)', params: 'gain, pitch, pan' }, (o, r) => {
    const parts = []
    for (const [eye, off] of [[0, 0], [1, 0.021]]) {
      let t = off
      for (let k = 0; k < 11; k++) {
        const f = (4200 + r() * 1600 + eye * 500) * o.pitch
        parts.push([sum(0.02, [[ping(f, 0.003, r), 1], [tick(r, 6000, 0.0006), 0.5]]), Math.pow(0.84, k) * (0.7 + 0.3 * r()), t])
        t += 0.055 * Math.pow(0.8, k) + 0.006 + r() * 0.006
      }
    }
    return sum(0.5, parts)
  })
  def('boing', { desc: 'spring boing', params: 'gain, pitch, pan' }, (o) => {
    const p = o.pitch
    const f = (t) => p * (150 + 180 * clamp(t / 0.12, 0, 1)) + (40 * p * Math.exp(-t / 0.18) + 2) * Math.sin(TAU * 14 * t)
    const x = chirp(0.55, f, AD(0.005, 0.18), 'tri')
    mixIn(x, chirp(0.55, (t) => 2 * f(t), AD(0.005, 0.12)), 0.15)
    return x
  })
  def('creak', { desc: 'little creak (gauge needle, luggage tag swinging)', params: 'dur (0.5), gain, pitch, pan', dur: 0.5 }, (o, r) => {
    const d = o.dur || 0.5
    const n = ns(d)
    const imp = new Float32Array(n)
    let ph = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      ph += ((45 + 30 * Math.sin(Math.PI * (t / d)) + 8 * Math.sin(t * 23)) * o.pitch) / SR
      if (ph >= 1) {
        ph -= 1
        imp[i] = 0.6 + r() * 0.4
      }
    }
    const e = (t) => Math.sin(Math.PI * clamp(t / d, 0, 1)) ** 0.8
    const y = sum(d, [[svf(imp, 420 * o.pitch, 6, BP), 1], [svf(imp, 1100 * o.pitch, 8, BP), 0.6], [svf(imp, 2300 * o.pitch, 10, BP), 0.3]])
    return env(y, e)
  })
  def('signFlip', { desc: "hanging sign flip + wooden clack, settling", params: 'gain, pitch, pan' }, (o, r) => {
    const clk = (g) => modal(650 * o.pitch, [[1, 1, 0.05], [2.3, 0.5, 0.03], [3.9, 0.2, 0.015]], 0.08, r, { attack: 0.0003, strike: 0.5, strikeFc: 2500 })
    return sum(0.5, [
      [SFX.flip({ pitch: 0.75 }, r), 0.6],
      [clk(), 1, 0.12],
      [clk(), 0.45, 0.22],
      [clk(), 0.2, 0.29],
    ])
  })
  def('blind', { desc: 'paper window-blind sliding down', params: 'dur (0.8), gain, pan', dur: 0.8 }, (o, r) => {
    const d = o.dur || 0.8
    const parts = [[burst(d, r, (t) => 2500 - 1600 * (t / d), 1, BP, (t) => 0.4 * clamp(t / 0.05, 0, 1) * clamp((d - t) / 0.05, 0, 1)), 1]]
    let t = 0.02
    while (t < d - 0.03) {
      parts.push([modal(1300 + r() * 300, [[1, 1, 0.02], [2.4, 0.4, 0.01]], 0.03, r, { attack: 0.0002 }), 0.3 + 0.2 * r(), t])
      t += 1 / lerp(22, 12, t / d)
    }
    parts.push([chirp(0.12, 120, ex(0.035)), 0.9, d - 0.02])
    parts.push([tick(r, 2000, 0.003), 0.5, d - 0.02])
    return sum(d + 0.12, parts)
  })
  def('blindUp', { desc: 'blind rolling up with a snap', params: 'gain, pan' }, (o, r) => {
    const parts = []
    let t = 0
    while (t < 0.4) {
      parts.push([burst(0.02, r, 1200 + 1800 * (t / 0.4), 1.4, BP, ex(0.003)), 0.4 + 0.3 * (t / 0.4), t])
      t += 1 / lerp(18, 60, t / 0.4)
    }
    parts.push([burst(0.4, r, (t) => 1200 + 4000 * t, 0.9, BP, (t) => 0.25 * (t / 0.4)), 1, 0])
    parts.push([burst(0.03, r, 2600, 0.8, BP, ex(0.004)), 1, 0.42])
    parts.push([SFX.flap({ pitch: 1.3 }, r), 0.5, 0.45])
    parts.push([SFX.flap({ pitch: 1.1 }, r), 0.3, 0.52])
    return sum(0.8, parts)
  })
  def('conveyor', { desc: 'conveyor clickety-clack + belt rumble', params: 'dur (1.5), gain, pitch, pan', dur: 1.5, off: -4 }, (o, r) => {
    const d = o.dur || 1.5
    const cyc = 0.36 / o.pitch
    const parts = [[burst(d, r, 220, 0.8, LP, (t) => 0.5 * clamp(t / 0.1, 0, 1) * clamp((d - t) / 0.1, 0, 1) * (0.8 + 0.2 * Math.sin(TAU * 2.8 * t))), 1]]
    for (let c = 0; c * cyc < d - 0.05; c++) {
      for (const [dt, v, f] of [[0, 0.5, 1900], [0.07, 0.4, 2100], [0.12, 0.45, 2000], [0.2, 1, 900]]) {
        const t = c * cyc + dt / o.pitch
        if (t < d) parts.push([modal(f * o.pitch, [[1, 1, 0.03], [2.3, 0.4, 0.015]], 0.04, r, { attack: 0.0002, strike: 0.3, strikeFc: 3000 }), v * (0.85 + 0.3 * r()), t])
      }
    }
    return sum(d + 0.06, parts)
  })
  def('crickets', { desc: 'soft night crickets bed (two crickets, L/R)', params: 'dur (2), gain, pitch', dur: 2, off: -11 }, (o, r) => {
    const d = o.dur || 2
    const parts = []
    for (const [f, pan, per] of [[4400, -0.5, 0.62], [4900, 0.5, 0.78]]) {
      let t = r() * 0.3
      while (t < d - 0.12) {
        for (let k = 0; k < 3; k++) parts.push([chirp(0.03, f * o.pitch, (x) => clamp(x / 0.003, 0, 1) * Math.exp(-x / 0.008)), 0.8 - k * 0.1, t + k * 0.028, pan])
        t += per * (0.85 + 0.3 * r())
      }
    }
    return stereoOf(d + 0.05, parts)
  })
  def('footsteps', { desc: 'tiny cartoon footsteps (pitter-patter)', params: 'dur (1), gain, pitch, pan', dur: 1, off: -3 }, (o, r) => {
    const d = o.dur || 1
    const parts = []
    let i = 0
    for (let t = 0; t < d - 0.03; t += 0.13 * (0.9 + 0.2 * r())) {
      const f = (i % 2 ? 560 : 480) * o.pitch
      parts.push([sum(0.05, [[chirp(0.05, (x) => f * (1 - 2.5 * x), AD(0.001, 0.014)), 1], [burst(0.02, r, 1200, 0.8, LP, ex(0.006)), 0.5]]), 0.8 + 0.2 * r(), t])
      i++
    }
    return sum(d + 0.05, parts)
  })
  def('snore', { desc: 'one gentle snore (rumble in, whistle out)', params: 'gain, pitch, pan', off: -3 }, (o, r) => {
    const din = 0.85
    const n = ns(din)
    const src = svf(noise(n, r), 520 * o.pitch, 0.8, LP)
    const y = new Float32Array(n)
    let ph = 0
    for (let i = 0; i < n; i++) {
      const t = i / SR
      ph += lerp(22, 30, t / din) / SR
      y[i] = src[i] * (0.35 + 0.65 * Math.exp(-(ph % 1) / 0.18)) * Math.sin(Math.PI * clamp(t / din, 0, 1))
    }
    const wl = 0.6
    const whistle = slideWhistle(wl, (t) => (880 + 420 * Math.sin(Math.PI * clamp(t / wl, 0, 1) * 0.8)) * o.pitch, r, (t) => 0.35 * Math.sin(Math.PI * clamp(t / wl, 0, 1)))
    const breath = burst(wl, r, 1400, 0.8, BP, (t) => 0.25 * Math.sin(Math.PI * clamp(t / wl, 0, 1)))
    return sum(1.75, [[y, 1], [whistle, 0.5, 1.0], [breath, 0.6, 1.0]])
  })
  def('zzz', { desc: 'sleepy buzzing zzz', params: 'dur (1.2), gain, pan', dur: 1.2, off: -5 }, (o, r) => {
    const d = o.dur || 1.2
    const parts = []
    for (let i = 0; i < 3; i++) {
      const l = d / 3 - 0.05
      const b = chirp(l, (t) => (110 + i * 12) * o.pitch * (1 + 0.02 * Math.sin(TAU * 5 * t)), (t) => Math.sin(Math.PI * clamp(t / l, 0, 1)), 'saw')
      parts.push([svf(b, 600 + i * 60, 2, BP), 1 - i * 0.2, (i * d) / 3])
    }
    return sum(d + 0.05, parts)
  })

  // ---- bells, kazoo & friends (musical) ----
  def('alarm', { desc: 'wind-up alarm clock bell ring', params: 'dur (0.8), gain, pitch, pan', dur: 0.8, send: 0.2 }, (o, r) => {
    const d = o.dur || 0.8
    const parts = []
    let k = 0
    for (let t = 0; t < d; t += 1 / 24) {
      const f = (k % 2 ? 2080 : 1750) * o.pitch
      parts.push([modal(f, [[1, 1, 0.5], [2.1, 0.4, 0.25], [2.9, 0.3, 0.15], [4.2, 0.12, 0.08]], 0.6, r, { attack: 0.0003, strike: 0.3, strikeFc: 5000 }), 0.35 * (0.8 + 0.4 * r()), t])
      k++
    }
    parts.push([burst(d, r, 3500, 0.7, HP, (t) => 0.05 * clamp((d - t) / 0.05, 0, 1)), 1])
    return sum(d + 0.7, parts)
  })
  def('ding', { desc: 'bright glock ding (final ding, basket shot)', params: 'gain, pitch | note, pan', send: 0.3 }, (o) => {
    const m = pitchMidi(o, 96)
    return sum(1.8, [[glockN(Math.round(m)), 1], [glockN(Math.round(m) + 7), 0.25, 0.01]])
  })
  def('plink', { desc: 'glassy plink (x3 ascending: pitch 1, 1.26, 1.5 or note)', params: 'gain, pitch | note, pan', send: 0.25 }, (o, r) => {
    const f = o.note != null ? midi(o.note) : 1047 * o.pitch
    return sum(0.5, [[modal(f, [[1, 1, 0.45], [3.0, 0.18, 0.12], [5.2, 0.08, 0.05]], 0.5, r, { strike: 0.25, strikeFc: 7000 }), 1]])
  })
  def('chime', { desc: 'three-note rising glock chime', params: 'gain, pitch, pan', send: 0.3 }, (o) => {
    const s = Math.round(12 * Math.log2(o.pitch))
    return sum(1.8, [84, 88, 91].map((m, i) => [glockN(m + s), 0.8, i * 0.09]))
  })
  def('sparkle', { desc: 'random high glock twinkles', params: 'gain, pitch, pan', send: 0.35, off: -2 }, (o, r) => {
    const notes = [84, 86, 89, 91, 93, 96, 98, 101]
    const s = Math.round(12 * Math.log2(o.pitch))
    const parts = []
    for (let i = 0; i < 6; i++) parts.push([glockN(notes[Math.floor(r() * notes.length)] + s), 0.5 + 0.3 * r(), i * 0.055, (r() * 2 - 1) * 0.6])
    return stereoOf(1.4, parts)
  })
  def('swirl', { desc: 'harp + glock swirl for page turns', params: 'gain, pan, dir (1 up | −1 down)', send: 0.35, off: -3 }, (o) => {
    const S = stem(ns(1.9))
    const G = { harp: GROUPS.harp.g, bell: GROUPS.bell.g }
    swirlInto((g, src, t, vel, pan) => put(S, src, t + 0.3, vel * G[g] * 3, pan), 0, o.dir || 1, 1)
    return [S.L, S.R]
  })
  def('toyRun', { desc: 'toy-piano run rising two octaves', params: 'dur (0.7), gain, pitch, pan', dur: 0.7, off: -2, send: 0.25 }, (o) => {
    const d = o.dur || 0.7
    const scale = [77, 79, 81, 82, 84, 86, 88, 89, 91, 93, 94, 96, 98, 100, 101]
    const s = Math.round(12 * Math.log2(o.pitch))
    return sum(d + 1.3, scale.map((m, i) => [toyN(m + s - 12), 0.6 + (0.4 * i) / scale.length, (d * i) / scale.length]))
  })
  def('snareRoll', { desc: 'toy snare roll crescendo', params: 'dur (1.2), gain, pan', dur: 1.2, off: -2 }, (o) => {
    const d = o.dur || 1.2
    const parts = []
    let i = 0
    for (let t = 0; t < d; t += t > d - 0.3 ? 0.036 : 0.072) {
      parts.push([snareN(i % 6), 0.2 + 0.8 * Math.pow(t / d, 1.5), t])
      i++
    }
    parts.push([snareN(1), 1.1, d])
    return sum(d + 0.35, parts)
  })
  def('bandHit', { desc: 'full-band stab (strum + bass + glock + claps + tambourine)', params: 'gain, pan', off: 2, send: 0.2 }, () => {
    const S = stem(ns(1.9))
    bandHit({ put: (g, src, t, vel, pan = 0, opt) => put(S, src, t + 0.02, vel * GROUPS[g].g, GROUPS[g].pan + pan, 0, opt) }, 0, 1)
    return [S.L, S.R]
  })
  def('pluck', { desc: 'single ukulele pluck', params: 'gain, note (72) | pitch, pan', send: 0.2 }, (o) => ukeN(Math.round(pitchMidi(o, 72)), 1, 0))
  def('kazooTada', { desc: "kazoo 'ta-da!'", params: 'gain, pitch, pan', send: 0.2 }, (o, r) => {
    const s = 12 * Math.log2(o.pitch)
    return kazoo([[0, 0.11, 72 + s, { scoop: 1 }], [0.15, 0.48, 77 + s, { scoop: 0.6, vib: 0.35 }]], r)
  })
  def('rooster', { desc: 'kazoo rooster crow (cock-a-doodle-doo)', params: 'gain, pitch, pan', send: 0.2 }, (o, r) => {
    const s = 12 * Math.log2(o.pitch)
    return kazoo([[0, 0.1, 72 + s, { scoop: 1.5 }], [0.12, 0.09, 76 + s], [0.23, 0.11, 74 + s], [0.37, 0.56, 81 + s, { scoop: 2, fall: 4, vib: 0.4 }]], r)
  })
  def('honk', { desc: 'kazoo honk (comic accent)', params: 'gain, pitch, pan', send: 0.15 }, (o, r) => kazoo([[0, 0.2, 67 + 12 * Math.log2(o.pitch), { scoop: 1.4, fall: 1 }]], r))
  def('bwomp', { desc: "comic bassoon 'bwomp'", params: 'gain, pitch, pan', send: 0.15 }, (o, r) => {
    const d = 0.62
    const f = (t) => o.pitch * (t < 0.05 ? 92 + 8 * (t / 0.05) : 100 * Math.pow(0.74, clamp((t - 0.05) / 0.4, 0, 1)))
    const n = ns(d)
    const src = osc(n, f, 'saw')
    mixIn(src, osc(n, f, 'sqr'), 0.35)
    const y = svf(src, (t) => 1300 - 950 * clamp(t / 0.45, 0, 1), 1.5, LP)
    const fm = svf(src, 480, 3, BP)
    for (let i = 0; i < n; i++) y[i] = (y[i] + 0.6 * fm[i]) * ASR(0.03, 0.34, 0.24)(i / SR)
    return y
  })
  def('cuckoo', { desc: 'whistled cuckoo', params: 'gain, pitch, pan' }, (o, r) =>
    sum(0.8, [
      [slideWhistle(0.22, () => midi(76) * o.pitch, r), 1],
      [slideWhistle(0.3, () => midi(72) * o.pitch, r), 1, 0.3],
    ])
  )
  def('slideUp', { desc: 'slide whistle up', params: 'dur (0.45), gain, pitch, pan', dur: 0.45 }, (o, r) => {
    const d = o.dur || 0.45
    return slideWhistle(d + 0.05, (t) => 420 * o.pitch * Math.pow(1500 / 420, clamp(t / d, 0, 1)), r)
  })
  def('slideDown', { desc: 'slide whistle down', params: 'dur (0.45), gain, pitch, pan', dur: 0.45 }, (o, r) => {
    const d = o.dur || 0.45
    return slideWhistle(d + 0.05, (t) => 1400 * o.pitch * Math.pow(380 / 1400, clamp(t / d, 0, 1)), r)
  })
  def('twang', { desc: 'yarn string twang (wobbly)', params: 'gain, pitch, pan' }, (o) => {
    const x = svf(ks(98 * o.pitch, { len: 0.9, t60: 0.5, bright: 0.35, pick: 0.3, seed: 11 }), 1800, 0.7, LP)
    return normPeak(warp(x, (t) => 1 + 0.035 * Math.sin(TAU * 7 * t) * Math.exp(-t / 0.25)))
  })
  def('claps', { desc: 'small crowd clapping', params: 'dur (1.2), gain, pan', dur: 1.2, off: -3 }, (o, r) => {
    const d = o.dur || 1.2
    const parts = []
    for (let p = 0; p < 4; p++) {
      const per = 0.2 + r() * 0.08
      const pan = (p / 3 - 0.5) * 1.2
      for (let t = r() * 0.1; t < d; t += per * (0.93 + 0.14 * r())) parts.push([clapN(Math.floor(r() * 16)), (0.6 + 0.4 * r()) * clamp((d - t) / (d * 0.5), 0.15, 1), t, pan])
    }
    return stereoOf(d + 0.3, parts)
  })
  def('applause', { desc: 'bigger applause wash', params: 'dur (1.6), gain, pan', dur: 1.6, off: -3 }, (o, r) => {
    const d = o.dur || 1.6
    const parts = []
    const k = Math.floor(d * 60)
    for (let i = 0; i < k; i++) {
      const t = r() * d
      parts.push([clapN(Math.floor(r() * 16)), (0.4 + 0.6 * r()) * (1 - t / d), t, r() * 1.6 - 0.8])
    }
    return stereoOf(d + 0.3, parts)
  })
  // aliases the storyboard might use
  def('tick', { desc: 'clock tick (woody, high)', params: 'gain, pitch, pan', off: -3 }, (o, r) => modal(1900 * o.pitch, [[1, 1, 0.06], [2.43, 0.35, 0.035]], 0.1, r, { attack: 0.0003, strike: 0.3, strikeFc: 3000 }))
  def('tock', { desc: 'clock tock (woody, low)', params: 'gain, pitch, pan', off: -3 }, (o, r) => modal(1250 * o.pitch, [[1, 1, 0.07], [2.43, 0.35, 0.04]], 0.12, r, { attack: 0.0003, strike: 0.3, strikeFc: 2500 }))

  /** render one sfx event → { buf: mono|[L,R] (level-normalised), send } */
  function renderCue(e, idx) {
    const fn = SFX[e.type]
    const meta = META[e.type]
    const o = { pitch: e.pitch > 0 ? e.pitch : 1, dur: e.dur > 0 ? e.dur : undefined, pan: e.pan, note: e.note, dir: e.dir }
    const r = rngOf('sfx', e.type, (+e.t || 0).toFixed(3), idx)
    const raw = fn(o, r)
    const src = Array.isArray(raw) ? raw.map((c) => svf(c, 55, 0.7, HP)) : svf(raw, 55, 0.7, HP) // nothing below laptop speakers
    const chans = Array.isArray(src) ? src : [src]
    const lu = loudnessOf(chans).shortMax
    const g = Number.isFinite(lu) ? db(SFX_REF + meta.off - lu) : 0
    // clicks stay clicky but never spike past SFX_PEAK (a sub-ms tanh knee is inaudible)
    const cap = db(SFX_PEAK) / Math.max(g, 1e-9)
    for (const c of chans) softCap(c, cap)
    return { src, g, send: meta.send }
  }

  // ═════════════════════════════ voice-over ═════════════════════════════════
  function monoOf(b) {
    const n = b.length
    const x = new Float32Array(n)
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c)
      for (let i = 0; i < n; i++) x[i] += d[i] / b.numberOfChannels
    }
    return resample(x, b.sampleRate / SR)
  }
  /** speech spans (global seconds) found in a clip */
  function speechSpans(x, start) {
    const hop = ns(0.01)
    const win = ns(0.03)
    const rms = []
    for (let a = 0; a + win <= x.length; a += hop) {
      let s = 0
      for (let i = a; i < a + win; i++) s += x[i] * x[i]
      rms.push(Math.sqrt(s / win))
    }
    const pk = Math.max(0, ...rms)
    const thr = Math.max(pk * db(-32), db(-58))
    const spans = []
    let on = -1
    rms.forEach((v, k) => {
      const t = start + (k * hop + win / 2) / SR
      if (v > thr && on < 0) on = t
      if (v <= thr && on >= 0) {
        spans.push([on, t])
        on = -1
      }
    })
    if (on >= 0) spans.push([on, start + x.length / SR])
    const out = []
    for (const s of spans) {
      const last = out[out.length - 1]
      if (last && s[0] - last[1] < 0.25) last[1] = s[1]
      else out.push(s)
    }
    return out.filter((s) => s[1] - s[0] > 0.05)
  }
  /** music gain curve at 100 Hz: 1 → −10 dB under speech, merged, smooth */
  function duckCurve(spans, dur) {
    const fr = 100
    const n = Math.ceil(dur * fr) + 2
    const tgt = new Float32Array(n).fill(1)
    const ex2 = spans.map(([a, b]) => [a - 0.14, b + 0.12]).sort((a, b) => a[0] - b[0])
    const merged = []
    for (const s of ex2) {
      const last = merged[merged.length - 1]
      if (last && s[0] - last[1] < 0.7) last[1] = Math.max(last[1], s[1])
      else merged.push(s.slice())
    }
    for (const [a, b] of merged) for (let k = Math.max(0, Math.ceil(a * fr)); k <= Math.min(n - 1, Math.floor(b * fr)); k++) tgt[k] = DUCK
    const out = new Float32Array(n)
    let g = 1
    for (let k = 0; k < n; k++) {
      const tau = tgt[k] < g ? 0.05 : 0.3
      g += (tgt[k] - g) * (1 - Math.exp(-1 / (fr * tau)))
      out[k] = g
    }
    return { curve: out, merged }
  }

  // ═════════════════════════════ reverb IR ══════════════════════════════════
  let IR = null
  function makeIR() {
    const len = 1.9
    const n = ns(len)
    const chans = [0, 1].map((ch) => {
      const r = rngOf('ir', ch)
      const x = noise(n, r)
      const lo = svf(x, 2200, 0.6, LP)
      const y = new Float32Array(n)
      const pre = ns(0.011)
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / SR
        const hi = x[i] - lo[i]
        y[i] = (lo[i] * Math.exp((-6.91 * t) / 1.5) + hi * Math.exp((-6.91 * t) / 0.55)) * (1 - Math.exp(-t / 0.012))
      }
      // early reflections
      for (let k = 0; k < 8; k++) {
        const t = 0.006 + r() * 0.04
        y[ns(t)] += (r() < 0.5 ? -1 : 1) * (0.5 - k * 0.04) * 6
      }
      return y
    })
    let e = 0
    for (const c of chans) for (let i = 0; i < n; i++) e += c[i] * c[i]
    const k = 1 / Math.sqrt(e / 2)
    for (const c of chans) for (let i = 0; i < n; i++) c[i] *= k
    return chans
  }

  // ═════════════════════════════ master ═════════════════════════════════════
  /** 4× windowed-sinc interpolation kernels (phases ¼, ½, ¾; 32 taps) for true-peak detection */
  const TP_K = [0.25, 0.5, 0.75].map((f) => {
    const h = new Float64Array(32)
    for (let k = -15; k <= 16; k++) {
      const x = k - f
      const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / 16.5) + 0.08 * Math.cos((2 * Math.PI * x) / 16.5) // Blackman
      h[k + 15] = (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w
    }
    return h
  })
  /** true peak of x between samples i and i+1 */
  function tpAt(x, i) {
    let m = Math.abs(x[i])
    if (i < 15 || i + 16 >= x.length) return m
    for (const h of TP_K) {
      let v = 0
      for (let k = 0; k < 32; k++) v += x[i - 15 + k] * h[k]
      if (Math.abs(v) > m) m = Math.abs(v)
    }
    return m
  }
  /** stereo-linked look-ahead limiter (offline), true-peak aware */
  function limit(L, R, ceil) {
    const n = L.length
    const la = ns(0.004)
    const req = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let p = Math.max(Math.abs(L[i]), Math.abs(R[i]))
      if (p > ceil * 0.5) p = Math.max(tpAt(L, i), tpAt(R, i), tpAt(L, i - 1), tpAt(R, i - 1))
      req[i] = p > ceil ? ceil / p : 1
    }
    // look-ahead min (monotonic deque)
    const m = new Float32Array(n)
    const dq = new Int32Array(n)
    let h = 0
    let tl = 0
    for (let i = n - 1; i >= 0; i--) {
      while (tl > h && req[dq[tl - 1]] >= req[i]) tl--
      dq[tl++] = i
      while (dq[h] > i + la) h++
      m[i] = req[dq[h]]
    }
    // release smoothing
    const rel = 1 - Math.exp(-1 / (0.08 * SR))
    let s = 1
    for (let i = 0; i < n; i++) {
      s = Math.min(m[i], s + (1 - s) * rel)
      m[i] = s
    }
    // attack smoothing: moving average over the look-ahead
    let acc = 0
    const g = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      acc += m[i]
      if (i >= la) acc -= m[i - la]
      g[i] = acc / Math.min(i + 1, la)
    }
    let minG = 1
    let at = 0
    let busy = 0
    const events = []
    for (let i = 0; i < n; i++) {
      L[i] *= g[i]
      R[i] *= g[i]
      if (g[i] < minG) {
        minG = g[i]
        at = i
      }
      if (g[i] < 0.989) {
        busy++ // > 0.1 dB of gain reduction
        const t = +(i / SR).toFixed(1)
        const last = events[events.length - 1]
        if (!last || t - last.t > 0.25) events.push({ t, grDb: 0 })
        const e = events[events.length - 1]
        e.grDb = Math.max(e.grDb, +(-20 * Math.log10(g[i])).toFixed(2))
      }
    }
    return { maxGrDb: -20 * Math.log10(minG), worstAt: at / SR, activePct: (100 * busy) / Math.max(1, n), events: events.slice(0, 40) }
  }

  // ═════════════════════════════ renderMix ══════════════════════════════════
  async function renderMix(plan) {
    const duration = Math.max(0.1, +plan.duration || 0)
    const n = ns(duration)
    const mute = new Set(plan.mute || [])
    const normalize = plan.normalize !== false
    const info = { stats: {} }

    // ---- music (JS stems) ----
    const M = musicMixer(n, plan.solo)
    let X = null
    if (plan.music !== false && !mute.has('music')) X = scoreMusic(plan, M)
    let gm = 1
    if (X && !plan.solo) {
      const lm = loudnessOf([M.L, M.R]).integrated
      if (Number.isFinite(lm)) gm = db(MUSIC_LUFS - lm)
      // tame stray transients (glock strikes, stacked hits) before the mix: cap = MUSIC_LUFS + 15 dB
      const cap = db(MUSIC_LUFS + 15) / gm
      softCap(M.L, cap)
      softCap(M.R, cap)
    }

    // ---- voice-over ----
    const V = stem(n)
    const Cm = stem(n)
    const spans = []
    const camSpans = []
    for (const v of plan.vo || []) {
      if (!v || !v.buffer) continue
      const kind = v.kind === 'cameo' ? 'cameo' : 'narration'
      const muted = mute.has(kind === 'cameo' ? 'cameo' : 'vo') // muted voices still duck/carve (tests)
      const x = monoOf(v.buffer)
      if (kind === 'narration') spans.push(...speechSpans(x, v.start))
      else camSpans.push(...speechSpans(x, v.start))
      if (muted) continue
      const lu = loudnessOf([x]).integrated
      const g = (Number.isFinite(lu) ? db(clamp((kind === 'cameo' ? CAMEO_LUFS : VO_LUFS) - lu, -12, 14)) : 1) * (v.gain != null ? v.gain : 1)
      put(kind === 'narration' ? V : Cm, x, v.start, g, v.pan || 0, kind === 'narration' ? 0.07 : 0.12)
    }

    // voice EQ in JS (so the peak catch below really is the last stage): clean lows, less box, presence
    for (const c of [V.L, V.R]) {
      biq(c, 'hp', 75)
      biq(c, 'peak', 260, -1.5, 1)
      biq(c, 'peak', 3300, 2.5, 0.9)
    }
    for (const c of [Cm.L, Cm.R]) {
      biq(c, 'hp', 110)
      biq(c, 'peak', 3000, 2, 0.9)
    }
    // narration: gentle compression, then back to VO_LUFS so the compressor only shapes dynamics
    let voGr = 0
    if (spans.length) {
      voGr = compress(V.L, V.R, { thr: VO_LUFS - 2, ratio: 2.2, knee: 6, att: 0.004, rel: 0.14 })
      const lv = loudnessOf([V.L, V.R]).integrated
      const back = Number.isFinite(lv) ? db(VO_LUFS - lv) : 1
      for (let i = 0; i < n; i++) {
        V.L[i] *= back
        V.R[i] *= back
      }
      // plosive peaks: a look-ahead catch 12 dB over the voice loudness (speech crest ~10–12 dB)
      info.voPeak = limit(V.L, V.R, db(VO_LUFS + 12))
    }

    info.cameoPeak = limit(Cm.L, Cm.R, db(CAMEO_LUFS + 11))

    // ---- duck the music under narration ----
    const { curve, merged } = duckCurve(spans, duration)
    info.duckSpans = merged
    for (let i = 0; i < n; i++) {
      const p = (i / SR) * 100
      const k = p | 0
      const g = gm * (curve[k] + (curve[Math.min(k + 1, curve.length - 1)] - curve[k]) * (p - k))
      M.L[i] *= g
      M.R[i] *= g
      M.sL[i] *= g
      M.sR[i] *= g
    }

    // ---- sfx ----
    const F = stem(n)
    if (!mute.has('sfx'))
      (plan.sfx || []).forEach((e, idx) => {
        if (!e || !SFX[e.type]) {
          if (e) console.warn('unknown sfx', e.type)
          return
        }
        if (!(e.t >= -0.5 && e.t < duration)) return
        const { src, g, send } = renderCue(e, idx)
        put(F, src, e.t, g * (e.gain != null ? e.gain : 1), META[e.type].ownPan ? 0 : e.pan || 0, send)
      })

    // ---- WebAudio: EQ + reverb ----
    const ac = new OfflineAudioContext(2, n, SR)
    const srcs = []
    const bufOf = (L, R) => {
      const b = ac.createBuffer(2, n, SR)
      b.copyToChannel(L, 0)
      b.copyToChannel(R, 1)
      const s = ac.createBufferSource()
      s.buffer = b
      srcs.push(s)
      return s
    }
    const master = ac.createGain()
    master.connect(ac.destination)
    const biquad = (type, f, g = 0, q = 0.707) => {
      const bq = ac.createBiquadFilter()
      bq.type = type
      bq.frequency.value = f
      bq.gain.value = g
      bq.Q.value = q
      return bq
    }
    const chain = (src, ...nodes) => nodes.reduce((x, y) => x.connect(y), src)
    // music: a little air on top, and a presence carve (not a duck) while a cameo speaks
    const carve = biquad('peaking', 2400, 0, 0.7)
    carve.gain.setValueAtTime(0, 0)
    const camMerged = []
    for (const sp of camSpans.slice().sort((x, y) => x[0] - y[0])) {
      const last = camMerged[camMerged.length - 1]
      if (last && sp[0] - last[1] < 0.35) last[1] = Math.max(last[1], sp[1])
      else camMerged.push(sp.slice())
    }
    for (const [a, b] of camMerged) {
      carve.gain.setValueAtTime(0, Math.max(0, a - 0.1))
      carve.gain.linearRampToValueAtTime(-5, Math.max(0, a - 0.02))
      carve.gain.setValueAtTime(-5, b + 0.05)
      carve.gain.linearRampToValueAtTime(0, b + 0.2)
    }
    info.cameoSpans = camMerged
    chain(bufOf(M.L, M.R), biquad('highpass', 38, 0, 0.6), biquad('highshelf', 7500, 1.5), carve, master)
    chain(bufOf(F.L, F.R), master)
    // voices (EQ'd, compressed and peak-caught in JS)
    chain(bufOf(V.L, V.R), master)
    chain(bufOf(Cm.L, Cm.R), master)
    // the room: one reverb for the music (choked on the silent beat), one for voice + sfx
    if (!IR) IR = makeIR()
    const irb = ac.createBuffer(2, IR[0].length, SR)
    irb.copyToChannel(IR[0], 0)
    irb.copyToChannel(IR[1], 1)
    const room = () => {
      const c = ac.createConvolver()
      c.normalize = false
      c.buffer = irb
      return c
    }
    const choke = ac.createGain()
    choke.gain.setValueAtTime(1, 0)
    for (const [a, b] of (X && X.chokes) || []) {
      choke.gain.setValueAtTime(1, a)
      choke.gain.linearRampToValueAtTime(0, a + 0.07)
      choke.gain.setValueAtTime(0, Math.max(a + 0.08, b - 0.03))
      choke.gain.linearRampToValueAtTime(1, b)
    }
    chain(bufOf(M.sL, M.sR), biquad('highpass', 180), room(), choke, master)
    const sL = new Float32Array(n)
    const sR = new Float32Array(n)
    for (const S of [F, V, Cm])
      for (let i = 0; i < n; i++) {
        sL[i] += S.sL[i]
        sR[i] += S.sR[i]
      }
    chain(bufOf(sL, sR), biquad('highpass', 180), room(), master)
    for (const s of srcs) s.start(0)
    const out = await ac.startRendering()

    // ---- master: loudness, limiter, fades ----
    const L = out.getChannelData(0)
    const R = out.getChannelData(1)
    if (normalize) {
      const lu = loudnessOf([L, R]).integrated
      const g = Number.isFinite(lu) ? db((plan.targetLufs != null ? plan.targetLufs : TARGET_LUFS) - lu) : 1
      for (let i = 0; i < n; i++) {
        L[i] *= g
        R[i] *= g
      }
      info.masterGainDb = 20 * Math.log10(g)
      // clicks riding on speech peaks: a 2 dB tanh knee shaves them (sub-ms, inaudible) so the
      // limiter does not have to pull the voice down for 80 ms; the limiter stays as the safety net
      softCap(L, CEIL * db(-0.4), 2)
      softCap(R, CEIL * db(-0.4), 2)
      info.limiter = limit(L, R, CEIL)
      const fi = ns(0.004)
      for (let i = 0; i < fi; i++) {
        L[i] *= i / fi
        R[i] *= i / fi
      }
      const fo = Math.min(n, ns(0.3))
      for (let i = 0; i < fo; i++) {
        const k = n - 1 - i
        const e = 0.5 - 0.5 * Math.cos((Math.PI * i) / fo)
        L[k] *= e
        R[k] *= e
      }
    }
    if (X) info.music = { beat: X.beat, logoTime: X.L, button: X.button, secs: X.secs.map((s) => ({ mood: s.mood, start: s.start, end: s.end, variant: s.variant, resume: s.resume })) }
    info.voMaxGrDb = voGr
    renderMix.last = info
    return out
  }

  /** one SFX alone at mix scale (for dev/audio-test) */
  function renderSfx(type, o = {}) {
    const d = Math.max(0.6, (o.dur || (META[type] && META[type].dur) || 0.5) + 1.6)
    return renderMix({ duration: d, bpm: 104, moods: [], vo: [], sfx: [Object.assign({ t: 0.05, type }, o)], music: false, normalize: false })
  }
  function loudness(b) {
    const chans = Array.isArray(b) ? b : Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
    return loudnessOf(chans)
  }

  function toWav(buf) {
    const nCh = buf.numberOfChannels
    const len = buf.length
    const bytes = 44 + len * nCh * 2
    const ab = new ArrayBuffer(bytes)
    const v = new DataView(ab)
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
    w(0, 'RIFF')
    v.setUint32(4, bytes - 8, true)
    w(8, 'WAVE')
    w(12, 'fmt ')
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true)
    v.setUint16(22, nCh, true)
    v.setUint32(24, buf.sampleRate, true)
    v.setUint32(28, buf.sampleRate * nCh * 2, true)
    v.setUint16(32, nCh * 2, true)
    v.setUint16(34, 16, true)
    w(36, 'data')
    v.setUint32(40, len * nCh * 2, true)
    const chans = [...Array(nCh)].map((_, c) => buf.getChannelData(c))
    const r = rngOf('dither')
    let o = 44
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nCh; c++) {
        const x = chans[c][i]
        const d = x === 0 ? 0 : (r() - r()) / 32768 // TPDF dither, silence stays silent
        const s = Math.max(-1, Math.min(1, x + d))
        v.setInt16(o, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
        o += 2
      }
    }
    return ab
  }

  window.AUDIO = {
    SR,
    renderMix,
    toWav,
    SFX_TYPES: Object.keys(SFX),
    SFX_META: META,
    renderSfx,
    loudness,
    // dev/audio-test only: raw note banks for tuning checks
    _dev: { ukeN, pizzN, pizzHiN, harpN, glockN, mboxN, toyN, feltN, kazoo, midi },
  }
})()

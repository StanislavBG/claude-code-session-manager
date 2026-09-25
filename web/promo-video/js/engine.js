/* engine.js — timeline, transitions, captions, player + render hooks.
 *
 * Scenes register with PROMO.scene(id, { draw(ctx, t, dur, info), sfx(dur, info) }).
 * timeline.json (written by build-timeline.mjs from script/script.json + the generated
 * voice clips) decides when each scene starts and ends. The engine draws the stop-motion
 * camera nudge, the transitions between scenes and the burned-in captions.
 *
 * ---- what a scene gets ----------------------------------------------------------------
 * draw(ctx, t, dur, info)   t = scene-local seconds, already quantized to 15 fps. During a
 *                           'pan'/'tilt' transition the engine ALSO draws the scene outside
 *                           [0, dur] (t down to -0.3 before its start, up to dur + 0.3 after
 *                           its end) — clamp your internal timeline so that renders sensibly.
 * sfx(dur, info)            → [{ t (scene-local), type (AUDIO.SFX_TYPES), gain?, pitch?, pan?, dur? }]
 * info = {
 *   id, index, start, end, dur          global start/end (s), scene length
 *   mood                                'chaos' | 'full' | 'night' | 'sunrise' | 'build' | 'finale'
 *   voStart, voEnd                      local time the narration begins / ends (0 if none)
 *   lines   [{ text, start, end }]      narration clips, local times (text = caption text)
 *   words   [{ word, start, end }]      estimated per-word times (lower-case, punctuation stripped)
 *   wordAt(word, fallback = 0, nth = 0) → local time `word` is spoken (nth occurrence) — sync to this
 *   cameos  [{ id, text, start, duration, end }]   character cameos (local times, never captioned)
 *   cameoAt(id, fallback = 0)           → local start time of a cameo
 *   beat                                seconds per beat (60 / timeline.bpm; ~0.58 s)
 *   nextBeat(localT)                    → local time of the first beat ≥ localT (grid anchored at global 0)
 *   transIn, transOut                   transition kind into this scene / into the next one (or null)
 *   camShift(localT)                    → { dx, dy } the engine's pan/tilt offset applied to this scene
 *                                         at localT ({0,0} outside a pan/tilt) — counter-shift background
 *                                         layers by a fraction of it for parallax
 * }
 *
 * ---- transitions (kind is set on the INCOMING scene; all centred on the cut) -----------
 *   wipe  0.72 s  a torn coloured sheet sweeps right→left across the frame
 *   drop  0.72 s  a sheet falls top→bottom across the frame
 *   tape  0.84 s  three wide washi strips (terracotta / butter / peach) slap diagonally across,
 *                 cover the cut, then rip off up-right revealing the new scene
 *   pan   0.60 s  camera pans: outgoing slides left, incoming slides in from the right with a
 *                 torn leading edge + shadow on the seam (both scenes drawn, inOutCubic)
 *   tilt  0.60 s  camera tilts up: incoming slides down from the top, outgoing slides down and out
 *   none          hard cut (the scene continues the previous set itself)
 *
 * window.PROMO (used by render.mjs / preview.mjs through Playwright):
 *   ready            Promise — fonts, timeline, textures loaded
 *   duration, fps, timeline, TRANSITIONS
 *   drawFrame(t)     draw global time t onto the stage canvas (pure function of t)
 *   renderAudioWav() Promise<base64 WAV> of the full mix
 *   contactSheet(times, cols, width) → PNG data URL grid of frames
 *   allSfx()         every scheduled sfx (scene sfx + transition sfx), global times
 */
(function () {
  'use strict'
  const { W, H, C } = K
  const params = new URLSearchParams(location.search)
  const RENDER = params.has('render')
  const scenes = new Map()
  const state = { timeline: null, captions: params.get('cc') !== '0', mix: null }

  function scene(id, def) {
    scenes.set(id, def)
  }

  // ---------- transitions: half-lengths around the cut ----------
  const TRANSITIONS = {
    wipe: { half: 0.36, sfx: 'swoosh' },
    drop: { half: 0.36, sfx: 'slideDown' },
    tape: { half: 0.42, sfx: 'tape' },
    pan: { half: 0.3, sfx: 'whoosh' },
    tilt: { half: 0.3, sfx: 'slideUp' },
    none: { half: 0, sfx: null },
  }
  const kindOf = (sc) => (sc && TRANSITIONS[sc.transition] ? sc.transition : 'wipe')
  const isCamera = (kind) => kind === 'pan' || kind === 'tilt'

  // ---------- captions ----------
  /**
   * Split a VO line into caption chunks of ≤ ~42 chars. Balanced: a line is cut into the fewest
   * chunks that fit, at the break that best evens their lengths, preferring punctuation — so no
   * orphan "Code." / "you." chunk trails behind.
   */
  const CAP_MAX = 42
  function chunkLine(text) {
    const words = text.split(/\s+/).filter(Boolean)
    if (text.length <= CAP_MAX + 4 || words.length < 2) return [words.join(' ')]
    const n = Math.ceil(text.length / CAP_MAX)
    const target = text.length / n
    let best = null
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ')
      const b = words.slice(i).join(' ')
      let cost = Math.abs(a.length - target) + (n === 2 ? Math.abs(b.length - target) : 0)
      if (/[,;:—.!?]$/.test(words[i - 1])) cost -= 16
      if (words[i] === '—') cost += 20 // never start a chunk with a dash
      if (a.length > CAP_MAX + 4) cost += 100
      if (!best || cost < best.cost) best = { cost, a, rest: words.slice(i).join(' ') }
    }
    return [best.a, ...chunkLine(best.rest)]
  }
  // MUST match build-timeline.mjs (it places word-anchored cameos with the same estimate)
  const weight = (s) => s.replace(/[^a-z0-9]/gi, '').length + 2 * (s.match(/[,.!?;:—]/g) || []).length
  const cleanWord = (w) => String(w).replace(/[^a-z0-9'-]/gi, '').toLowerCase()
  /** Timed caption chunks for every NARRATION clip (cameos are never captioned). */
  function buildCaptions(tl) {
    const caps = []
    for (const sc of tl.scenes) {
      for (const v of sc.vo || []) {
        const chunks = chunkLine(v.text)
        const total = chunks.reduce((a, c) => a + weight(c), 0)
        let at = v.start
        for (const c of chunks) {
          const d = (weight(c) / total) * v.duration
          caps.push({ start: at, end: at + d, text: c, scene: sc.id })
          at += d
        }
      }
    }
    // hold each chunk until the next one starts (max +0.6s) so captions don't flicker
    for (let i = 0; i < caps.length; i++) {
      const next = caps[i + 1]
      caps[i].hold = next ? Math.min(next.start, caps[i].end + 0.6) : caps[i].end + 0.6
    }
    return caps
  }
  /** Approximate spoken times of each word in a scene's VO (scene-local seconds). */
  function wordTimes(sc) {
    const out = []
    for (const v of sc.vo || []) {
      const words = (v.say || v.text).split(/\s+/).filter(Boolean)
      const total = words.reduce((a, w) => a + weight(w) + 1, 0)
      let at = v.start - sc.start
      for (const w of words) {
        const d = ((weight(w) + 1) / total) * v.duration
        out.push({ word: cleanWord(w), start: at, end: at + d })
        at += d
      }
    }
    return out
  }

  function drawCaption(ctx, t) {
    const caps = state.caps
    const c = caps.find((x) => t >= x.start && t < x.hold)
    if (!c) return
    const size = 46
    K.font(ctx, 'hand', size)
    const w = Math.min(ctx.measureText(c.text).width + 70, W - 120)
    const appear = K.ease.outBack(K.seg(t, c.start, c.start + 0.18))
    K.at(ctx, W / 2, H - 70, -0.004, [1, 0.6 + 0.4 * appear], () => {
      K.paper(ctx, K.boxPts(w, size + 30), C.paperWhite, { seed: 'cap' + c.start.toFixed(2), torn: 4, shadow: 0.9 })
      K.hand(ctx, c.text, 0, size * 0.33, { size, family: 'hand', t, id: 'cap' + c.start.toFixed(2), jitter: 0.5 })
    })
  }

  // ---------- transition: paper wipe / drop (overlay sheets) ----------
  function drawWipe(ctx, p, idx, kind) {
    // p: 0 (sheet off right) → 0.5 (covers frame) → 1 (off left)
    const colors = [C.terracotta, C.butter, C.hiveTeal, C.peach, C.sage, C.honey, C.sky, C.pink]
    const color = colors[idx % colors.length]
    if (kind === 'drop') {
      const y = K.lerp(-H * 1.2, H * 1.2, K.ease.inOutCubic(p))
      K.at(ctx, W / 2, y + H / 2, (p - 0.5) * 0.05, 1, () => {
        K.paper(ctx, K.boxPts(W * 1.25, H * 1.15), color, { torn: 12, seed: 'wipe' + idx, lift: 10 })
        K.tape(ctx, -W * 0.3, -H * 0.5, 220, -0.2, 'rgba(255,255,255,0.6)', { seed: 'wt' + idx })
        K.tape(ctx, W * 0.3, -H * 0.5, 220, 0.18, 'rgba(255,255,255,0.6)', { seed: 'wt2' + idx })
      })
      return
    }
    const x = K.lerp(W * 1.35, -W * 1.35, K.ease.inOutCubic(p))
    K.at(ctx, x + W / 2, H / 2, -0.04 + p * 0.06, 1, () => {
      K.paper(ctx, K.boxPts(W * 1.3, H * 1.4), color, { torn: 14, seed: 'wipe' + idx, lift: 12 })
      // a doodle on the sheet so the wipe isn't a blank card
      K.twinkle(ctx, -W * 0.18, -H * 0.12, 46, 'wtw' + idx, p * 3, C.paperWhite)
      K.twinkle(ctx, W * 0.2, H * 0.14, 30, 'wtw2' + idx, p * 3, C.lemon)
    })
  }

  // ---------- transition: washi tape rip ----------
  // Three wide washi strips laid along one diagonal. Their bands (perpendicular to the strip)
  // are sized from the frame's corners so that, at the cut, together they cover every pixel.
  const TAPE_ANGLE = -0.26 // rises to the right
  const TAPE_GEO = (() => {
    const u = [Math.cos(TAPE_ANGLE), Math.sin(TAPE_ANGLE)]
    const n = [-u[1], u[0]]
    const corners = [[0, 0], [W, 0], [0, H], [W, H]]
    const pu = corners.map(([x, y]) => x * u[0] + y * u[1])
    const pn = corners.map(([x, y]) => x * n[0] + y * n[1])
    const u0 = Math.min(...pu)
    const u1 = Math.max(...pu)
    const n0 = Math.min(...pn)
    const n1 = Math.max(...pn)
    const band = (n1 - n0) / 3
    const thick = band + 110 // generous overlap between strips
    const len = u1 - u0 + 320
    const uc = (u0 + u1) / 2
    const strips = [0, 1, 2].map((j) => ({ nc: n0 + band * (j + 0.5), ang: TAPE_ANGLE + (j - 1) * 0.018 }))
    return { u, n, thick, len, uc, strips }
  })()
  const TAPE_STYLE = [
    { color: C.terracotta, pattern: 'stripes' },
    { color: C.butter, pattern: 'dots' },
    { color: C.peach, pattern: 'stripes' },
  ]
  /** Washi strip polygon (local, centred): straight long edges, torn zig-zag short ends. */
  function tapeStripPts(len, thick, seed) {
    const r = K.rng('tapeT', seed)
    const pts = []
    const teeth = 22
    const half = len / 2
    const hy = thick / 2
    // top long edge (left → right) with a faint hand-cut wobble
    for (let i = 0; i <= 12; i++) pts.push([-half + (i / 12) * len, -hy + (r() - 0.5) * 3])
    // right end: zig-zag down
    for (let i = 1; i < teeth; i++) pts.push([half + (i % 2 ? -16 : 10) + (r() - 0.5) * 10, -hy + (i / teeth) * thick])
    // bottom long edge (right → left)
    for (let i = 12; i >= 0; i--) pts.push([-half + (i / 12) * len, hy + (r() - 0.5) * 3])
    // left end: zig-zag up
    for (let i = teeth - 1; i > 0; i--) pts.push([-half + (i % 2 ? 16 : -10) + (r() - 0.5) * 10, -hy + (i / teeth) * thick])
    return pts
  }
  const tapeCache = new Map()
  function drawTapeStrip(ctx, j, idx, lift) {
    const G = TAPE_GEO
    const style = TAPE_STYLE[j]
    const key = idx + ':' + j
    let pts = tapeCache.get(key)
    if (!pts) tapeCache.set(key, (pts = tapeStripPts(G.len, G.thick, key)))
    K.dropShadow(ctx, pts, 1.1, 6 + lift)
    ctx.save()
    K.pathPoly(ctx, pts)
    ctx.fillStyle = K.paperPattern(ctx, style.color)
    ctx.fill()
    ctx.clip()
    // printed washi pattern
    ctx.globalAlpha = 0.24
    if (style.pattern === 'dots') {
      ctx.fillStyle = C.paperWhite
      for (let x = -G.len / 2 + 30; x < G.len / 2; x += 74) {
        for (let y = -G.thick / 2 + 30; y < G.thick / 2; y += 74) {
          const ox = (Math.round((y + G.thick) / 74) % 2) * 37
          ctx.beginPath()
          ctx.arc(x + ox, y, 11, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    } else {
      ctx.strokeStyle = C.paperWhite
      ctx.lineWidth = 26
      for (let x = -G.len / 2 - G.thick; x < G.len / 2 + G.thick; x += 78) {
        ctx.beginPath()
        ctx.moveTo(x, -G.thick / 2 - 10)
        ctx.lineTo(x + G.thick * 0.55, G.thick / 2 + 10)
        ctx.stroke()
      }
    }
    // translucent washi edges + a few crinkles along the strip
    ctx.globalAlpha = 1
    ctx.fillStyle = 'rgba(255,250,240,0.22)'
    ctx.fillRect(-G.len / 2 - 20, -G.thick / 2 - 4, G.len + 40, 14)
    ctx.fillRect(-G.len / 2 - 20, G.thick / 2 - 10, G.len + 40, 14)
    const r = K.rng('crinkle', key)
    ctx.strokeStyle = 'rgba(90,60,30,0.10)'
    ctx.lineWidth = 2.5
    for (let k = 0; k < 4; k++) {
      const y = (r() - 0.5) * G.thick * 0.8
      const x0 = -G.len / 2 + r() * G.len * 0.5
      ctx.beginPath()
      ctx.moveTo(x0, y)
      ctx.quadraticCurveTo(x0 + 180, y + (r() - 0.5) * 24, x0 + 360 + r() * 300, y + (r() - 0.5) * 16)
      ctx.stroke()
    }
    ctx.restore()
  }
  function drawTape(ctx, p, idx) {
    // p: 0 → 0.5 strips slap on one after another (cover the cut) → 1 ripped off up-right
    const G = TAPE_GEO
    for (let j = 0; j < 3; j++) {
      const pin = K.seg(p, 0.02 + j * 0.1, 0.3 + j * 0.1)
      const pout = K.seg(p, 0.53 + (2 - j) * 0.07, 0.83 + (2 - j) * 0.07)
      if (pin <= 0 || pout >= 1) continue
      const travel = G.len + 260
      const off = -travel * (1 - K.ease.outCubic(pin)) + travel * K.ease.inCubic(pout)
      const s = G.strips[j]
      const along = G.uc + off
      const cx = G.n[0] * s.nc + G.u[0] * along
      const cy = G.n[1] * s.nc + G.u[1] * along
      // ripping curls the strip a touch and lifts it off the page
      const rot = s.ang - pout * 0.07 + (1 - pin) * 0.03
      K.at(ctx, cx, cy, rot, 1 + pout * 0.03, () => drawTapeStrip(ctx, j, idx, pout * 26))
    }
  }

  // ---------- transition: camera pan / tilt (two scenes on screen) ----------
  /** Torn leading edge of the incoming sheet, in the sheet's own frame. */
  const edgeCache = new Map()
  function sheetEdge(idx, kind) {
    const key = idx + kind
    let e = edgeCache.get(key)
    if (e) return e
    const horiz = kind === 'pan'
    const span = horiz ? H : W
    const n = Math.ceil((span + 160) / 16)
    const r = K.rng('seam', key)
    let drift = 0
    const sheet = []
    const rim = []
    for (let i = 0; i <= n; i++) {
      const a = -80 + (i / n) * (span + 160)
      drift = drift * 0.55 + (r() - 0.5) * 7
      const d = 10 + K.noise1(i * 0.22, 'seamw', key) * 9 + drift // depth into the sheet
      const dr = d - 6 - r() * 5 // white fibre rim pokes out past the colour
      sheet.push(horiz ? [d, a] : [a, H - d])
      rim.push(horiz ? [dr, a] : [a, H - dr])
    }
    const close = horiz ? [[W + 80, H + 80], [W + 80, -80]] : [[W + 80, -80], [-80, -80]]
    e = { sheet: sheet.concat(close), rim: rim.concat(close) }
    edgeCache.set(key, e)
    return e
  }
  function camOffsets(kind, p) {
    const e = K.ease.inOutCubic(K.clamp01(p))
    return kind === 'pan'
      ? { out: [-W * e, 0], in: [W * (1 - e), 0] }
      : { out: [0, H * e], in: [0, -H * (1 - e)] }
  }
  function drawCamera(ctx, t, k, p, kind) {
    const list = state.timeline.scenes
    const off = camOffsets(kind, p)
    const A = list[k - 1]
    const B = list[k]
    if (Math.abs(off.out[0]) < W - 1 && Math.abs(off.out[1]) < H - 1) {
      ctx.save()
      ctx.translate(off.out[0], off.out[1])
      drawScene(ctx, k - 1, t - A.start)
      ctx.restore()
    }
    if (Math.abs(off.in[0]) >= W - 1 || Math.abs(off.in[1]) >= H - 1) return
    const edge = sheetEdge(k, kind)
    const horiz = kind === 'pan'
    ctx.save()
    ctx.translate(off.in[0], off.in[1])
    // shadow the incoming sheet casts on the outgoing one (it lies on top, lifted a little)
    const sh = horiz ? [[-7, 3, 0.16], [-17, 7, 0.09], [-30, 11, 0.05]] : [[3, 7, 0.16], [7, 17, 0.09], [11, 30, 0.05]]
    for (const [dx, dy, a] of sh) {
      ctx.save()
      ctx.translate(dx, dy)
      K.pathPoly(ctx, edge.rim)
      ctx.fillStyle = `rgba(58,36,14,${a})`
      ctx.fill()
      ctx.restore()
    }
    // white fibre rim of the torn edge
    K.pathPoly(ctx, edge.rim)
    ctx.fillStyle = K.paperPattern(ctx, C.paperWhite)
    ctx.fill()
    // the incoming scene, clipped to its torn sheet
    K.pathPoly(ctx, edge.sheet)
    ctx.clip()
    ctx.fillStyle = C.paper
    ctx.fillRect(-80, -80, W + 160, H + 160)
    drawScene(ctx, k, t - B.start)
    ctx.restore()
  }

  // ---------- frame ----------
  function sceneAt(t) {
    const list = state.timeline.scenes
    for (let i = 0; i < list.length; i++) if (t < list[i].end || i === list.length - 1) return i
    return list.length - 1
  }
  function drawScene(ctx, i, local) {
    const sc = state.timeline.scenes[i]
    const def = scenes.get(sc.id)
    ctx.save()
    try {
      if (def) def.draw(ctx, local, sc.end - sc.start, sc.info)
      else {
        K.desk(ctx)
        K.ransom(ctx, sc.id, W / 2, H / 2, { size: 70, t: local })
      }
    } catch (e) {
      console.error('scene', sc.id, 't=' + local.toFixed(2), e && e.stack ? e.stack : e)
      K.hand(ctx, 'scene error: ' + sc.id + ' — ' + (e && e.message), W / 2, H / 2, { size: 40, color: C.tomato })
    }
    ctx.restore()
  }
  /** Active pan/tilt around global t: { k (incoming index), p, kind } or null. */
  function cameraAt(t, i) {
    const list = state.timeline.scenes
    for (const k of [i, i + 1]) {
      if (k < 1 || k >= list.length) continue
      const kind = kindOf(list[k])
      if (!isCamera(kind)) continue
      const half = TRANSITIONS[kind].half
      const cut = list[k].start
      if (t >= cut - half && t < cut + half) return { k, p: (t - (cut - half)) / (2 * half), kind }
    }
    return null
  }

  function drawFrame(tRaw, target) {
    const ctx = target || state.ctx
    const t = K.quant(Math.max(0, Math.min(tRaw, state.timeline.duration - 1e-3)))
    const list = state.timeline.scenes
    const i = sceneAt(t)
    const sc = list[i]
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = C.paper
    ctx.fillRect(0, 0, W, H)
    // stop-motion camera bump
    const cam = K.nudge('cam', t, 0.7)
    // whole-pixel bump: sub-pixel offsets knock every grain fill off Skia's fast path (~2x bg cost)
    ctx.translate(Math.round(cam.dx), Math.round(cam.dy))
    const moving = cameraAt(t, i)
    if (moving) drawCamera(ctx, t, moving.k, moving.p, moving.kind)
    else drawScene(ctx, i, t - sc.start)
    // overlay transitions around cuts
    for (let k = 1; k < list.length; k++) {
      const kind = kindOf(list[k])
      if (kind === 'none' || isCamera(kind)) continue
      const half = TRANSITIONS[kind].half
      const cut = list[k].start
      if (t < cut - half || t >= cut + half) continue
      const p = (t - (cut - half)) / (2 * half)
      if (kind === 'tape') drawTape(ctx, p, k)
      else drawWipe(ctx, p, k, kind)
    }
    if (state.captions) drawCaption(ctx, t)
    ctx.restore()
    return { scene: sc.id, local: t - sc.start }
  }

  // ---------- sfx + audio ----------
  function transitionSfx(sc) {
    const kind = kindOf(sc)
    const T = TRANSITIONS[kind]
    if (!T.sfx) return []
    const has = (type) => !window.AUDIO || !AUDIO.SFX_TYPES || AUDIO.SFX_TYPES.includes(type)
    const type = has(T.sfx) ? T.sfx : 'swoosh'
    const cut = sc.start
    switch (kind) {
      case 'tape': // slap on … rip off
        return [
          { t: cut - T.half, type, gain: 0.85, dur: 0.3 },
          { t: cut + 0.04, type: has('tapeRip') ? 'tapeRip' : type, gain: 0.8, dur: 0.34 },
        ]
      case 'pan':
        return [{ t: cut - T.half * 1.1, type, gain: 0.8, dur: T.half * 2.2, pan: 0.6 }]
      case 'tilt':
        return [{ t: cut - T.half, type, gain: 0.9, dur: T.half * 1.8 }]
      case 'drop':
        return [{ t: cut - T.half, type, gain: 0.9, dur: T.half * 1.6 }]
      default:
        return [{ t: cut - T.half * 0.95, type, gain: 0.7, dur: T.half * 2 }]
    }
  }
  function allSfx() {
    const out = []
    const list = state.timeline.scenes
    list.forEach((sc, k) => {
      const def = scenes.get(sc.id)
      const dur = sc.end - sc.start
      if (def && def.sfx) {
        try {
          for (const e of def.sfx(dur, sc.info) || []) out.push(Object.assign({}, e, { t: sc.start + e.t }))
        } catch (err) {
          console.error('sfx', sc.id, err)
        }
      }
      if (k > 0) for (const e of transitionSfx(sc)) out.push(Object.assign({ transition: kindOf(sc) }, e))
    })
    return out.sort((a, b) => a.t - b.t)
  }
  /** Narration + cameo clips → AUDIO plan.vo items. */
  async function loadVo(ac) {
    const tl = state.timeline
    const items = []
    for (const sc of tl.scenes) {
      for (const v of sc.vo || []) items.push({ file: v.file, start: v.start, kind: 'narration' })
      for (const c of sc.cameos || []) items.push({ file: c.file, start: c.start, kind: 'cameo', gain: c.gain ?? 1, pan: c.pan ?? 0 })
    }
    const bufs = await Promise.all(
      items.map(async (it) => {
        const res = await fetch(it.file)
        if (!res.ok) throw new Error('missing VO clip ' + it.file)
        return ac.decodeAudioData(await res.arrayBuffer())
      })
    )
    return items.map((it, i) => {
      const o = { start: it.start, buffer: bufs[i], kind: it.kind }
      if (it.kind === 'cameo') Object.assign(o, { gain: it.gain, pan: it.pan })
      return o
    })
  }
  async function mix() {
    if (state.mix) return state.mix
    const tl = state.timeline
    const tmp = new OfflineAudioContext(1, 1, AUDIO.SR)
    const vo = state.voiceOff ? [] : await loadVo(tmp)
    // A scene may steer the score: music(dur, info) → { hit?: localT, dip?: [a, b] } (scene-local).
    // audio.js resolves a 'build' mood's snare roll on `hit` and places the 'night' near-silence at `dip`.
    const moods = tl.scenes.map((s) => {
      const m = { start: s.start, end: s.end, mood: s.mood || 'full' }
      const def = scenes.get(s.id)
      if (def && typeof def.music === 'function') {
        try {
          const r = def.music(s.end - s.start, s.info) || {}
          if (Number.isFinite(r.hit)) m.hit = s.start + r.hit
          if (Array.isArray(r.dip) && r.dip.length === 2 && r.dip.every(Number.isFinite)) m.dip = r.dip.map((x) => s.start + x)
        } catch (e) {
          console.error('music hook', s.id, e)
        }
      }
      return m
    })
    state.mix = await AUDIO.renderMix({ duration: tl.duration, bpm: tl.bpm, logoTime: tl.logoTime, moods, vo, sfx: allSfx() })
    return state.mix
  }
  async function renderAudioWav() {
    const buf = await mix()
    const ab = AUDIO.toWav(buf)
    // base64 in chunks (btoa on a huge string blows the stack otherwise)
    const bytes = new Uint8Array(ab)
    let s = ''
    const CH = 0x8000
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
    return btoa(s)
  }

  function contactSheet(times, cols = 4, width = 480) {
    const h = Math.round((width * H) / W)
    const rows = Math.ceil(times.length / cols)
    const pad = 8
    const sheet = K.mkCanvas(cols * (width + pad) + pad, rows * (h + pad + 26) + pad)
    const sg = sheet.getContext('2d')
    sg.fillStyle = '#222'
    sg.fillRect(0, 0, sheet.width, sheet.height)
    const tmp = K.mkCanvas(W, H)
    const tg = tmp.getContext('2d')
    times.forEach((t, i) => {
      drawFrame(t, tg)
      const x = pad + (i % cols) * (width + pad)
      const y = pad + Math.floor(i / cols) * (h + pad + 26)
      sg.drawImage(tmp, x, y + 26, width, h)
      sg.fillStyle = '#fff'
      sg.font = '18px monospace'
      sg.fillText('t=' + t.toFixed(2), x + 4, y + 19)
    })
    return sheet.toDataURL('image/png')
  }

  // ---------- boot ----------
  async function loadFonts() {
    const faces = [
      ['Patrick Hand', 'vendor/fonts/PatrickHand/PatrickHand-Regular.ttf', {}],
      ['Gochi Hand', 'vendor/fonts/GochiHand/GochiHand-Regular.ttf', {}],
      ['Caveat', 'vendor/fonts/Caveat/Caveat-Variable.ttf', { weight: '400 700' }],
      ['Kalam', 'vendor/fonts/Kalam/Kalam-Regular.ttf', {}],
      ['Kalam', 'vendor/fonts/Kalam/Kalam-Bold.ttf', { weight: '700' }],
      ['Fredoka', 'vendor/fonts/Fredoka/Fredoka-Variable.ttf', { weight: '300 700' }],
    ]
    await Promise.all(
      faces.map(async ([fam, url, desc]) => {
        try {
          const f = new FontFace(fam, `url("${encodeURI(url)}")`, desc)
          await f.load()
          document.fonts.add(f)
        } catch (e) {
          console.warn('font failed', fam, url, e.message)
        }
      })
    )
  }

  function buildInfo(tl, sc, i) {
    const list = tl.scenes
    const beat = 60 / tl.bpm
    const dur = sc.end - sc.start
    const lines = (sc.vo || []).map((v) => ({ text: v.text, start: v.start - sc.start, end: v.start - sc.start + v.duration }))
    const cameos = (sc.cameos || []).map((c) => ({ id: c.id, text: c.text, start: c.start - sc.start, duration: c.duration, end: c.start - sc.start + c.duration }))
    const transIn = i > 0 ? kindOf(sc) : null
    const transOut = i + 1 < list.length ? kindOf(list[i + 1]) : null
    const info = {
      id: sc.id,
      index: i,
      start: sc.start,
      end: sc.end,
      dur,
      mood: sc.mood || 'full',
      voStart: lines.length ? lines[0].start : 0,
      voEnd: lines.length ? lines[lines.length - 1].end : 0,
      lines,
      words: wordTimes(sc),
      cameos,
      beat,
      transIn,
      transOut,
    }
    /** Scene-local time a word is spoken (case/punctuation-insensitive); fallback if not found. */
    info.wordAt = (word, fallback = 0, nth = 0) => {
      const w = cleanWord(word)
      const hits = info.words.filter((x) => x.word === w)
      return hits[nth] ? hits[nth].start : fallback
    }
    /** Scene-local start of a cameo by id; fallback if the script has no such cameo. */
    info.cameoAt = (id, fallback = 0) => {
      const c = cameos.find((x) => x.id === id)
      return c ? c.start : fallback
    }
    /** Scene-local time of the first beat at or after localT (grid anchored at global t = 0). */
    info.nextBeat = (localT) => {
      const g = sc.start + localT
      return Math.ceil(g / beat - 1e-6) * beat - sc.start
    }
    /** The engine's pan/tilt offset applied to this scene at localT (for parallax counter-shifts). */
    info.camShift = (localT) => {
      const g = sc.start + localT
      if (transIn && isCamera(transIn)) {
        const half = TRANSITIONS[transIn].half
        if (g >= sc.start - half && g < sc.start + half) {
          const o = camOffsets(transIn, (g - (sc.start - half)) / (2 * half)).in
          return { dx: o[0], dy: o[1] }
        }
      }
      if (transOut && isCamera(transOut)) {
        const half = TRANSITIONS[transOut].half
        if (g >= sc.end - half && g < sc.end + half) {
          const o = camOffsets(transOut, (g - (sc.end - half)) / (2 * half)).out
          return { dx: o[0], dy: o[1] }
        }
      }
      return { dx: 0, dy: 0 }
    }
    return info
  }

  async function boot() {
    const canvas = document.getElementById('stage')
    canvas.width = W
    canvas.height = H
    state.ctx = canvas.getContext('2d')
    await loadFonts()
    const res = await fetch('timeline.json', { cache: 'no-store' })
    const tl = await res.json()
    tl.scenes.forEach((sc, i) => (sc.info = buildInfo(tl, sc, i)))
    state.timeline = tl
    state.caps = buildCaptions(tl)
    // warm texture caches
    K.desk(state.ctx)
    drawFrame(0)
  }

  // ---------- live player ----------
  function player() {
    const tl = state.timeline
    const playBtn = document.getElementById('play')
    const scrub = document.getElementById('scrub')
    const time = document.getElementById('time')
    const cc = document.getElementById('cc')
    const overlay = document.getElementById('overlay')
    scrub.max = tl.duration
    let ac = null
    let src = null
    let startedAt = 0
    let offset = 0
    let playing = false
    const now = () => (playing ? ac.currentTime - startedAt : offset)
    function stop() {
      if (src) {
        try {
          src.stop()
        } catch (e) {}
        src.disconnect()
        src = null
      }
    }
    async function play() {
      if (!ac) ac = new AudioContext()
      overlay.classList.add('busy')
      const buf = await mix()
      overlay.classList.remove('busy')
      overlay.classList.add('hidden')
      if (offset >= tl.duration - 0.05) offset = 0
      stop()
      src = ac.createBufferSource()
      src.buffer = buf
      src.connect(ac.destination)
      startedAt = ac.currentTime - offset
      src.start(0, offset)
      src.onended = () => {
        if (playing && now() >= tl.duration - 0.1) {
          playing = false
          offset = tl.duration
          playBtn.textContent = '↻'
          overlay.classList.remove('hidden')
        }
      }
      playing = true
      playBtn.textContent = '❚❚'
    }
    function pause() {
      offset = now()
      playing = false
      stop()
      playBtn.textContent = '▶'
    }
    playBtn.onclick = () => (playing ? pause() : play())
    overlay.onclick = () => play()
    scrub.oninput = () => {
      const was = playing
      if (playing) pause()
      offset = parseFloat(scrub.value)
      if (was) play()
    }
    cc.onclick = () => {
      state.captions = !state.captions
      cc.classList.toggle('off', !state.captions)
    }
    cc.classList.toggle('off', !state.captions)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault()
        playing ? pause() : play()
      }
    })
    function loop() {
      const t = Math.min(now(), tl.duration)
      drawFrame(t)
      scrub.value = t
      time.textContent = `${t.toFixed(1)} / ${tl.duration.toFixed(1)}s`
      requestAnimationFrame(loop)
    }
    loop()
  }

  const ready = boot()
    .then(() => {
      if (!RENDER) player()
      document.documentElement.dataset.ready = '1'
    })
    .catch((e) => {
      console.error(e)
      document.documentElement.dataset.ready = 'error'
      throw e
    })

  window.PROMO = {
    scene,
    ready,
    drawFrame,
    renderAudioWav,
    contactSheet,
    allSfx,
    TRANSITIONS,
    setCaptions: (on) => (state.captions = !!on),
    setVoice: (on) => {
      state.voiceOff = !on
      state.mix = null
    },
    get duration() {
      return state.timeline.duration
    },
    get fps() {
      return K.ANIM_FPS
    },
    get timeline() {
      return state.timeline
    },
  }
})()

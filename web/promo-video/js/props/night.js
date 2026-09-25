/* props/night.js — night + sunrise collage props for s4 (night scheduler) and s5 (sunrise).
 *
 * Owner: props-night. Extends window.PROPS. Every function is a PURE function of
 * (t, opts): no state survives between calls, randomness only via K.rng/K.seedOf,
 * pencil "boil" via K.boil(t). No blur shadows or canvas filters; depth = K.paper
 * shadows. The sun has NO rays (round torn discs only). The laptop is ALWAYS open.
 *
 * Common signature: PROPS.name(ctx, x, y, t, o = {})
 *   Every function accepts o.scale (default 1), o.rot (default 0, radians) and
 *   o.id (seed string; defaults to the prop name). Returned anchor points are in
 *   the CALLER's coordinate space (whatever transform was active at call time).
 *   Options named `ease` take a K.ease key ('outBack', 'outBounce', 'inCubic', ...),
 *   one of this file's own curves by name — 'blind' (accelerating fall, lands at 55 %,
 *   two small damped bounces ≤ 4 %) or 'sign' (hinged fall, lands at 60 %, one 10 %
 *   rebound) — a function p → p, or false (= linear, drive it yourself).
 *
 * ── SKY ─────────────────────────────────────────────────────────────────────
 * nightBlind(ctx, x=0, y=0, t, o) → { bottom:[x,y] }
 *   Navy construction-paper blind that drops from the top like a window blind.
 *   (x, y) = TOP-LEFT of the area it covers (pass 0, 0 for the full frame). Pinprick
 *   stars are punched INTO the sheet (they travel with it) and twinkle (+ glints on the
 *   big ones); 7 butter/lemon paper 4-point stars with soft glows; 2 dotted-pencil
 *   constellations; soft broken fold creases; a kraft dowel; a torn bottom fringe;
 *   a pull cord with a mustard ring + terracotta tassel.
 *   o.drop 0..1 (1 = fully down). Full-frame: at 1 the dowel is parked just off-frame.
 *   o.ease ('blind'). For the morning snap-UP animate drop 1→0 with 'inCubic' or
 *     'inOutCubic'. 'outBounce' still works but its 25 % rebound is rubbery.
 *   o.stars pinprick count (120; they span frame y 10..h-10 at drop 1)
 *   o.twinkle 0..1 (1) · o.color (K.C.night) · o.cord (true) · o.creases (true)
 *   o.constellations true | false | [[x,y],[x,y]] frame positions of the two groups
 *     (default [[.22w, .06h], [.52w, .05h]] — high, left of centre). Group 1 spans
 *     ~212x58 px right/down of its point, group 2 ~128x56: pass positions clear of
 *     your moon / signs.
 *   o.w / o.h: default K.W / K.H = full-bleed (sheet overhangs 80 px each side).
 *     Passing either makes a WINDOW blind: the sheet is clipped to [0, w] and below
 *     y (the window top), the dowel overhangs 12 px, paper stars shrink, and at drop 1
 *     the dowel rests inside the window's bottom edge with the fringe 20 px below it.
 *   Returns the bottom-edge (fringe) centre. Cost: ~35 ms full-frame at drop < 1
 *   (fringe + shadow), less when parked at 1.
 *
 * moonOnThread(ctx, x, y, t, o) → { pivot, hook, moon }
 *   Butter-paper crescent (lighter moon-paper layer, torn white rim, pencil craters,
 *   sleepy closed eye with lashes, blush + tiny smile, soft glow) hanging from its
 *   upper horn on a visible cream thread. (x, y) = the thread's washi-taped pivot.
 *   o.drop 0..1 (1) unspools the thread, eased by o.ease ('outBack' → bounces on the
 *     string). Below 0 thread length the moon is hauled straight up past the pivot.
 *   o.len thread length at drop 1 (300) · o.r moon radius (110)
 *   o.swing sway amount (1 = gentle ±4°); the moon lags the swing a little.
 *   o.angle extra swing angle, radians: POSITIVE swings the moon LEFT, negative RIGHT.
 *     "Swings off": animate angle to about ±1.3 while drop goes 1→0 (ease 'inCubic').
 *   o.face (true) · o.glow 0..1 (1) · o.charm (true: tiny lemon star dangling from the
 *   lower horn) · o.tape (true; washi at the pivot, scales with r — it stays put when
 *   the moon swings off, so pass tape:false or stop drawing once it's gone)
 *   o.tapeColor ('rgba(184,92,52,0.9)') · o.color (K.C.butter) · o.light (K.C.moon)
 *   Returns pivot, hook (thread end) and moon (centre of the crescent's outer disc).
 *
 * paperSun(ctx, x, y, t, o) → { centre }
 *   NO RAYS. Warm radial glow + two translucent torn tissue rings (pale gold inside,
 *   cream outside), a tangerine torn rim, a scissor-cut mustard disc, a lemon light
 *   sliver hugging the upper-left rim and a honey shade sliver lower-right; the face
 *   sits on flat mustard with blush + cream cheek catch-lights. The rim/disc slowly
 *   turn; face + light stay upright. (x, y) = centre when fully risen.
 *   o.rise 0..1 (1), eased by o.ease ('outBack' overshoot). Squash & stretch from the
 *     rise velocity; a ±3 px idle bob fades in over the last 20 % of the rise.
 *   o.dist rise travel px (420) · o.r radius (130; reads down to r 60)
 *   o.face 'happy' (^^ eyes, open D smile) | 'sleepy' | 'awake' (googly eyes, uses
 *     o.look [lx, ly], default [0.15, -0.1]) | 'none'
 *   o.glow 0..1 (1; also fades the tissue rings)
 *   o.horizon caller-space y; everything below it is clipped (rise from behind a hill).
 *     Without it, draw your hills after the sun.
 *   Colours: o.color (K.C.mustard) · o.rim ('#f2934f') · o.light (K.C.lemon) ·
 *     o.shade (K.C.honey) · o.halo inner tissue ('#ffd98f') · o.haloOuter ('#fff0cc')
 *
 * ── SCHEDULER MACHINERY ─────────────────────────────────────────────────────
 * conveyor(ctx, x, y, t, o) → { left, right, top, label }
 *   Paper conveyor belt: dark belt loop with cream slat ticks that travel around it,
 *   a terracotta side panel, hatched butter rollers that spin with offset, kraft legs
 *   and a taped cream "Scheduler" plaque. (x, y) = centre of the belt.
 *   o.w (1100) · o.h belt height (100) · o.offset belt travel px (animate it; +
 *   moves the top run right) · o.label ('Scheduler'; '' hides) · o.labelSize (50)
 *   o.rollers (6) · o.legs (true) · o.band belt thickness (15)
 *   Colours: o.belt ('#4a3a2c') · o.panel (K.C.terracotta) · o.rollerColor (K.C.butter)
 *   Returns the top-run surface: left/right ends of the straight part + centre, and
 *   the plaque centre. Place riders at lerp(left, right, u) with their bottom on top[1].
 *   Draws no cards: use PROPS.indexCard (day.js) or your own for the riders.
 *
 * slotBoxes(ctx, x, y, t, o) → { slots:[[x,y]..], floor:[[x,y]..], label }
 *   A kraft tray of n recessed "parking-spot" bays with dashed cream crayon lines, a
 *   marquee bulb over each bay (clear bluish glass + grey coil when off → warm lemon
 *   glass, honey coil, white-hot core + glow when lit) and a taped "Slots" plaque.
 *   (x, y) = centre of the tray. o.n (5) · o.slotW (170) · o.slotH (150) · o.gap (22)
 *   o.label ('Slots'; '' hides)
 *   o.lit number (first ⌊lit⌋ bulbs on, the fraction warms the next) or array 0..1/bay
 *   o.part 'all' | 'back' | 'front' — draw 'back', then your cards/helpers standing on
 *   floor[i], then 'front' (lip + plaque) so they sit INSIDE the bays.
 *   Colours: o.color tray (K.C.kraft) · o.inside bay floor ('#9a7650')
 *   Returns bay centres, floor points (feet line) and the plaque centre.
 *
 * gauge(ctx, x, y, t, o) → { pivot, tip, tick }
 *   Cut-paper dial: kraft plate, cream face, sage/mustard/peach bands, pencil ticks, a
 *   RED CRAYON tick at o.tick, a black paper needle on a butter brad, label below.
 *   (x, y) = needle pivot. o.value 0..1 (0.5; clamps at 1.04; tiny live jiggle)
 *   o.tick (0.9) · o.r (150) · o.label ('Window used') · o.jiggle (1)
 *   When value reaches the tick, red crayon "buzz" marks appear beside it.
 *
 * hangingSign(ctx, x, y, t, o) → { pin, sign }
 *   Cream sign with a terracotta paper border, pause bars + "paused", hinged on a kraft
 *   dowel that hangs by 2-ply twine from a mustard pin. (x, y) = the pin.
 *   o.flip 0..1: 0 = folded UP over the dowel, leaning back (80 % height), showing its
 *     kraft back with a dashed stitch border and a sage paper ▶ (running) — the twine
 *     and pin stay in FRONT of it; 1 = hanging down, front readable.
 *   o.ease ('sign': gravity fall + small rebound). Animate 0→1 to flip down, 1→0 to
 *     flip back up.
 *   o.rock 0..1 | bool (1): the damped rock on the pin while flip is in 0.6..1. Pass
 *     rock:false on the flip-back-UP path so it doesn't wobble before it rises.
 *   o.text ('paused') · o.w (300) · o.h (116) · o.len twine drop (56) · o.swing idle
 *   sway (1) · o.icon pause bars (true)
 *   Colours: o.color face (K.C.cream) · o.border (K.C.terracotta) · o.back (K.C.kraft)
 *   Returns the pin and the current sign-face centre.
 *
 * ── BEDSIDE ─────────────────────────────────────────────────────────────────
 * laptop(ctx, x, y, t, o) → { screen, tag, mug, lamp, deck }
 *   ALWAYS OPEN and lit: silver-blue paper laptop whose cream screen shows a mini
 *   console (terracotta bar, tabs, sidebar, ticked job rows, and the same black
 *   terminal card as s1–s2 — PROPS.terminalCard when loaded — with green crayon "> _"
 *   and a blinking cursor); a breathing green awake-LED on the deck; honey anglepoise
 *   lamp with a light cone (screen blend); steaming mug; twine-tied kraft tag
 *   "app open = laptop stays awake" in marker lettering.
 *   (x, y) = centre of the laptop's bottom edge (where it sits on the desk).
 *   o.w LID width (420; the screen is w-30) · o.lamp (true) · o.lampOn 0..1 cone (1)
 *   o.lampSide 'right' | 'left' · o.mug (true; on the side opposite the lamp)
 *   o.glow 0..1 screen light (1) · o.body lid/deck colour ('#aebdcb')
 *   o.tag text ('app open = laptop stays awake'; split into 2 lines at " = ";
 *     false / '' hides it — always safe, whatever tagSide is)
 *   o.tagSize font px at scale 1 (40 → 29 px at scale .72)
 *   o.tagSide 'below' (default; hangs in front of the desk edge) | 'left' | 'right'
 *     (twine looped round the lid's top corner, tag beside the screen). Use the side
 *     OPPOSITE the lamp; the mug steps further out when the tag hangs on its side.
 *   Returns screen centre, tag eyelet, mug rim, lamp bulb, deck top centre (missing
 *   keys when that part is hidden).
 *
 * alarmClock(ctx, x, y, t, o) → { centre, top, tag }
 *   Wind-up twin-bell alarm clock: terracotta body, mustard bells, hammer, cream dial
 *   with hands, dot eyes + blush + smile, turning butter wind-up key, stubby feet, and
 *   a kraft tag "reset" hanging from the key. (x, y) = centre of the body.
 *   o.ring 0..1 (0): per-frame shake + hop, hammer flicks, vibration ARCS (never rays),
 *     > < squeezed eyes and an open mouth.
 *   o.r (84) · o.time hours for the hands (7) · o.tag ('reset'; false hides)
 *   o.tagSize (40) · o.color (K.C.terracotta) · o.bell (K.C.mustard)
 *   o.arcColor (K.C.ink; pass a light colour when the clock is on navy)
 *   Returns body centre, top of the hammer, and the tag eyelet.
 *
 * teacup(ctx, x, y, t, o) → { rim }
 *   Tiny paper teacup on a saucer, polka dots, teabag string + tag, steam curls.
 *   (x, y) = centre of the cup. o.r cup half-width (34; ~16 for helper-held cups)
 *   o.color (K.C.pink) · o.steam 0..1 (1) · o.saucer (true) · o.tilt radians (0)
 *
 * doneStack(ctx, x, y, t, o) → { cards:[[x,y]..], top }
 *   A shingled pile of n ruled index cards (checkbox scribbles), each getting a
 *   terracotta rubber-stamp "DONE" on its visible lower strip; stamped cards get
 *   green crayon checks. (x, y) = centre of the BOTTOM card; the pile climbs upward.
 *   o.n (4) · o.stamped 0..n: cards [0, ⌊stamped⌋) are stamped; the fraction animates
 *   the current thunk (overshoot scale, ink fade-in, card squash, 4 corner tick flicks).
 *   Drive it as seg(t, a, b) * n for a cascade.
 *   o.w (230) · o.h (150) · o.step vertical pitch (60) · o.color (K.C.paperWhite)
 *   o.stampColor (K.C.terracotta)
 *
 * tally(ctx, x, y, t, o) → { end }
 *   Torn cream scrap: "Done today" + terracotta crayon tally marks (groups of five,
 *   4 bars + a slash). (x, y) = centre of the scrap.
 *   o.count (4) · o.p 0..1 draw-on (label writes itself over the first 40 %, then
 *   each mark draws top-to-bottom) · o.label ('Done today') · o.paper (true)
 *   o.color marks (K.C.terracotta). Returns the right end of what's drawn so far.
 */
(function () {
  'use strict'
  const C = K.C
  const TAU = Math.PI * 2
  const RED = '#d4382a' // red crayon
  const THREAD = '#f3e7c8' // cream thread (reads on navy)
  const TWINE = '#c9a468' // twine for tags (reads on navy and on cream)
  const SILVER = '#aebdcb' // laptop paper
  const clamp01 = K.clamp01

  /** Blind drop: accelerating fall that lands at p = 0.55, then two small damped bounces (≤ 3.75 %). */
  function blindEase(p) {
    if (p < 0.55) return K.ease.inQuad(p / 0.55)
    const q = (p - 0.55) / 0.45
    return 1 - 0.05 * Math.abs(Math.sin(q * TAU)) * (1 - q)
  }
  /** Sign flip-down: falls like a hinged board (accelerating), lands at 0.6, one small rebound. */
  function signEase(p) {
    if (p < 0.6) return K.ease.inQuad(p / 0.6)
    const q = (p - 0.6) / 0.4
    return 1 - 0.1 * Math.sin(q * Math.PI) * (1 - q)
  }
  const LOCAL_EASE = { blind: blindEase, sign: signEase }
  const easeBy = (e, p) => (typeof e === 'function' ? e(p) : e && LOCAL_EASE[e] ? LOCAL_EASE[e](p) : e && K.ease[e] ? K.ease[e](p) : p)

  // ---------- anchors: local → caller coordinates ----------
  function mapper(ctx) {
    const inv = ctx.getTransform().inverse()
    return (lx, ly) => {
      const q = inv.multiply(ctx.getTransform()).transformPoint(new DOMPoint(lx, ly))
      return [q.x, q.y]
    }
  }
  /** Standard placement: K.at with o.rot / o.scale; fn(m) gets the local→caller mapper. */
  function place(ctx, x, y, o, fn) {
    const m = mapper(ctx)
    let out
    K.at(ctx, x, y, o.rot || 0, o.scale === undefined ? 1 : o.scale, () => {
      out = fn(m)
    })
    return out
  }

  // ---------- cheap pencil (plain canvas, boiling) ----------
  /** A hand-drawn segment: bowed quadratic with boiling jitter; `double` adds a lighter 2nd pass. */
  function jseg(ctx, x1, y1, x2, y2, id, t, o = {}) {
    const { color = C.ink, w = 3, amp = 1.1, alpha = 1, double = false } = o
    const r = K.rng('js', id, K.boil(t))
    ctx.save()
    const a0 = ctx.globalAlpha
    ctx.strokeStyle = color
    ctx.lineCap = 'round'
    const pass = (lw, a) => {
      const j = () => (r() - 0.5) * 2 * amp
      ctx.globalAlpha = a0 * a
      ctx.lineWidth = lw
      ctx.beginPath()
      ctx.moveTo(x1 + j(), y1 + j())
      ctx.quadraticCurveTo((x1 + x2) / 2 + j() * 1.6, (y1 + y2) / 2 + j() * 1.6, x2 + j(), y2 + j())
      ctx.stroke()
    }
    pass(w, alpha)
    if (double) pass(w * 0.55, alpha * 0.55)
    ctx.restore()
  }
  /** Boiling pencil polyline (open unless o.closed). */
  function jpoly(ctx, pts, id, t, o = {}) {
    const { color = C.ink, w = 3, amp = 1, alpha = 1, closed = false, dash = null } = o
    const r = K.rng('jp', id, K.boil(t))
    ctx.save()
    ctx.globalAlpha *= alpha
    ctx.strokeStyle = color
    ctx.lineWidth = w
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (dash) ctx.setLineDash(dash)
    ctx.beginPath()
    pts.forEach(([px, py], i) => {
      const jx = (r() - 0.5) * 2 * amp
      const jy = (r() - 0.5) * 2 * amp
      if (i) ctx.lineTo(px + jx, py + jy)
      else ctx.moveTo(px + jx, py + jy)
    })
    if (closed) ctx.closePath()
    ctx.stroke()
    ctx.restore()
  }
  /** 2-ply twine: a dark under-stroke (reads on cream/kraft) + a light top ply (reads on navy). */
  function twine(ctx, x1, y1, x2, y2, id, t, o = {}) {
    const { w = 2.6, color = TWINE } = o
    jseg(ctx, x1, y1 + 0.6, x2, y2 + 0.6, id, t, { color: 'rgba(74,50,26,0.8)', w: w + 1.6, amp: 0.6 })
    jseg(ctx, x1, y1, x2, y2, id, t, { color, w: w * 0.78, amp: 0.6 })
  }
  function dot(ctx, x, y, r, fill) {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.fillStyle = fill
    ctx.fill()
  }
  /** Soft radial light. `box` [x0, y0, x1, y1] limits the filled area (raster cost ∝ area). */
  function glowDisc(ctx, x, y, r, rgb, a, box = null) {
    if (a <= 0) return
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(${rgb},${a})`)
    g.addColorStop(0.45, `rgba(${rgb},${a * 0.45})`)
    g.addColorStop(1, `rgba(${rgb},0)`)
    ctx.fillStyle = g
    let x0 = x - r
    let y0 = y - r
    let x1 = x + r
    let y1 = y + r
    if (box) {
      x0 = Math.max(x0, box[0])
      y0 = Math.max(y0, box[1])
      x1 = Math.min(x1, box[2])
      y1 = Math.min(y1, box[3])
      if (x1 <= x0 || y1 <= y0) return
    }
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
  }

  // ---------- shapes ----------
  function arcPts(cx, cy, r, a0, a1, n = 24) {
    const pts = []
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
    return pts
  }
  /** Annular sector (ring slice) polygon. */
  function sectorPts(r1, r2, a0, a1, n = 16) {
    return [...arcPts(0, 0, r2, a0, a1, n), ...arcPts(0, 0, r1, a1, a0, n)]
  }
  /** Crescent = disc(0,0,R) minus disc(cx,cy,r2). Returns polygon + the two horn tips [upper-ish, lower-ish]. */
  function crescentPts(R, cx, cy, r2, n = 44) {
    const dd = Math.hypot(cx, cy)
    const phi = Math.atan2(cy, cx)
    const a = (R * R - r2 * r2 + dd * dd) / (2 * dd)
    const beta = Math.acos(K.clamp(a / R, -1, 1))
    const hh = Math.sqrt(Math.max(0, R * R - a * a))
    const gamma = Math.atan2(hh, dd - a)
    const pts = []
    for (let k = 0; k <= n; k++) {
      const th = phi + beta + (k / n) * (TAU - 2 * beta)
      pts.push([R * Math.cos(th), R * Math.sin(th)])
    }
    const mm = Math.round(n * 0.7)
    for (let k = 1; k < mm; k++) {
      const ps = phi + Math.PI + gamma - (k / mm) * 2 * gamma
      pts.push([cx + r2 * Math.cos(ps), cy + r2 * Math.sin(ps)])
    }
    const tA = [R * Math.cos(phi - beta), R * Math.sin(phi - beta)]
    const tB = [R * Math.cos(phi + beta), R * Math.sin(phi + beta)]
    return { pts, tips: tA[1] < tB[1] ? [tA, tB] : [tB, tA] }
  }
  const stadiumPts = (w, h, steps = 8) => K.roundRectPts(-w / 2, -h / 2, w, h, h / 2, steps)

  // ---------- small shared pieces ----------
  /** Rising steam curls (cream, fading) — pure function of t. */
  function steam(ctx, x, y, h, t, id, o = {}) {
    const { n = 2, spread = 16, amp = 7, rgb = '255,250,236', alpha = 0.8, w = 4 } = o
    if (alpha <= 0) return
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let i = 0; i < n; i++) {
      const ph = i * 2.3 + (K.hash(id, i) % 100) / 30
      const bx = x + (i - (n - 1) / 2) * spread
      const g = ctx.createLinearGradient(0, y, 0, y - h)
      g.addColorStop(0, `rgba(${rgb},0)`)
      g.addColorStop(0.22, `rgba(${rgb},${alpha})`)
      g.addColorStop(1, `rgba(${rgb},0)`)
      ctx.strokeStyle = g
      ctx.lineWidth = w
      ctx.beginPath()
      const N = 12
      for (let k = 0; k <= N; k++) {
        const f = k / N
        const yy = y - f * h
        const xx = bx + Math.sin(f * 5.4 - t * 4.2 + ph) * amp * (0.3 + f)
        if (k) ctx.lineTo(xx, yy)
        else ctx.moveTo(xx, yy)
      }
      ctx.stroke()
    }
    ctx.restore()
  }
  /** Cream plaque with hand lettering + two washi corners, centred at (x, y). */
  function plaque(ctx, text, x, y, t, id, o = {}) {
    const { size = 48, family = 'marker', bg = C.cream, ink = C.ink, rot = 0, tapeColor = 'rgba(232,169,136,0.9)', padX = 28 } = o
    K.font(ctx, family, size)
    const w = ctx.measureText(text).width + padX * 2
    const h = size * 1.28
    K.at(ctx, x, y, rot, 1, () => {
      K.paper(ctx, K.boxPts(w, h), bg, { seed: id + 'pl', cut: 2, shadow: 0.95, lift: 2 })
      K.hand(ctx, text, 0, size * 0.33, { family, size, color: ink, t, id: id + 'plt', jitter: 0.6 })
      if (tapeColor) {
        K.tape(ctx, -w / 2 + 6, -h / 2 + 6, 58, -0.72, tapeColor, { h: 22, seed: id + 'pt1' })
        K.tape(ctx, w / 2 - 6, -h / 2 + 6, 58, 0.72, tapeColor, { h: 22, seed: id + 'pt2' })
      }
    })
    return { w, h }
  }
  /** Luggage tag hanging from its eyelet at the local origin; body below.
   *  Tag text is marker (Gochi Hand, the heaviest hand) so it survives 0.5–0.7 scale + video compression. */
  const TAG_FAMILY = 'marker'
  function tagPad(size) {
    return Math.max(8, size * 0.24)
  }
  function tagWidth(ctx, lines, size = 40, family = TAG_FAMILY) {
    if (!lines || !lines.length) return 0
    K.font(ctx, family, size)
    return Math.max(...lines.map((s) => ctx.measureText(s).width)) + tagPad(size) * 2 + 4
  }
  function tagBody(ctx, lines, t, id, o = {}) {
    const { size = 40, family = TAG_FAMILY, color = C.kraft, ink = C.ink } = o
    if (!lines || !lines.length) return { w: 0, h: 0 }
    const tw = tagWidth(ctx, lines, size, family)
    const lh = size * 0.96
    const top = -15
    const textTop = 11 // just under the eyelet
    const h = textTop - top + lines.length * lh + size * 0.2
    const c = Math.min(22, tw * 0.2)
    const pts = [[-tw / 2 + c, top], [tw / 2 - c, top], [tw / 2, top + c], [tw / 2, top + h], [-tw / 2, top + h], [-tw / 2, top + c]]
    K.paper(ctx, pts, color, { seed: id + 'tag', cut: 1.1, shadow: 0.95, lift: 2 })
    // reinforced eyelet
    ctx.save()
    ctx.beginPath()
    ctx.arc(0, 0, 9.5, 0, TAU)
    ctx.fillStyle = K.paperPattern(ctx, C.cream)
    ctx.fill()
    ctx.lineWidth = 1.4
    ctx.strokeStyle = 'rgba(42,34,26,0.45)'
    ctx.stroke()
    dot(ctx, 0, 0, 4, '#3a2d20')
    ctx.restore()
    lines.forEach((s, i) => K.hand(ctx, s, 0, textTop + size * 0.78 + i * lh, { family, size, color: ink, t, id: id + 'l' + i, jitter: 0.55 }))
    return { w: tw, h }
  }
  /** Twine from anchor (ax, ay) to a tag hanging `len` px away at angle `ang` (0 = straight down). Returns eyelet. */
  function hangTag(ctx, ax, ay, len, ang, lines, t, id, o = {}) {
    const ex = ax + Math.sin(ang) * len
    const ey = ay + Math.cos(ang) * len
    twine(ctx, ax, ay, ex, ey, id + 'tw', t, { color: o.twine || TWINE })
    dot(ctx, ax, ay, 3.5, o.twine || TWINE)
    K.at(ctx, ex, ey, -ang * 0.9, 1, () => tagBody(ctx, lines, t, id, o))
    return [ex, ey]
  }
  /** Rubber-stamp ink block centred at the origin. */
  function inkStamp(ctx, text, w, h, color, id, o = {}) {
    const { alpha = 0.9, bg = C.paperWhite } = o
    const r = K.rng('stamp', id)
    ctx.save()
    ctx.globalAlpha *= alpha
    ctx.strokeStyle = color
    ctx.lineJoin = 'round'
    ctx.lineWidth = 5
    K.pathPoly(ctx, K.wobble(K.roundRectPts(-w / 2, -h / 2, w, h, 9, 3), 1.1, id, 'o'))
    ctx.stroke()
    ctx.lineWidth = 2
    K.pathPoly(ctx, K.roundRectPts(-w / 2 + 7, -h / 2 + 7, w - 14, h - 14, 5, 3))
    ctx.stroke()
    K.font(ctx, 'chunky', h * 0.6, '700')
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = color
    ctx.fillText(text, 0, h * 0.04)
    // ink skips: paper-coloured speckles inside the stamp
    ctx.fillStyle = bg
    for (let i = 0; i < 30; i++) {
      ctx.globalAlpha = alpha * (0.35 + r() * 0.55)
      dot(ctx, (r() - 0.5) * (w - 6), (r() - 0.5) * (h - 6), 0.7 + r() * 1.7, bg)
    }
    ctx.restore()
  }

  // =====================================================================
  // SKY
  // =====================================================================
  function nightBlind(ctx, x = 0, y = 0, t = 0, o = {}) {
    const { drop = 1, ease = 'blind', id = 'blind', color = C.night, stars = 120, twinkle = 1, cord = true, creases = true, constellations = true } = o
    const bounded = !!(o.w || o.h) // window-sized blind: no overhang, clipped to the window
    const w = o.w || K.W
    const h = o.h || K.H
    const ov = bounded ? 0 : 80 // sheet overhang past each side (full-bleed only)
    const rodOv = bounded ? 12 : 90 // dowel overhang
    const d = easeBy(ease, clamp01(drop))
    // at drop 1 a full-frame blind parks its dowel just off-frame; a window blind rests its dowel
    // inside the window's bottom edge with the fringe over the sill
    const byEnd = bounded ? h + 20 : h + 62
    // whole pixels: a sub-pixel offset pushes the full-frame grain fill off Skia's fast path (~2x)
    const by = Math.round(K.lerp(-110, byEnd, d)) // bottom-edge (fringe) y in local frame
    const fy0 = byEnd // local→frame y offset of the sheet at drop 1 (frame y = fy - fy0 + by)
    return place(ctx, x, y, o, (m) => {
      const out = { bottom: m(w / 2, by) }
      if (by < -100) return out
      // a window blind: the sheet is clipped to the window [0, w] below its top edge; only the
      // dowel (drawn after, under its own clip) overhangs the sides
      const clipTo = (x0, x1) => {
        ctx.save()
        if (!bounded) return
        ctx.beginPath()
        ctx.rect(x0, 0, x1 - x0, 1e5)
        ctx.clip()
      }
      const ss = bounded ? K.clamp(Math.min(w / K.W, h / K.H) * 1.6, 0.55, 1) : 1 // paper-star size
      clipTo(0, w)
      K.at(ctx, 0, by, 0, 1, () => {
        // perf: only the bottom fringe is torn + casts the shadow; the body is one plain fill in
        // the same local frame (so the grain pattern is continuous across the seam, which the
        // body and the dowel cover)
        if (by <= byEnd - 10 || bounded) K.paper(ctx, [[-ov, -70], [w + ov, -70], [w + ov, 0], [-ov, 0]], color, { torn: 6, seed: id, shadow: 1.6, lift: 14 })
        K.paper(ctx, [[-ov, -h - 180], [w + ov, -h - 180], [w + ov, -40], [-ov, -40]], color, { cut: 0, shadow: 0, seed: id + 'body' })

        // fold creases (paper that has been rolled up): broken into 2–3 soft segments with faded
        // ends and a gentle y drift, so they read as paper folds and never as a compression seam
        if (creases) {
          ctx.save()
          ctx.lineCap = 'round'
          const cr = K.rng(id, 'crease')
          for (const [ci, fyc] of [[0, -h * 0.34], [1, -h * 0.68]]) {
            const nSeg = 2 + (cr() < 0.5 ? 1 : 0)
            let sx0 = -ov + cr() * w * 0.12
            for (let s = 0; s < nSeg; s++) {
              const len = (w / nSeg) * (0.4 + cr() * 0.3)
              const sx1 = Math.min(w + ov, sx0 + len)
              const pts = []
              for (let k = 0; k <= 8; k++) {
                const px = K.lerp(sx0, sx1, k / 8)
                pts.push([px, fyc + K.noise1(px * 0.004, id, 'cr', ci) * 12])
              }
              for (const [dy, rgb, a, lw] of [[-1.5, '255,255,255', 0.045, 3], [1.5, '5,10,22', 0.15, 2]]) {
                const g = ctx.createLinearGradient(sx0, 0, sx1, 0)
                g.addColorStop(0, `rgba(${rgb},0)`)
                g.addColorStop(0.3, `rgba(${rgb},${a})`)
                g.addColorStop(0.7, `rgba(${rgb},${a})`)
                g.addColorStop(1, `rgba(${rgb},0)`)
                ctx.strokeStyle = g
                ctx.lineWidth = lw
                ctx.beginPath()
                pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py + dy) : ctx.moveTo(px, py + dy)))
                ctx.stroke()
              }
              sx0 = sx1 + w * (0.06 + cr() * 0.1)
              if (sx0 > w + ov) break
            }
          }
          ctx.restore()
        }

        // pinprick stars punched into the sheet (span frame y 10 .. h-10 at drop 1)
        const r = K.rng(id, 'stars')
        ctx.save()
        for (let i = 0; i < stars; i++) {
          const sx = 6 + r() * (w - 12)
          const sy = 10 + r() * (h - 20) - fy0
          const big = r() > 0.74
          const sz = big ? 2.4 + r() * 1.3 : 1.2 + r() * 1.0
          const fq = 1.1 + r() * 2.6
          const ph = r() * TAU
          const tw = 0.5 + 0.5 * Math.sin(t * fq + ph)
          const a = 1 - twinkle * 0.72 * (1 - tw)
          if (big) {
            dot(ctx, sx + 0.7, sy + 0.9, sz + 0.8, 'rgba(8,12,24,0.35)') // punched-hole rim
            glowDisc(ctx, sx, sy, sz * 5.5, '255,236,176', 0.2 * a)
          }
          dot(ctx, sx, sy, sz, `rgba(255,250,230,${a})`)
          if (big && twinkle && tw > 0.78) {
            const L = sz * 4.2 * ((tw - 0.78) / 0.22)
            ctx.strokeStyle = `rgba(255,250,230,${0.75 * a})`
            ctx.lineWidth = 1.4
            ctx.lineCap = 'round'
            ctx.beginPath()
            ctx.moveTo(sx - L, sy)
            ctx.lineTo(sx + L, sy)
            ctx.moveTo(sx, sy - L)
            ctx.lineTo(sx, sy + L)
            ctx.stroke()
          }
        }
        ctx.restore()

        // two little dotted-pencil constellations (default: high in the top band, left of centre,
        // clear of the top-right where s4 hangs its sign + gauge)
        if (constellations) {
          const shapes = [[[0, 0], [58, -24], [118, -10], [150, 34], [212, 22]], [[0, 0], [46, 30], [104, 18], [128, -26]]]
          const at = Array.isArray(constellations) ? constellations : [[w * 0.22, h * 0.06], [w * 0.52, h * 0.05]]
          const groups = at.map(([fx, fy], gi) => [fx, fy - fy0, shapes[gi % 2]])
          groups.forEach(([gx, gy, ps], gi) => {
            const pts = ps.map(([px, py]) => [gx + px, gy + py])
            jpoly(ctx, pts, id + 'cn' + gi, t, { color: 'rgba(255,244,214,0.42)', w: 2, amp: 0.6, dash: [3, 9] })
            pts.forEach(([px, py], k) => {
              const tw = 0.5 + 0.5 * Math.sin(t * (1.7 + k * 0.37) + gi * 2 + k)
              glowDisc(ctx, px, py, 14, '255,236,176', 0.18 + 0.14 * tw)
              dot(ctx, px, py, 2.9, `rgba(255,250,230,${0.65 + 0.35 * tw})`)
            })
          })
        }

        // a few butter paper 4-point stars glued on
        const pr = K.rng(id, 'pstars')
        for (let k = 0; k < 7; k++) {
          const sx = Math.min(90, w * 0.1) + pr() * (w - Math.min(180, w * 0.2))
          const sy = 40 + pr() * (h - 180) - fy0
          const s = (10 + pr() * 8) * ss
          const ph = pr() * TAU
          const tw = 0.5 + 0.5 * Math.sin(t * (1.3 + pr()) + ph)
          glowDisc(ctx, sx, sy, s * 3.4, '255,232,160', 0.1 + 0.22 * tw * twinkle)
          K.at(ctx, sx, sy, 0.25 * Math.sin(t * 0.7 + ph), 0.84 + 0.26 * tw * twinkle, () => {
            K.paper(ctx, K.starPts(0, 0, s, s * 0.4, 4), k % 2 ? C.lemon : C.moon, { cut: 0.5, shadow: 0.7, seed: id + 'ps' + k })
          })
        }
      })
      ctx.restore()
      clipTo(-rodOv - 4, w + rodOv + 4)
      K.at(ctx, 0, by, 0, 1, () => {
        // kraft dowel + pull cord
        K.paper(ctx, K.roundRectPts(-rodOv, -44, w + rodOv * 2, 24, 10), C.kraftDark, { cut: 1, shadow: 1, lift: 3, seed: id + 'rod' })
        jseg(ctx, -rodOv + 30, -40, w + rodOv - 30, -40, id + 'rodhi', t, { color: 'rgba(255,240,210,0.35)', w: 2.5, amp: 0.8 })
        if (cord) {
          const cx = w * 0.5
          const a = 0.12 * Math.sin(t * 2.3 + 0.7)
          const ex = cx + Math.sin(a) * 70
          const ey = -32 + Math.cos(a) * 70
          jseg(ctx, cx, -32, ex, ey, id + 'cord', t, { color: THREAD, w: 2.4, amp: 0.5 })
          K.at(ctx, ex, ey, -a, 1, () => {
            ctx.save()
            ctx.lineWidth = 5
            ctx.strokeStyle = C.mustard
            ctx.beginPath()
            ctx.arc(0, 11, 10, 0, TAU)
            ctx.stroke()
            ctx.restore()
            K.paper(ctx, [[-7, 20], [7, 20], [11, 48], [0, 54], [-11, 48]], C.terracotta, { cut: 0.6, shadow: 0.7, seed: id + 'tassel' })
          })
        }
      })
      ctx.restore()
      return out
    })
  }

  function moonOnThread(ctx, x, y, t = 0, o = {}) {
    const { drop = 1, ease = 'outBack', len = 300, r = 110, swing = 1, angle = 0, face = true, glow = 1, charm = true, tape = true, id = 'moon', color = C.butter, light = C.moon, tapeColor = 'rgba(184,92,52,0.9)' } = o
    const d = easeBy(ease, clamp01(drop))
    const L = K.lerp(-2.4 * r, len, d)
    const ph = (K.hash(id) % 100) / 16
    const sw = 0.07 * swing
    const a = angle + sw * Math.sin(t * 1.7 + ph)
    const av = sw * Math.cos(t * 1.7 + ph) // angular velocity (for lag)
    const cr = crescentPts(r, r * 0.46, -r * 0.2, r * 0.84)
    const [tip, low] = cr.tips
    return place(ctx, x, y, o, (m) => {
      const out = {}
      // thread length ≥ 0 swings; below 0 the moon is simply hauled straight up past the pivot
      K.at(ctx, 0, Math.min(0, L), a, 1, () => {
        const hookY = Math.max(0, L)
        if (L > 2) {
          K.pencil.line(ctx, 0, -6, 0, hookY, id + 'thr', t, { stroke: THREAD, strokeWidth: 2.2, roughness: 0.45, bowing: 0.6 })
        }
        out.hook = m(0, hookY)
        // the moon hangs from its upper horn tip; lags the swing a little
        K.at(ctx, 0, hookY, -av * 0.9, 1, () => {
          K.at(ctx, -tip[0], -tip[1], 0, 1, () => {
            glowDisc(ctx, -r * 0.18, r * 0.06, r * 2.3, '255,236,170', 0.26 * glow)
            K.paper(ctx, cr.pts, color, { torn: 3, seed: id + 'base', shadow: 1, lift: 6 })
            // lighter moon-paper layer (leaves a butter shading sliver lower-right)
            const hi = cr.pts.map(([px, py]) => [-r * 0.12 + (px + r * 0.12) * 0.86 - 3, -r * 0.1 + (py + r * 0.1) * 0.86 - 4])
            K.paper(ctx, hi, light, { cut: 1.2, seed: id + 'hi', shadow: 0.3 })
            // craters
            ctx.save()
            for (const [cx, cy, cr2] of [[-0.66, -0.42, 0.1], [-0.83, 0.3, 0.06], [-0.2, 0.8, 0.07]]) {
              ctx.beginPath()
              ctx.ellipse(cx * r, cy * r, cr2 * r, cr2 * r * 0.85, 0.3, 0, TAU)
              ctx.fillStyle = 'rgba(211,162,60,0.32)'
              ctx.fill()
              ctx.lineWidth = 1.6
              ctx.strokeStyle = 'rgba(91,74,54,0.35)'
              ctx.stroke()
            }
            ctx.restore()
            if (face) {
              // sleepy closed eye with lashes, rosy blush, tiny content smile
              const lw = Math.max(3, r * 0.045)
              const ex = -r * 0.6
              const ey = -r * 0.02
              K.pencil.arc(ctx, ex, ey, r * 0.34, r * 0.26, 0.12 * Math.PI, 0.88 * Math.PI, id + 'eye', t, { strokeWidth: lw, roughness: 0.5 })
              jseg(ctx, ex - r * 0.13, ey + r * 0.1, ex - r * 0.2, ey + r * 0.18, id + 'l1', t, { w: lw * 0.7, amp: 0.5 })
              jseg(ctx, ex - r * 0.03, ey + r * 0.13, ex - r * 0.05, ey + r * 0.22, id + 'l2', t, { w: lw * 0.7, amp: 0.5 })
              jseg(ctx, ex + r * 0.08, ey + r * 0.11, ex + r * 0.11, ey + r * 0.19, id + 'l3', t, { w: lw * 0.7, amp: 0.5 })
              K.cheek(ctx, -r * 0.76, r * 0.24, r * 0.18)
              K.pencil.arc(ctx, -r * 0.5, r * 0.36, r * 0.2, r * 0.15, 0.12 * Math.PI, 0.88 * Math.PI, id + 'mouth', t, { strokeWidth: lw * 0.85, roughness: 0.5 })
            }
            // knot at the horn
            dot(ctx, tip[0], tip[1] + 3, 4, THREAD)
            // a tiny paper star dangling from the lower horn (lags more)
            if (charm) {
              const ca = -av * 2.2 + 0.1 * Math.sin(t * 2.4 + ph)
              const cl = r * 0.42
              const sx = low[0] + Math.sin(ca) * cl
              const sy = low[1] + Math.cos(ca) * cl
              jseg(ctx, low[0], low[1], sx, sy, id + 'cth', t, { color: THREAD, w: 1.8, amp: 0.4 })
              const tw = 0.5 + 0.5 * Math.sin(t * 2.1 + ph)
              glowDisc(ctx, sx, sy + 13, 36, '255,236,170', 0.16 + 0.16 * tw)
              K.at(ctx, sx, sy + 13, ca * 0.5, 1, () => K.paper(ctx, K.starPts(0, 0, 14, 5.6, 4), C.lemon, { cut: 0.5, shadow: 0.7, seed: id + 'ch' }))
            }
            out.moon = m(0, 0)
          })
        })
      })
      if (tape) K.tape(ctx, 0, -2, Math.max(40, r * 0.8), -0.12, tapeColor, { h: Math.max(18, r * 0.27), seed: id + 'tape' })
      out.pivot = m(0, 0)
      return out
    })
  }

  function paperSun(ctx, x, y, t = 0, o = {}) {
    const { rise = 1, ease = 'outBack', dist = 420, r = 130, face = 'happy', look = [0.15, -0.1], glow = 1, horizon = null, id = 'sun', color = C.mustard, rim = '#f2934f', light = C.lemon, halo = '#ffd98f', haloOuter = '#fff0cc', shade = C.honey } = o
    const p = clamp01(rise)
    const e = easeBy(ease, p)
    const p0 = Math.max(0, p - 0.03)
    const p1 = Math.min(1, p + 0.03)
    const v = (easeBy(ease, p1) - easeBy(ease, p0)) / Math.max(1e-6, p1 - p0)
    const sy = K.clamp(1 + 0.05 * v, 0.88, 1.18)
    const sx = 1 / Math.sqrt(sy)
    // idle bob fades in over the last 20 % of the rise (hidden inside the overshoot) — no pop at rise = 1
    const bw = K.seg(p, 0.8, 1)
    const bob = Math.sin(t * 1.3) * 3 * bw * bw * (3 - 2 * bw)
    const cy = (1 - e) * dist + bob
    ctx.save()
    if (horizon !== null && horizon !== undefined) {
      ctx.beginPath()
      ctx.rect(-1e5, -1e5, 2e5, 1e5 + horizon)
      ctx.clip()
    }
    const out = place(ctx, x, y, o, (m) => {
      K.at(ctx, 0, cy, 0, [sx, sy], () => {
        glowDisc(ctx, 0, 0, r * 2.1, '255,244,214', 0.66 * glow)
        // translucent tissue rings in the sun's own warm hues: the edge reads as glow, not as a plate
        if (glow > 0) {
          tissue(ctx, K.ellipsePts(0, 0, r * 1.46, r * 1.46, 48), haloOuter, 0.32 * glow, id + 'h2', 6, t * 0.03)
          tissue(ctx, K.ellipsePts(0, 0, r * 1.24, r * 1.24, 48), halo, 0.5 * glow, id + 'h1', 5, -t * 0.04)
        }
        // the disc slowly turns (torn edges creep round); face + highlight stay put
        K.at(ctx, 0, 0, t * 0.05, 1, () => {
          K.paper(ctx, K.ellipsePts(0, 0, r * 1.08, r * 1.08, 44), rim, { torn: 4, seed: id + 'rim', shadow: 1, lift: 4 })
          // one torn edge only (the coral rim's white fibres face the sky); the disc is scissor-cut so
          // there's no second white ring inside the sun (that read as a pie crust)
          K.paper(ctx, K.ellipsePts(0, 0, r, r, 44), color, { cut: 2.2, seed: id + 'disc', shadow: 0.6 })
        })
        // light: a lemon sliver hugging the upper-left rim; a honey sliver of shade lower-right
        const hi = crescentPts(r * 0.9, r * 0.085, r * 0.085, r * 0.86, 40)
        K.paper(ctx, hi.pts, light, { cut: 1.4, shadow: 0, seed: id + 'hi' })
        const lo = crescentPts(r * 0.92, -r * 0.05, -r * 0.05, r * 0.9, 36)
        K.withAlpha(ctx, 0.55, () => K.paper(ctx, lo.pts, shade, { cut: 1.2, shadow: 0, seed: id + 'lo' }))
        sunFace(ctx, r, t, id, face, look, color)
      })
      return { centre: m(0, cy) }
    })
    ctx.restore()
    return out
  }
  /** Translucent tissue paper: torn edge, no white fibre rim, no shadow; turns by `rot`.
   *  Flat colour on purpose: grain is invisible at tissue alpha, and a rotated pattern fill
   *  is ~4x the raster cost. */
  function tissue(ctx, pts, color, alpha, seed, torn, rot = 0) {
    if (alpha <= 0) return
    K.at(ctx, 0, 0, rot, 1, () => {
      ctx.save()
      ctx.globalAlpha *= alpha
      K.pathPoly(ctx, K.tear(pts, torn, seed))
      ctx.fillStyle = color
      ctx.fill()
      ctx.restore()
    })
  }
  function sunFace(ctx, r, t, id, face, look, light) {
    if (face === 'none') return
    const ex = r * 0.34
    const ey = -r * 0.08
    const ink = { strokeWidth: Math.max(3, r * 0.04), roughness: 0.55, stroke: C.ink }
    if (face === 'awake') {
      K.googly(ctx, -ex, ey, r * 0.17, t, id + 'eL', look, { lidColor: light })
      K.googly(ctx, ex, ey + 2, r * 0.15, t, id + 'eR', look, { lidColor: light })
    } else if (face === 'sleepy') {
      K.pencil.arc(ctx, -ex, ey, r * 0.24, r * 0.18, 0.12 * Math.PI, 0.88 * Math.PI, id + 'sl', t, ink)
      K.pencil.arc(ctx, ex, ey, r * 0.24, r * 0.18, 0.12 * Math.PI, 0.88 * Math.PI, id + 'sr', t, ink)
    } else {
      K.pencil.arc(ctx, -ex, ey + r * 0.07, r * 0.24, r * 0.22, 1.12 * Math.PI, 1.88 * Math.PI, id + 'hl', t, ink)
      K.pencil.arc(ctx, ex, ey + r * 0.07, r * 0.24, r * 0.22, 1.12 * Math.PI, 1.88 * Math.PI, id + 'hr', t, ink)
    }
    K.cheek(ctx, -r * 0.55, r * 0.16, r * 0.22)
    K.cheek(ctx, r * 0.55, r * 0.16, r * 0.22)
    // tiny cream catch-lights on the cheeks (appeal)
    dot(ctx, -r * 0.5, r * 0.11, Math.max(2, r * 0.035), 'rgba(255,250,235,0.85)')
    dot(ctx, r * 0.6, r * 0.11, Math.max(2, r * 0.035), 'rgba(255,250,235,0.85)')
    if (face === 'sleepy') {
      K.pencil.arc(ctx, 0, r * 0.2, r * 0.18, r * 0.12, 0.15 * Math.PI, 0.85 * Math.PI, id + 'sm', t, ink)
      return
    }
    // open happy mouth (D shape) with a coral tongue
    ctx.save()
    const my = r * 0.15
    const mr = r * 0.2
    ctx.beginPath()
    ctx.moveTo(-mr, my)
    ctx.quadraticCurveTo(0, my - mr * 0.12, mr, my)
    ctx.arc(0, my, mr, 0, Math.PI)
    ctx.closePath()
    ctx.fillStyle = '#6b2f1c'
    ctx.fill()
    ctx.clip()
    ctx.beginPath()
    ctx.ellipse(0, my + mr * 0.95, mr * 0.62, mr * 0.45, 0, 0, TAU)
    ctx.fillStyle = C.coral
    ctx.fill()
    ctx.restore()
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(-mr, my)
    ctx.quadraticCurveTo(0, my - mr * 0.12, mr, my)
    ctx.arc(0, my, mr, 0, Math.PI)
    ctx.closePath()
    ctx.lineWidth = Math.max(2.5, r * 0.028)
    ctx.strokeStyle = C.ink
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.restore()
  }

  // =====================================================================
  // SCHEDULER MACHINERY
  // =====================================================================
  /** Point + normal at arc-length s around a stadium centre-line (top run first, moving right). */
  function stadiumAt(s, L, rc) {
    if (s < L) return [-L / 2 + s, -rc, 0, 1]
    s -= L
    const arc = Math.PI * rc
    if (s < arc) {
      const a = -Math.PI / 2 + s / rc
      return [L / 2 + Math.cos(a) * rc, Math.sin(a) * rc, Math.cos(a), Math.sin(a)]
    }
    s -= arc
    if (s < L) return [L / 2 - s, rc, 0, 1]
    s -= L
    const a = Math.PI / 2 + s / rc
    return [-L / 2 + Math.cos(a) * rc, Math.sin(a) * rc, Math.cos(a), Math.sin(a)]
  }
  function roller(ctx, cx, cy, r, ang, id, t, color) {
    K.at(ctx, cx, cy, ang, 1, () => {
      K.paper(ctx, K.ellipsePts(0, 0, r, r, 26), color, { cut: 0.8, seed: id, shadow: 0.7, lift: 1 })
      ctx.save()
      K.pathPoly(ctx, K.ellipsePts(0, 0, r - 2.5, r - 2.5, 26))
      ctx.clip()
      ctx.strokeStyle = 'rgba(42,34,26,0.4)'
      ctx.lineWidth = 2.3
      ctx.lineCap = 'round'
      ctx.beginPath()
      const jr = K.rng('hatch', id, K.boil(t))
      for (let k = -r * 1.6; k < r * 1.6; k += 8.5) {
        ctx.moveTo(k - r + (jr() - 0.5) * 2, -r)
        ctx.lineTo(k + r + (jr() - 0.5) * 2, r)
      }
      ctx.stroke()
      ctx.restore()
      dot(ctx, 0, 0, r * 0.3, C.inkDim)
      dot(ctx, 0, 0, r * 0.14, C.cream)
      dot(ctx, r * 0.62, 0, r * 0.1, C.terracotta) // spin marker
    })
    K.pencil.circle(ctx, cx, cy, r * 2, id + 'o', t, { strokeWidth: 2.4, roughness: 0.8 })
  }
  function conveyor(ctx, x, y, t = 0, o = {}) {
    const { w = 1100, h = 100, offset = 0, label = 'Scheduler', rollers = 6, legs = true, id = 'conveyor', belt = '#4a3a2c', panel = C.terracotta, rollerColor = C.butter, band = 15, labelSize = 50 } = o
    return place(ctx, x, y, o, (m) => {
      const L = w - h
      const R0 = h / 2
      if (legs) {
        for (const sx of [-1, 1]) {
          const lx = sx * (L / 2 - 40)
          K.paper(ctx, [[lx - 15, 0], [lx + 15, 0], [lx + 22, R0 + 92], [lx - 22, R0 + 92]], C.kraftDark, { cut: 1, seed: id + 'leg' + sx, shadow: 0.8 })
          K.paper(ctx, K.roundRectPts(lx - 38, R0 + 86, 76, 17, 8), C.inkDim, { cut: 0.8, seed: id + 'ft' + sx, shadow: 0.8 })
        }
      }
      K.paper(ctx, stadiumPts(w, h), belt, { cut: 1.2, seed: id + 'belt', shadow: 1.1, lift: 5 })
      K.paper(ctx, stadiumPts(w - band * 2, h - band * 2), panel, { cut: 0.8, seed: id + 'panel', shadow: 0.55 })
      // slat ticks travelling round the belt
      const rc = R0 - band / 2
      const P = 2 * L + TAU * rc
      const sp = 30
      ctx.save()
      ctx.strokeStyle = 'rgba(246,239,225,0.6)'
      ctx.lineWidth = 2.6
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (let s = ((offset % sp) + sp) % sp; s < P; s += sp) {
        const [px, py, nx, ny] = stadiumAt(s, L, rc)
        ctx.moveTo(px - nx * band * 0.3, py - ny * band * 0.3)
        ctx.lineTo(px + nx * band * 0.3, py + ny * band * 0.3)
      }
      ctx.stroke()
      ctx.restore()
      const rr = R0 - band - 6
      for (let i = 0; i < rollers; i++) {
        const cx = rollers > 1 ? -L / 2 + (i / (rollers - 1)) * L : 0
        roller(ctx, cx, 0, rr, offset / (rr + 4), id + 'r' + i, t, rollerColor)
      }
      // top-run highlight
      jseg(ctx, -L / 2, -R0 + 3, L / 2, -R0 + 3, id + 'hi', t, { color: 'rgba(255,240,210,0.28)', w: 2.5, amp: 0.8 })
      if (label) plaque(ctx, label, 0, R0 + 56, t, id, { size: labelSize, rot: -0.015 })
      return { left: m(-L / 2, -R0), right: m(L / 2, -R0), top: m(0, -R0), label: m(0, R0 + 56) }
    })
  }

  const mix = (a, b, p) => {
    const A = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
    const B = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
    return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * p)).join(',')})`
  }
  /** Marquee bulb standing on (x, y): socket, neck, glass with a coil filament. lit 0..1. */
  function bulb(ctx, x, y, lit, t, id) {
    const R = 16
    // socket + threaded neck
    K.paper(ctx, K.roundRectPts(x - 10, y - 7, 20, 13, 3), C.inkDim, { cut: 0.5, seed: id + 's', shadow: 0.5 })
    K.paper(ctx, K.roundRectPts(x - 7, y - 14, 14, 8, 2), '#9aa3a8', { cut: 0.3, seed: id + 'n', shadow: 0 })
    ctx.save()
    ctx.strokeStyle = 'rgba(42,34,26,0.45)'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(x - 6, y - 11)
    ctx.lineTo(x + 6, y - 9.5)
    ctx.stroke()
    ctx.restore()
    const cy = y - 14 - R + 3
    if (lit > 0) glowDisc(ctx, x, cy, 80, '255,206,96', 0.62 * lit)
    ctx.save()
    // glass: clear bluish when off → warm lemon/mustard when lit
    ctx.beginPath()
    ctx.arc(x, cy, R, 0, TAU)
    ctx.fillStyle = mix('#dce6ea', '#ffd45e', lit)
    ctx.globalAlpha = 0.9 + 0.1 * lit
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(42,34,26,0.75)'
    ctx.stroke()
    if (lit > 0.5) {
      // white-hot core
      const k = (lit - 0.5) / 0.5
      glowDisc(ctx, x, cy + 1, R * 0.95, '255,255,240', 0.9 * k)
      dot(ctx, x, cy + 1, 5, `rgba(255,255,246,${0.95 * k})`)
    }
    // coil filament on two little support wires
    const fc = lit > 0.2 ? C.honey : C.inkFaint
    jseg(ctx, x - 5, cy + R - 2, x - 5, cy + 3, id + 'w1', t, { color: 'rgba(91,74,54,0.55)', w: 1.4, amp: 0.2 })
    jseg(ctx, x + 5, cy + R - 2, x + 5, cy + 3, id + 'w2', t, { color: 'rgba(91,74,54,0.55)', w: 1.4, amp: 0.2 })
    jpoly(ctx, [[x - 6, cy + 3], [x - 3.5, cy - 2], [x - 1, cy + 3], [x + 1.5, cy - 2], [x + 4, cy + 3], [x + 6, cy - 1]], id + 'f', t, { color: fc, w: lit > 0.2 ? 2.4 : 1.8, amp: 0.25 })
    // glass shine
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 2.6
    ctx.beginPath()
    ctx.arc(x, cy, R - 5, Math.PI * 1.08, Math.PI * 1.42)
    ctx.stroke()
    ctx.restore()
  }
  function slotBoxes(ctx, x, y, t = 0, o = {}) {
    const { n = 5, slotW = 170, slotH = 150, gap = 22, label = 'Slots', lit = 0, part = 'all', id = 'slots', color = C.kraft, inside = '#9a7650' } = o
    const TW = n * slotW + (n - 1) * gap + 56
    const TH = slotH + 56
    const pitch = slotW + gap
    const cxs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch)
    const litOf = (i) => clamp01(Array.isArray(lit) ? lit[i] || 0 : lit - i)
    const lipTop = slotH / 2 - 30
    return place(ctx, x, y, o, (m) => {
      if (part !== 'front') {
        K.paper(ctx, K.roundRectPts(-TW / 2, -TH / 2, TW, TH, 16), color, { cut: 1.5, seed: id + 'tray', shadow: 1.1, lift: 4 })
        cxs.forEach((cx, i) => {
          const L = litOf(i)
          const box = K.rectPts(cx - slotW / 2, -slotH / 2, slotW, slotH)
          K.paper(ctx, box, inside, { cut: 0.8, seed: id + 'bay' + i, shadow: 0 })
          ctx.save()
          // depth: shadow under the top edge + left wall
          ctx.fillStyle = 'rgba(40,24,10,0.22)'
          ctx.fillRect(cx - slotW / 2, -slotH / 2, slotW, 14)
          ctx.fillStyle = 'rgba(40,24,10,0.12)'
          ctx.fillRect(cx - slotW / 2, -slotH / 2, 10, slotH)
          ctx.restore()
          if (L > 0) glowDisc(ctx, cx, -slotH * 0.12, slotW * 0.62, '255,214,120', 0.3 * L)
          // painted parking lines (dashed cream crayon)
          jpoly(ctx, K.rectPts(cx - slotW / 2 + 10, -slotH / 2 + 12, slotW - 20, slotH - 16), id + 'pk' + i, t, { color: 'rgba(251,244,228,0.8)', w: 3.6, amp: 1, closed: true, dash: [15, 10] })
        })
        cxs.forEach((cx, i) => bulb(ctx, cx, -TH / 2 + 2, litOf(i), t, id + 'b' + i))
      }
      if (part !== 'back') {
        K.paper(ctx, K.roundRectPts(-TW / 2 + 3, lipTop, TW - 6, TH / 2 - lipTop, 12), color, { cut: 1.2, seed: id + 'lip', shadow: 0.9, lift: 2 })
        jseg(ctx, -TW / 2 + 16, lipTop + 5, TW / 2 - 16, lipTop + 5, id + 'liphi', t, { color: 'rgba(255,248,230,0.55)', w: 2.5, amp: 0.8 })
        if (label) plaque(ctx, label, 0, TH / 2 + 34, t, id, { size: 46, rot: 0.012 })
      }
      return { slots: cxs.map((cx) => m(cx, 0)), floor: cxs.map((cx) => m(cx, lipTop + 14)), label: m(0, TH / 2 + 34) }
    })
  }

  function gauge(ctx, x, y, t = 0, o = {}) {
    const { value = 0.5, tick = 0.9, r = 150, label = 'Window used', jiggle = 1, id = 'gauge' } = o
    const v = K.clamp(value, 0, 1.04)
    const A = (u) => Math.PI + u * Math.PI
    return place(ctx, x, y, o, (m) => {
      const R = r
      const plate = [...arcPts(0, 0, R + 28, Math.PI, TAU, 30), [R + 28, 100], [-(R + 28), 100]]
      K.paper(ctx, plate, C.kraft, { cut: 2, seed: id + 'plate', shadow: 1.1, lift: 3 })
      K.paper(ctx, [...arcPts(0, 0, R, Math.PI, TAU, 30), [R, 10], [-R, 10]], C.cream, { cut: 1.2, seed: id + 'face', shadow: 0.5 })
      ;[[0, 0.55, C.sage], [0.55, 0.8, C.mustard], [0.8, 1, C.peach]].forEach(([a, b, col], i) => {
        K.paper(ctx, sectorPts(R * 0.6, R * 0.82, A(a), A(b), 14), col, { cut: 0.6, seed: id + 'band' + i, shadow: 0.35 })
      })
      for (let k = 0; k <= 10; k++) {
        const aa = A(k / 10)
        const r2 = k % 5 === 0 ? R * 0.99 : R * 0.95
        jseg(ctx, Math.cos(aa) * R * 0.86, Math.sin(aa) * R * 0.86, Math.cos(aa) * r2, Math.sin(aa) * r2, id + 'tk' + k, t, { w: k % 5 === 0 ? 3.4 : 2.4, amp: 0.6 })
      }
      // red crayon tick
      const ta = A(tick)
      const tx0 = Math.cos(ta) * R * 0.5
      const ty0 = Math.sin(ta) * R * 0.5
      const tx1 = Math.cos(ta) * R * 1.16
      const ty1 = Math.sin(ta) * R * 1.16
      K.pencil.line(ctx, tx0, ty0, tx1, ty1, id + 'red', t, { stroke: RED, strokeWidth: 7, roughness: 1.4, bowing: 0.5 })
      K.pencil.line(ctx, tx0 + 2, ty0 + 1, tx1 + 2, ty1 + 1, id + 'red2', t, { stroke: RED, strokeWidth: 3.5, roughness: 1.8, bowing: 0.8 })
      // needle
      const na = A(v) + K.noise1(t * 5, id, 'n') * 0.012 * jiggle
      K.at(ctx, 0, 0, na, 1, () => {
        K.paper(ctx, [[-20, 0], [0, -8.5], [R * 0.88, 0], [0, 8.5]], C.termBlack, { cut: 0, seed: id + 'needle', shadow: 1, lift: 6 })
        jseg(ctx, 4, -2.5, R * 0.6, -0.5, id + 'nhi', t, { color: 'rgba(255,255,255,0.22)', w: 2, amp: 0.3 })
      })
      // brad
      dot(ctx, 1.5, 2.5, 14, 'rgba(58,36,14,0.25)')
      dot(ctx, 0, 0, 13, C.butter)
      ctx.save()
      ctx.lineWidth = 2
      ctx.strokeStyle = C.inkDim
      ctx.beginPath()
      ctx.arc(0, 0, 13, 0, TAU)
      ctx.moveTo(-5, 0)
      ctx.lineTo(5, 0)
      ctx.stroke()
      ctx.restore()
      // at/over the limit: red crayon buzz marks beside the tick
      const alert = K.seg(v, tick - 0.025, tick)
      if (alert > 0) {
        const nx = Math.cos(ta)
        const ny = Math.sin(ta)
        const px = -ny
        const py = nx
        K.withAlpha(ctx, alert, () => {
          for (const s of [-1, 1]) {
            for (const k of [0, 1]) {
              const off = s * (16 + k * 11)
              const bx = tx1 * 0.97 + px * off
              const by = ty1 * 0.97 + py * off
              jseg(ctx, bx - nx * 10, by - ny * 10, bx + nx * 10, by + ny * 10, id + 'bz' + s + k, t, { color: RED, w: 3.2, amp: 1.2 })
            }
          }
        })
      }
      K.hand(ctx, label, 0, 72, { family: 'hand', size: 46, t, id: id + 'lbl', jitter: 0.6 })
      return { pivot: m(0, 0), tip: m(Math.cos(na) * R * 0.88, Math.sin(na) * R * 0.88), tick: m(tx1, ty1) }
    })
  }

  function hangingSign(ctx, x, y, t = 0, o = {}) {
    const { text = 'paused', flip = 1, ease = signEase, w = 300, h = 116, len = 56, swing = 1, icon = true, rock = 1, id = 'sign', color = C.cream, border = C.terracotta, back = C.kraft } = o
    const fp = clamp01(flip)
    const f = easeBy(ease, fp)
    const theta = Math.PI * (1 - f)
    const sy0 = Math.cos(theta)
    // folded up, the board leans back over the dowel (foreshortened to 80 %) so the pin stays clear
    const sy = sy0 < 0 ? sy0 * 0.8 : sy0
    const ph = (K.hash(id) % 100) / 15
    // follow-through: the whole sign rocks on its pin after it lands (o.rock 0/false = off, e.g.
    // on the flip-back-up path so it doesn't wobble before it starts to rise)
    const q = K.seg(fp, 0.6, 1)
    const rk = rock === true ? 1 : +rock || 0
    const kick = fp > 0.6 && fp < 1 ? 0.1 * rk * Math.sin(q * Math.PI * 3) * (1 - q) : 0
    const sway = 0.03 * swing * Math.sin(t * 1.9 + ph) + kick
    const hx = w * 0.4
    const hanger = () => {
      // twine triangle + mustard pin
      twine(ctx, 0, 0, -hx, len, id + 's1', t, { w: 2.8 })
      twine(ctx, 0, 0, hx, len, id + 's2', t, { w: 2.8 })
      dot(ctx, 1.5, 3, 8, 'rgba(58,36,14,0.25)')
      dot(ctx, 0, 0, 7.5, C.mustard)
      dot(ctx, -2, -2, 2.4, 'rgba(255,255,255,0.8)')
    }
    return place(ctx, x, y, o, (m) => {
      let signC
      K.at(ctx, 0, 0, sway, 1, () => {
        // hanging down: twine behind the board. Folded up: the board is behind the twine.
        if (sy >= 0) hanger()
        // the sign, hinged on the dowel, flipping about it
        const hy = len + 5
        if (Math.abs(sy) > 0.02) {
          K.at(ctx, 0, hy, 0, [1, sy], () => {
            const body = K.roundRectPts(-w / 2, 0, w, h, 12, 4)
            if (sy > 0) {
              K.paper(ctx, body, border, { cut: 1.4, seed: id + 'b', shadow: 1, lift: 5 })
              K.paper(ctx, K.roundRectPts(-w / 2 + 10, 10, w - 20, h - 20, 8, 4), color, { cut: 1, seed: id + 'f', shadow: 0.35 })
              const tx = icon ? h * 0.3 : 0
              if (icon) {
                const ix = -w / 2 + h * 0.38
                const bh = h * 0.36
                K.paper(ctx, K.roundRectPts(ix - 13, h / 2 - bh / 2, 11, bh, 4, 2), border, { cut: 0.4, seed: id + 'i1', shadow: 0.5 })
                K.paper(ctx, K.roundRectPts(ix + 5, h / 2 - bh / 2, 11, bh, 4, 2), border, { cut: 0.4, seed: id + 'i2', shadow: 0.5 })
              }
              K.hand(ctx, text, tx, h / 2 + h * 0.17, { family: 'marker', size: h * 0.5, t, id: id + 'txt', jitter: 0.7 })
            } else {
              // back face: plain kraft with a sage paper "play" triangle (it's running again)
              K.paper(ctx, body, back, { cut: 1.4, seed: id + 'bk', shadow: 1, lift: 5 })
              jpoly(ctx, K.roundRectPts(-w / 2 + 12, 12, w - 24, h - 24, 8, 3), id + 'bkl', t, { color: 'rgba(91,74,54,0.35)', w: 2, closed: true, dash: [8, 8] })
              // ▶ sits near the hinge, between the twine legs and clear of the pin when folded up
              const th = h * 0.22
              const pyc = h * 0.29
              K.paper(ctx, [[-th * 0.8, pyc - th], [th * 1.05, pyc], [-th * 0.8, pyc + th]], C.sage, { cut: 0.6, seed: id + 'play', shadow: 0.6 })
            }
            // edge-on darkening while it turns (+ a touch of shade when leaning back)
            const dark = 0.4 * (1 - Math.abs(sy0)) + (sy < 0 ? 0.06 : 0)
            if (dark > 0.01) {
              K.pathPoly(ctx, body)
              ctx.fillStyle = `rgba(30,20,10,${dark})`
              ctx.fill()
            }
          })
        }
        // dowel on top
        K.paper(ctx, K.roundRectPts(-w / 2 - 14, hy - 7, w + 28, 14, 7), C.kraftDark, { cut: 0.6, seed: id + 'rod', shadow: 0.8 })
        dot(ctx, -w / 2 - 14, hy, 8, C.terracotta)
        dot(ctx, w / 2 + 14, hy, 8, C.terracotta)
        if (sy < 0) hanger()
        signC = m(0, hy + (h / 2) * sy)
      })
      return { pin: m(0, 0), sign: signC }
    })
  }

  // =====================================================================
  // BEDSIDE
  // =====================================================================
  function screenContents(ctx, sx, sy, sw, sh, t, id) {
    // console window in miniature
    const bar = sh * 0.13
    K.flat(ctx, K.rectPts(sx, sy, sw, bar), C.terracotta)
    for (let i = 0; i < 3; i++) {
      const tw = sw * 0.17
      const tx = sx + sw * 0.2 + i * (tw + 6)
      K.flat(ctx, K.roundRectPts(tx, sy + bar * 0.3, tw, bar * 0.7 + 1, 4, 2), i === 0 ? C.cream : C.peach)
    }
    const side = sw * 0.17
    K.flat(ctx, K.rectPts(sx, sy + bar, side, sh - bar), C.kraftLight)
    for (let k = 0; k < 4; k++) jseg(ctx, sx + 9, sy + bar + 18 + k * 20, sx + side - 10, sy + bar + 18 + k * 20, id + 'sd' + k, t, { color: C.inkFaint, w: 3, amp: 0.6 })
    // ticked job rows
    const lx = sx + side + 14
    for (let k = 0; k < 3; k++) {
      const ry = sy + bar + 22 + k * 26
      ctx.save()
      ctx.strokeStyle = C.inkDim
      ctx.lineWidth = 2
      ctx.strokeRect(lx, ry - 8, 14, 14)
      ctx.restore()
      if (k < 2) jpoly(ctx, [[lx + 2, ry], [lx + 6, ry + 5], [lx + 15, ry - 9]], id + 'ck' + k, t, { color: '#4f9a3a', w: 3, amp: 0.5 })
      jseg(ctx, lx + 24, ry, lx + 24 + sw * (0.28 - k * 0.05), ry, id + 'row' + k, t, { color: C.inkFaint, w: 3, amp: 0.8 })
    }
    // black paper terminal card with green crayon prompt — the SAME card the audience met in
    // s1–s2 (PROPS.terminalCard from day.js, at its native 230x160 layout scaled into the slot);
    // a matching local stand-in (rough cream border, title dots, chevron + cursor) if it's absent
    const th2 = sh * 0.46
    const tw2 = th2 * (236 / 160)
    const tx2 = sx + sw - tw2 - 10
    const ty2 = sy + sh - th2 - 10
    const cxT = tx2 + tw2 / 2
    const cyT = ty2 + th2 / 2
    const ks = th2 / 160
    if (window.PROPS && typeof window.PROPS.terminalCard === 'function' && window.PROPS.terminalCard !== miniTerminal) {
      window.PROPS.terminalCard(ctx, cxT, cyT, t, { w: 236, h: 160, scale: ks, rot: -0.03, jitter: 0, shadow: 0.6, torn: 1.6, scribbles: 2, id: id + 'term' })
    } else {
      miniTerminal(ctx, cxT, cyT, t, { scale: ks, id: id + 'term' })
    }
  }
  /** Local stand-in for day.js terminalCard (236x160 at scale 1), same visual vocabulary. */
  function miniTerminal(ctx, x, y, t, o = {}) {
    const id = o.id || 'mterm'
    const w = 236
    const h = 160
    K.at(ctx, x, y, -0.03, o.scale || 1, () => {
      K.paper(ctx, K.boxPts(w, h), C.termBlack, { torn: 1.6, seed: id, shadow: 0.6 })
      K.pencil.rect(ctx, -w / 2 + 9, -h / 2 + 9, w - 18, h - 18, id + 'bd', t, { stroke: 'rgba(251,244,228,0.8)', strokeWidth: 2.2, roughness: 1.5, bowing: 1.4 })
      for (let i = 0; i < 3; i++) dot(ctx, -w / 2 + 25 + i * 13, -h / 2 + 25, 3.8, i === 0 ? 'rgba(240,153,124,0.85)' : 'rgba(251,244,228,0.7)')
      const lx = -w / 2 + 25
      jseg(ctx, lx, -h / 2 + 50, lx + 120, -h / 2 + 50, id + 'o1', t, { color: 'rgba(251,244,228,0.45)', w: 3, amp: 0.7 })
      jseg(ctx, lx, -h / 2 + 70, lx + 80, -h / 2 + 70, id + 'o2', t, { color: 'rgba(251,244,228,0.45)', w: 3, amp: 0.7 })
      const py = h / 2 - 40
      jpoly(ctx, [[lx, py - 15], [lx + 19, py], [lx, py + 15]], id + 'gt', t, { color: C.crayonGreen, w: 5.6, amp: 0.8 })
      if ((t * 0.95 + 0.3) % 1 < 0.56) jseg(ctx, lx + 33, py + 15, lx + 58, py + 15, id + 'cu', t, { color: C.crayonGreen, w: 6.5, amp: 0.5 })
    })
  }
  function laptop(ctx, x, y, t = 0, o = {}) {
    const { w = 420, lamp = true, lampOn = 1, lampSide = 'right', mug = true, glow = 1, tag = 'app open = laptop stays awake', tagSide = 'below', tagSize = 40, id = 'laptop', body = SILVER } = o
    const sh = Math.round(w * 0.64)
    const deckH = 30
    const lidTop = -deckH - sh
    const ls = lampSide === 'left' ? -1 : 1
    return place(ctx, x, y, o, (m) => {
      const out = {}
      // --- lamp stand (behind) ---
      const baseX = ls * (w / 2 + 120)
      const elbow = [baseX + ls * 36, -250]
      const head = [ls * (w * 0.26), -sh - 120]
      const shadeRot = ls * 0.5
      if (lamp) {
        K.paper(ctx, [[baseX - 40, 0], [baseX + 40, 0], [baseX + 30, -12], [baseX - 30, -12]], C.honey, { cut: 0.8, seed: id + 'lb0', shadow: 0.9 })
        K.paper(ctx, K.ellipsePts(baseX, -14, 30, 9, 18), C.honey, { cut: 0.5, seed: id + 'lb1', shadow: 0.4 })
        armSeg(ctx, [baseX, -16], elbow, id + 'a1', t)
        armSeg(ctx, elbow, head, id + 'a2', t)
        brad(ctx, elbow[0], elbow[1])
        brad(ctx, baseX, -16)
      }
      // --- screen light spilling onto the surroundings ---
      glowDisc(ctx, 0, lidTop + sh / 2, w * 0.72, '255,244,214', 0.26 * glow)
      // --- the laptop, OPEN ---
      K.paper(ctx, K.roundRectPts(-w / 2, lidTop, w, sh + 4, 16, 4), body, { cut: 1.2, seed: id + 'lid', shadow: 1, lift: 4 })
      const sx = -w / 2 + 15
      const sy = lidTop + 15
      const sw = w - 30
      const shh = sh - 26
      K.flat(ctx, K.rectPts(sx, sy, sw, shh), C.cream)
      screenContents(ctx, sx, sy, sw, shh, t, id)
      glowDisc(ctx, 0, sy + shh * 0.45, sw * 0.52, '255,255,245', 0.22 * glow, [sx, sy, sx + sw, sy + shh])
      jpoly(ctx, K.rectPts(sx, sy, sw, shh), id + 'sbz', t, { color: 'rgba(42,34,26,0.55)', w: 2.2, amp: 0.7, closed: true })
      dot(ctx, 0, lidTop + 8, 2.6, 'rgba(42,34,26,0.5)') // webcam
      // deck (keyboard, foreshortened)
      const deck = [[-w / 2 - 6, -deckH], [w / 2 + 6, -deckH], [w / 2 + 30, -7], [w / 2 + 30, 0], [-w / 2 - 30, 0], [-w / 2 - 30, -7]]
      K.paper(ctx, deck, body, { cut: 0.8, seed: id + 'deck', shadow: 1.1, lift: 2 })
      ctx.save()
      ctx.fillStyle = 'rgba(40,50,60,0.18)'
      ctx.fillRect(-w / 2 - 28, -7, w + 56, 7)
      ctx.restore()
      for (let row = 0; row < 2; row++) {
        const ky = -deckH + 8 + row * 9
        const kw = w * (0.86 + row * 0.06)
        ctx.save()
        ctx.setLineDash([12, 5])
        ctx.lineWidth = 4.5
        ctx.strokeStyle = 'rgba(42,34,26,0.32)'
        ctx.beginPath()
        ctx.moveTo(-kw / 2, ky)
        ctx.lineTo(kw / 2, ky)
        ctx.stroke()
        ctx.restore()
      }
      jseg(ctx, -w / 2 + 4, -deckH + 1, w / 2 - 4, -deckH + 1, id + 'hinge', t, { color: 'rgba(42,34,26,0.5)', w: 2.4, amp: 0.6 })
      // awake light: a little green LED that breathes
      const led = 0.75 + 0.25 * Math.sin(t * 2.4)
      glowDisc(ctx, -ls * w * 0.42, -4, 16, '126,211,107', 0.55 * led * glow)
      dot(ctx, -ls * w * 0.42, -4, 3.2, C.crayonGreen)
      out.screen = m(0, sy + shh / 2)
      out.deck = m(0, -deckH)
      // --- mug + steam ---
      const tagLines = tag ? (String(tag).includes(' = ') ? [String(tag).split(' = ')[0] + ' =', String(tag).split(' = ').slice(1).join(' = ')] : [String(tag)]) : []
      const tagSgn = tagSide === 'left' ? -1 : tagSide === 'right' ? 1 : 0
      if (mug) {
        // keep the mug clear of a tag hanging on its side
        const mx = -ls * (w / 2 + 88 + (tagLines.length && tagSgn === -ls ? tagWidth(ctx, tagLines, tagSize) + 24 : 0))
        const hs = -ls // handle on the outer side
        ctx.save()
        ctx.lineWidth = 11
        ctx.strokeStyle = K.paperPattern(ctx, C.cream)
        ctx.beginPath()
        ctx.ellipse(mx + hs * 38, -42, 17, 21, 0, 0, TAU)
        ctx.stroke()
        ctx.lineWidth = 1.6
        ctx.strokeStyle = 'rgba(42,34,26,0.45)'
        ctx.beginPath()
        ctx.ellipse(mx + hs * 38, -42, 23, 27, 0, 0, TAU)
        ctx.stroke()
        ctx.restore()
        K.paper(ctx, K.roundRectPts(mx - 36, -86, 72, 86, 12, 3), C.cream, { cut: 1, seed: id + 'mug', shadow: 1, lift: 2 })
        K.paper(ctx, K.rectPts(mx - 36, -58, 72, 18), C.terracotta, { cut: 0.6, seed: id + 'mugband', shadow: 0.2 })
        ctx.save()
        ctx.beginPath()
        ctx.ellipse(mx, -84, 31, 6.5, 0, 0, TAU)
        ctx.fillStyle = '#5b3a22'
        ctx.fill()
        ctx.restore()
        steam(ctx, mx, -94, 130, t, id + 'st', { n: 2, spread: 18, amp: 8, w: 4.5 })
        out.mug = m(mx, -86)
      }
      // --- lamp light cone + shade (on top) ---
      if (lamp) {
        K.at(ctx, head[0], head[1], shadeRot, 1, () => {
          if (lampOn > 0) {
            ctx.save()
            ctx.globalCompositeOperation = 'screen'
            const Lc = sh + 200
            const g = ctx.createLinearGradient(0, 56, 0, 56 + Lc)
            g.addColorStop(0, `rgba(255,222,140,${0.55 * lampOn})`)
            g.addColorStop(0.55, `rgba(255,214,120,${0.22 * lampOn})`)
            g.addColorStop(1, 'rgba(255,214,120,0)')
            ctx.fillStyle = g
            ctx.beginPath()
            ctx.moveTo(-44, 56)
            ctx.lineTo(44, 56)
            ctx.lineTo(44 + Lc * 0.42, 56 + Lc)
            ctx.lineTo(-44 - Lc * 0.42, 56 + Lc)
            ctx.closePath()
            ctx.fill()
            ctx.restore()
            glowDisc(ctx, 0, 62, 70, '255,230,150', 0.5 * lampOn)
          }
          K.paper(ctx, [[-16, -6], [16, -6], [52, 58], [-52, 58]], C.honey, { cut: 1, seed: id + 'shade', shadow: 1, lift: 3 })
          jseg(ctx, -44, 48, 44, 48, id + 'shl', t, { color: 'rgba(120,70,20,0.45)', w: 3, amp: 0.6 })
          ctx.save()
          ctx.beginPath()
          ctx.ellipse(0, 58, 26, 9, 0, 0, Math.PI)
          ctx.fillStyle = lampOn > 0 ? '#fff4c8' : C.cream
          ctx.fill()
          ctx.restore()
        })
        brad(ctx, head[0], head[1])
        out.lamp = m(head[0] - ls * 30, head[1] + 60)
      }
      // --- tag ---
      if (tagLines.length) {
        const lines = tagLines
        const sway = 0.07 * Math.sin(t * 1.6 + 0.4)
        let ax
        let ay
        let len
        let ang
        if (tagSide === 'left' || tagSide === 'right') {
          // twine looped round the lid's top corner, tag dangling beside the screen
          const s = tagSide === 'left' ? -1 : 1
          const tw = tagWidth(ctx, lines, tagSize)
          ax = s * (w / 2 - 8)
          ay = lidTop + 8
          const ex = s * (w / 2 + tw / 2 + 14)
          const ey = lidTop + 58
          const tpts = [[ax, ay], [(ax + ex) / 2, (ay + ey) / 2 + 12], [ex, ey]]
          jpoly(ctx, tpts.map(([px, py]) => [px, py + 0.6]), id + 'tagtw', t, { color: 'rgba(74,50,26,0.8)', w: 4.2, amp: 0.5 })
          jpoly(ctx, tpts, id + 'tagtw', t, { color: TWINE, w: 2, amp: 0.5 })
          dot(ctx, ax, ay, 3.5, TWINE)
          K.at(ctx, ex, ey, s * 0.05 + sway * 0.4, 1, () => tagBody(ctx, lines, t, id + 'tag', { size: tagSize }))
          out.tag = m(ex, ey)
        } else {
          ax = ls * w * 0.3
          ay = -4
          len = 34
          ang = sway
          out.tag = m(...hangTag(ctx, ax, ay, len, ang, lines, t, id + 'tag', { size: tagSize }))
        }
      }
      return out
    })
  }
  function armSeg(ctx, a, b, id, t) {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const L = Math.hypot(dx, dy)
    K.at(ctx, a[0], a[1], Math.atan2(dy, dx), 1, () => {
      K.paper(ctx, K.roundRectPts(-4, -5.5, L + 8, 11, 5, 2), C.inkDim, { cut: 0.6, seed: id, shadow: 0.7 })
    })
    jseg(ctx, a[0], a[1], b[0], b[1], id + 'sp', t, { color: 'rgba(255,230,190,0.3)', w: 1.8, amp: 0.4 })
  }
  function brad(ctx, x, y) {
    dot(ctx, x + 1, y + 2, 8, 'rgba(58,36,14,0.25)')
    dot(ctx, x, y, 7.5, C.mustard)
    dot(ctx, x - 2, y - 2, 2.2, 'rgba(255,255,255,0.75)')
  }

  function alarmClock(ctx, x, y, t = 0, o = {}) {
    const { ring = 0, r = 84, tag = 'reset', tagSize = 40, time = 7, id = 'clock', color = C.terracotta, bell = C.mustard, arcColor = C.ink } = o
    const R = clamp01(ring)
    const fr = Math.round(t * 15)
    const sgn = fr % 2 ? 1 : -1
    const shake = R * (0.085 * sgn + K.noise1(t * 7, id) * 0.03)
    const hop = -R * (fr % 2 ? 9 : 2)
    return place(ctx, x, y, o, (m) => {
      const out = {}
      K.at(ctx, sgn * R * 2.5, hop, shake, 1, () => {
        // wind-up key (behind, right) — turns
        const kx = r * 1.02
        const ky = -r * 0.1
        K.paper(ctx, K.rectPts(kx - 12, ky - 5, 28, 10), C.inkDim, { cut: 0.4, seed: id + 'ks', shadow: 0.5 })
        K.at(ctx, kx + 26, ky, 0, [Math.max(0.15, Math.abs(Math.cos(t * 1.6))), 1], () => {
          K.paper(ctx, [...K.ellipsePts(0, -13, 14, 12, 14)], bell, { cut: 0.5, seed: id + 'k1', shadow: 0.6 })
          K.paper(ctx, [...K.ellipsePts(0, 13, 14, 12, 14)], bell, { cut: 0.5, seed: id + 'k2', shadow: 0.6 })
          dot(ctx, 0, 0, 5, C.honey)
        })
        // feet
        for (const s of [-1, 1]) {
          const a = Math.PI / 2 + s * 0.62
          const fx = Math.cos(a) * r * 1.02
          const fy = Math.sin(a) * r * 1.02
          jseg(ctx, Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8, fx + s * 4, fy + 10, id + 'leg' + s, t, { color: C.inkDim, w: 5, amp: 0.5 })
          K.paper(ctx, K.ellipsePts(fx + s * 6, fy + 14, 16, 8, 14), C.inkDim, { cut: 0.4, seed: id + 'ft' + s, shadow: 0.7 })
        }
        // hammer post + hammer (flicks between the bells)
        const ha = R > 0 ? sgn * 0.5 : 0
        K.at(ctx, 0, -r * 0.94, ha, 1, () => {
          jseg(ctx, 0, 0, 0, -r * 0.42, id + 'hm', t, { color: C.inkDim, w: 5, amp: 0.4 })
          dot(ctx, 0, -r * 0.44, 8, C.inkDim)
        })
        // bells
        for (const s of [-1, 1]) {
          const a = -Math.PI / 2 + s * 0.72
          const bx = Math.cos(a) * r * 0.98
          const by = Math.sin(a) * r * 0.98
          K.at(ctx, bx, by, a + Math.PI / 2, 1, () => {
            jseg(ctx, 0, 6, 0, 18, id + 'bs' + s, t, { color: C.inkDim, w: 5, amp: 0.3 })
            const dome = [...arcPts(0, 0, r * 0.4, Math.PI, TAU, 16), [r * 0.4, 4], [-r * 0.4, 4]]
            K.paper(ctx, dome, bell, { cut: 0.8, seed: id + 'bell' + s, shadow: 0.9, lift: 2 })
            jpoly(ctx, arcPts(0, 0, r * 0.28, Math.PI * 1.15, Math.PI * 1.45, 5), id + 'bh' + s, t, { color: 'rgba(255,255,255,0.7)', w: 3, amp: 0.4 })
            dot(ctx, 0, -r * 0.42, 5, C.honey)
          })
        }
        // body + dial
        K.paper(ctx, K.ellipsePts(0, 0, r, r, 40), color, { cut: 1.2, seed: id + 'body', shadow: 1.1, lift: 4 })
        K.paper(ctx, K.ellipsePts(0, 0, r * 0.78, r * 0.78, 36), C.cream, { cut: 0.8, seed: id + 'dial', shadow: 0.5 })
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * TAU
          dot(ctx, Math.cos(a) * r * 0.66, Math.sin(a) * r * 0.66, k % 3 === 0 ? 3.4 : 2, 'rgba(42,34,26,0.6)')
        }
        // hands
        const hA = ((time % 12) / 12) * TAU - Math.PI / 2
        const mA = ((time % 1) * TAU) - Math.PI / 2
        jseg(ctx, 0, 0, Math.cos(hA) * r * 0.36, Math.sin(hA) * r * 0.36, id + 'hh', t, { w: 6, amp: 0.5 })
        jseg(ctx, 0, 0, Math.cos(mA) * r * 0.56, Math.sin(mA) * r * 0.56, id + 'mh', t, { w: 4, amp: 0.5 })
        dot(ctx, 0, 0, 5.5, C.terracotta)
        // cute face
        const ex = r * 0.3
        const ey = -r * 0.16
        if (R > 0.3) {
          for (const s of [-1, 1]) {
            jpoly(ctx, [[s * ex - s * 8, ey - 7], [s * ex + s * 2, ey], [s * ex - s * 8, ey + 7]], id + 'sq' + s, t, { w: 3.6, amp: 0.4 })
          }
        } else {
          for (const s of [-1, 1]) {
            dot(ctx, s * ex, ey, 6, C.ink)
            dot(ctx, s * ex - 2, ey - 2.4, 2, '#fff')
          }
        }
        K.cheek(ctx, -r * 0.46, r * 0.14, r * 0.17)
        K.cheek(ctx, r * 0.46, r * 0.14, r * 0.17)
        if (R > 0.3) {
          ctx.save()
          ctx.beginPath()
          ctx.ellipse(r * 0.12, r * 0.4, r * 0.1, r * 0.13, 0, 0, TAU)
          ctx.fillStyle = '#6b2f1c'
          ctx.fill()
          ctx.beginPath()
          ctx.ellipse(r * 0.12, r * 0.47, r * 0.06, r * 0.04, 0, 0, TAU)
          ctx.fillStyle = C.coral
          ctx.fill()
          ctx.restore()
        } else {
          K.pencil.arc(ctx, r * 0.12, r * 0.34, r * 0.2, r * 0.14, 0.1 * Math.PI, 0.9 * Math.PI, id + 'mo', t, { strokeWidth: 3.2, roughness: 0.5 })
        }
        // ringing: vibration arcs beside the bells (arcs, never rays)
        if (R > 0) {
          K.withAlpha(ctx, R, () => {
            for (const s of [-1, 1]) {
              const a = -Math.PI / 2 + s * 0.72
              const bx = Math.cos(a) * r * 1.1
              const by = Math.sin(a) * r * 1.1
              for (const k of [0, 1]) {
                const rr = r * (0.55 + k * 0.17) + (fr % 2) * 3
                jpoly(ctx, arcPts(bx, by, rr, a - 0.42, a + 0.42, 6), id + 'vb' + s + k, t, { color: arcColor, w: 3.6, amp: 0.8 })
              }
            }
          })
        }
        out.centre = m(0, 0)
        out.top = m(0, -r * 1.42)
        // "reset" tag hanging from the key
        if (tag) {
          const ang = 0.08 * Math.sin(t * 1.8) + R * 0.28 * sgn
          out.tag = m(...hangTag(ctx, kx + 30, ky + 22, 40, ang, [String(tag)], t, id + 'tag', { size: tagSize }))
        }
      })
      return out
    })
  }

  function teacup(ctx, x, y, t = 0, o = {}) {
    const { r = 34, color = C.pink, steam: st = 1, saucer = true, tilt = 0, id = 'teacup' } = o
    return place(ctx, x, y, o, (m) => {
      if (saucer) K.paper(ctx, K.ellipsePts(0, r * 0.66, r * 1.6, r * 0.3, 28), C.cream, { cut: 0.8, seed: id + 'sc', shadow: 0.9 })
      let rim
      K.at(ctx, 0, 0, tilt, 1, () => {
        // handle
        ctx.save()
        ctx.lineWidth = r * 0.2
        ctx.strokeStyle = K.paperPattern(ctx, color)
        ctx.beginPath()
        ctx.ellipse(r * 0.98, -r * 0.08, r * 0.3, r * 0.32, 0, 0, TAU)
        ctx.stroke()
        ctx.restore()
        const top = -r * 0.5
        const bowl = [[-r, top], [r, top], ...arcPts(0, top, r, 0, Math.PI, 16).map(([px, py]) => [px, top + (py - top) * 1.05])]
        K.paper(ctx, bowl, color, { cut: 0.6, seed: id + 'cup', shadow: 0.8, lift: 1 })
        ctx.save()
        ctx.beginPath()
        ctx.ellipse(0, top + 1, r * 0.92, r * 0.13, 0, 0, TAU)
        ctx.fillStyle = '#b8743c'
        ctx.fill()
        ctx.restore()
        const pr = K.rng('dots', id)
        for (let k = 0; k < 5; k++) dot(ctx, -r * 0.6 + k * r * 0.3, top + r * (0.35 + (k % 2) * 0.28) + pr() * 3, r * 0.07, 'rgba(255,250,240,0.85)')
        // teabag string + tiny tag over the rim
        jseg(ctx, r * 0.35, top, r * 0.62, top + r * 0.5, id + 'tb', t, { color: C.paperWhite, w: 1.5, amp: 0.3 })
        K.paper(ctx, K.rectPts(r * 0.5, top + r * 0.48, r * 0.26, r * 0.3), C.sage, { cut: 0.3, seed: id + 'tt', shadow: 0.5 })
        rim = m(0, top)
      })
      if (st > 0) steam(ctx, 0, -r * 0.62, r * 1.9, t, id + 'st', { n: 2, spread: r * 0.4, amp: r * 0.16, w: Math.max(2.4, r * 0.09), alpha: 0.8 * st })
      return { rim }
    })
  }

  function doneStack(ctx, x, y, t = 0, o = {}) {
    const { n = 4, stamped = 0, w = 230, h = 150, step = 60, color = C.paperWhite, id = 'done', stampColor = C.terracotta } = o
    return place(ctx, x, y, o, (m) => {
      const cards = []
      for (let i = 0; i < n; i++) {
        const r = K.rng(id, 'card', i)
        const cx = (r() - 0.5) * 22
        const cy = -i * step
        const rot = (r() - 0.5) * 0.09
        const s = K.clamp(stamped - i, 0, 1)
        // the card being stamped squashes on the thunk
        const thunk = s > 0 && s < 1 ? Math.sin(K.seg(s, 0.3, 0.6) * Math.PI) : 0
        K.at(ctx, cx, cy + thunk * 3, rot, [1 + thunk * 0.015, 1 - thunk * 0.03], () => {
          K.paper(ctx, K.boxPts(w, h), color, { cut: 1.1, seed: id + 'c' + i, shadow: 1, lift: 2 })
          // ruled lines + margin
          ctx.save()
          ctx.strokeStyle = 'rgba(134,194,227,0.55)'
          ctx.lineWidth = 1.6
          ctx.beginPath()
          for (let k = 1; k <= 4; k++) {
            ctx.moveTo(-w / 2 + 6, -h / 2 + 16 + k * 26)
            ctx.lineTo(w / 2 - 6, -h / 2 + 16 + k * 26)
          }
          ctx.stroke()
          ctx.strokeStyle = 'rgba(184,92,52,0.5)'
          ctx.beginPath()
          ctx.moveTo(-w / 2 + 26, -h / 2 + 4)
          ctx.lineTo(-w / 2 + 26, h / 2 - 4)
          ctx.stroke()
          ctx.restore()
          // checkbox scribbles (visible upper part is covered by the next card; the top card shows all)
          for (let k = 0; k < 3; k++) {
            const ry = -h / 2 + 30 + k * 26
            jpoly(ctx, K.rectPts(-w / 2 + 34, ry - 8, 13, 13), id + 'bx' + i + k, t, { color: C.inkDim, w: 2, amp: 0.5, closed: true })
            if (s >= 0.3) jpoly(ctx, [[-w / 2 + 34, ry - 3], [-w / 2 + 40, ry + 4], [-w / 2 + 52, ry - 13]], id + 'ok' + i + k, t, { color: '#4f9a3a', w: 3.4, amp: 0.5 })
            const wl = w * (0.5 - r() * 0.2)
            jpoly(ctx, [[-w / 2 + 56, ry], [-w / 2 + 56 + wl * 0.33, ry - 3], [-w / 2 + 56 + wl * 0.66, ry + 2], [-w / 2 + 56 + wl, ry - 1]], id + 'sc' + i + k, t, { color: C.inkFaint, w: 2.4, amp: 0.8 })
          }
          // DONE stamp (lower strip stays visible under the next card)
          if (s > 0) {
            const hit = K.seg(s, 0, 0.35)
            const sc = 1 + 0.45 * (1 - K.ease.outBack(hit))
            const alpha = K.seg(s, 0.2, 0.4)
            const srot = (i % 2 ? 0.1 : -0.12) + (r() - 0.5) * 0.06
            K.at(ctx, w * 0.12, h * 0.24, srot, sc, () => {
              inkStamp(ctx, 'DONE', 124, 46, stampColor, id + 'st' + i, { alpha: 0.92 * alpha, bg: color })
              // thunk: four short ticks flicking off the stamp's corners
              const pf = K.seg(s, 0.3, 0.85)
              if (pf > 0 && pf < 1) {
                K.withAlpha(ctx, 1 - pf, () => {
                  for (const [qx, qy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
                    const bx = qx * (70 + pf * 10)
                    const by = qy * (30 + pf * 8)
                    jseg(ctx, bx, by, bx + qx * 14, by + qy * 9, id + 'tk' + i + qx + qy, t, { color: stampColor, w: 3.2, amp: 0.5 })
                  }
                })
              }
            })
          }
        })
        cards.push(m(cx, cy))
      }
      return { cards, top: cards[cards.length - 1] || m(0, 0) }
    })
  }

  function tally(ctx, x, y, t = 0, o = {}) {
    const { count = 4, p = 1, label = 'Done today', paper = true, id = 'tally', color = C.terracotta } = o
    const size = 48
    K.font(ctx, 'hand', size)
    const tw = ctx.measureText(label).width
    const groups = Math.ceil(count / 5)
    const marksW = groups * 96 - 16
    const W = tw + marksW + 90
    const H = 118
    return place(ctx, x, y, o, (m) => {
      if (paper) K.paper(ctx, K.boxPts(W, H), C.cream, { torn: 3, seed: id + 'scrap', shadow: 0.95, lift: 2 })
      const lx = -W / 2 + 32
      K.hand(ctx, label, lx, 16, { family: 'hand', size, align: 'left', t, id: id + 'lbl', jitter: 0.6, reveal: K.seg(p, 0, 0.4) })
      let endX = lx + tw
      const mx0 = lx + tw + 30
      for (let k = 0; k < count; k++) {
        const kp = K.seg(p, 0.4 + (k / count) * 0.6, 0.4 + ((k + 1) / count) * 0.6)
        if (kp <= 0) continue
        const g = Math.floor(k / 5)
        const j = k % 5
        const gx = mx0 + g * 96
        let x1
        let y1
        let x2
        let y2
        if (j < 4) {
          x1 = gx + j * 18
          y1 = -24
          x2 = x1 + 2
          y2 = 30
        } else {
          x1 = gx - 10
          y1 = 22
          x2 = gx + 68
          y2 = -16
        }
        K.pencil.line(ctx, x1, y1, K.lerp(x1, x2, kp), K.lerp(y1, y2, kp), id + 'm' + k, t, { stroke: color, strokeWidth: 6, roughness: 1.3, bowing: 0.8 })
        endX = Math.max(endX, K.lerp(x1, x2, kp))
      }
      return { end: m(endX, 0) }
    })
  }

  window.PROPS = window.PROPS || {}
  Object.assign(window.PROPS, {
    nightBlind,
    moonOnThread,
    paperSun,
    conveyor,
    slotBoxes,
    gauge,
    hangingSign,
    laptop,
    alarmClock,
    teacup,
    doneStack,
    tally,
  })
})()

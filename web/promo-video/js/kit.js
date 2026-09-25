/* kit.js — the paper-collage drawing kit every scene draws with.
 *
 * Law: every draw is a PURE function of time. No state survives between frames,
 * so the renderer can draw any frame, in any order, on any worker. All
 * randomness comes from K.rng(...keys), seeded by stable keys (+ K.boil(t) when
 * a line should "boil" like stop-motion pencil).
 *
 * Coordinates: a fixed 1920x1080 stage. Shapes are polygons (arrays of [x, y])
 * built around a LOCAL origin and placed with K.at(), so paper grain travels
 * with the piece instead of sliding through it.
 */
(function () {
  'use strict'

  const W = 1920
  const H = 1080
  const ANIM_FPS = 15 // motion advances in stop-motion steps
  const BOIL_FPS = 7.5 // pencil lines re-jitter this often

  // ---------- randomness ----------
  function hash(...keys) {
    let h = 2166136261 >>> 0
    for (const k of keys) {
      const s = String(k)
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 16777619) >>> 0
      }
      h ^= 0x9e3779b9
      h = Math.imul(h, 16777619) >>> 0
    }
    return h >>> 0
  }
  function mulberry32(a) {
    return function () {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  /** rng(...keys) → () => [0,1). Same keys, same sequence. */
  const rng = (...keys) => mulberry32(hash(...keys))
  /** Integer seed for rough.js (must be > 0). */
  const seedOf = (...keys) => (hash(...keys) % 2147483646) + 1

  // ---------- time ----------
  const quant = (t) => Math.floor(t * ANIM_FPS + 1e-6) / ANIM_FPS
  const boil = (t) => Math.floor(t * BOIL_FPS + 1e-6)

  // ---------- math + easing ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
  const clamp01 = (v) => clamp(v, 0, 1)
  const lerp = (a, b, p) => a + (b - a) * p
  /** 0→1 progress of t through [a, b]. */
  const seg = (t, a, b) => clamp01((t - a) / (b - a))
  const ease = {
    linear: (p) => p,
    inQuad: (p) => p * p,
    outQuad: (p) => 1 - (1 - p) * (1 - p),
    inOutQuad: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    inCubic: (p) => p * p * p,
    outBack: (p) => {
      const c1 = 1.70158
      const c3 = c1 + 1
      return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
    },
    outElastic: (p) => {
      if (p === 0 || p === 1) return p
      return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
    },
    outBounce: (p) => {
      const n1 = 7.5625
      const d1 = 2.75
      if (p < 1 / d1) return n1 * p * p
      if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75
      if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375
      return n1 * (p -= 2.625 / d1) * p + 0.984375
    },
  }
  /** Springy 0→1 (overshoots) starting at t0. */
  function spring(t, t0, { freq = 14, damp = 7 } = {}) {
    const x = t - t0
    if (x <= 0) return 0
    return 1 - Math.exp(-damp * x) * Math.cos(freq * x)
  }
  /** Pop-in scale: 0 before t0, overshoot to 1 over dur. */
  function pop(t, t0, dur = 0.45) {
    if (t <= t0) return 0
    return ease.outBack(clamp01((t - t0) / dur))
  }
  /** 1D smooth value noise in [-1, 1]. */
  function noise1(x, ...keys) {
    const i = Math.floor(x)
    const f = x - i
    const a = rng(...keys, i)() * 2 - 1
    const b = rng(...keys, i + 1)() * 2 - 1
    const u = f * f * (3 - 2 * f)
    return a + (b - a) * u
  }
  /** Tiny stop-motion hand-nudge: pieces shift a hair every boil frame. */
  function nudge(id, t, amp = 1) {
    const r = rng('nudge', id, boil(t))
    return { dx: (r() - 0.5) * 2.2 * amp, dy: (r() - 0.5) * 2.2 * amp, rot: (r() - 0.5) * 0.012 * amp }
  }

  // ---------- palette (construction paper) ----------
  // Brand "Almanac" palette from the app (tailwind.config.js) + a few brighter
  // construction-paper accents for whimsy. Prefer the brand names.
  const C = {
    // brand
    paper: '#f6efe1', // app background
    paperHi: '#fbf6ec',
    kraftLight: '#efe6d3', // bg-elev: desk
    ink: '#2a221a', // pencil / text
    inkDim: '#5b4a36', // pencil limbs, secondary lines
    inkFaint: '#8a7a60',
    terracotta: '#b85c34', // THE accent
    peach: '#e8a988', // accent-muted
    sage: '#6f7d52',
    butter: '#e4b85a',
    honey: '#d3a23c',
    hiveTeal: '#4f7d72',
    line: '#e0d3b8',
    // playful accents
    cream: '#fbf4e4',
    paperWhite: '#fffaf0',
    kraft: '#d9b98c',
    kraftDark: '#b8905e',
    tomato: '#e0694a',
    coral: '#f0997c',
    mustard: '#f0bf4c',
    lemon: '#f7de8a',
    teal: '#3f9990',
    mint: '#a9d6bf',
    sky: '#86c2e3',
    blue: '#5a82c4',
    lilac: '#b9a6dc',
    pink: '#f2a9c0',
    grass: '#8cbf6a',
    termBlack: '#24201c', // black construction paper (terminals)
    crayonGreen: '#7ed36b', // terminal prompt crayon
    night: '#24324a', // night sky blind
    nightDeep: '#1a2438',
    moon: '#f5e3a3',
  }
  const PAPER_COLORS = [C.terracotta, C.butter, C.sage, C.hiveTeal, C.peach, C.honey, C.sky, C.pink, C.cream, C.mint]

  // ---------- paper textures ----------
  const texCache = new Map()
  let grainCanvas = null
  function mkCanvas(w, h) {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  function grain() {
    if (grainCanvas) return grainCanvas
    const S = 384
    const c = mkCanvas(S, S)
    const g = c.getContext('2d')
    const img = g.createImageData(S, S)
    const r = rng('grain')
    for (let i = 0; i < S * S; i++) {
      const v = 228 + r() * 27
      img.data[i * 4] = v
      img.data[i * 4 + 1] = v - 2
      img.data[i * 4 + 2] = v - 6
      img.data[i * 4 + 3] = 255
    }
    g.putImageData(img, 0, 0)
    // fibres
    for (let k = 0; k < 260; k++) {
      const x = r() * S
      const y = r() * S
      const a = r() * Math.PI * 2
      const len = 6 + r() * 26
      g.strokeStyle = r() < 0.5 ? 'rgba(90,70,40,0.10)' : 'rgba(255,255,255,0.35)'
      g.lineWidth = 0.6 + r() * 0.8
      g.beginPath()
      g.moveTo(x, y)
      g.quadraticCurveTo(x + Math.cos(a + 0.6) * len * 0.5, y + Math.sin(a + 0.6) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len)
      g.stroke()
    }
    grainCanvas = c
    return c
  }
  /** A repeating CanvasPattern of `color` construction paper. */
  function paperPattern(ctx, color) {
    let tex = texCache.get(color)
    if (!tex) {
      const gc = grain()
      tex = mkCanvas(gc.width, gc.height)
      const g = tex.getContext('2d')
      g.fillStyle = color
      g.fillRect(0, 0, tex.width, tex.height)
      g.globalCompositeOperation = 'multiply'
      g.drawImage(gc, 0, 0)
      g.globalCompositeOperation = 'source-over'
      texCache.set(color, tex)
    }
    return ctx.createPattern(tex, 'repeat')
  }

  // ---------- polygons ----------
  const rectPts = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
  /** Rect centred on local origin. */
  const boxPts = (w, h) => rectPts(-w / 2, -h / 2, w, h)
  function roundRectPts(x, y, w, h, r, steps = 5) {
    r = Math.min(r, w / 2, h / 2)
    const pts = []
    const corner = (cx, cy, a0) => {
      for (let i = 0; i <= steps; i++) {
        const a = a0 + (i / steps) * (Math.PI / 2)
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
      }
    }
    corner(x + w - r, y + r, -Math.PI / 2)
    corner(x + w - r, y + h - r, 0)
    corner(x + r, y + h - r, Math.PI / 2)
    corner(x + r, y + r, Math.PI)
    return pts
  }
  function ellipsePts(cx, cy, rx, ry, n = 36) {
    const pts = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
    }
    return pts
  }
  function starPts(cx, cy, r1, r2, n = 5, rot = -Math.PI / 2) {
    const pts = []
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 ? r2 : r1
      const a = rot + (i / (n * 2)) * Math.PI * 2
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
    return pts
  }
  /** Resample a closed polygon so no edge is longer than `step`. */
  function resample(pts, step) {
    const out = []
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i]
      const [x1, y1] = pts[(i + 1) % pts.length]
      const d = Math.hypot(x1 - x0, y1 - y0)
      const n = Math.max(1, Math.ceil(d / step))
      for (let k = 0; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n])
    }
    return out
  }
  function centroid(pts) {
    let x = 0
    let y = 0
    for (const p of pts) {
      x += p[0]
      y += p[1]
    }
    return [x / pts.length, y / pts.length]
  }
  /** Scissor-cut wobble: low-frequency radial wiggle (hand-cut, not machine). */
  function wobble(pts, amp, ...keys) {
    const rs = resample(pts, 18)
    const [cx, cy] = centroid(rs)
    return rs.map(([x, y], i) => {
      const n = noise1(i * 0.35, 'wob', ...keys) * amp
      const dx = x - cx
      const dy = y - cy
      const d = Math.hypot(dx, dy) || 1
      return [x + (dx / d) * n, y + (dy / d) * n]
    })
  }
  /** Torn-paper edge: high-frequency jags perpendicular to each edge. */
  function tear(pts, amp, ...keys) {
    const rs = resample(pts, 7)
    const r = rng('tear', ...keys)
    const [cx, cy] = centroid(rs)
    let drift = 0
    return rs.map(([x, y]) => {
      drift = drift * 0.6 + (r() - 0.5) * amp * 1.4
      const dx = x - cx
      const dy = y - cy
      const d = Math.hypot(dx, dy) || 1
      return [x + (dx / d) * drift, y + (dy / d) * drift]
    })
  }
  /** Grow a polygon outward from its centroid by `px`. */
  function grow(pts, px) {
    const [cx, cy] = centroid(pts)
    return pts.map(([x, y]) => {
      const dx = x - cx
      const dy = y - cy
      const d = Math.hypot(dx, dy) || 1
      return [x + (dx / d) * px, y + (dy / d) * px]
    })
  }
  function pathPoly(ctx, pts) {
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
    ctx.closePath()
  }

  // ---------- placement ----------
  /** Draw `fn` in a local frame at (x, y), rotated `rot` rad, scaled `s`. */
  function at(ctx, x, y, rot, s, fn) {
    ctx.save()
    ctx.translate(x, y)
    if (rot) ctx.rotate(rot)
    if (s !== undefined && s !== 1) {
      if (Array.isArray(s)) ctx.scale(s[0], s[1])
      else ctx.scale(s, s)
    }
    fn(ctx)
    ctx.restore()
  }
  function withAlpha(ctx, a, fn) {
    ctx.save()
    ctx.globalAlpha *= a
    fn(ctx)
    ctx.restore()
  }

  // ---------- shadows (fake, fast) ----------
  // ctx.shadowBlur is ~10x the cost of the whole frame in headless Chromium, so
  // layered-paper depth is faked with two offset translucent fills: a crisp
  // contact shadow plus a wider, fainter penumbra. Never use shadowBlur/filter.
  function dropShadow(ctx, pts, strength = 1, lift = 0) {
    if (strength <= 0) return
    const ox = 3 + lift * 0.5
    const oy = 5 + lift
    ctx.save()
    ctx.translate(ox * 1.7, oy * 1.7)
    pathPoly(ctx, pts)
    ctx.fillStyle = `rgba(58,36,14,${0.07 * strength})`
    ctx.fill()
    ctx.translate(-ox * 0.8, -oy * 0.8)
    pathPoly(ctx, pts)
    ctx.fillStyle = `rgba(58,36,14,${0.13 * strength})`
    ctx.fill()
    ctx.translate(-ox * 0.5, -oy * 0.5)
    pathPoly(ctx, pts)
    ctx.fillStyle = `rgba(58,36,14,${0.1 * strength})`
    ctx.fill()
    ctx.restore()
  }
  function circleShadow(ctx, x, y, r, strength = 1, lift = 0) {
    dropShadow(ctx, ellipsePts(x, y, r, r, 28), strength, lift)
  }

  // ---------- the paper cut-out ----------
  /**
   * paper(ctx, pts, color, opts) — a piece of construction paper.
   *   torn:   0 = scissor-cut, >0 = torn edge jag amplitude (px) with white fibre rim
   *   cut:    scissor wobble amplitude (px) (default 2.5)
   *   shadow: 0..1 drop-shadow strength (layered-paper depth; default 1)
   *   lift:   extra shadow offset (px) — pieces "held up" cast longer shadows
   *   stroke: optional pencil outline colour
   */
  function paper(ctx, pts, color, opts = {}) {
    const { torn = 0, cut = 2.5, shadow = 1, lift = 0, stroke = null, seed = 'p', grainOn = true } = opts
    let shape = torn ? tear(pts, torn, seed) : cut ? wobble(pts, cut, seed) : pts
    ctx.save()
    let rim = null
    if (torn) rim = tear(grow(pts, torn * 0.9 + 2), torn * 0.8, seed, 'rim')
    if (shadow > 0) dropShadow(ctx, rim || shape, shadow, lift)
    if (rim) {
      // white fibre rim that shows where paper tore
      pathPoly(ctx, rim)
      ctx.fillStyle = grainOn ? paperPattern(ctx, C.paperWhite) : C.paperWhite
      ctx.fill()
    }
    pathPoly(ctx, shape)
    ctx.fillStyle = grainOn ? paperPattern(ctx, color) : color
    ctx.fill()
    if (stroke) {
      ctx.lineWidth = 2.2
      ctx.strokeStyle = stroke
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
    ctx.restore()
    return shape
  }
  /** Fill without paper edges (e.g., inside a cut-out window). */
  function flat(ctx, pts, color) {
    pathPoly(ctx, pts)
    ctx.fillStyle = paperPattern(ctx, color)
    ctx.fill()
  }

  /** A strip of washi tape centred at (x, y). */
  function tape(ctx, x, y, w, rot, color = 'rgba(244,193,69,0.78)', opts = {}) {
    const h = opts.h || 38
    const seed = opts.seed || 'tape'
    at(ctx, x, y, rot, 1, () => {
      const r = rng('tape', seed)
      // long straight edges, zig-zag torn short ends
      const teeth = 7
      const poly = [[-w / 2, -h / 2], [w / 2, -h / 2]]
      for (let i = 1; i < teeth; i++) poly.push([w / 2 + (i % 2 ? -5 : 3) + (r() - 0.5) * 3, -h / 2 + (i / teeth) * h])
      poly.push([w / 2, h / 2], [-w / 2, h / 2])
      for (let i = teeth - 1; i > 0; i--) poly.push([-w / 2 + (i % 2 ? 5 : -3) + (r() - 0.5) * 3, -h / 2 + (i / teeth) * h])
      ctx.save()
      ctx.translate(1, 2)
      pathPoly(ctx, poly)
      ctx.fillStyle = 'rgba(58,36,14,0.1)'
      ctx.fill()
      ctx.translate(-1, -2)
      pathPoly(ctx, poly)
      ctx.fillStyle = color
      ctx.fill()
      // printed pattern: diagonal stripes or dots
      ctx.clip()
      ctx.globalAlpha = 0.28
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 6
      if (opts.pattern === 'dots') {
        ctx.fillStyle = '#fff'
        for (let px = -w / 2 + 10; px < w / 2; px += 18) for (let py = -h / 2 + 9; py < h / 2; py += 18) {
          ctx.beginPath()
          ctx.arc(px, py, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      } else {
        for (let px = -w; px < w; px += 22) {
          ctx.beginPath()
          ctx.moveTo(px, -h)
          ctx.lineTo(px + h * 2, h)
          ctx.stroke()
        }
      }
      ctx.restore()
    })
  }

  // ---------- pencil / crayon lines (rough.js) ----------
  const rcCache = new WeakMap()
  function rc(ctx) {
    let r = rcCache.get(ctx.canvas)
    if (!r) {
      r = window.rough.canvas(ctx.canvas)
      // rough draws on canvas.getContext('2d') — the same ctx, current transform honoured
      rcCache.set(ctx.canvas, r)
    }
    return r
  }
  /** rough.js options with a boiling seed + pencil defaults. */
  function ro(id, t, o = {}) {
    return Object.assign(
      {
        seed: seedOf(id, t === null ? 0 : boil(t)),
        roughness: 1.3,
        bowing: 1.2,
        stroke: C.ink,
        strokeWidth: 3,
        fillStyle: 'hachure',
        fillWeight: 2,
        hachureGap: 9,
      },
      o
    )
  }
  const pencil = {
    line: (ctx, x1, y1, x2, y2, id, t, o) => rc(ctx).line(x1, y1, x2, y2, ro(id, t, o)),
    rect: (ctx, x, y, w, h, id, t, o) => rc(ctx).rectangle(x, y, w, h, ro(id, t, o)),
    circle: (ctx, x, y, d, id, t, o) => rc(ctx).circle(x, y, d, ro(id, t, o)),
    ellipse: (ctx, x, y, w, h, id, t, o) => rc(ctx).ellipse(x, y, w, h, ro(id, t, o)),
    poly: (ctx, pts, id, t, o) => rc(ctx).polygon(pts, ro(id, t, o)),
    curve: (ctx, pts, id, t, o) => rc(ctx).curve(pts, ro(id, t, o)),
    path: (ctx, d, id, t, o) => rc(ctx).path(d, ro(id, t, o)),
    arc: (ctx, x, y, w, h, a0, a1, id, t, o) => rc(ctx).arc(x, y, w, h, a0, a1, false, ro(id, t, o)),
  }
  /** Hand-drawn arrow from (x1,y1) to (x2,y2) with a curved shaft. */
  function arrow(ctx, x1, y1, x2, y2, id, t, o = {}) {
    const bend = o.bend === undefined ? 0.2 : o.bend
    const mx = (x1 + x2) / 2 - (y2 - y1) * bend
    const my = (y1 + y2) / 2 + (x2 - x1) * bend
    const draw = o.progress === undefined ? 1 : o.progress
    if (draw <= 0) return
    // sample the quadratic curve up to `draw`
    const pts = []
    const N = 12
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * draw
      const x = (1 - s) * (1 - s) * x1 + 2 * (1 - s) * s * mx + s * s * x2
      const y = (1 - s) * (1 - s) * y1 + 2 * (1 - s) * s * my + s * s * y2
      pts.push([x, y])
    }
    pencil.curve(ctx, pts, id, t, o)
    if (draw >= 0.98) {
      const [ex, ey] = pts[pts.length - 1]
      const [px, py] = pts[pts.length - 3]
      const a = Math.atan2(ey - py, ex - px)
      const L = o.head || 22
      pencil.line(ctx, ex, ey, ex - Math.cos(a - 0.5) * L, ey - Math.sin(a - 0.5) * L, id + 'h1', t, o)
      pencil.line(ctx, ex, ey, ex - Math.cos(a + 0.5) * L, ey - Math.sin(a + 0.5) * L, id + 'h2', t, o)
    }
  }
  /** Little doodle sparkles/motion marks around a point. */
  function sparkle(ctx, x, y, r, id, t, o = {}) {
    const n = o.n || 4
    const rr = rng('spark', id)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rr() * 0.6
      const r1 = r * 0.75
      const r2 = r * (1.05 + rr() * 0.35)
      pencil.line(ctx, x + Math.cos(a) * r1, y + Math.sin(a) * r1, x + Math.cos(a) * r2, y + Math.sin(a) * r2, id + i, t, {
        stroke: o.color || C.ink,
        strokeWidth: o.w || 3.5,
        roughness: 0.8,
      })
    }
  }
  /** Scribbled 4-point star (hand-drawn twinkle). */
  function twinkle(ctx, x, y, r, id, t, color = C.mustard) {
    const pts = starPts(x, y, r, r * 0.38, 4)
    pencil.poly(ctx, pts, id, t, { fill: color, fillStyle: 'solid', stroke: C.ink, strokeWidth: 2.5, roughness: 1 })
  }

  // ---------- lettering ----------
  const FONTS = {
    hand: '"Patrick Hand", "Gochi Hand", cursive',
    marker: '"Gochi Hand", "Patrick Hand", cursive',
    script: '"Caveat", "Kalam", cursive',
    chunky: '"Fredoka", "Patrick Hand", sans-serif',
    kalam: '"Kalam", "Patrick Hand", cursive',
  }
  function font(ctx, family, size, weight = '') {
    ctx.font = `${weight ? weight + ' ' : ''}${size}px ${FONTS[family] || family}`
  }
  /**
   * Hand lettering with per-letter boil (letters wobble a hair each boil frame).
   * align: 'left' | 'center' | 'right'. reveal: 0..1 fraction of letters shown (typewriter).
   */
  function hand(ctx, str, x, y, o = {}) {
    const { family = 'hand', size = 48, color = C.ink, align = 'center', t = 0, id = str, jitter = 1, reveal = 1, weight = '', outline = null, outlineW = 8, spacing = 0 } = o
    font(ctx, family, size, weight)
    const widths = [...str].map((ch) => ctx.measureText(ch).width + spacing)
    const total = widths.reduce((a, b) => a + b, 0) - spacing
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x
    const show = Math.round(reveal * str.length)
    const b = boil(t)
    ctx.save()
    ctx.textBaseline = 'alphabetic'
    ;[...str].forEach((ch, i) => {
      if (i < show && ch !== ' ') {
        const r = rng('ltr', id, i, b)
        const dx = (r() - 0.5) * 2 * jitter
        const dy = (r() - 0.5) * 3 * jitter
        const rot = (r() - 0.5) * 0.06 * jitter
        ctx.save()
        ctx.translate(cx + widths[i] / 2 + dx, y + dy)
        ctx.rotate(rot)
        if (outline) {
          ctx.lineJoin = 'round'
          ctx.lineWidth = outlineW
          ctx.strokeStyle = outline
          ctx.strokeText(ch, -widths[i] / 2 + spacing / 2, 0)
        }
        ctx.fillStyle = color
        ctx.fillText(ch, -widths[i] / 2 + spacing / 2, 0)
        ctx.restore()
      }
      cx += widths[i]
    })
    ctx.restore()
    return total
  }
  /**
   * Ransom-note headline: every letter cut from a different scrap of paper.
   * appear: seconds between letters popping in, starting at t0.
   */
  function ransom(ctx, str, x, y, o = {}) {
    const { size = 90, t = 0, t0 = -99, appear = 0.05, id = str, colors = PAPER_COLORS, align = 'center', gap = 8 } = o
    const fams = ['chunky', 'marker', 'hand', 'kalam']
    const letters = [...str]
    const specs = letters.map((ch, i) => {
      const r = rng('ransom', id, i)
      const fam = fams[Math.floor(r() * fams.length)]
      const sz = size * (0.86 + r() * 0.26)
      font(ctx, fam, sz, fam === 'chunky' ? '600' : '')
      const w = ch === ' ' ? size * 0.35 : ctx.measureText(ch).width + sz * 0.3
      return { ch, fam, sz, w, bg: colors[Math.floor(r() * colors.length)], rot: (r() - 0.5) * 0.22, dy: (r() - 0.5) * size * 0.12, light: r() < 0.3 }
    })
    const total = specs.reduce((a, s) => a + s.w + gap, -gap)
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x
    specs.forEach((s, i) => {
      const sc = pop(t, t0 + i * appear, 0.35)
      if (s.ch !== ' ' && sc > 0) {
        const n = nudge(id + i, t, 0.6)
        at(ctx, cx + s.w / 2 + n.dx, y + s.dy + n.dy, s.rot + n.rot, sc, () => {
          const bgc = s.light ? C.paperWhite : s.bg
          paper(ctx, boxPts(s.w, s.sz * 1.08), bgc, { seed: id + 'r' + i, cut: 3, shadow: 0.8 })
          font(ctx, s.fam, s.sz, s.fam === 'chunky' ? '600' : '')
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = s.light ? ([C.butter, C.cream, C.lemon].includes(s.bg) ? C.ink : s.bg) : C.ink
          if (!s.light && [C.teal, C.tomato, C.blue, C.terracotta, C.sage, C.hiveTeal, C.night].includes(s.bg)) ctx.fillStyle = C.paperWhite
          ctx.fillText(s.ch, 0, s.sz * 0.04)
        })
      }
      cx += s.w + gap
    })
    return total
  }
  /** Torn paper label with hand text (sticker / caption / name tag). */
  function label(ctx, str, x, y, o = {}) {
    const { size = 40, family = 'hand', color = C.ink, bg = C.paperWhite, rot = 0, t = 0, id = str, padX = 24, padY = 14, torn = 0, scale = 1, tapeColor = null } = o
    font(ctx, family, size)
    const w = ctx.measureText(str).width + padX * 2
    const h = size + padY * 2
    at(ctx, x, y, rot, scale, () => {
      paper(ctx, boxPts(w, h), bg, { seed: id + 'lbl', torn, cut: torn ? 0 : 2, shadow: 0.8 })
      if (tapeColor) tape(ctx, 0, -h / 2, Math.min(w * 0.45, 120), -0.08, tapeColor, { h: 30, seed: id + 'tp' })
      hand(ctx, str, 0, size * 0.34, { family, size, color, t, id: id + 'txt', jitter: 0.7 })
    })
    return { w, h }
  }

  // ---------- speech bubble ----------
  function bubble(ctx, x, y, w, h, tail, o = {}) {
    const { color = C.paperWhite, seed = 'bub', scale = 1 } = o
    at(ctx, x, y, o.rot || 0, scale, () => {
      const body = ellipsePts(0, 0, w / 2, h / 2, 40)
      const [tx, ty] = tail // tail tip, relative
      const tailPts = [[-w * 0.08, h * 0.3], [tx, ty], [w * 0.1, h * 0.28]]
      ctx.save()
      const b = wobble(body, 3, seed)
      dropShadow(ctx, b, 0.9)
      ctx.beginPath()
      pathPoly(ctx, b)
      ctx.moveTo(tailPts[0][0], tailPts[0][1])
      ctx.lineTo(tailPts[1][0], tailPts[1][1])
      ctx.lineTo(tailPts[2][0], tailPts[2][1])
      ctx.closePath()
      ctx.fillStyle = paperPattern(ctx, color)
      ctx.fill('nonzero')
      ctx.restore()
    })
  }

  // ---------- eyes (the adorable part) ----------
  /**
   * googly(ctx, x, y, r, t, id, look) — a googly eye whose pupil lags and
   * jiggles. look: [lx, ly] in -1..1 (where the character is looking).
   */
  function googly(ctx, x, y, r, t, id, look = [0, 0], o = {}) {
    const { blink = true, pupil = 0.5 } = o
    // blink every few seconds (pure function of t)
    let lid = 0
    if (blink) {
      const period = 3.1 + (hash(id) % 100) / 60
      const ph = (t + (hash(id, 'b') % 100) / 37) % period
      if (ph < 0.14) lid = Math.sin((ph / 0.14) * Math.PI)
    }
    ctx.save()
    ctx.beginPath()
    ctx.arc(x + r * 0.06, y + r * 0.12, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(58,36,14,0.2)'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = '#fffdf7'
    ctx.fill()
    ctx.lineWidth = Math.max(2, r * 0.1)
    ctx.strokeStyle = C.ink
    ctx.stroke()
    // pupil with a lagging jiggle
    const jig = noise1(t * 3, 'jig', id) * 0.18
    const px = x + (look[0] + jig) * r * (1 - pupil) * 0.9
    const py = y + (look[1] + noise1(t * 3 + 9, 'jig', id) * 0.15) * r * (1 - pupil) * 0.9
    ctx.beginPath()
    ctx.arc(px, py, r * pupil, 0, Math.PI * 2)
    ctx.fillStyle = '#1d1b33'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(px - r * pupil * 0.35, py - r * pupil * 0.4, r * pupil * 0.28, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
    if (lid > 0) {
      ctx.beginPath()
      ctx.rect(x - r - 2, y - r - 2, r * 2 + 4, (r * 2 + 4) * lid)
      ctx.save()
      ctx.clip()
      ctx.beginPath()
      ctx.arc(x, y, r + 1, 0, Math.PI * 2)
      ctx.fillStyle = o.lidColor || C.butter
      ctx.fill()
      ctx.restore()
      if (lid > 0.6) {
        ctx.beginPath()
        ctx.arc(x, y - r * 0.2, r * 0.8, 0.25 * Math.PI, 0.75 * Math.PI)
        ctx.lineWidth = Math.max(2.5, r * 0.14)
        ctx.lineCap = 'round'
        ctx.strokeStyle = C.ink
        ctx.stroke()
      }
    }
    ctx.restore()
  }
  /** Rosy cheek dabs. */
  function cheek(ctx, x, y, r) {
    ctx.save()
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, 'rgba(240,110,120,0.55)')
    g.addColorStop(1, 'rgba(240,110,120,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
    ctx.restore()
  }

  // ---------- backgrounds ----------
  /** Large, non-repeating light/dark mottling across a full frame. */
  function mottle(g, key) {
    const r = rng('mottle', key)
    for (let k = 0; k < 26; k++) {
      const x = r() * W
      const y = r() * H
      const rad = 120 + r() * 320
      const dark = r() < 0.55
      const gr = g.createRadialGradient(x, y, 0, x, y, rad)
      gr.addColorStop(0, dark ? 'rgba(110,80,40,0.045)' : 'rgba(255,255,255,0.06)')
      gr.addColorStop(1, 'rgba(110,80,40,0)')
      g.fillStyle = gr
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2)
    }
  }
  let deskCache = null
  /** Full-frame craft-table background (cached — static). */
  function desk(ctx, color = C.kraftLight) {
    if (!deskCache || deskCache.color !== color) {
      const c = mkCanvas(W, H)
      const g = c.getContext('2d')
      g.fillStyle = paperPattern(g, color)
      g.fillRect(0, 0, W, H)
      mottle(g, 'desk')
      // faint dotted grid like a cutting mat / bullet journal
      g.fillStyle = 'rgba(43,42,76,0.09)'
      for (let x = 30; x < W; x += 48) for (let y = 30; y < H; y += 48) {
        g.beginPath()
        g.arc(x, y, 2.2, 0, Math.PI * 2)
        g.fill()
      }
      // vignette
      const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.05)
      v.addColorStop(0, 'rgba(90,60,30,0)')
      v.addColorStop(1, 'rgba(90,60,30,0.22)')
      g.fillStyle = v
      g.fillRect(0, 0, W, H)
      deskCache = { color, c }
    }
    ctx.drawImage(deskCache.c, 0, 0)
  }
  const bgCache = new Map()
  /** Full-frame plain paper background of any colour (cached). */
  function backdrop(ctx, color, o = {}) {
    const key = color + (o.dots ? 'd' : '') + (o.vignette === false ? 'nv' : '')
    let c = bgCache.get(key)
    if (!c) {
      c = mkCanvas(W, H)
      const g = c.getContext('2d')
      g.fillStyle = paperPattern(g, color)
      g.fillRect(0, 0, W, H)
      mottle(g, key)
      if (o.dots) {
        g.fillStyle = o.dotColor || 'rgba(255,255,255,0.12)'
        for (let x = 30; x < W; x += 48) for (let y = 30; y < H; y += 48) {
          g.beginPath()
          g.arc(x, y, 2.2, 0, Math.PI * 2)
          g.fill()
        }
      }
      if (o.vignette !== false) {
        const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.05)
        v.addColorStop(0, 'rgba(20,10,0,0)')
        v.addColorStop(1, 'rgba(20,10,0,0.25)')
        g.fillStyle = v
        g.fillRect(0, 0, W, H)
      }
      bgCache.set(key, c)
    }
    ctx.drawImage(c, 0, 0)
  }

  window.K = {
    W,
    H,
    ANIM_FPS,
    BOIL_FPS,
    C,
    PAPER_COLORS,
    hash,
    rng,
    seedOf,
    quant,
    boil,
    clamp,
    clamp01,
    lerp,
    seg,
    ease,
    spring,
    pop,
    noise1,
    nudge,
    mkCanvas,
    paperPattern,
    rectPts,
    boxPts,
    roundRectPts,
    ellipsePts,
    starPts,
    resample,
    centroid,
    wobble,
    tear,
    grow,
    pathPoly,
    at,
    withAlpha,
    paper,
    flat,
    dropShadow,
    circleShadow,
    tape,
    rc,
    ro,
    pencil,
    arrow,
    sparkle,
    twinkle,
    FONTS,
    font,
    hand,
    ransom,
    label,
    bubble,
    googly,
    cheek,
    desk,
    backdrop,
  }
})()

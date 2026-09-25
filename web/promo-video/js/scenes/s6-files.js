/* s6-files.js — scene 6: "Files sit right beside Claude: edit one, or toss it into chat."
 * Owner: scene s6. Contract: script/BRIEF.md §6. Pure function of (t, info): nothing survives between
 * frames; every beat is placed from info.wordAt / info.nextBeat (the VO sets the clock), with the
 * build-time timeline as fallback. Draws sensibly for t outside [0, dur] (clamped internal timeline).
 *
 * STORY (left → right: the File Explorer tree · the page · the cream chat bubble), one focal point per beat
 *   0      a gentle push-in on the tree growing out of its "File Explorer" pot     "Files …"
 *   beat   Pip drops onto the tip of the slide branch                               "… sit"
 *          Pip slides down the branch, zips down the trunk, flips out onto the desk "right"
 *   word   the cream chat bubble slides in from the right                           "beside"
 *   word   the chat bubble bounces hello                                            "Claude"
 *          THEN the cut-out hand plucks the "M" leaf; it flips into a folded notebook page and unfolds
 *   word   a hand-held pencil scribbles out a line …                                "edit"
 *   word   … and writes a better one; a postage stamp thumps "All changes saved"    "one"
 *   beat   a hand thunks the "Send to chat" rubber stamp onto the page and lifts away  "or"
 *   word   Pip folds it: tugs the page (corners flip in), pushes the left half over "toss"
 *          (hands riding its free edge), the wedge snaps and flies into Pip's hand as the wings open
 *   word   wind-up, release: the plane loops along a dotted pencil trail            "into chat"
 *   vo end the bubble gulps the plane (the file lands as an attachment chip) and does a satisfied bounce
 *   beat   Pip cheers, then hops right — it keeps moving right in screen space through the pan to s7
 * On-screen words: "File Explorer" (pot), "M" (sticker), "All changes saved" (postage stamp),
 * "Send to chat" (rubber stamp on the page + the plane's wing). Nothing else is lettered.
 *
 * The fold is drawn here (not by paperAirplane) until the half is over: the real notebook page (its tabs,
 * strike-out, rewrite, stamps) is clipped into the paperAirplane fold geometry, so nothing the viewer just
 * watched vanishes on "toss". At fold 0.6 (only the plain back of the folded half shows) it hands over to
 * PROPS.paperAirplane at the identical wedge placement for the snap + wings.
 */
;(function () {
  'use strict'
  const C = K.C
  const E = K.ease
  const { seg, clamp01, lerp, clamp } = K
  const TAU = Math.PI * 2

  // ───────────── layout (stage px) ─────────────
  const TREE = { x: 404, y: 512, s: 0.8 }
  const PAGE = { x: 1082, y: 548, s: 0.72, w: 560, h: 720 }
  // paperAirplane's page is 260 x 340 plane units; the notebook page maps onto it exactly
  const AP_HW = 130
  const AP_HH = 170
  const SAX = (PAGE.s * PAGE.w) / (2 * AP_HW) // ≈ 1.551
  const SAY = (PAGE.s * PAGE.h) / (2 * AP_HH) // ≈ 1.525
  const SA = SAX // uniform plane-unit scale used for the stamps
  const BUB = { x: 1628, y: 372, w: 520, h: 330 }
  const PIP_S = 0.8
  const GIVE_HX = 82 // 'give' pose: x of the hands' midpoint from Pip's ground point (scale 0.8, probed)
  const GIVE_HY = 100
  const EDGE0 = PAGE.x - AP_HW * SAX // the page's left edge
  const G = [Math.round(EDGE0 + 4 - GIVE_HX), 892] // Pip's spot at the page's lower-left corner
  const PUSH_S = 0.72 // share of the half-fold Pip pushes (to just shy of vertical); then it flops over
  const PUSH_FB = 0.46
  const G2 = [Math.round(PAGE.x - AP_HW * SAX * Math.cos(Math.PI * PUSH_FB) + 4 - GIVE_HX), 892] // throw spot
  const PLANE_WEDGE = 1.05 // plane scale when the wedge has snapped
  const PLANE_HAND = 0.58 // plane scale in Pip's hand
  const PLANE_LEG1 = 0.72 // first flight leg: big enough to read "Send to chat"
  const PLANE_FLY = 0.5
  // grip on the finished plane (plane-local, relative to its bbox centre (5,-60)): the keel's belly
  const GRIP = [-45, 96]
  // stamp overlay positions in plane-page units (both on the RIGHT half, below the corner flaps)
  const SEND_AT = [60, 6]
  const SAVED_AT = [63, 104]
  const RELEASE_ROT = -0.62 // the plane's heading in Pip's hand at the release frame
  // opening camera: framed in on the tree (push-in + offset right), easing out to the full set by ~1.6 s
  const ZOOM = { s: 0.12, x: TREE.x + 150, y: 520, off: 230, end: 1.6 }

  // ───────────── small math ─────────────
  const ring = (x, k = 8, w = 16) => (x <= 0 ? 0 : Math.exp(-k * x) * Math.cos(w * x))
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
  const mix = (a, b, p) => [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p]
  const rot2 = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)]
  function cumLen(pl) {
    const c = [0]
    for (let i = 1; i < pl.length; i++) c.push(c[i - 1] + Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]))
    return c
  }
  function along(pl, p) {
    const cum = cumLen(pl)
    const L = cum[cum.length - 1]
    const d = clamp01(p) * L
    let i = 1
    while (i < pl.length - 1 && cum[i] < d) i++
    const a = pl[i - 1]
    const b = pl[i]
    const k = clamp01((d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1))
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.atan2(b[1] - a[1], b[0] - a[0])]
  }
  /** Affine [a,b,c,d,e,f] (for ctx.transform) mapping triangle P onto triangle Q. */
  function triAffine(P, Q) {
    const [[x0, y0], [x1, y1], [x2, y2]] = P
    const det = x0 * (y1 - y2) - y0 * (x1 - x2) + (x1 * y2 - x2 * y1)
    if (Math.abs(det) < 1e-6) return [1, 0, 0, 1, 0, 0]
    const inv = [
      [(y1 - y2) / det, (y2 - y0) / det, (y0 - y1) / det],
      [(x2 - x1) / det, (x0 - x2) / det, (x1 - x0) / det],
      [(x1 * y2 - x2 * y1) / det, (x2 * y0 - x0 * y2) / det, (x0 * y1 - x1 * y0) / det],
    ]
    const sol = (v) => inv.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
    const [a, c, e] = sol([Q[0][0], Q[1][0], Q[2][0]])
    const [b, d, f] = sol([Q[0][1], Q[1][1], Q[2][1]])
    return [a, b, c, d, e, f]
  }
  /** Flat translucent fill (fold shading). */
  function shade(ctx, pts, color) {
    K.pathPoly(ctx, pts)
    ctx.fillStyle = color
    ctx.fill()
  }
  /** Cheap boiling pencil stroke (native canvas). */
  function ink(ctx, pl, id, t, o = {}) {
    if (!pl || pl.length < 2) return
    const b = K.boil(t)
    const w = o.w || 2.6
    const jit = o.jit === undefined ? 1.4 : o.jit
    ctx.save()
    const ga = ctx.globalAlpha
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = o.color || C.ink
    for (let pass = 0; pass < (o.passes || 2); pass++) {
      const r = K.rng('s6ink', id, b, pass)
      ctx.globalAlpha = ga * (o.alpha === undefined ? 0.85 : o.alpha) * (pass ? 0.5 : 1)
      ctx.lineWidth = pass ? w * 0.6 : w
      ctx.beginPath()
      pl.forEach((p, i) => {
        const x = p[0] + (r() - 0.5) * jit
        const y = p[1] + (r() - 0.5) * jit
        if (i) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      })
      if (o.closed) ctx.closePath()
      ctx.stroke()
    }
    ctx.restore()
  }

  // ───────────── the timeline (from the words) ─────────────
  function plan(info) {
    const wd = (s, fb) => (info && info.wordAt ? info.wordAt(s, fb) : fb)
    const nb = (x) => (info && info.nextBeat ? info.nextBeat(x) : x)
    const beat = (info && info.beat) || 0.58
    const files = wd('files', 0.45)
    const sit = wd('sit', 0.78)
    const beside = wd('beside', 1.34)
    const claude = wd('claude', 1.73)
    const edit = wd('edit', 2.53)
    const one = wd('one', 2.82)
    const toss = wd('toss', 3.35)
    const into = wd('into', 3.82)
    const voEnd = info && info.voEnd ? info.voEnd : 4.52
    const P = { beat }
    P.grow = [0, files + 0.6]
    // Pip's route is over before "Claude", so the hello and the pluck each get their own beat
    P.land1 = nb(sit - 0.1) // Pip lands on the slide branch tip, on the beat
    P.drop0 = P.land1 - 0.34
    P.slide = [P.land1 + 0.06, Math.max(P.land1 + 0.26, beside - 0.22)] // down the branch
    P.pole = [P.slide[1], P.slide[1] + 0.15] // down the trunk, hugging it
    P.arc = [P.pole[1] + 0.03, P.pole[1] + 0.33] // hop out of the pot with a forward flip
    P.bubIn = [beside - 0.24, beside + 0.12] // the chat bubble slides in from the right on "beside"
    P.hello = Math.max(claude, P.arc[1] + 0.08, P.bubIn[1] + 0.12)
    // hand A: pluck the M leaf (only after the hello), carry it, it flips into the folded page, unfold
    P.aIn = P.hello + 0.05
    P.pinch = P.aIn + 0.2
    P.pluck1 = P.pinch + 0.12
    P.carry1 = Math.max(P.pluck1 + 0.2, edit - 0.3)
    P.unfold1 = P.carry1 + 0.28
    P.aOut = [P.carry1 + 0.08, P.carry1 + 0.22] // up and away to the right before the pencil works
    // hand B: the pencil
    P.strike = [Math.max(P.carry1 + 0.12, edit - 0.1), 0]
    P.strike[1] = P.strike[0] + 0.2
    P.rewrite = [P.strike[1] + 0.08, Math.max(P.strike[1] + 0.3, one + 0.08)]
    P.bIn = P.strike[0] - 0.17
    P.bOut = [P.rewrite[1] - 0.02, P.rewrite[1] + 0.14]
    P.saved = P.rewrite[1] + 0.1 // postage stamp impact (after the pencil hand has cleared out)
    // hand C: rubber stamp "Send to chat" onto the page, on the beat; gone before the fold starts
    const sb = nb(P.saved + 0.08)
    P.send = sb <= P.saved + 0.34 ? sb : P.saved + 0.2
    P.cIn = P.send - 0.15
    P.cOut = [P.send + 0.02, P.send + 0.11]
    // Pip folds it (A corners · B left half over · C wedge snap · D wings open while it flies to Pip)
    const f0 = Math.max(toss - 0.06, P.cOut[1])
    P.grab = [P.cOut[0], f0]
    P.fA = [f0, f0 + 0.14]
    P.fB = [P.fA[1], P.fA[1] + 0.3]
    P.pushEnd = P.fB[0] + PUSH_S * (P.fB[1] - P.fB[0])
    P.fC = [P.fB[1], P.fB[1] + 0.13]
    P.fD = [P.fC[1], P.fC[1] + 0.13]
    P.swoop = P.fD
    P.throw0 = P.fD[0] // the wind-up starts as the finished plane flies into the hand
    P.q0 = 0
    P.release = Math.max(into + 0.02, P.throw0 + 0.28)
    P.rate = clamp((PIP.THROW_RELEASE - P.q0) / (P.release - P.throw0), 0.8, 1.35)
    P.release = P.throw0 + (PIP.THROW_RELEASE - P.q0) / P.rate
    P.land = Math.max(voEnd - 0.02, P.release + 0.46)
    P.flight = [P.release, P.land]
    P.hop1 = nb(P.land + 0.3)
    P.hop2 = P.hop1 + beat
    return P
  }
  /** The fold value paperAirplane would have at T (A 0–0.3, B 0.3–0.6, C 0.6–0.72, D 0.72–1). */
  function foldAt(T, P) {
    if (T < P.fA[0]) return 0
    if (T < P.fB[0]) return 0.3 * seg(T, P.fA[0], P.fA[1])
    if (T < P.fC[0]) return 0.3 + 0.3 * seg(T, P.fB[0], P.fB[1])
    if (T < P.fD[0]) return 0.6 + 0.12 * seg(T, P.fC[0], P.fC[1])
    return 0.72 + 0.28 * seg(T, P.fD[0], P.fD[1])
  }
  /** Half-fold progress 0..1 (k = cos(π·fb)): Pip pushes it to just shy of vertical, then it flops over. */
  function fbAt(T, P) {
    const s = seg(T, P.fB[0], P.fB[1])
    return s < PUSH_S ? PUSH_FB * E.inOutQuad(s / PUSH_S) : PUSH_FB + (1 - PUSH_FB) * E.inQuad((s - PUSH_S) / (1 - PUSH_S))
  }
  const edgeX = (k) => PAGE.x - AP_HW * SAX * k

  // ───────────── props drawn locally ─────────────
  /** The cream chat bubble (the s2 Chat face's bubble, without lettering): rounded rect, tail down-left,
   *  three bouncing dots. o.sx/o.sy squash about the bottom, o.dx/o.dy offset, o.attach 0..1 file chip. */
  function chatBubble(ctx, t, o) {
    const { w, h } = BUB
    const id = 's6bub'
    const sx = o.sx || 1
    const sy = o.sy || 1
    K.at(ctx, BUB.x + (o.dx || 0), BUB.y + h / 2 + (o.dy || 0), o.rot || 0, [sx, sy], () => {
      ctx.translate(0, -h / 2)
      const rr = K.roundRectPts(-w / 2, -h / 2, w, h, h * 0.42, 5)
      // tail on the bottom edge, pointing down-left toward the page
      const tail = [[-w * 0.16, h / 2], [-w * 0.4, h / 2 + 62], [-w * 0.33, h / 2]]
      const pts = rr.slice(0, 12).concat(tail).concat(rr.slice(12))
      const shape = K.paper(ctx, pts, C.cream, { cut: 1.6, shadow: 1, lift: 8 + (o.lift || 0), seed: id })
      ink(ctx, K.resample(shape, 22), id + 'o', t, { w: 3, alpha: 0.8, closed: true })
      K.tape(ctx, w * 0.4, -h * 0.5 + 6, 110, 0.5, 'rgba(232,169,136,0.85)', { h: 34, seed: id + 'tp' })
      // content: attachment chip (the file that flew in) + three dots
      const at = clamp01(o.attach || 0)
      const dotX = lerp(0, 64, E.outCubic(at))
      if (at > 0) {
        const sc = E.outBack(at)
        K.at(ctx, -104, 18, -0.08, sc * 1.05, () => {
          PROPS.fileLeaf(ctx, 0, 0, t, { kind: 'file', m: true, id: 's6chip', nudge: 0.3 })
        })
      }
      const dc = [C.terracotta, C.honey, C.sage]
      const speed = o.typing ? 12 : 7
      for (let i = 0; i < 3; i++) {
        const dy = -Math.max(0, Math.sin(t * speed - i * 0.95)) * (o.typing ? 16 : 11)
        const dx = dotX + (i - 1) * 40
        ctx.beginPath()
        ctx.arc(dx + 2, 32 + 3, 13, 0, TAU)
        ctx.fillStyle = 'rgba(58,36,14,0.16)'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(dx, 28 + dy, 13, 0, TAU)
        ctx.fillStyle = dc[i]
        ctx.fill()
        ctx.beginPath()
        ctx.arc(dx - 4, 23 + dy, 3.6, 0, TAU)
        ctx.fillStyle = 'rgba(255,250,235,0.7)'
        ctx.fill()
      }
    })
  }

  /** Perforated postage-stamp outline (w x h, centred). */
  function perfPts(w, h, r = 5.5, step = 17) {
    const pts = []
    const cs = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    for (let e = 0; e < 4; e++) {
      const [x0, y0] = cs[e]
      const [x1, y1] = cs[(e + 1) % 4]
      const len = Math.hypot(x1 - x0, y1 - y0)
      const n = Math.max(1, Math.round(len / step))
      const ux = (x1 - x0) / len
      const uy = (y1 - y0) / len
      for (let i = 0; i < n; i++) {
        const sx = x0 + (ux * len * i) / n
        const sy = y0 + (uy * len * i) / n
        pts.push([sx, sy])
        const mx = sx + (ux * len) / (2 * n)
        const my = sy + (uy * len) / (2 * n)
        for (let k = 0; k <= 6; k++) {
          const a = (Math.PI * k) / 6
          pts.push([mx - ux * r * Math.cos(a) - uy * r * Math.sin(a), my - uy * r * Math.cos(a) + ux * r * Math.sin(a)])
        }
      }
    }
    return pts
  }
  const PERF = perfPts(216, 150)
  /** Peach postage stamp "All changes / saved" (+ check, postmark), drawn at (x, y) in the current frame,
   *  sized by `s`. p 0..1: drops in, thumps at 0.3, postmark (ring + wavy cancel bars) 0.45–0.7. */
  function savedStamp(ctx, x, y, t, p, s) {
    if (p <= 0) return
    const id = 's6saved'
    const k1 = seg(p, 0, 0.3)
    const inAir = p < 0.3
    const sc = inAir ? lerp(1.8, 1, E.inCubic(k1)) : 1 - 0.08 * Math.sin(seg(p, 0.3, 0.6) * Math.PI) * (1 - seg(p, 0.3, 0.6))
    const sy = inAir ? 1 : 1 - 0.12 * Math.sin(seg(p, 0.3, 0.46) * Math.PI)
    const w = 216
    const h = 150
    K.withAlpha(ctx, Math.min(1, p * 6), () => {
      K.at(ctx, x, y, lerp(-0.42, -0.09, E.outCubic(k1)), [s * sc, s * sc * sy], () => {
        K.paper(ctx, PERF, C.peach, { seed: id + 'ps', cut: 0, shadow: 1, lift: inAir ? 30 * (1 - k1) : 0 })
        K.paper(ctx, K.rectPts(-w / 2 + 14, -h / 2 + 14, w - 28, h - 28), C.cream, { seed: id + 'pi', cut: 0.8, shadow: 0 })
        ink(ctx, K.rectPts(-w / 2 + 20, -h / 2 + 20, w - 40, h - 40), id + 'pb', t, { w: 1.6, alpha: 0.45, closed: true, passes: 1 })
        K.hand(ctx, 'All changes', 0, -6, { family: 'marker', size: 38, color: C.ink, t, id: id + 's1', jitter: 0.3 })
        K.hand(ctx, 'saved', -16, 36, { family: 'marker', size: 42, color: C.terracotta, t, id: id + 's2', jitter: 0.3 })
        ink(ctx, [[38, 22], [49, 35], [72, 4]], id + 'chk', t, { w: 5, color: C.sage, alpha: 0.95 })
        const pm = seg(p, 0.45, 0.7)
        if (pm > 0) {
          // postmark: a ring on the top-left corner + three wavy cancel bars trailing right, above the text
          ctx.save()
          ctx.globalAlpha *= 0.6 * pm
          ctx.strokeStyle = C.inkDim
          ctx.lineWidth = 2.6
          ctx.lineCap = 'round'
          const cx = -w / 2 + 6
          const cy = -h / 2 + 4
          ctx.beginPath()
          ctx.arc(cx, cy, 30, 0, TAU)
          ctx.stroke()
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.arc(cx, cy, 22, 0, TAU)
          ctx.stroke()
          ctx.lineWidth = 2.6
          const len = 150 * pm
          for (let i = 0; i < 3; i++) {
            ctx.beginPath()
            for (let sx = 0; sx <= 14; sx++) {
              const xx = cx + 38 + (sx / 14) * len
              const yy = cy - 14 + i * 12 + Math.sin(sx * 0.95 + i * 0.6) * 3.6
              if (sx) ctx.lineTo(xx, yy)
              else ctx.moveTo(xx, yy)
            }
            ctx.stroke()
          }
          ctx.restore()
        }
      })
    })
    if (p > 0.3 && p < 0.62) impact(ctx, x, y, w * s, h * s, id, t, 1 - seg(p, 0.3, 0.62))
  }
  /** Four short "thunk" ticks off the corners (never a starburst). */
  function impact(ctx, x, y, w, h, id, t, a) {
    ;[[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy], i) => {
      const x0 = x + sx * (w / 2 + 8)
      const y0 = y + sy * (h / 2 + 8)
      ink(ctx, [[x0, y0], [x0 + sx * 18, y0 + sy * 13]], id + 'tk' + i, t, { w: 3.2, color: C.inkDim, alpha: 0.85 * a, passes: 1 })
    })
  }
  /** A small copy of the saved postage stamp stuck on the finished plane's keel, near the tail, placed
   *  through the plane's nose/tail anchors (fold 1: plane-local nose (210,0), tail (-160,25)). */
  function savedDecal(ctx, a, t, pop = 1) {
    if (!a || !a.nose || !a.tail || pop <= 0) return
    const Ln = [210, 0]
    const Lt = [-160, 25]
    const d = sub(a.nose, a.tail)
    const dl = sub(Ln, Lt)
    const den = dl[0] * dl[0] + dl[1] * dl[1]
    const re = (d[0] * dl[0] + d[1] * dl[1]) / den
    const im = (d[1] * dl[0] - d[0] * dl[1]) / den
    const q = sub([-96, 25], Lt)
    const pos = add(a.tail, [q[0] * re - q[1] * im, q[0] * im + q[1] * re])
    const s = Math.hypot(re, im) * 0.27 * pop
    K.at(ctx, pos[0], pos[1], Math.atan2(im, re) - 0.07, s, () => {
      K.paper(ctx, PERF, C.peach, { seed: 's6decal', cut: 0, shadow: 0.7 })
      K.paper(ctx, K.rectPts(-94, -61, 188, 122), C.cream, { seed: 's6decali', cut: 0.8, shadow: 0 })
      ctx.save()
      ctx.lineCap = 'round'
      ctx.strokeStyle = C.ink
      ctx.globalAlpha *= 0.7
      ctx.lineWidth = 12
      ctx.beginPath()
      ctx.moveTo(-66, -22)
      ctx.lineTo(40, -24)
      ctx.stroke()
      ctx.strokeStyle = C.terracotta
      ctx.beginPath()
      ctx.moveTo(-66, 18)
      ctx.lineTo(-4, 17)
      ctx.stroke()
      ctx.globalAlpha /= 0.7
      ctx.strokeStyle = C.sage
      ctx.lineWidth = 13
      ctx.beginPath()
      ctx.moveTo(22, 14)
      ctx.lineTo(36, 30)
      ctx.lineTo(66, -6)
      ctx.stroke()
      ctx.restore()
    })
  }
  /** Rubber-stamp ink impression (terracotta rounded box + text), thunks in at p 0.25. */
  function inkMark(ctx, x, y, t, p, o) {
    if (p <= 0.25) return
    const k = seg(p, 0.25, 0.62)
    const sc = 1 + 0.32 * (1 - E.outBack(k))
    const size = o.size
    K.font(ctx, 'hand', size)
    const tw = ctx.measureText(o.text).width
    const w = tw + size * 1.1
    const h = size * 1.55
    K.at(ctx, x, y, o.rot, sc, () => {
      ctx.save()
      ctx.globalAlpha *= Math.min(1, k * 4) * 0.9
      ctx.strokeStyle = C.terracotta
      ctx.lineJoin = 'round'
      ctx.lineWidth = size * 0.17
      K.pathPoly(ctx, K.wobble(K.roundRectPts(-w / 2, -h / 2, w, h, size * 0.36, 3), 1.1, o.id, 'a'))
      ctx.stroke()
      ctx.lineWidth = size * 0.07
      K.pathPoly(ctx, K.wobble(K.roundRectPts(-w / 2 + size * 0.24, -h / 2 + size * 0.24, w - size * 0.48, h - size * 0.48, size * 0.2, 3), 1, o.id, 'b'))
      ctx.stroke()
      K.font(ctx, 'hand', size)
      ctx.fillStyle = C.terracotta
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(o.text, 0, size * 0.06)
      const r = K.rng('s6speck', o.id)
      ctx.fillStyle = 'rgba(255,250,240,0.55)'
      for (let i = 0; i < 14; i++) ctx.fillRect((r() - 0.5) * w * 0.92, (r() - 0.5) * h * 0.8, 1 + r() * 2.4, 0.8 + r() * 1.6)
      ctx.restore()
    })
  }
  /** Wooden rubber stamp (terracotta rubber pad, kraft block, turned handle). (x, y) = centre of the
   *  rubber face. Returns the knob top (where the hand pinches). */
  function stampTool(ctx, x, y, t, o) {
    const id = 's6tool'
    const sq = o.squash || 1
    let knob = [x, y]
    K.at(ctx, x, y, o.rot || 0, [o.s * (2 - sq), o.s * sq], () => {
      K.paper(ctx, K.rectPts(-74, -16, 148, 16), C.tomato, { seed: id + 'rb', cut: 0.6, shadow: 0.9, lift: o.lift || 0 })
      const blk = K.paper(ctx, K.roundRectPts(-82, -58, 164, 44, 7, 3), C.kraft, { seed: id + 'bk', cut: 1, shadow: 0.8 })
      ink(ctx, blk, id + 'bko', t, { w: 2.2, alpha: 0.7, closed: true })
      K.paper(ctx, K.rectPts(-48, -48, 96, 22), C.cream, { seed: id + 'lb', cut: 0.8, shadow: 0 })
      ink(ctx, [[-36, -37], [34, -38]], id + 'lbl', t, { w: 3, color: C.terracotta, alpha: 0.55, passes: 1 })
      const neck = K.paper(ctx, [[-13, -58], [13, -58], [10, -96], [-10, -96]], C.kraftDark, { seed: id + 'nk', cut: 0.6, shadow: 0.6 })
      ink(ctx, neck, id + 'nko', t, { w: 2, alpha: 0.6, closed: true })
      const kb = K.paper(ctx, K.ellipsePts(0, -114, 30, 24, 22), C.honey, { seed: id + 'kb', cut: 0.8, shadow: 0.7 })
      ink(ctx, kb, id + 'kbo', t, { w: 2.2, alpha: 0.7, closed: true })
      ctx.beginPath()
      ctx.ellipse(-9, -121, 9, 5, -0.4, 0, TAU)
      ctx.fillStyle = 'rgba(255,250,235,0.45)'
      ctx.fill()
      const m = ctx.getTransform()
      const inv = o.base.inverse().multiply(m)
      const p = inv.transformPoint(new DOMPoint(0, -128))
      knob = [p.x, p.y]
    })
    return { knob }
  }

  /** The two stamps printed on the page, in plane-page units (260 x 340, origin = page centre). */
  function pageStamps(ctx, t, savedP, sendP, s, layer = 'page') {
    // the postage stamp is on the 'air' layer (above the hands) until it lands at p 0.3
    const landed = savedP >= 0.3
    if (landed === (layer === 'page')) savedStamp(ctx, SAVED_AT[0], SAVED_AT[1], t, savedP, 0.56 * s)
    if (layer !== 'page') return
    if (sendP > 0) inkMark(ctx, SEND_AT[0], SEND_AT[1], t, sendP, { text: 'Send to chat', size: 21, rot: -0.1, id: 's6send' })
  }

  // ───────────── the fold, part 1: the real notebook page in paperAirplane's fold geometry ─────────────
  /** Everything printed on the page (notebook + stamps), in plane-page units (the fold frame). */
  function pageContent(ctx, t) {
    K.at(ctx, 0, 0, 0, [(2 * AP_HW) / PAGE.w, (2 * AP_HH) / PAGE.h], () => {
      PROPS.notebookPage(ctx, 0, 0, t, { unfold: 1, strike: 1, rewrite: 1, saved: 0, pencil: false, id: 's6nb', nudge: 0 })
    })
    K.at(ctx, 0, 0, 0, [1, SAX / SAY], () => pageStamps(ctx, t, 1, 1, 1))
  }
  /** Plain back of the page as paperAirplane prints it (rules + punched holes), in page units. */
  function apBack(ctx) {
    ctx.save()
    ctx.strokeStyle = 'rgba(110,160,195,0.42)'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let yy = -AP_HH + 40; yy < AP_HH; yy += 34) {
      ctx.moveTo(-AP_HW - 20, yy)
      ctx.lineTo(AP_HW + 20, yy)
    }
    ctx.stroke()
    ctx.fillStyle = 'rgba(92,64,36,0.26)'
    for (const f of [0.2, 0.5, 0.8]) {
      ctx.beginPath()
      ctx.arc(-AP_HW + 15, -AP_HH + 2 * AP_HH * f, 6, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }
  /** fold 0..0.6 of the page (same geometry + easing as paperAirplane stage A/B), drawn with the real
   *  page's content. fold → corner flaps (fa); fb → the left half turns over (k = cos πfb). */
  function foldingPage(ctx, t, fold, fb) {
    const hw = AP_HW
    const hh = AP_HH
    const fa = E.inOutCubic(seg(fold, 0, 0.3))
    const k = Math.cos(Math.PI * fb)
    const A = [0, -hh]
    const B = [-hw, -hh + hw]
    const c0 = [-hw, -hh]
    const mir = [0, -hh + hw]
    const up = [-0.25, -1]
    let v = [lerp(c0[0], mir[0], fa) + up[0] * Math.sin(Math.PI * fa) * 44, lerp(c0[1], mir[1], fa) + up[1] * Math.sin(Math.PI * fa) * 44]
    const cn = [-Math.SQRT1_2, -Math.SQRT1_2]
    const sd = (v[0] - A[0]) * cn[0] + (v[1] - A[1]) * cn[1]
    if (fa > 0 && Math.abs(sd) < 8) {
      const want = (fa < 0.5 ? 8 : -8) - sd
      v = [v[0] + cn[0] * want, v[1] + cn[1] * want]
    }
    const fM = triAffine([A, B, c0], [A, B, v])
    const mirrorM = (m) => [m[0], -m[1], -m[2], m[3], -m[4], m[5]] // conjugate by x → -x
    const mx = (pts) => pts.map((p) => [-p[0], p[1]])
    const M = 24 // clip margin beyond the page's outer edges (wobbly cut edge, shadow, tabs)
    const baseL = [A, B, [-hw, hh], [0, hh]]
    const clipL = [A, B, [-hw - M, -hh + hw], [-hw - M, hh + M], [0, hh + M]]
    const flapClip = [A, B, [-hw - M, -hh + hw], [-hw - M, -hh - 64], [0, -hh - 64]]
    const n = K.nudge('s6nb', t, 0.4)
    const region = (m, clip, fn) => {
      ctx.save()
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
      K.pathPoly(ctx, clip)
      ctx.clip()
      fn()
      ctx.restore()
    }
    const flap = (m, tri, key) => {
      if (fa <= 0.004) return
      const lift = Math.sin(Math.PI * fa)
      K.dropShadow(ctx, tri, 0.3, 2 + 5 * lift)
      if (fa < 0.5) {
        region(m, flapClip, () => pageContent(ctx, t))
        if (fa > 0.12) shade(ctx, tri, `rgba(70,45,20,${(0.2 * fa).toFixed(3)})`)
      } else {
        // the flap's back: paper back with the ruling showing through, folded at an angle
        K.paper(ctx, tri, '#f3ebdb', { seed: 's6flap' + key, cut: 0, shadow: 0 })
        ctx.save()
        K.pathPoly(ctx, tri)
        ctx.clip()
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
        apBack(ctx)
        ctx.restore()
        shade(ctx, tri, 'rgba(120,90,50,0.06)')
        ink(ctx, tri, 's6flapo' + key, t, { w: 2.4, alpha: 0.75, closed: true })
      }
      if (fa > 0.02 && fa < 0.98) ink(ctx, [tri[0], tri[1]], 's6cr' + key, t, { w: 1.6, alpha: 0.45, passes: 1 })
    }
    K.at(ctx, PAGE.x + n.dx, PAGE.y + n.dy, n.rot, [SAX, SAY], () => {
      const leftFront = () => {
        ctx.save()
        ctx.transform(k, 0, 0, 1, 0, 0)
        if (k > 0.03) {
          region([1, 0, 0, 1, 0, 0], clipL, () => pageContent(ctx, t))
          if (k < 0.995) shade(ctx, baseL, `rgba(70,45,20,${(0.3 * (1 - k)).toFixed(3)})`)
          if (fa > 0.02) ink(ctx, [A, B], 's6crL', t, { w: 1.6, alpha: 0.5, passes: 1 })
        } else ink(ctx, [[0, -hh + hw], [0, hh]], 's6sliver', t, { w: 3, alpha: 0.8 })
        ctx.restore()
        ctx.save()
        ctx.transform(k, 0, 0, 1, 0, 0)
        if (k > 0.03) flap(fM, [A, B, v], 'L') // (the half's x-scale k is already on the context)
        ctx.restore()
      }
      const right = () => {
        region([1, 0, 0, 1, 0, 0], mx(clipL), () => pageContent(ctx, t))
        if (fa > 0.02) ink(ctx, mx([A, B]), 's6crR', t, { w: 1.6, alpha: 0.5, passes: 1 })
        flap(mirrorM(fM), mx([A, B, v]), 'R')
      }
      if (k >= 0) {
        leftFront()
        right()
        if (fold >= 0.3) ink(ctx, [[0, -hh], [0, hh]], 's6mid', t, { w: 1.4, alpha: 0.3, passes: 1 })
      } else {
        right()
        // the left half's plain back, turning over onto the right half
        ctx.save()
        ctx.transform(k, 0, 0, 1, 0, 0)
        K.dropShadow(ctx, baseL, 0.55, 4 + 16 * Math.sin(Math.PI * fb))
        K.paper(ctx, baseL, '#eee2cb', { seed: 's6Lb', cut: 0, shadow: 0 })
        ctx.save()
        K.pathPoly(ctx, baseL)
        ctx.clip()
        apBack(ctx)
        shade(ctx, baseL, `rgba(70,45,20,${(0.05 + 0.25 * (1 + k)).toFixed(3)})`)
        ctx.restore()
        ink(ctx, baseL, 's6Lbo', t, { w: 2.4, alpha: 0.75, closed: true })
        ctx.restore()
      }
    })
  }

  // ───────────── the scene ─────────────
  // the flight: out of the hand along the release heading, a loop-de-loop (upside down over the top),
  // then a glide into the bubble's left side
  const TRAIL_TAIL = [
    [1230, 532],
    [1262, 428],
    [1230, 324],
    [1150, 286],
    [1072, 324],
    [1050, 412],
    [1098, 488],
    [1200, 506],
    [1370, 458],
    [BUB.x - 30, BUB.y + 14],
  ]

  function draw(ctx, t, dur, info) {
    const P = plan(info)
    const T = clamp(t, -0.4, dur + 0.4)
    const cam = info && info.camShift ? info.camShift(t) : { dx: 0, dy: 0 }

    // ── backdrop (parallax: the desk moves less than the collage during the pan to s7)
    K.at(ctx, Math.round(-0.4 * cam.dx), 0, 0, 1, () => {
      K.desk(ctx)
      // a little desk life, low-key (never a focal point): an old coffee ring under the chat bubble
      PROPS.coffeeRing(ctx, 1700, 800, T, { r: 80, alpha: 0.38, id: 's6ring' })
    })

    // ── the collage, with a gentle push-in on the tree for the first clause
    const zk = 1 - E.inOutCubic(seg(T, 0, ZOOM.end))
    const z = 1 + ZOOM.s * zk
    if (zk > 0.002) {
      K.at(ctx, ZOOM.x + ZOOM.off * zk, ZOOM.y, 0, z, () => {
        ctx.translate(-ZOOM.x, -ZOOM.y)
        collage(ctx, T, P, cam)
      })
      return null
    }
    return collage(ctx, T, P, cam)
  }

  function collage(ctx, T, P, cam) {
    const base = ctx.getTransform()

    // ── the chat bubble: slides in from the right on "beside", says hello on "Claude", gulps the plane
    const inK = seg(T, P.bubIn[0], P.bubIn[1])
    if (inK > 0) {
      const hello = PIP.hop(T, P.hello, { dur: 0.3, height: 16, pre: 0.08 })
      const gulp = PIP.hop(T, P.land + 0.1, { dur: 0.36, height: 30, pre: 0.1 })
      const bump = T >= P.land && T < P.land + 0.12 ? 1 - seg(T, P.land, P.land + 0.12) : 0
      let bsy = T < P.land ? hello.squash : gulp.squash
      let bsx = 1 + (1 - bsy) * 0.8 + 0.1 * bump
      bsy -= 0.04 * bump
      // slide: stretched while it travels, a squash when it stops (outBack overshoot), settles
      const slide = E.outBack(inK)
      const moving = inK < 0.55 ? 1 - inK / 0.55 : 0
      const stop = ring(T - (P.bubIn[0] + 0.55 * (P.bubIn[1] - P.bubIn[0])), 9, 20)
      bsx *= 1 + 0.12 * moving - 0.06 * stop
      bsy *= 1 - 0.07 * moving + 0.06 * stop
      const flightU = seg(T, P.flight[0], P.flight[1])
      chatBubble(ctx, T, {
        sx: bsx,
        sy: bsy,
        dx: (1 - slide) * 780,
        dy: T < P.land ? hello.y : gulp.y,
        rot: 0.05 * moving,
        attach: seg(T, P.land + 0.06, P.land + 0.4),
        typing: flightU > 0.3 && T < P.land,
      })
    }

    // ── the File Explorer tree
    const grow = seg(T, P.grow[0], P.grow[1])
    const pluckP = seg(T, P.pinch + 0.02, P.pluck1)
    const tree = PROPS.fileTree(ctx, TREE.x, TREE.y, T, {
      scale: TREE.s,
      grow: E.outQuad(grow),
      pluck: pluckP,
      pluckT: T - P.pluck1,
      id: 's6tree',
    })
    const slide = tree.slide.slice(0, tree.slideJoin + 1)
    const tip = slide[0]
    const join = slide[slide.length - 1]
    const mLeafNow = tree.leaves.find((l) => l.m) || { x: tree.mLeaf[0], y: tree.mLeaf[1] }
    const mS = tree.mLeafScale

    // ── the page: leaf → folded page → notebook → (fold) → paper airplane
    const pageTop = [PAGE.x, PAGE.y - (PAGE.h / 2) * PAGE.s]
    const pinchPage = [PAGE.x + 250 * PAGE.s, pageTop[1] + 4] // hand A holds the top-right corner
    const carryK = seg(T, P.pluck1, P.carry1)
    const flipK = seg(T, P.carry1 - 0.12, P.carry1) // 0 → 1: leaf squeezes edge-on, then the page opens
    const unfold = E.outCubic(seg(T, P.carry1, P.unfold1))
    const fold = foldAt(T, P)
    const settle = seg(T, P.aOut[0], P.aOut[0] + 0.2)
    let pinchPt = null // hand A fingertip
    let penPt = null
    let pageAnch = null
    const strikeP = E.inOutQuad(seg(T, P.strike[0], P.strike[1]))
    const rewriteP = E.inOutQuad(seg(T, P.rewrite[0], P.rewrite[1]))
    const savedP = seg(T, P.saved - 0.12, P.saved + 0.28)
    const sendP = seg(T, P.send - 0.08, P.send + 0.24) // inkMark thunks at 0.25 → P.send

    // the carried leaf (after the pluck, before the flip)
    if (T >= P.pluck1 && T < P.carry1) {
      const e = E.inOutCubic(carryK)
      const from = [mLeafNow.x, mLeafNow.y - 30 * mS]
      const ctrl = [lerp(from[0], pinchPage[0], 0.5), Math.min(from[1], pinchPage[1]) - 120]
      const q = (1 - e) * (1 - e)
      const at = [q * from[0] + 2 * (1 - e) * e * ctrl[0] + e * e * pinchPage[0], q * from[1] + 2 * (1 - e) * e * ctrl[1] + e * e * pinchPage[1]]
      pinchPt = at
      const sq = Math.cos((Math.PI / 2) * seg(flipK, 0, 1)) // squeeze to edge-on
      const s = lerp(mS, mS * 2.1, E.inOutQuad(carryK))
      K.at(ctx, at[0], at[1], lerp(0.3, 0.04, e) + 0.1 * Math.sin(Math.PI * e), [s * Math.max(0.06, sq), s], () => {
        ctx.translate(0, 30)
        PROPS.fileLeaf(ctx, 0, 0, T, { kind: 'file', m: true, id: 's6mleaf', nudge: 0 })
      })
    }
    if (T >= P.carry1 && T < P.fA[0]) {
      // notebook page: opens edge-on → unfolds from the pinned top edge
      const open = E.outBack(seg(T, P.carry1, P.carry1 + 0.1))
      const sx = Math.max(0.04, open)
      const lift = (1 - settle) * 6
      pageAnch = PROPS.notebookPage(ctx, PAGE.x + (1 - sx) * 250 * PAGE.s, PAGE.y - lift * 0.5, T, {
        scale: [PAGE.s * sx, PAGE.s],
        unfold,
        strike: strikeP,
        rewrite: rewriteP,
        saved: 0,
        pencil: false,
        id: 's6nb',
        nudge: 0.4,
      })
      penPt = T >= P.bIn && T < P.bOut[1] ? penTip(T, P, pageAnch) : null
      if (T < P.aOut[1]) pinchPt = [pinchPage[0], pinchPage[1] - lift * 0.5]
      // the stamps, in plane-page units
      const n = K.nudge('s6nb', T, 0.4)
      K.at(ctx, PAGE.x + n.dx, PAGE.y + n.dy - lift * 0.5, n.rot, SA * sx, () => pageStamps(ctx, T, savedP, sendP, 1))
    } else if (T >= P.fA[0] && T < P.fC[0]) {
      foldingPage(ctx, T, fold, fbAt(T, P))
    }

    // ── Pip (the anchors drive the swoop and the launch)
    const pip = pipState(T, P, { tip, join, slide, pole: tree.slide.slice(tree.slideJoin), focus: focusAt(T, P, mLeafNow, penPt) })
    if (cam.dx) pip.x -= cam.dx // exit: Pip keeps moving right in screen space through the pan to s7

    // the plane on the desk (wedge snap) and on its way into Pip's hand (behind Pip: the hand is behind
    // the card at this point of the wind-up, and so is the held plane once the hold takes over)
    if (T >= P.fC[0] && T < P.fD[1]) {
      const n = K.nudge('s6nb', T, 0.4)
      const w0 = [PAGE.x + n.dx + AP_HW * 0.5 * SAX * Math.cos(n.rot), PAGE.y + n.dy + AP_HW * 0.5 * SAX * Math.sin(n.rot)]
      const cK = E.outQuad(seg(T, P.fC[0], P.fC[1]))
      const w1 = [w0[0] - 70 * cK, w0[1] - 30 * cK] // lifts off the desk, clear of the bubble's tail
      let c = w1
      // the wedge snaps and shrinks toward hand size (the page-sized plane would dwarf the stage)
      const sw = lerp(SAX, PLANE_WEDGE, cK)
      let sc = [sw, lerp(SAY, SAX, cK) * (sw / SAX)]
      let rot = n.rot * (1 - cK)
      if (T >= P.fD[0]) {
        const e = E.inOutQuad(seg(T, P.fD[0], P.fD[1]))
        const probe = pipProbe(ctx, pip)
        const rH = holdRot(T, P) + throwBodyRot((T - P.throw0) * P.rate)
        const target = add(probe.hands[1], rot2([-GRIP[0], -GRIP[1]], rH).map((v) => v * PLANE_HAND))
        c = mix(w1, target, e)
        c[1] -= Math.sin(Math.PI * e) * 70
        const s = lerp(PLANE_WEDGE, PLANE_HAND, E.outQuad(e))
        sc = [s, s]
        rot = lerp(0, rH, e)
      }
      const a = PROPS.paperAirplane(ctx, c[0], c[1], T, { fold, scale: sc, rot, stamp: 1, id: 's6plane', nudge: 0 })
      if (fold >= 0.95) savedDecal(ctx, a, T)
    }

    // ── launch point (Pip's throwing hand on the release frame)
    let launchC = null
    if (T >= P.release - 0.001) {
      const rel = pipReleasePoint(ctx, P)
      launchC = add(rel.hand, rot2([-GRIP[0], -GRIP[1]], RELEASE_ROT).map((v) => v * PLANE_HAND))
    }

    // the hands are drawn above the page, below Pip
    drawHands(ctx, T, P, { mLeafNow, mS, pinchPt, penPt, pageAnch, base })
    if (pageAnch && savedP > 0 && savedP < 0.3) {
      const n = K.nudge('s6nb', T, 0.4)
      K.at(ctx, PAGE.x + n.dx, PAGE.y + n.dy, n.rot, SA, () => pageStamps(ctx, T, savedP, 0, 1, 'air'))
    }

    // speed lines behind Pip while it pushes the page half over
    if (T > P.fB[0] + 0.02 && T < P.pushEnd + 0.06) {
      const a = 1 - seg(T, P.pushEnd - 0.04, P.pushEnd + 0.06)
      K.withAlpha(ctx, a, () => PROPS.speedLines(ctx, pip.x - 64, pip.y - 96, T, { dir: 0, len: 90, n: 3, spread: 70, width: 3, color: C.inkDim }))
    }

    const pa = PIP.draw(ctx, pip.x, pip.y, T, pip.o)

    if (launchC && T <= P.land) {
      const pts = trailPts(launchC)
      const flightU = seg(T, P.flight[0], P.flight[1])
      const u = flightEase(flightU)
      PROPS.dottedTrail(ctx, 0, 0, T, { pts, p: u, color: C.inkDim, w: 4.5, alpha: 0.75, gap: 26, dash: 12, id: 's6trail' })
      const [x, y, ang] = PROPS.trailAt(pts, u)
      const shrink = 1 - E.inCubic(seg(u, 0.86, 1))
      // first leg big (the "Send to chat" wing reads), smaller through the loop
      const s = (u < 0.1 ? lerp(PLANE_HAND, PLANE_LEG1, E.outQuad(u / 0.1)) : lerp(PLANE_LEG1, PLANE_FLY, E.inOutQuad(seg(u, 0.15, 0.33)))) * shrink
      if (shrink > 0.02) {
        const a = PROPS.paperAirplane(ctx, x, y, T, { fold: 1, scale: s, rot: ang, bank: false, stamp: 1, flutter: 0.6, id: 's6plane', nudge: 0 })
        savedDecal(ctx, a, T)
        if (u < 0.9) PROPS.speedLines(ctx, x - Math.cos(ang) * 190 * s, y - Math.sin(ang) * 190 * s, T, { dir: ang, len: 90, n: 3, spread: 40, width: 3, color: C.inkDim })
      }
    } else if (launchC && T > P.land) {
      // the trail rolls back up from the bubble end, so nothing sits on top of the new attachment chip
      const pts = trailPts(launchC)
      const er = E.inOutQuad(seg(T, P.land, P.land + 0.5))
      if (er < 1) PROPS.dottedTrail(ctx, 0, 0, T, { pts, p: 1 - er, color: C.inkDim, w: 4.5, alpha: 0.75, gap: 26, dash: 12, id: 's6trail' })
    }
    // the gulp: a little pop puff where the plane went in
    const gp = seg(T, P.land - 0.02, P.land + 0.4)
    if (gp > 0 && gp < 1) PROPS.doodlePuff(ctx, BUB.x - 12, BUB.y + 4, T, { p: gp, r: 46, id: 's6puff' })
    return pa
  }

  /** The flight path: out of the hand along the release heading, up into the loop, into the bubble. */
  function trailPts(launch) {
    const lead = add(launch, [Math.cos(RELEASE_ROT) * 140, Math.sin(RELEASE_ROT) * 140])
    return [launch, lead].concat(TRAIL_TAIL)
  }
  /** Arc-length progress along the loop: quick out of the hand, a floaty loop top, a glide in.
   *  (integral of a speed profile, normalised; 32 steps — cheap and pure) */
  const speedAt = (u) => 1.35 - 0.6 * Math.exp(-Math.pow((u - 0.45) / 0.12, 2)) - 0.4 * seg(u, 0.78, 1)
  function flightEase(u) {
    u = clamp01(u)
    const N = 32
    let tot = 0
    let part = 0
    for (let i = 0; i < N; i++) {
      const m = (i + 0.5) / N
      const v = speedAt(m) / N
      tot += v
      if (m < u) part += v * Math.min(1, (u - i / N) * N)
    }
    return clamp01(part / tot)
  }

  /** What Pip looks at (world point). */
  function focusAt(t, P, mLeaf, pen) {
    if (t < P.arc[1]) return null
    if (t < P.hello + 0.25) return [BUB.x - 120, BUB.y]
    if (t < P.pluck1 + 0.1) return [mLeaf.x, mLeaf.y]
    if (t < P.carry1 + 0.1) return [PAGE.x + 120, PAGE.y - 200]
    if (pen && t < P.rewrite[1]) return pen
    if (t < P.send + 0.1) return [PAGE.x + 90, PAGE.y + 60]
    return [PAGE.x, PAGE.y]
  }

  // ───────────── Pip ─────────────
  /** Pip's body rotation in the 'throw' pose at poseT q (mirrors mascot.js, for the hold frame). */
  const throwBodyRot = (q) => (q < 0.3 ? -0.13 * E.inOutCubic(clamp01(q / 0.3)) : q < 0.4 ? lerp(-0.13, 0.15, E.inOutQuad((q - 0.3) / 0.1)) : 0.15)
  /** The plane's angle in Pip's throwing hand (hold frame) at scene time t. */
  const holdRot = (t, P) => lerp(-0.42, RELEASE_ROT, seg((t - P.throw0) * P.rate + P.q0, 0.08, 0.3))

  function pipState(t, P, a) {
    const o = { scale: PIP_S, id: 's6pip', shadow: true }
    if (t >= P.grab[0] && t < P.land) o.blink = 0 // eyes open through the fold, the throw and the flight
    let x = G[0]
    let y = G[1]
    const lookAt = (pt, from) => {
      if (!pt) return null
      const v = sub(pt, from)
      const d = Math.hypot(v[0], v[1]) || 1
      return [clamp(v[0] / d, -1, 1), clamp((v[1] / d) * 0.9, -1, 1)]
    }
    if (t < P.drop0) {
      // not yet in frame: parked high above the branch tip (off-screen)
      x = a.tip[0]
      y = -400
      o.pose = 'slide'
      o.shadow = false
    } else if (t < P.land1) {
      const u = seg(t, P.drop0, P.land1)
      x = a.tip[0] - 30 * (1 - u)
      y = lerp(-260, a.tip[1], u * u)
      o.pose = 'catch'
      o.poseT = 0.12
      o.squash = 1.12
      o.vel = [80, 900 * u]
      o.shadow = false
      o.look = [0.1, 0.8]
    } else if (t < P.slide[0]) {
      x = a.tip[0]
      y = a.tip[1]
      o.pose = 'idle'
      o.squash = 1 - 0.24 * ring(t - P.land1, 7, 18)
      o.shadow = false
      o.eyes = 'wide'
      o.mouth = 'o'
    } else if (t < P.slide[1]) {
      const u = E.inQuad(seg(t, P.slide[0], P.slide[1]))
      const [px, py, ang] = along(a.slide, u)
      x = px
      y = py
      o.pose = 'slide'
      o.poseT = t - P.slide[0]
      o.rot = ang * 0.85
      o.vel = [Math.cos(ang) * 700 * (0.4 + u), Math.sin(ang) * 700 * (0.4 + u)]
      o.shadow = false
    } else if (t < P.pole[1]) {
      // fireman's pole: hug the trunk and zip down to the soil
      const u = E.inQuad(seg(t, P.pole[0], P.pole[1]))
      const [px, py] = along(a.pole, u)
      x = px
      y = py
      const [, , ang0] = along(a.slide, 1)
      o.pose = 'hug'
      o.poseT = t - P.pole[0]
      o.rot = lerp(ang0 * 0.85, 0, E.outQuad(seg(t, P.pole[0], P.pole[0] + 0.1)))
      o.vel = [0, 900]
      o.shadow = false
      o.eyes = 'happy'
      o.mouth = 'open'
    } else if (t < P.arc[0]) {
      const s0 = a.pole[a.pole.length - 1]
      x = s0[0]
      y = s0[1]
      o.pose = 'idle'
      o.squash = 0.8
      o.shadow = false
    } else if (t < P.arc[1]) {
      const s0 = a.pole[a.pole.length - 1]
      const u = seg(t, P.arc[0], P.arc[1])
      const H = 190
      const D = P.arc[1] - P.arc[0]
      x = lerp(s0[0], G[0], u)
      y = lerp(s0[1], G[1], u) - 4 * H * u * (1 - u)
      o.pose = 'slide'
      o.poseT = t - P.slide[0]
      o.rot = TAU * E.inOutQuad(u)
      o.squash = u < 0.15 ? 1.14 : 1.06
      o.vel = [(G[0] - s0[0]) / D, (G[1] - s0[1]) / D - (4 * H * (1 - 2 * u)) / D]
      o.shadow = u > 0.7
    } else if (t < P.grab[0]) {
      // on the desk: land squash, watch the action, a tiny paper clap for the saved stamp
      o.pose = 'idle'
      o.poseT = t - P.arc[1]
      o.squash = 1 - 0.26 * ring(t - P.arc[1], 7, 17)
      if (t < P.arc[1] + 0.2) {
        o.eyes = 'happy'
        o.mouth = 'grin'
      }
      if (t >= P.saved && t < P.saved + 0.22) {
        o.pose = 'clap'
        o.poseT = t - P.saved
        o.eyes = 'happy'
      }
      const lk = lookAt(a.focus, [x, y - 150 * PIP_S])
      if (lk) o.look = lk
    } else if (t < P.fB[0]) {
      // gets a grip on the page's left edge (anticipation crouch), then tugs: the corners flip in
      const tug = t >= P.fA[0]
      o.pose = 'give'
      o.poseT = t - P.grab[0]
      o.squash = tug ? 0.86 : lerp(1, 0.9, E.outQuad(seg(t, P.grab[0], P.fA[0])))
      o.rot = tug ? -0.06 : -0.02
      x = G[0] - (tug ? 5 : 0)
      o.brows = 'determined'
      o.mouth = 'tongue'
      o.look = [0.35, -0.85] // up at the corners
    } else if (t < P.pushEnd + 0.02) {
      // pushes the left half over: hands ride its free edge (paperAirplane frame: x = -hw·k)
      const s = seg(t, P.fB[0], P.pushEnd)
      const k = Math.cos(Math.PI * fbAt(Math.min(t, P.pushEnd), P))
      const lean = 0.12 * Math.sin(Math.PI * Math.min(1, s * 1.2))
      x = edgeX(k) + 4 - (GIVE_HX + GIVE_HY * lean)
      const air = 10 * Math.abs(Math.sin(TAU * s))
      y = G[1] - air
      o.air = air
      o.pose = 'give'
      o.poseT = t - P.grab[0]
      o.rot = lean
      o.squash = 1.04 - 0.1 * (1 - Math.abs(Math.sin(TAU * s)))
      o.vel = [700 * Math.sin(Math.PI * s), 0]
      o.brows = 'determined'
      o.mouth = 'tongue'
      o.look = [0.5, -0.6]
    } else if (t < P.throw0) {
      // lets go at the top; the half flops over and the wedge snaps — Pip watches, delighted
      x = G2[0]
      o.pose = 'idle'
      o.poseT = t - P.pushEnd
      o.squash = 1 - 0.12 * ring(t - P.pushEnd, 8, 18)
      o.rot = 0.06 * ring(t - P.pushEnd, 6, 12)
      o.eyes = t > P.fC[0] ? 'wide' : 'normal'
      o.mouth = t > P.fC[0] ? 'o' : 'grin'
      o.look = [0.8, -0.35]
    } else {
      x = G2[0]
      const q = P.q0 + (t - P.throw0) * P.rate
      o.pose = 'throw'
      o.poseT = q
      if (t < P.release && t >= P.swoop[1]) {
        o.hold = (g) => {
          const rot = holdRot(t, P)
          const s = PLANE_HAND / PIP_S
          const c = rot2([-GRIP[0], -GRIP[1]], rot).map((v) => v * s)
          const an = PROPS.paperAirplane(g, c[0], c[1], t, { fold: 1, scale: s, rot, stamp: 1, id: 's6plane', nudge: 0 })
          savedDecal(g, an, t)
        }
      }
      if (t > P.release + 0.12 && t < P.land) {
        // watch the plane loop
        const u = flightEase(seg(t, P.flight[0], P.flight[1]))
        o.look = [0.75, lerp(-0.8, -0.35, u)]
      }
      if (t >= P.land + 0.02) {
        o.pose = 'cheer'
        o.poseT = t - P.land
        o.look = [0.9, -0.4]
        o.eyes = 'happy'
      }
      if (t >= P.hop1 - 0.12) {
        const h1 = PIP.hop(t, P.hop1, { dur: 0.42, height: 64, pre: 0.1 })
        const h2 = PIP.hop(t, P.hop2, { dur: 0.42, height: 64, pre: 0.1 })
        const inSecond = t >= P.hop2 - 0.1
        const h = inSecond ? h2 : h1
        const dx1 = 190 * E.inOutQuad(seg(t, P.hop1, P.hop1 + 0.42))
        const dx2 = 190 * E.inOutQuad(seg(t, P.hop2, P.hop2 + 0.42))
        x = G2[0] + dx1 + dx2
        y = G2[1] + h.y
        o.air = -h.y
        o.squash = h.squash
        o.pose = 'hop'
        o.poseT = 0.3
        o.look = [1, -0.1]
        o.mouth = 'grin'
        o.eyes = 'normal'
        o.vel = [h.air ? 420 : 0, 0]
      }
    }
    return { x, y, o }
  }
  /** Pip's anchors for this frame without drawing it (probe draw, clipped to nothing). */
  function pipProbe(ctx, pip) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, 0, 0)
    ctx.clip()
    const a = PIP.draw(ctx, pip.x, pip.y, 0, Object.assign({}, pip.o, { hold: null, shadow: false }))
    ctx.restore()
    return a
  }
  /** Pip's throwing-hand position on the release frame (probe draw, clipped to nothing). */
  function pipReleasePoint(ctx, P) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, 0, 0)
    ctx.clip()
    const a = PIP.draw(ctx, G2[0], G2[1], P.release, { scale: PIP_S, id: 's6pip', pose: 'throw', poseT: PIP.THROW_RELEASE })
    ctx.restore()
    return { hand: a.hands[1], rot: RELEASE_ROT }
  }

  // ───────────── the cut-out hands ─────────────
  function drawHands(ctx, t, P, a) {
    // A — plucks the M leaf, carries it, holds the page's corner while it starts to unfold, then leaves
    //     up and to the right (gone before the pencil works)
    if (t >= P.aIn && t < P.aOut[1]) {
      let pt
      if (t < P.pinch) {
        const e = E.outBack(seg(t, P.aIn, P.pinch))
        const target = [a.mLeafNow.x + 4, a.mLeafNow.y - 30 * a.mS]
        pt = [target[0], lerp(-90, target[1], e)]
      } else if (a.pinchPt) {
        pt = a.pinchPt
        if (t < P.pluck1) pt = [a.mLeafNow.x + 4, a.mLeafNow.y - 30 * a.mS]
      } else pt = [a.mLeafNow.x + 4, a.mLeafNow.y - 30 * a.mS]
      let rot = 0.12
      if (t >= P.aOut[0]) {
        const e = E.inQuad(seg(t, P.aOut[0], P.aOut[1]))
        pt = [pt[0] + 300 * e, lerp(pt[1], -160, e)]
        rot = lerp(0.12, 0.4, e)
      }
      CAST.hand(ctx, pt[0], pt[1], t, { from: 'top', pose: 'pinch', scale: 0.6, rot, id: 's6handA' })
    }
    // B — holds the pencil: scribble out, rewrite
    if (t >= P.bIn && t < P.bOut[1] && a.penPt) {
      let tip = a.penPt
      let off = [0, 0]
      if (t < P.strike[0]) {
        const e = E.outBack(seg(t, P.bIn, P.strike[0]))
        off = [lerp(330, 0, e), lerp(460, 0, e)]
      }
      if (t >= P.bOut[0]) {
        const e = E.inCubic(seg(t, P.bOut[0], P.bOut[1]))
        off = [980 * e, 360 * e]
      }
      tip = add(tip, off)
      const dir = [Math.cos(-0.75), Math.sin(-0.75)]
      pencilAt(ctx, tip[0], tip[1], t)
      const grip = add(tip, dir.map((v) => v * 34 * PAGE.s))
      CAST.hand(ctx, grip[0], grip[1], t, { from: 'right', pose: 'pinch', scale: 0.52, rot: 0.78, id: 's6handB' })
    }
    // C — rubber stamp "Send to chat" onto the page; lifts clear before the fold starts
    if (t >= P.cIn && t < P.cOut[1]) {
      const face = [PAGE.x + SEND_AT[0] * SA, PAGE.y + SEND_AT[1] * SA]
      let y = face[1]
      let squash = 1
      let lift = 0
      if (t < P.send) {
        const e = seg(t, P.cIn, P.send)
        y = lerp(-150, face[1] - 30, E.outCubic(Math.min(1, e / 0.7)))
        if (e > 0.7) y = lerp(face[1] - 30, face[1], E.inQuad((e - 0.7) / 0.3))
        lift = 30 * (1 - e)
      } else if (t < P.cOut[0]) {
        squash = 1 - 0.14 * Math.sin(Math.PI * seg(t, P.send, P.cOut[0]))
      } else {
        const e = E.inQuad(seg(t, P.cOut[0], P.cOut[1]))
        y = lerp(face[1], -200, e)
        lift = 30 * e
      }
      const tool = stampTool(ctx, face[0], y, t, { s: 0.72, rot: -0.1, squash, lift, base: a.base })
      CAST.hand(ctx, tool.knob[0], tool.knob[1] + 6, t, { from: 'top', pose: 'pinch', scale: 0.55, rot: 0.1, id: 's6handC' })
    }
  }
  /** The pencil's graphite tip: along the scribble-out, back to the start of the next line, along the
   *  rewrite (matches notebookPage's strike / rewrite geometry through its strikeLine anchor). */
  function penTip(t, P, anch) {
    if (!anch || !anch.strikeLine) return null
    const [a, b] = anch.strikeLine
    const s = E.inOutQuad(seg(t, P.strike[0], P.strike[1]))
    const x0 = a[0] + 12 * PAGE.s
    const len = b[0] - a[0] - 26 * PAGE.s
    const y1 = a[1] + 44 * PAGE.s
    if (t < P.strike[1]) {
      const x = lerp(a[0], b[0], s)
      const zig = s > 0 && s < 1 ? Math.sin(s * 44) * 8 * PAGE.s : 0
      return [x, a[1] + zig - (x - a[0]) * Math.tan(0.03) * PAGE.s]
    }
    if (t < P.rewrite[0]) {
      // hop back to the start of the next line (pencil lifts)
      const e = E.inOutQuad(seg(t, P.strike[1], P.rewrite[0]))
      return [lerp(b[0], x0, e), lerp(a[1], y1, e) - 22 * Math.sin(Math.PI * e)]
    }
    const r = E.inOutQuad(seg(t, P.rewrite[0], P.rewrite[1]))
    return [x0 + len * 0.95 * r, y1]
  }
  /** A yellow pencil (tip at x,y) like the notebook's, for the frames the page isn't drawing it. */
  function pencilAt(ctx, x, y, t) {
    K.at(ctx, x, y, -0.75, PAGE.s, () => {
      const L = 150
      K.paper(ctx, [[0, 0], [18, -9], [18, 9]], '#e8c9a0', { seed: 's6pw', cut: 0, shadow: 0.9, lift: 8 })
      K.pathPoly(ctx, [[0, 0], [6, -3], [6, 3]])
      ctx.fillStyle = C.ink
      ctx.fill()
      K.paper(ctx, [[18, -9], [18 + L, -9], [18 + L, 9], [18, 9]], C.mustard, { seed: 's6pb', cut: 0.8, shadow: 0.9, lift: 8 })
      K.paper(ctx, [[18 + L, -9], [18 + L + 14, -9], [18 + L + 14, 9], [18 + L, 9]], '#b8bcc0', { seed: 's6pf', cut: 0, shadow: 0 })
      K.paper(ctx, [[18 + L + 14, -9], [18 + L + 34, -8], [18 + L + 36, 0], [18 + L + 34, 8], [18 + L + 14, 9]], C.pink, { seed: 's6pe', cut: 0.5, shadow: 0 })
    })
  }

  // ───────────── sound ─────────────
  function sfx(dur, info) {
    const P = plan(info)
    const px = (x) => clamp((x / K.W) * 1.6 - 0.8, -0.8, 0.8)
    const tipX = TREE.x - 258 * TREE.s
    const mX = TREE.x + 396 * TREE.s
    const cues = [
      { t: 0.04, type: 'rustle', dur: 1.0, pitch: 1.3, gain: 0.55, pan: px(TREE.x) },
      { t: P.grow[0] + (P.grow[1] - P.grow[0]) * 0.5, type: 'rustle', dur: 0.5, pitch: 1.4, gain: 0.6, pan: px(TREE.x - 80) },
      { t: P.grow[0] + (P.grow[1] - P.grow[0]) * 0.78, type: 'pop', pitch: 1.5, gain: 0.45, pan: px(mX) },
      { t: P.land1, type: 'boing', pitch: 1.35, gain: 0.55, pan: px(tipX) },
      { t: P.slide[0], type: 'slideDown', dur: P.pole[1] - P.slide[0], pitch: 1.25, gain: 0.5, pan: px(TREE.x - 60) },
      { t: P.bubIn[0] + 0.04, type: 'swish', pitch: 0.95, gain: 0.5, pan: px(BUB.x + 150) },
      { t: P.pole[1], type: 'thup', pitch: 1.2, gain: 0.55, pan: px(TREE.x) },
      { t: P.arc[1], type: 'thud', pitch: 1.35, gain: 0.55, pan: px(G[0]) },
      { t: P.hello, type: 'bloop', pitch: 1.25, gain: 0.55, pan: px(BUB.x) },
      { t: P.pinch + 0.02, type: 'rustle', dur: 0.35, pitch: 1.5, gain: 0.55, pan: px(mX) },
      { t: P.pluck1 - 0.03, type: 'pop', pitch: 1.2, gain: 0.5, pan: px(mX) },
      { t: P.carry1 - 0.06, type: 'flip', pitch: 1.1, gain: 0.6, pan: px(PAGE.x) },
      { t: P.carry1 + 0.02, type: 'crinkle', pitch: 1.0, gain: 0.8, pan: px(PAGE.x) },
      { t: P.carry1 + 0.07, type: 'crinkle', pitch: 1.12, gain: 0.75, pan: px(PAGE.x) },
      { t: P.carry1 + 0.12, type: 'crinkle', pitch: 1.24, gain: 0.7, pan: px(PAGE.x) },
      { t: P.strike[0], type: 'scratch', dur: P.strike[1] - P.strike[0], gain: 0.85, pitch: 1.1, pan: px(PAGE.x - 40) },
      { t: P.rewrite[0], type: 'pencil', dur: P.rewrite[1] - P.rewrite[0], gain: 0.75, pan: px(PAGE.x - 20) },
      { t: P.saved, type: 'thump', gain: 0.9, pan: px(PAGE.x + 90) },
      { t: P.saved + 0.1, type: 'tap', pitch: 1.6, gain: 0.35, pan: px(G[0]) }, // Pip's tiny paper clap
      { t: P.send, type: 'stamp', gain: 0.9, pan: px(PAGE.x + 80) },
      { t: P.fA[0] + 0.01, type: 'crinkle', pitch: 1.3, gain: 0.7, pan: px(PAGE.x - 100) },
      { t: P.fA[0] + 0.06, type: 'crinkle', pitch: 1.15, gain: 0.7, pan: px(PAGE.x + 100) },
      { t: P.fB[0] + 0.02, type: 'footsteps', dur: P.pushEnd - P.fB[0], pitch: 1.3, gain: 0.5, pan: px(G[0] + 90) },
      { t: P.pushEnd + 0.04, type: 'flap', pitch: 1.1, gain: 0.7, pan: px(PAGE.x) },
      { t: P.fC[0] + 0.03, type: 'flip', pitch: 1.3, gain: 0.7, pan: px(PAGE.x + 100) },
      { t: P.fD[0] + 0.02, type: 'swish', pitch: 1.2, gain: 0.55, pan: px(PAGE.x - 20) },
      { t: P.release, type: 'whoosh', dur: 0.5, pitch: 1.15, gain: 0.8, pan: px(G2[0] + 150) },
      { t: P.release + 0.02, type: 'toyRun', dur: P.land - P.release, gain: 0.6, pan: px(1250) },
      { t: P.land, type: 'gulp', gain: 0.95, pan: px(BUB.x) },
      { t: P.land + 0.08, type: 'plink', pitch: 1.5, gain: 0.45, pan: px(BUB.x - 90) },
      { t: P.land + 0.16, type: 'boing', pitch: 0.9, gain: 0.45, pan: px(BUB.x) },
      { t: P.hop1, type: 'boing', pitch: 1.5, gain: 0.4, pan: px(G2[0] + 100) },
    ]
    const ok = window.AUDIO && AUDIO.SFX_TYPES ? new Set(AUDIO.SFX_TYPES) : null
    return cues.filter((c) => c.t >= 0 && c.t < dur && (!ok || ok.has(c.type)))
  }

  PROMO.scene('s6-files', { draw, sfx })
})()

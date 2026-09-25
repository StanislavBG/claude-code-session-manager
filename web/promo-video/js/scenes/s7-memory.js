/* s7-memory.js — "Peek at what Claude remembers — plain notes you can tidy."
 * Owner: scene s7 (phase B). Pure function of (t, info): every beat time is derived from info.wordAt /
 * info.nextBeat each frame (see beats()), nothing survives between frames, randomness only via kit/prop seeds.
 *
 * Set: a wood-framed cork board "Memory" (sage "Workspace" tab) on the craft table; an "Aggregate" button
 * on a kraft plate to its upper right; a wicker basket on the floor at the right. Pip hides behind a tall
 * peach card hanging off the bottom of the board: only its legs, scarf and lower body show. One floor line.
 * Beats (T.* in beats()):
 *   pan-in    camera pans in from s6; desk (-0.42 dx), board (-0.12 dx), basket (+0.1 dx) parallax. Our Pip
 *             is hidden only on the pan frame where s6's Pip is still on screen; its legs then plop in.
 *             The "Memory" header pops on; four torn cards swoop in and pin themselves on a 16th-note
 *             run starting on the first beat (T.tacks, tack x4).
 *   T.liftA   "Peek": Pip dips (anticipation), pushes the flap up (stretch) and it lands on the next beat
 *             (T.liftB); Pip then bobs down under the lifted lip so its face slides into view (peekaboo).
 *   T.take    double take to camera: wide eyes, 'o' mouth, raised brows, surprise ticks.
 *   T.tap     half-beat on "remembers": a mitten taps "Aggregate"; red yarn strings pin to pin, twangs,
 *             the pins pop, the yarn pulls the three cards into a stack (it shortens as they converge), two
 *             strands tie them with a bow, a teal clip slides on, the "Clusters" tag swings in and the
 *             crayon arrow from the button lands on it together → "Aggregate → Clusters".
 *   T.hop0    Pip hops out from under the flap (it flops shut) and lands under the stale card (T.land)
 *             BEFORE the stamp, so the stamp gets the frame to itself.
 *   T.stamp   beat on "plain": a wooden rubber stamp THUNKs terracotta "STALE" on the faded, coffee-ringed
 *             card; Pip flinches underneath (squash, eyes shut).
 *   T.grab    Pip reaches up, the pin pops, the card comes off overhead with STALE readable; T.crA..T.crB
 *             ("notes you can") it crumples into a ball (hands squeeze in, the ball pops on a beat, bwomp);
 *   T.rel     the throw wind-up starts after the crumple and releases on "tidy": the ball flies a chunky
 *             crayon-swooshed arc into the basket (T.in swish, basket bounces, plink on the next beat).
 *   T.newPin  a mitten slides a mint "+ New memory" card into the gap; it pins on a half-beat; Pip claps,
 *   T.proud   then on the next beat pops to a proud grin at camera (the scene's button before the tilt).
 * Text-less cards carry neutral pencil squiggles (never letter-like scribbles). Key action stays above
 * y ≈ 900 (captions). t outside [0, dur] is safe (every phase is clamped).
 */
(function () {
  'use strict'
  const { C } = K
  const E = K.ease
  const seg = K.seg
  const lerp = K.lerp
  const clamp = K.clamp
  const clamp01 = K.clamp01
  const P = window.PROPS

  // ───────── layout (scene px) ─────────
  const FLOOR = 890 // Pip's feet
  const SP = 0.85 // Pip scale
  const SC = 0.95 // stale / new card scale
  const BOARD = { x: 790, y: 415, s: 0.9 }
  const BUN = { x: 790, y: 330, s: 0.95 } // clipBundle frame (cards inside are at CS)
  const CS = 0.92
  const SPREAD = [[-300, -50], [0, 30], [300, -40]]
  const STACK = [[-16, 10], [0, 0], [14, -8]] // clipBundle's stacked offsets
  const RS = [[-0.05, -0.1], [0.04, 0.06], [0.07, -0.03]] // clipBundle's spread → stack rotations
  const CARDS = [{ text: 'tests: npm test', color: 'cream' }, { text: 'likes small commits', color: 'butter' }, { text: ' ', color: 'sage' }]
  const PO = (90 - 10) * CS // clipBundle: pin offset from a card's centre
  const DCARD = { x: 470, y: 590, s: 0.9, rot: -0.045, color: '#d3e3ec' }
  // Pip's 'carry' rig, probed at SP 0.85 (world px above the feet as a function of squash s): head top
  // 14.5 + 192·s, face bottom ≈ 119·s; with carryH ≥ 133 the hands ride 37 local px higher: 18.4 + 235·s
  const HANDS_HI = (s) => (18.4 + 235 * s) * (SP / 0.85)
  const SH = 0.8 // Pip's squash while holding the flap up: crouched, peeking out from under it
  // The peek flap: a taller peach card. Lifted, its curl lip sits at Pip's raised mitts, clear above the
  // squashed paperclip antenna and the brows; flat, its bottom edge covers Pip's whole face (the scarf,
  // lower body and legs show).
  const MAXA = Math.PI * 0.33 // memoryCard's lift clamp
  const PEEK = { x: 790, w: 260, h: 226, s: 1, rot: -0.012 }
  PEEK.y = FLOOR - HANDS_HI(SH) + 2 - PEEK.s * (PEEK.h * (Math.cos(MAXA) - 0.5) + 18)
  const PEEK_CW = ((PEEK.w / 2) * 0.62 * 1.14 * PEEK.s) / SP * 2 - 8 // carryW so the hands meet memoryCard.grip
  const PEEK_CH = 133 // carryH that raises the hands to their highest grip
  // 'carry' holdAt = feet - SP*(250 + ch/2): the pinned stale card sits exactly where Pip will hold it
  const STALE = { x: 1110, y: FLOOR - SP * 250 - 90 * SC, rot: -0.022 }
  const STAMP_AT = [0, 22] // card-local
  const BTN = { x: 1492, y: 236 }
  const TIP = [BTN.x + 104, BTN.y - 8] // mitten fingertip on the cap, right of the label
  const ARROW = { a: [BTN.x - 132, BTN.y + 30], b: [1106, 322] } // button → the Clusters tag
  const BASKET = { x: 1590, y: 792, s: 1 } // centre; rim at y - 100
  const SPOOL = { x: 150, y: 800 } // a ball of the red yarn on the table (set dressing)
  const MOUTH = [BASKET.x - 4, BASKET.y - 100 + 22] // resting ball centre
  const LAUNCH = [STALE.x + 147.5 * SP, FLOOR - 175.7 * SP] // PIP 'throw' hands[1] at THROW_RELEASE (probe)
  const BALL_S = SC
  const HOP_H = 70

  // ───────── helpers ─────────
  const bump = (t, a, b) => Math.sin(Math.PI * seg(t, a, b))
  const wob = (t, t0, amp, f = 20, d = 8) => (t < t0 ? 0 : amp * Math.exp(-d * (t - t0)) * Math.sin(f * (t - t0)))
  const panOf = (x) => clamp((x / K.W) * 1.6 - 0.8, -0.8, 0.8)
  const rotPt = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)]
  /** Keyframed look vector: keys [[t, [lx, ly]], ...], eased over `blend` s after each key. */
  function lookSeq(t, keys, blend = 0.12) {
    let cur = keys[0][1]
    for (let i = 1; i < keys.length; i++) {
      const [tk, v] = keys[i]
      if (t < tk) break
      const p = E.outBack(seg(t, tk, tk + blend))
      cur = [lerp(cur[0], v[0], p), lerp(cur[1], v[1], p)]
    }
    return cur
  }

  /** Every beat time of the scene, derived from the narration + the music grid (never hard-coded). */
  function beats(info) {
    const W = (w, f, n) => (info && info.wordAt ? info.wordAt(w, f, n) : f)
    const beat = (info && info.beat) || 0.58
    const NB = (x) => (info && info.nextBeat ? info.nextBeat(x) : x)
    const half = beat / 2
    // nearest point of the half-beat grid to x
    const nearHalf = (x) => Math.min(NB(x - half / 2), NB(x - half / 2 - half) + half)
    const T = { beat }
    T.peek = W('peek', 0.45)
    T.rem = W('remembers', 1.46)
    T.plain = W('plain', 2.12)
    T.tidy = W('tidy', 3.13)
    // pin-on: a 16th-note run of four tacks starting on the first beat after the cut
    const b0 = NB(-0.06)
    T.tacks = [0, 1, 2, 3].map((i) => b0 + (i * beat) / 4)
    // "Peek": the flap starts on the word and lands on the next beat
    T.liftA = Math.max(T.peek + 0.02, T.tacks[3] + 0.02)
    T.liftB = Math.max(T.liftA + 0.12, NB(T.liftA + 0.05))
    T.take = T.liftB + 0.2
    // "remembers": the mitten taps on the nearest half beat; the gather is tight so the bundle (bow, clip,
    // tag, arrow) is finished before the stamp owns the frame
    T.tap = nearHalf(T.rem)
    T.gs = T.tap + 0.1
    T.gd = 0.65
    T.clip = T.gs + 0.66 * T.gd
    T.tagIn = T.clip + 0.05
    T.arrowA = T.tagIn - 0.24 // the crayon arrow's head arrives with the tag
    T.arrowB = T.tagIn + 0.04
    // "plain": stamp THUNK on the next beat
    T.stamp = NB(T.plain + 0.05)
    T.sd = 0.45 // stampMark p duration; its hit is at p 0.35
    T.s0 = T.stamp - 0.35 * T.sd
    // Pip hops out from under the flap and lands under the stale card before the stamp comes down
    T.hopDur = 0.38
    T.hop0 = T.stamp - 0.52
    T.land = T.hop0 + T.hopDur
    T.flap0 = T.hop0 + 0.1 // the flap flops shut once Pip is clear
    T.grab = T.stamp + 0.17 // flinch (≈0.09 s), reach, then the pin pops as the stamp tool lifts away
    // crumple over "notes you can", the ball pops on a beat; the throw wind-up (from poseT 0.2) starts
    // after it and releases (PIP.THROW_RELEASE) on "tidy"
    T.rel = T.tidy
    T.throw0 = T.rel - (PIP.THROW_RELEASE - 0.2)
    T.crA = Math.max(T.grab + 0.1, T.stamp + 0.27)
    T.crB = Math.min(NB(T.crA + 0.25), T.throw0 - 0.01)
    T.in = T.rel + 0.28 // ball drops through the rim
    T.ding = NB(T.in)
    // the new card pins on the half beat after the ding
    T.newPin = nearHalf(T.in + 0.4)
    T.proud = NB(T.newPin + 0.2) // the clap ends on a beat
    return T
  }

  // ───────── cards ─────────
  /** Neutral pencil squiggle "words" (soft waves, never letter shapes) from x0 along a line at y0. */
  function squiggle(ctx, x0, y0, len, id, t, color) {
    const r = K.rng('s7sq', id)
    const jr = K.rng('s7sqj', id, K.boil(t))
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const end = x0 + len
    let x = x0
    while (x < end - 16) {
      const wl = Math.min(end - x, 38 + r() * 44)
      const amp = 3.6 + r() * 2.4
      const f = 0.3 + r() * 0.1
      const ph = r() * 6
      ctx.beginPath()
      for (let u = 0; u <= wl; u += 3) {
        const env = Math.sqrt(Math.sin(Math.PI * Math.min(1, u / wl)))
        const yy = y0 + Math.sin(ph + u * f) * amp * (0.45 + 0.55 * env) + (jr() - 0.5) * 0.8
        if (u) ctx.lineTo(x + u, yy)
        else ctx.moveTo(x + u, yy)
      }
      ctx.stroke()
      x += wl + 12 + r() * 10
    }
    ctx.restore()
  }
  /** Two squiggle lines where memoryCard writes its text (card-local), foreshortened like its lifted face. */
  function cardSquiggles(ctx, t, o) {
    const w = o.w || 260
    const h = o.h || 180
    const T = -h / 2
    const lift = clamp01(o.lift || 0)
    const col = o.stale ? 'rgba(122,110,92,0.5)' : 'rgba(58,48,38,0.7)'
    const lines = () => {
      const ty = T + 62 + 8 * Math.min(1, lift * 4)
      squiggle(ctx, -w / 2 + 22, ty, w * 0.62, o.id + 'a', t, col)
      squiggle(ctx, -w / 2 + 22, ty + 34, w * 0.4, o.id + 'b', t, col)
    }
    if (lift <= 0) return lines()
    const ang = E.outQuad(lift) * MAXA
    const near = Math.sin(ang) / Math.sin(MAXA)
    K.at(ctx, 0, T, 0, [1 + 0.07 * near, Math.cos(ang)], () => {
      ctx.translate(0, h / 2)
      lines()
    })
  }
  /** memoryCard; a card with no text gets our squiggles instead, drawn in the same (nudged) frame. */
  function card(ctx, x, y, t, o) {
    const sq = !o.text || o.text === ' '
    const res = P.memoryCard(ctx, x, y, t, sq ? Object.assign({}, o, { text: ' ' }) : o)
    if (!sq || o.part === 'under') return res
    const amp = o.nudge === undefined ? 0.5 : o.nudge
    const n = amp ? K.nudge(o.id, t, amp) : { dx: 0, dy: 0, rot: 0 }
    K.at(ctx, x + n.dx, y + n.dy, (o.rot || 0) + n.rot, o.scale === undefined ? 1 : o.scale, () => cardSquiggles(ctx, t, o))
    return res
  }

  /** clipBundle's card poses at gather g (same math as the prop), bundle-local: [[x, y, rot] x3]. */
  function bundlePos(g) {
    const tug = 0.04 * Math.sin(Math.PI * seg(g, 0, 0.3))
    const mp = seg(g, 0.3, 0.82)
    const ge = E.inOutCubic(mp) + 0.07 * Math.sin(Math.PI * seg(mp, 0.72, 1))
    return STACK.map((s, i) => [lerp(SPREAD[i][0] * (1 + tug), s[0], ge), lerp(SPREAD[i][1], s[1], ge), lerp(RS[i][0], RS[i][1], ge)])
  }
  /** A card's (nudged) pin point, bundle-local. */
  function bundlePin(q, i, t) {
    const n = K.nudge('s7bc' + i, t, 0.4)
    const a = q[2] + n.rot
    return [q[0] + n.dx + Math.sin(a) * PO, q[1] + n.dy - Math.cos(a) * PO]
  }
  function rectPts(cx, cy, rot, s, w, h) {
    return [[-w / 2, -h / 2 - 6], [w / 2, -h / 2 - 6], [w / 2, h / 2], [-w / 2, h / 2]].map((p) => {
      const q = rotPt([p[0] * s, p[1] * s], rot)
      return [cx + q[0], cy + q[1]]
    })
  }
  /** Over clipBundle while it gathers: the sage card's squiggles (clipped to where card 1 doesn't cover
   *  it) and the red yarn that PULLS the cards together (taut, twanging, shortening as they converge). */
  function bundleExtras(ctx, t, T, g) {
    const pos = bundlePos(g)
    K.at(ctx, BUN.x, BUN.y, 0, BUN.s, () => {
      if (g < 0.72) {
        const n2 = K.nudge('s7bc2', t, 0.4)
        const n1 = K.nudge('s7bc1', t, 0.4)
        const r2 = rectPts(pos[2][0] + n2.dx, pos[2][1] + n2.dy, pos[2][2] + n2.rot, CS, 260, 180)
        const r1 = rectPts(pos[1][0] + n1.dx, pos[1][1] + n1.dy, pos[1][2] + n1.rot, CS, 264, 184)
        ctx.save()
        K.pathPoly(ctx, r2)
        ctx.clip()
        ctx.beginPath()
        ;[r2, r1].forEach((r) => {
          ctx.moveTo(r[0][0], r[0][1])
          for (let i = 1; i < 4; i++) ctx.lineTo(r[i][0], r[i][1])
          ctx.closePath()
        })
        ctx.clip('evenodd')
        K.at(ctx, pos[2][0] + n2.dx, pos[2][1] + n2.dy, pos[2][2] + n2.rot, CS, () => cardSquiggles(ctx, t, { id: 's7bc2' }))
        ctx.restore()
      }
      const ya = seg(g, 0.3, 0.4) * (1 - seg(g, 0.54, 0.64))
      if (ya > 0) {
        const tw = seg(g, 0.3, 0.56)
        const sag = lerp(7, 0, seg(g, 0.3, 0.46))
        const p0 = bundlePin(pos[0], 0, t)
        const p1 = bundlePin(pos[1], 1, t)
        const p2 = bundlePin(pos[2], 2, t)
        K.withAlpha(ctx, ya, () => {
          P.yarn(ctx, 0, 0, t, { id: 's7py1', from: p0, to: p1, sag, twang: tw })
          P.yarn(ctx, 0, 0, t, { id: 's7py2', from: p1, to: p2, sag, twang: tw })
        })
      }
    })
  }

  // ───────── pieces ─────────
  /** Chunky paper push-button on a kraft plate. press 0..1 sinks the cap. */
  function aggButton(ctx, t, press) {
    const w = 252
    const h = 74
    const depth = 16
    K.at(ctx, BTN.x, BTN.y, -0.035, 1, () => {
      K.paper(ctx, K.roundRectPts(-w / 2 - 24, -h / 2 - 22, w + 48, h + depth + 44, 16), C.kraft, { seed: 's7plate', cut: 2, shadow: 1, lift: 2 })
      K.tape(ctx, -w / 2 - 6, -h / 2 - 20, 90, -0.5, 'rgba(111,125,82,0.8)', { seed: 's7bt1', h: 28 })
      K.tape(ctx, w / 2 + 8, h / 2 + depth + 14, 90, -0.45, 'rgba(111,125,82,0.8)', { seed: 's7bt2', h: 28 })
      // socket
      const sock = K.roundRectPts(-w / 2 - 4, -h / 2 + depth - 4, w + 8, h + 8, 24)
      K.pathPoly(ctx, sock)
      ctx.fillStyle = '#2f4c45'
      ctx.fill()
      const dy = press * depth * 0.8
      const sq = 1 - 0.05 * press
      K.at(ctx, 0, dy, 0, [1 + 0.02 * press, sq], () => {
        // side wall of the cap (the part that sinks)
        const side = K.roundRectPts(-w / 2, -h / 2 + 2, w, h + depth * (1 - press) * 0.8, 22)
        K.paper(ctx, side, '#3c665d', { seed: 's7capside', cut: 0.8, shadow: 0 })
        const cap = K.roundRectPts(-w / 2, -h / 2, w, h, 22)
        const shape = K.paper(ctx, cap, C.hiveTeal, { seed: 's7cap', cut: 0.8, shadow: 0 })
        // crown highlight + rim
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(-w / 2 + 26, -h / 2 + 12)
        ctx.lineTo(w / 2 - 40, -h / 2 + 12)
        ctx.strokeStyle = 'rgba(255,250,240,0.4)'
        ctx.lineWidth = 5
        ctx.lineCap = 'round'
        ctx.stroke()
        K.pathPoly(ctx, shape)
        ctx.lineWidth = 2.6
        ctx.strokeStyle = 'rgba(30,24,18,0.85)'
        ctx.lineJoin = 'round'
        ctx.stroke()
        ctx.restore()
        K.hand(ctx, 'Aggregate', -4, 12, { family: 'chunky', weight: '600', size: 38, color: C.paperWhite, t, id: 's7agg', jitter: 0.35 })
      })
    })
  }

  /** The three cluster cards before the tap (identical to clipBundle at gather 0), swooping in to pin. */
  function bundleCardsPinning(ctx, t, T) {
    // bundle-local start offsets [dx, dy, rot]; card 1 comes from the upper right, BELOW the header strip
    const from = [[-240, -300, -0.6], [420, -240, 0.45], [300, -260, 0.6]]
    const tk = [T.tacks[0], T.tacks[2], T.tacks[3]]
    K.at(ctx, BUN.x, BUN.y, 0, BUN.s, () => {
      ;[0, 2, 1].forEach((i) => {
        const a = tk[i] - 0.2
        if (t < a) return
        const fly = E.outCubic(seg(t, a, tk[i] - 0.05))
        const land = wob(t, tk[i], 0.05, 26, 9)
        const x = SPREAD[i][0] + from[i][0] * (1 - fly)
        const y = SPREAD[i][1] + from[i][1] * (1 - fly)
        const rot = lerp(from[i][2], RS[i][0], fly)
        const s = CS * lerp(1.22, 1, fly)
        if (fly < 1) flyShadow(ctx, x, y, rot, s, 1 - fly)
        card(ctx, x, y, t, { id: 's7bc' + i, text: CARDS[i].text, color: CARDS[i].color, rot, pin: t >= tk[i] - 0.07, pinPop: 0, pinPress: seg(t, tk[i] - 0.07, tk[i]), nudge: 0.4, scale: [s * (1 + land), s * (1 - land)] })
      })
      // yarn strings pin to pin right after the tap (clipBundle takes over at gather 0)
      if (t >= T.tap + 0.02) {
        const pin = (i) => [SPREAD[i][0] + Math.sin(RS[i][0]) * PO, SPREAD[i][1] - Math.cos(RS[i][0]) * PO]
        const y1 = seg(t, T.tap + 0.02, T.tap + 0.06)
        const y2 = seg(t, T.tap + 0.06, T.gs)
        P.yarn(ctx, 0, 0, t, { id: 's7by1', from: pin(0), to: pin(1), sag: 18, p: y1 })
        if (y2 > 0) P.yarn(ctx, 0, 0, t, { id: 's7by2', from: pin(1), to: pin(2), sag: 18, p: y2 })
      }
    })
  }
  /** Soft lifted shadow under a card that is still flying in. */
  function flyShadow(ctx, x, y, rot, s, k) {
    K.at(ctx, x + 26 * k, y + 38 * k, rot, s, () => {
      K.pathPoly(ctx, K.boxPts(250, 172))
      ctx.fillStyle = `rgba(58,36,14,${0.16 * k})`
      ctx.fill()
    })
  }

  /** A card flying in to be pinned on (world space). */
  function pinCard(ctx, t, tk, c, o) {
    const a = tk - 0.2
    if (t < a) return
    const fly = E.outCubic(seg(t, a, tk - 0.05))
    const land = wob(t, tk, 0.05, 26, 9)
    const x = c.x + o.from[0] * (1 - fly)
    const y = c.y + o.from[1] * (1 - fly)
    const rot = lerp(o.from[2], c.rot, fly)
    const s = c.s * lerp(1.22, 1, fly)
    if (fly < 1) flyShadow(ctx, x, y, rot, s, 1 - fly)
    card(ctx, x, y, t, Object.assign({ rot, pin: t >= tk - 0.07, pinPress: seg(t, tk - 0.07, tk), scale: [s * (1 + land), s * (1 - land)] }, o.card))
  }

  /** "STALE" stamp (tool + ink) in the stale card's local frame. */
  function staleStamp(ctx, t, T, o = {}) {
    // stampMark p: 0–0.35 the tool drops (thunk at 0.35), 0.35–1 it lifts off — compressed into 0.17 s so the
    // tool is gone before Pip takes the card
    const p = o.p !== undefined ? o.p : t < T.stamp ? 0.35 * clamp01((t - T.s0) / (T.stamp - T.s0)) : 0.35 + 0.65 * clamp01((t - T.stamp) / 0.17)
    if (p <= 0) return
    P.stampMark(ctx, STAMP_AT[0], STAMP_AT[1], t, { id: 's7stamp', text: 'STALE', size: 40, color: C.terracotta, rot: -0.16, p, tool: o.tool !== false, jitter: 0.4 })
    // four short thunk ticks (never a starburst)
    const k = seg(t, T.stamp, T.stamp + 0.22)
    if (o.tool !== false && k > 0 && k < 1) {
      K.withAlpha(ctx, 1 - k, () => {
        ;[[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy], i) => {
          const x0 = STAMP_AT[0] + sx * (112 + 10 * k)
          const y0 = STAMP_AT[1] + sy * (50 + 8 * k)
          K.pencil.line(ctx, x0, y0, x0 + sx * 18, y0 + sy * 13, 's7tk' + i, t, { stroke: C.inkDim, strokeWidth: 3.2, roughness: 0.7 })
        })
      })
    }
  }

  /** The stale card, faded + coffee-ringed, with its stamp; `local` = draw at (0,0) unrotated (Pip's hold). */
  function staleCard(ctx, t, T, o = {}) {
    const hit = wob(t, T.stamp, 0.045, 30, 10)
    const draw = () => {
      card(ctx, 0, 0, t, { id: 's7stale', stale: true, pin: true, pinPop: o.pinPop || 0, scale: [1 + hit, 1 - hit] })
      staleStamp(ctx, t, T, { tool: !o.local })
    }
    if (o.local) draw()
    else K.at(ctx, STALE.x, STALE.y, STALE.rot, SC, draw)
  }

  /** The crumpling ball in the stale card's local frame (squiggles + stamp ink squash away with the face);
   *  it pops (squash-stretch) the moment it is finished. */
  function staleBall(ctx, t, T, cp) {
    const pop = cp >= 1 ? 0.16 * bump(t, T.crB - 0.02, T.crB + 0.14) : 0
    K.at(ctx, 0, 0, 0, [1 + pop, 1 - pop * 0.6], () => {
      P.crumple(ctx, 0, 0, t, { id: 's7stale', stale: true, text: ' ', p: cp })
      const e = E.inOutCubic(cp)
      const a = 1 - seg(cp, 0.12, 0.6)
      if (a > 0) {
        K.withAlpha(ctx, a, () => {
          K.at(ctx, 0, 0, 0.6 * e, 1 - 0.72 * e, () => {
            cardSquiggles(ctx, t, { id: 's7stale', stale: true })
            P.stampMark(ctx, STAMP_AT[0], STAMP_AT[1], t, { id: 's7stamp', text: 'STALE', size: 40, color: C.terracotta, rot: -0.16, p: 1, tool: false, jitter: 0.4 })
          })
        })
      }
    })
  }

  /** Ball position on its flight (world). u 0..1 = release → rest in the basket. */
  function ballAt(u) {
    const H = 170
    const x = lerp(LAUNCH[0], MOUTH[0], u)
    const y = lerp(LAUNCH[1], MOUTH[1], u) - 4 * H * u * (1 - u)
    return [x, y]
  }

  /** Chunky crayon swoosh behind the ball from u0 to u1: a peach under-ribbon, a fat terracotta crayon
   *  ribbon (tapered, steep tail fade), a second offset terracotta pass, waxy paper-grain skips and a
   *  boiling pencil edge. */
  function swoosh(ctx, t, u0, u1, alpha) {
    if (u1 - u0 < 0.03 || alpha <= 0) return
    const N = 16
    const pts = []
    for (let i = 0; i <= N; i++) pts.push(ballAt(lerp(u0, u1, i / N)))
    const nrm = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)]
      const b = pts[Math.min(N, i + 1)]
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      return [-(b[1] - a[1]) / d, (b[0] - a[0]) / d]
    })
    const r = K.rng('s7sw', K.boil(t))
    const ribbon = (width, off, jit) => {
      const L = []
      const R = []
      pts.forEach((p, i) => {
        const k = i / N
        const hw = (width / 2) * (0.15 + 0.85 * Math.pow(k, 0.55))
        const j = (r() - 0.5) * jit
        L.push([p[0] + nrm[i][0] * (off * k + hw + j), p[1] + nrm[i][1] * (off * k + hw + j)])
        R.push([p[0] + nrm[i][0] * (off * k - hw - j), p[1] + nrm[i][1] * (off * k - hw - j)])
      })
      return L.concat(R.reverse())
    }
    const tail = pts[0]
    const head = pts[N]
    const grad = (col, a) => {
      const g = ctx.createLinearGradient(tail[0], tail[1], head[0], head[1])
      g.addColorStop(0, `rgba(${col},0)`)
      g.addColorStop(0.45, `rgba(${col},${0.35 * a})`)
      g.addColorStop(1, `rgba(${col},${a})`)
      return g
    }
    ctx.save()
    ctx.globalAlpha *= alpha
    K.pathPoly(ctx, ribbon(58, -10, 2.5))
    ctx.fillStyle = grad('240,176,146', 0.75)
    ctx.fill()
    K.pathPoly(ctx, ribbon(36, 0, 3))
    ctx.fillStyle = grad('184,92,52', 0.92)
    ctx.fill()
    K.pathPoly(ctx, ribbon(13, 14, 1.5))
    ctx.fillStyle = grad('160,72,38', 0.8)
    ctx.fill()
    // waxy skips: short paper-coloured dashes along the crayon core
    ctx.lineCap = 'round'
    ctx.setLineDash([2, 5, 1, 11])
    ctx.lineDashOffset = r() * 16
    ctx.strokeStyle = 'rgba(246,239,225,0.26)'
    ctx.lineWidth = 1.6
    ;[-8, -2, 6].forEach((off) => {
      ctx.beginPath()
      const i0 = Math.ceil(N * 0.3)
      for (let i = i0; i <= N; i++) {
        const k = i / N
        const x = pts[i][0] + nrm[i][0] * off * k
        const y = pts[i][1] + nrm[i][1] * off * k
        if (i === i0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    })
    ctx.setLineDash([])
    ctx.restore()
    // boiling pencil edge along the leading half of the upper side
    const edge = []
    for (let i = Math.round(N * 0.45); i <= N; i += 2) {
      const k = i / N
      const hw = (36 / 2) * (0.15 + 0.85 * Math.pow(k, 0.55))
      edge.push([pts[i][0] + nrm[i][0] * (hw + 2), pts[i][1] + nrm[i][1] * (hw + 2)])
    }
    if (edge.length >= 3) K.withAlpha(ctx, 0.7 * alpha, () => K.pencil.curve(ctx, edge, 's7swe', t, { stroke: '#7e3a1d', strokeWidth: 2.2, roughness: 1.1 }))
  }

  /** A ball of the red yarn on the table, its loose end trailing up to the board (set dressing). */
  function yarnBall(ctx, t) {
    const n = K.nudge('s7spool', t, 0.4)
    K.at(ctx, SPOOL.x + n.dx, SPOOL.y + n.dy, 0, 1, () => {
      // loose strand across the table to the board's lower-left corner
      P.yarn(ctx, 0, 0, t, { id: 's7loose', from: [40, 20], to: [118, -96], sag: 34, w: 4.5 })
      K.circleShadow(ctx, 0, 0, 52, 1, 3)
      K.pathPoly(ctx, K.ellipsePts(0, 0, 52, 52, 30))
      ctx.fillStyle = K.paperPattern(ctx, '#c7352f')
      ctx.fill()
      ctx.save()
      ctx.clip()
      ctx.lineCap = 'round'
      const r = K.rng('s7wind')
      for (let i = 0; i < 9; i++) {
        const a = r() * Math.PI
        ctx.beginPath()
        ctx.ellipse((r() - 0.5) * 20, (r() - 0.5) * 20, 50, 16 + r() * 22, a, 0, Math.PI * 2)
        ctx.strokeStyle = i % 3 ? 'rgba(120,20,16,0.45)' : 'rgba(255,170,150,0.4)'
        ctx.lineWidth = 2.2
        ctx.stroke()
      }
      ctx.restore()
      ctx.beginPath()
      ctx.arc(0, 0, 52, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(42,34,26,0.75)'
      ctx.lineWidth = 2.4
      ctx.stroke()
    })
  }

  /** The "+ New memory" card on its way into the gap (null before it enters). */
  function newCard(t, T) {
    const nA = T.newPin - 0.36
    if (t < nA) return null
    const n = seg(t, nA, T.newPin - 0.07)
    return {
      n,
      x: lerp(STALE.x + 920, STALE.x, E.outBack(n)),
      y: STALE.y - 70 * Math.sin(Math.PI * Math.min(1, n * 1.15)),
      rot: lerp(0.22, 0.03, E.outCubic(n)),
      land: wob(t, T.newPin, 0.045, 26, 9),
    }
  }

  /** Pip's squash while it is under the peek flap (hidden on tiptoe → anticipation dip → push-up stretch →
   *  crouched peekaboo settle with a breath → the take pop → the pre-hop crouch). */
  function underSquash(t, T) {
    let s
    if (t < T.liftA - 0.1) {
      // the pan guard releases at the cut: Pip has just dropped in behind the card, so its legs plop
      // (capped at 0.95 so the face never dips below the card's edge)
      const d = Math.max(0, t)
      s = 1.04 + 0.012 * Math.sin(t * 7) - 0.09 * Math.exp(-12 * d) * Math.cos(18 * d)
    }
    else if (t < T.liftA) s = lerp(1.04, 1, E.inOutQuad(seg(t, T.liftA - 0.1, T.liftA)))
    else if (t < T.liftB) s = lerp(1, 1.06, E.outQuad(seg(t, T.liftA, T.liftB)))
    else {
      const d = t - T.liftB
      s = SH + (1.06 - SH) * Math.exp(-10 * d) * Math.cos(15 * d) + 0.008 * Math.sin(d * 6)
    }
    s += 0.04 * bump(t, T.take, T.take + 0.16)
    if (t > T.hop0 - 0.1) s -= 0.08 * Math.sin((Math.PI / 2) * seg(t, T.hop0 - 0.1, T.hop0))
    return s
  }
  /** Flap lift whose curl lip sits at Pip's raised mitts (hands ≈ 2 px below the lip), clamped to 0..1. */
  function liftForSquash(s) {
    const target = (FLOOR - HANDS_HI(s) + 2 - PEEK.y) / PEEK.s // card-local y of the lip bottom
    const h = PEEK.h
    const f = (a) => -h / 2 + h * Math.cos(a) + (18 * Math.sin(a)) / Math.sin(MAXA)
    if (target <= f(MAXA)) return 1
    let lo = 0.25
    let hi = MAXA
    for (let i = 0; i < 18; i++) {
      const m = (lo + hi) / 2
      if (f(m) > target) lo = m
      else hi = m
    }
    return clamp01(1 - Math.sqrt(Math.max(0, 1 - lo / MAXA)))
  }
  /** The peek flap's lift at t: swings up on "Peek", then rides Pip's hands; flops shut once Pip is gone. */
  function flapLift(t, T) {
    if (t < T.liftA) return 0
    if (t < T.liftB) return E.outCubic(seg(t, T.liftA, T.liftB))
    if (t < T.hop0) return liftForSquash(underSquash(t, T))
    const l0 = liftForSquash(underSquash(T.hop0 - 1e-4, T))
    return l0 * (1 - E.outBounce(seg(t, T.flap0, T.flap0 + 0.24)))
  }

  /** Pip for this frame: returns { x, y (feet), o, under } — the whole performance lives here.
   *  under = drawn between the peek flap's 'under' and 'flap' parts. */
  function pipAt(t, T) {
    const base = { scale: SP, id: 's7pip', blush: 1.15 }
    // ── A: behind / under the peek flap: hidden, the "Peek" push-up, the peekaboo bob, the double take
    if (t < T.hop0 - 0.1) {
      const squash = underSquash(t, T)
      const take = t >= T.take && t < T.take + 0.45
      const look = lookSeq(t, [[-9, [0.1, -0.7]], [T.take, [0, 0.15]], [T.tap - 0.36, [1, -0.55]], [T.hop0 - 0.22, [1, -0.3]]])
      const decided = t > T.hop0 - 0.22
      return {
        x: PEEK.x,
        y: FLOOR,
        under: true,
        o: Object.assign(base, {
          pose: 'carry',
          poseT: t + 3,
          stride: 0,
          carryW: PEEK_CW,
          carryH: PEEK_CH,
          squash,
          look,
          eyes: take ? 'wide' : 'normal',
          mouth: take ? 'o' : t < T.take ? 'open' : decided ? 'smile' : 'grin',
          brows: take ? 'raised' : decided ? 'determined' : null,
          blink: take || t < T.take ? 0 : null,
          blush: take ? 1.4 : 1.15,
        }),
      }
    }
    // ── B: pre-crouch under the flap, then a low hop (arms up) over to the stale card
    if (t < T.land) {
      const h = PIP.hop(t, T.hop0, { dur: T.hopDur, height: HOP_H, pre: 0.1 })
      const pre = t < T.hop0
      const squash = pre ? underSquash(t, T) : h.squash
      const p = seg(t, T.hop0, T.land)
      const vy = h.air ? (-HOP_H * 4 * (1 - 2 * h.p)) / T.hopDur : 0
      return {
        x: lerp(PEEK.x, STALE.x, p),
        y: FLOOR + h.y,
        under: pre,
        o: Object.assign(base, {
          pose: 'carry',
          poseT: t + 3,
          stride: 0,
          carryW: lerp(PEEK_CW, 110, E.outCubic(seg(t, T.hop0, T.hop0 + 0.12))),
          carryH: lerp(PEEK_CH, 10, E.outCubic(seg(t, T.hop0, T.hop0 + 0.12))),
          squash,
          air: -h.y,
          vel: h.air ? [(STALE.x - PEEK.x) / T.hopDur, vy] : [0, 0],
          look: lookSeq(t, [[-9, [1, -0.3]], [T.hop0 + 0.12, [0.5, -0.8]]]),
          eyes: 'normal',
          brows: 'determined',
          mouth: h.air ? 'open' : 'smile',
        }),
      }
    }
    const k = SC / SP
    // ── C: landed under the stale card, looking up; flinches at the THUNK
    if (t < T.grab - 0.08) {
      const h = PIP.hop(t, T.hop0, { dur: T.hopDur, height: HOP_H, pre: 0.1 })
      const fl = bump(t, T.stamp - 0.02, T.stamp + 0.14)
      const shut = t >= T.stamp - 0.02 && t < T.stamp + 0.09
      return {
        x: STALE.x,
        y: FLOOR,
        o: Object.assign(base, {
          pose: 'idle',
          poseT: t - T.land,
          squash: h.squash - 0.1 * fl,
          look: [0.05, -1],
          eyes: shut ? 'shut' : 'normal',
          brows: shut ? 'worried' : 'determined',
          mouth: shut ? 'wobbly' : 'smile',
          blink: shut ? null : 0,
        }),
      }
    }
    // ── D: reaches up to the card's sides (tiptoe stretch)
    if (t < T.grab) {
      return {
        x: STALE.x,
        y: FLOOR,
        o: Object.assign(base, { pose: 'carry', poseT: t - T.grab + 3, stride: 0, carryW: 260 * k, carryH: 180 * k, squash: 1 + 0.035 * bump(t, T.grab - 0.08, T.grab), look: [0.05, -1], brows: 'determined', mouth: 'flat' }),
      }
    }
    // ── E: holds the card overhead (STALE readable, pin pops), then crumples it (hands squeeze in)
    if (t < T.throw0) {
      const cp = seg(t, T.crA, T.crB)
      const e = E.inOutCubic(cp)
      const bw = 2 * 58 * k
      const squash = 1 - 0.05 * bump(t, T.grab, T.grab + 0.2) - 0.04 * bump(t, T.crA, T.crB) + 0.07 * bump(t, T.crB - 0.02, T.crB + 0.14)
      return {
        x: STALE.x,
        y: FLOOR,
        o: Object.assign(base, {
          pose: 'carry',
          poseT: t - T.grab + 3,
          stride: 0,
          carryW: lerp(260 * k, bw, e),
          carryH: lerp(180 * k, bw, e),
          squash,
          look: [0.1, -1],
          eyes: cp > 0.15 && cp < 0.9 ? 'squint' : 'normal',
          brows: 'determined',
          mouth: cp > 0.1 && cp < 1 ? 'wobbly' : cp >= 1 ? 'grin' : 'flat',
          hold: (g) =>
            K.at(g, 0, 0, 0, k, () => {
              if (cp <= 0) staleCard(g, t, T, { local: true, pinPop: seg(t, T.grab - 0.06, T.grab + 0.08) })
              else staleBall(g, t, T, cp)
            }),
        }),
      }
    }
    // ── F: throw (release on "tidy") and follow-through
    if (t < T.in) {
      return {
        x: STALE.x,
        y: FLOOR,
        o: Object.assign(base, {
          pose: 'throw',
          poseT: t - T.throw0 + 0.2,
          look: [1, -0.45],
          brows: t < T.rel ? 'determined' : null,
          hold: (g) => K.at(g, 0, 0, 0, k, () => staleBall(g, t, T, 1)),
        }),
      }
    }
    // ── G: cheer hop on the swish, then clap for the new card
    if (t < T.newPin + 0.04) {
      const h = PIP.hop(t, T.in + 0.04, { dur: 0.36, height: 46, pre: 0.06 })
      return {
        x: STALE.x,
        y: FLOOR + h.y,
        o: Object.assign(base, { pose: 'cheer', poseT: t - T.in, squash: h.squash, air: -h.y, eyes: 'happy', mouth: 'open', look: [1, -0.2], blush: 1.35 }),
      }
    }
    // ── H: claps for the new card, then (on a beat) a proud little look to camera to button the scene
    if (t < T.proud) {
      return {
        x: STALE.x,
        y: FLOOR,
        o: Object.assign(base, { pose: 'clap', poseT: t - T.newPin, eyes: 'happy', mouth: 'grin', look: [0, -1], blush: 1.35 }),
      }
    }
    const pd = t - T.proud
    return {
      x: STALE.x,
      y: FLOOR,
      o: Object.assign(base, {
        pose: 'idle',
        poseT: pd,
        squash: 1 + 0.07 * Math.exp(-9 * pd) * Math.cos(20 * pd),
        eyes: pd < 0.5 ? 'normal' : 'happy',
        blink: pd < 0.5 ? 0 : null,
        mouth: 'grin',
        look: lookSeq(t, [[-9, [0, -1]], [T.proud, [0, 0.1]]]),
        blush: 1.4,
      }),
    }
  }

  PROMO.scene('s7-memory', {
    draw(ctx, t, dur, info) {
      const T = beats(info)
      const cam = info && info.camShift ? info.camShift(t) : { dx: 0, dy: 0 }
      const layer = (k, fn) => K.at(ctx, Math.round(-k * cam.dx), Math.round(-k * cam.dy), 0, 1, fn)

      // ── background: the craft table moves least
      layer(0.42, () => K.desk(ctx))

      // ── the board layer (board, cards, Pip, button)
      layer(0.12, () => {
        P.corkboard(ctx, BOARD.x, BOARD.y, t, { scale: BOARD.s, titleIn: seg(t, -0.12, 0.2), id: 's7cork', nudge: 0.3 })
        yarnBall(ctx, t)

        // pale blue squiggle card, pinned second
        pinCard(ctx, t, T.tacks[1], DCARD, { from: [-300, 170, -0.55], card: { id: 's7d', color: DCARD.color } })

        // the stale card (until Pip lifts it off its pin)
        if (t < T.grab) staleCard(ctx, t, T, { pinPop: seg(t, T.grab - 0.06, T.grab + 0.08) })

        // the cluster: pinning → yarn → clipBundle gather (+ our pulling yarn) / clip / Clusters tag
        if (t < T.gs) bundleCardsPinning(ctx, t, T)
        else {
          const g = seg(t, T.gs, T.gs + T.gd)
          P.clipBundle(ctx, BUN.x, BUN.y, t, {
            id: 's7b',
            nudge: 0,
            scale: BUN.s,
            cards: CARDS,
            spread: SPREAD,
            gather: g,
            clip: seg(t, T.clip, T.clip + 0.16),
            tagIn: seg(t, T.tagIn, T.tagIn + 0.45),
          })
          bundleExtras(ctx, t, T, g)
        }

        // the Aggregate button + the arrow that lands on the Clusters tag
        const press = seg(t, T.tap - 0.05, T.tap) - seg(t, T.tap + 0.12, T.tap + 0.22)
        aggButton(ctx, t, press)
        const ap = E.outCubic(seg(t, T.arrowA, T.arrowB))
        if (ap > 0) K.arrow(ctx, ARROW.a[0], ARROW.a[1], ARROW.b[0], ARROW.b[1], 's7arrow', t, { progress: ap, bend: 0.2, stroke: C.terracotta, strokeWidth: 5.5, roughness: 1.1, head: 26 })

        // the fresh card slides into the gap (carried in by mitten #2, drawn in the fg layer); it sits
        // behind Pip so Pip's clapping hands stay in front of it
        const nc = newCard(t, T)
        if (nc) {
          P.memoryCard(ctx, nc.x, nc.y, t, { id: 's7new', text: '+ New memory', color: 'mint', rot: nc.rot, pin: t >= T.newPin - 0.07, pinPress: seg(t, T.newPin - 0.07, T.newPin), scale: [SC * (1 + nc.land), SC * (1 - nc.land)] })
          const sp = seg(t, T.newPin, T.newPin + 0.45)
          if (sp > 0 && sp < 1) {
            K.withAlpha(ctx, 1 - sp, () => {
              K.twinkle(ctx, STALE.x + 150, STALE.y - 92 - 10 * sp, 15 * (1 - 0.3 * sp), 's7tw1', t, C.lemon)
              K.twinkle(ctx, STALE.x - 150, STALE.y - 70 - 14 * sp, 11 * (1 - 0.3 * sp), 's7tw2', t, C.mustard)
            })
          }
        }

        // the peek flap: under-shade → Pip (while it is under) → the flap
        const lift = flapLift(t, T)
        const peekO = { id: 's7peek', color: 'peach', lift, scale: PEEK.s, rot: PEEK.rot, w: PEEK.w, h: PEEK.h }
        const pip = pipAt(t, T)
        // continuity: hide ours only for the pan frames where s6's Pip (s6 x≈846) is still on screen and
        // ours would be too; before that ours is off the right edge, after it the legs ride in with the card
        const hide = cam.dx > 0.5 * K.W && cam.dx < 0.76 * K.W
        card(ctx, PEEK.x, PEEK.y, t, Object.assign({ part: pip.under ? 'under' : 'both' }, peekO))
        const a = hide ? null : PIP.draw(ctx, pip.x, pip.y, t, pip.o)
        if (pip.under) card(ctx, PEEK.x, PEEK.y, t, Object.assign({ part: 'flap' }, peekO))

        // double take: four short surprise ticks off the sides of Pip's head, at eye level (below the flap)
        const tk = seg(t, T.take, T.take + 0.32)
        if (tk > 0 && tk < 1 && a && a.eyes) {
          const cx = (a.eyes[0][0] + a.eyes[1][0]) / 2
          const cy = (a.eyes[0][1] + a.eyes[1][1]) / 2 + 6
          K.withAlpha(ctx, 1 - tk * tk, () => {
            ;[-0.42, 0.28, Math.PI + 0.42, Math.PI - 0.28].forEach((ang, i) => {
              const r0 = (88 + 16 * E.outCubic(tk)) * (SP / 0.85)
              const x0 = cx + Math.cos(ang) * r0
              const y0 = cy + Math.sin(ang) * r0 * 0.8
              K.pencil.line(ctx, x0, y0, x0 + Math.cos(ang) * 22, y0 + Math.sin(ang) * 18, 's7take' + i, t, { stroke: C.ink, strokeWidth: 3.6, roughness: 0.6 })
            })
          })
        }
      })

      // ── foreground: basket (+ the ball), mittens
      layer(-0.1, () => {
        const bo = seg(t, T.in, T.in + 0.55)
        const bk = { id: 's7basket', scale: BASKET.s, bounce: bo }
        P.basket(ctx, BASKET.x, BASKET.y, t, Object.assign({ part: 'back' }, bk))
        const released = t >= T.throw0 + (PIP.THROW_RELEASE - 0.2) - 1e-6
        if (released) {
          const u = clamp01((t - T.rel) / (T.in - T.rel))
          swoosh(ctx, t, Math.max(0, u - 0.5), u, 1 - seg(t, T.in - 0.02, T.in + 0.22))
          let [bx, by] = ballAt(u)
          by += u >= 1 ? wob(t, T.in, 10, 18, 7) : 0
          const spin = -5.2 * u + (u >= 1 ? wob(t, T.in, 0.25, 16, 7) : 0)
          const st = u < 1 ? 1 + 0.08 * Math.sin(Math.PI * u) : 1
          P.crumple(ctx, bx, by, t, { id: 's7stale', stale: true, text: ' ', p: 1, rot: spin, scale: [BALL_S * st, BALL_S / st] })
        }
        P.basket(ctx, BASKET.x, BASKET.y, t, Object.assign({ part: 'front' }, bk))
        // swish marks off the rim
        const sw = seg(t, T.in, T.in + 0.24)
        if (sw > 0 && sw < 1) {
          K.withAlpha(ctx, 1 - sw, () => {
            ;[-1, 1].forEach((sx, i) => {
              const x0 = BASKET.x + sx * (120 + 16 * sw)
              const y0 = BASKET.y - 128 - 10 * sw
              K.pencil.line(ctx, x0, y0, x0 + sx * 22, y0 - 16, 's7sw' + i, t, { stroke: C.inkDim, strokeWidth: 3.2, roughness: 0.6 })
            })
          })
        }

        // mitten #1 taps Aggregate
        if (t > T.tap - 0.38 && t < T.tap + 0.52) {
          const inn = E.outCubic(seg(t, T.tap - 0.38, T.tap - 0.14))
          const out = E.inCubic(seg(t, T.tap + 0.22, T.tap + 0.52))
          const antic = -16 * bump(t, T.tap - 0.16, T.tap - 0.03)
          const press = seg(t, T.tap - 0.05, T.tap) - seg(t, T.tap + 0.12, T.tap + 0.22)
          CAST.hand(ctx, TIP[0] + 16 + 720 * (1 - inn) + 760 * out, TIP[1] + antic, t, { from: 'right', pose: 'press', press, mitten: true, id: 's7mit1' })
        }
        // mitten #2 slides the new card in by its top-right corner (clear of the basket), then lets go
        const nc = newCard(t, T)
        if (nc && t < T.newPin + 0.4) {
          const off = rotPt([118 * SC, -58 * SC], nc.rot)
          const away = E.inCubic(seg(t, T.newPin + 0.05, T.newPin + 0.4))
          CAST.hand(ctx, nc.x + off[0] + 820 * away, nc.y + off[1] - 40 * away, t, { from: 'right', pose: 'pinch', mitten: true, id: 's7mit2' })
        }
      })
    },

    sfx(dur, info) {
      const T = beats(info)
      const out = []
      const cue = (tt, type, o = {}) => {
        if (tt >= -0.05 && tt <= dur + 0.2) out.push(Object.assign({ t: Math.max(0, tt), type }, o))
      }
      // four tacks (A top-left, D bottom-left, B top-middle, C top-right)
      const tackX = [BUN.x - 285, DCARD.x, BUN.x, BUN.x + 285]
      T.tacks.forEach((tt, i) => cue(tt, 'tack', { gain: 0.95, pitch: [1, 1.12, 0.94, 1.22][i], pan: panOf(tackX[i]) }))
      // the peek
      cue(T.liftA, 'flap', { gain: 0.85, pitch: 1.05, pan: panOf(PEEK.x) })
      cue(T.take, 'rattle', { gain: 0.6, pitch: 1.25, pan: panOf(PEEK.x) })
      // aggregate: mitten in, tap, twang, pins pop, second twang as the yarn pulls, riffle of the slide
      cue(T.tap - 0.36, 'swoosh', { gain: 0.3, dur: 0.3, pitch: 1.2, pan: 0.8 })
      cue(T.tap, 'button', { gain: 1.1, pan: panOf(BTN.x) })
      cue(T.gs + 0.1 * T.gd, 'twang', { gain: 0.9, pitch: 1, pan: panOf(BUN.x) })
      ;[0, 1, 2].forEach((i) => cue(T.gs + (0.2 + 0.04 * i) * T.gd, 'pop', { gain: 0.35, pitch: 1.3 + 0.18 * i, pan: panOf(BUN.x + (i - 1) * 285) }))
      cue(T.gs + 0.3 * T.gd, 'twang', { gain: 0.6, pitch: 1.28, pan: panOf(BUN.x + 60) })
      cue(T.gs + 0.5 * T.gd, 'riffle', { gain: 0.35, dur: 0.25, pitch: 1.1, pan: panOf(BUN.x) })
      // Pip leaves the flap (boing on take-off, the flap flops shut)
      cue(T.hop0, 'boing', { gain: 0.28, pitch: 1.5, pan: panOf(PEEK.x) })
      cue(T.flap0 + 0.06, 'flap', { gain: 0.35, pitch: 0.78, pan: panOf(PEEK.x) })
      // the bundle ties off: clip clack, bow pluck
      cue(T.clip + 0.1, 'clack', { gain: 0.3, pitch: 1.35, pan: panOf(BUN.x + 90) })
      cue(T.gs + 0.9 * T.gd, 'pluck', { gain: 0.45, note: 81, pan: panOf(BUN.x) })
      // Pip lands; the STALE stamp gets ±0.1 s to itself
      cue(T.land, 'thup', { gain: 0.4, pitch: 1.3, pan: panOf(STALE.x) })
      cue(T.stamp, 'stamp', { gain: 1, pan: panOf(STALE.x) })
      // unpin, crumple, throw, swish
      cue(T.grab + 0.02, 'pop', { gain: 0.5, pitch: 1.15, pan: panOf(STALE.x) })
      cue(T.crA, 'crumple', { gain: 0.95, dur: Math.max(0.25, T.crB - T.crA + 0.04), pan: panOf(STALE.x) })
      cue(T.crB - 0.03, 'bwomp', { gain: 0.6, pan: panOf(STALE.x) })
      cue(T.rel, 'swoosh', { gain: 0.45, dur: 0.3, pan: panOf(LAUNCH[0]) })
      cue(T.in - 0.03, 'swish', { gain: 1, pan: panOf(BASKET.x) })
      cue(T.ding, 'plink', { gain: 0.75, pitch: 1, pan: panOf(BASKET.x) })
      // the fresh card
      cue(T.newPin - 0.3, 'swoosh', { gain: 0.22, dur: 0.26, pitch: 1.3, pan: 0.8 })
      cue(T.newPin, 'tack', { gain: 0.9, pitch: 1.32, pan: panOf(STALE.x) })
      cue(T.newPin + 0.05, 'sparkle', { gain: 0.45, pan: panOf(STALE.x) })
      return out
    },
  })
})()

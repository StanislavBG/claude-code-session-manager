/* mascot.js — PIP (the star) + CAST (the supporting players), drawn in kit.js's paper-collage language.
 *
 * LAWS: every function is a PURE function of its arguments (t, o). Nothing survives between calls.
 * Randomness only via K.rng / K.ro seeded by o.id; pencil lines boil via K.boil(t); pieces get a tiny
 * stop-motion K.nudge. No ctx.shadowBlur / ctx.filter — depth = K.paper / K.dropShadow only.
 * Follow-through (lagging googly pupils, cowlick flop, scarf tails, antenna) is computed WITHOUT state:
 * the pose's own motion is re-sampled over the last ~0.5 s of poseT and run through a damped-spring
 * kernel (see lagOf). Motion the caller adds (moving x/y) can be fed in with o.vel / o.squash / o.air.
 *
 * Every draw fn: fn(ctx, x, y, t, o = {}) with defaults for everything. Common options:
 *   id     seed string (default per function)       scale  1          rot  0 (rad, world)
 *   flip   false = faces right (+x); true mirrors   look   [lx, ly] -1..1 in WORLD space (flip is compensated)
 *   pose   see each fn                               poseT  seconds since the pose began (default t) — drives
 *                                                           cycles and one-shot moves; clamped ≥ 0, so a t a
 *                                                           little outside [0, dur] is safe
 * Returned anchors are always in the CALLER's coordinate space (current transform at call time).
 * WALKING without foot-slide: every walk cycle has a linear stance, so move the character at exactly
 *   PIP.WALK_SPEED / CAST.HELPER_WALK_SPEED / CAST.VISITOR_WALK_SPEED (px/s at scale 1) × scale × stride,
 *   in the direction it faces (flip:true → toward −x). Other speeds slide (or moonwalk).
 *
 * ─────────────────────────────── PIP ───────────────────────────────
 * PIP.draw(ctx, x, y, t, o) → { hands:[[x,y],[x,y]], head, antenna, feet:[[x,y],[x,y]], eyes:[[x,y],[x,y]],
 *                               holdAt, center, tool, tip, released }
 *   (x, y) = ground point between the feet. For 'sit' and 'ride' it is the SEAT point under Pip's bottom edge
 *   (legs dangle below it). With o.peek > 0 it is the hiding EDGE (see peek).
 *   o.pose   'idle' | 'hop' | 'cheer' | 'clap' | 'point' | 'carry' | 'thwack' | 'peek' | 'squint' | 'bow' | 'sit' |
 *            'hug' | 'wave' | 'slide' | 'ride' | 'catch' | 'throw' | 'fold'   (+ extras 'walk', 'give')
 *            cycles: idle hop cheer clap carry peek squint sit hug wave slide ride fold walk give
 *            one-shots (hold their last frame):
 *              point  jab over 0.32 s (outBack), three "boop" ticks at the fingertip ~0.13–0.47
 *              thwack wind-up behind the head 0→0.32, hit at PIP.THWACK_HIT = 0.42, settles by 0.9
 *              bow    0.1 s rise, the card FOLDS forward at the scarf line (down by PIP.BOW.down = 0.4),
 *                     holds, rises from 0.9 with a small overshoot, upright by PIP.BOW.up = 1.2
 *              catch  hands sweep up outside the card, catch at PIP.CATCH_AT = 0.25, item at the chest by 0.62
 *              throw  wind-up arcs over the head (hand + item behind the card), forward snap 0.30→0.40,
 *                     release at PIP.THROW_RELEASE = 0.38 with the hand forward-up (anchors.hands[1] there is
 *                     the launch point); o.hold is no longer drawn once anchors.released is true
 *            'walk'  stride cycle 0.56 s; ground speed PIP.WALK_SPEED × scale × o.stride (see WALKING above)
 *            'give'  holds an item out to the right with both mitts (s5 hand-over)
 *   o.poseT  = t
 *   o.stride = 1 ('walk') / 0 ('carry')  0..1 foot travel; 'carry' with stride 1 walks at PIP.WALK_SPEED too
 *   o.squash = null    override scaleY (pass PIP.hop(...).squash); scaleX compensates, knees bend when < 1
 *   o.air    = 0       WORLD px Pip is above its ground (caller-driven jumps: draw at groundY + hop.y and pass
 *                      air = -hop.y) → the contact shadow stays on the ground and shrinks with height
 *   o.vel    = [0, 0]  caller's motion in px/s (world) → pupils, scarf tails, antenna and cowlick trail it
 *   o.mouth  = pose default | 'smile' | 'grin' | 'o' | 'open' | 'flat' | 'wobbly'  (+ 'tongue')
 *   o.eyes   = pose default | 'normal' | 'happy' (^ ^) | 'squint' | 'wide' | 'shut' (> <)
 *   o.brows  = pose default | null | 'determined' | 'worried' | 'squint' | 'focus' | 'raised'
 *   o.blink  = null    0..1 forces the eyelids (e.g. a deliberate slow blink); null = automatic blinking
 *                      (automatic blinks snap shut and are suppressed while the brows are 'determined')
 *   o.eyeSpin = 0      0..1: the big eye's pupil rolls once around the rim (0 and 1 look normal)
 *   o.blush   = 1      0..1
 *   o.nightcap = false navy paper nightcap (cream stripes, moon dots, moonlit rim; drooping tip follows through)
 *   o.lantern  = 0     0..1 antenna bulb glow (halo radius ~40..95 px)
 *   o.glue     = false sage glue stick in the right-side hand (always on in 'thwack'); tip → anchors.tool
 *   o.hold     = null  fn(ctx) — draws an item in a local frame whose origin is the grip point (anchors.holdAt),
 *                      in Pip's scale, never mirrored by flip. Draw the item CENTRED on the origin.
 *                      Layer: between Pip's body and its arms/hands (hands grip over it); in 'throw' while the
 *                      hand is behind the card the item is drawn behind the card too.
 *                      Grip points: carry = over the head (see carryW/H; o.carryLow → at the tummy),
 *                      hug/catch/fold = tummy (catch: overhead until 0.32), squint/give = held out to the right,
 *                      throw = the throwing hand (until release).
 *   o.carryLow = false 'carry' holds the item at the tummy instead of overhead
 *   o.carryW   = 170   'carry' overhead: item width (local px at scale 1) → the hands grip its sides
 *   o.carryH   = 120   'carry' overhead: item height → holdAt = item centre, its bottom edge ~10 px above the
 *                      card top, so the item never covers the face (the antenna squashes flat under it)
 *   o.aim      = -0.3  'point' direction in radians (0 = +x/forward, negative = up); keep within ±90° of
 *                      forward and use flip to point the other way
 *   o.peek     = 0     0..1 — Pip sinks behind an edge at y (everything below y is clipped). 1 = only the top of
 *                      the card + the eyes show. Pair with pose 'peek' for darting eyes + hands gripping the edge.
 *   o.shadow   = true  ground contact shadow (off automatically for sit/ride/peek)
 *   anchors: hands[0] = Pip's left-side (margin-side) hand, hands[1] = right-side hand (glue/point/throw/wave).
 *            head = top centre of the card, antenna = bulb centre, holdAt = grip point, center = card centre,
 *            tool = glue-stick tip (null without glue), tip = pointing fingertip ('point' only, else null),
 *            released = true once a 'throw' has let go.
 * PIP.hop(t, t0, { dur = 0.5, height = 90, pre = 0.1 }) → { y, p, squash, air }
 *   jump arc starting at t0 (anticipation crouch from t0 - pre). y ≤ 0 is up, in the caller's px (add it to your
 *   ground y and pass air: -y), p = 0..1 airborne progress, air = airborne bool,
 *   squash = scaleY (0.84 crouch → 1.15 take-off stretch → 0.8 landing → springs back to 1).
 * PIP.size → { w: 150, h: 200 }   (card body at scale 1; legs add 40 px, antenna ~60 px)
 * PIP.POSES, PIP.MOUTHS, PIP.THROW_RELEASE (0.38), PIP.THWACK_HIT (0.42), PIP.CATCH_AT (0.25),
 * PIP.BOW ({ down: 0.4, up: 1.2 }), PIP.WALK_SPEED (≈128.6 px/s at scale 1, stride 1)
 * Cost (dev/cast.js page 4, forced raster, shared loaded machine): PIP.draw ≈ 3.0 ms mean (worst input 4.6);
 * the bow's fold frames ≈ 1.25x an idle frame; CAST helper 1.0 · agent 2.7 · you 3.5 · hand 3.6 · visitor 1.8 ms.
 *
 * ─────────────────────────────── CAST ───────────────────────────────
 * CAST.helper(ctx, x, y, t, o) → { hands, head, tool, feet, center }
 *   Sticky-note job helper (84 x 84 note + pencil legs; ~150 px tall at scale 1). (x, y) = ground point
 *   ('sit' / 'tea': the seat point on the floor).
 *   o.color 'sage' | 'teal' | 'peach' (also 'butter' | 'pink' | 'mint' | 'lemon' | any hex)   default 'sage'
 *   o.pose  'idle' | 'walk' | 'hammer' | 'magnify' | 'check' | 'tea' | 'sit' | 'hop' | 'cheer'
 *     walk:    0.44 s cycle; ground speed CAST.HELPER_WALK_SPEED (≈118 px/s) × scale
 *     hammer:  tiny pencil hammer, cycle 0.5 s, strikes at poseT ≡ CAST.HAMMER_HIT (0.35) mod 0.5;
 *              anchors.tool = strike face (≈ 95 px right of, 25–40 px above the feet at scale 1 — read it at the hit)
 *     magnify: holds a magnifier over its eye (the eye swells inside the lens), scanning
 *     check:   green crayon writes a check from poseT 0.12→0.5 then holds; anchors.tool = check centre
 *     tea:     sits with a tiny paper teacup, sips every 2.6 s; steam curls
 *   o.look, o.flip, o.poseT, o.scale, o.rot, o.id
 *
 * CAST.agent(ctx, x, y, t, o) → { hands, head, feet, center, holdAt }   (mini → { center, head })
 *   Paper-doll trading card with googly eyes (116 x 160 card + legs; ~250 px tall incl. hat at scale 1).
 *   (x, y) = ground point between the feet; with o.mini it is the card CENTRE.
 *   o.kind 'architect' (honey border, terracotta hard hat — a ridged rounded-triangle dome, rolled blueprint)
 *        | 'devlead' (hive-teal border, wrench, pencil behind the "ear") | 'validator' (sage border, magnifier)
 *   o.pose 'idle' | 'wave' | 'hop' | 'tear' (hands pull apart at the tummy — pass o.hold to draw the napkin) | 'fan'
 *   o.flip NUMBER 0..1 = card flip about its vertical axis: the whole doll (card, limbs, props) foreshortens,
 *          arms + props fade out edge-on, ≥ 0.5 shows the patterned back.
 *          o.flip === true (the boolean every other fn uses) = face left, same as o.mirror.
 *   o.mirror = false  face left (mirrors the doll; check marks are pre-mirrored so they never read backwards)
 *   o.mini false → tiny icon card (68 x 92 at scale 1, no limbs) for the Hot keys button: face panel + a white
 *          name plate carrying the kind's emblem (hard hat | wrench | lens); the architect also wears its hat
 *   o.hold fn(ctx) drawn at anchors.holdAt ('tear' pose: between the hands; the kind's prop is put away)
 *
 * CAST.you(ctx, x, y, t, o) → { head, hands, feet, zzz }
 *   "YOU" stick figure (paper head + striped pajama top). (x, y) = floor point under the bed centre when
 *   o.inBed, else the ground point between the feet (in bed the figure sits at x - 70).
 *   o.pose 'sleep' | 'stretch' (sits up, arms up, yawns) | 'wake' (sits up, eyes open, little wave)
 *   o.inBed = true   paper bed with patchwork quilt
 *   o.bedFlat = 0    0..1 the bed squashes flat and fades (gone by 0.75); the legs arrive 0.5→0.9 and YOU stands
 *   o.zzz = false    crayon Z's boil upward from the head (o.zzzColor, default moon butter)
 *
 * CAST.hand(ctx, x, y, t, o) → { tip, palm, wrist, holdAt }
 *   Cut-out human hand on a sleeve that runs off-screen toward o.from. (x, y) = the fingertip for
 *   'point' | 'press'; the pinch point for 'pinch'; the grip point for 'hold'; the palm centre for 'drop' | 'open'.
 *   o.from 'right' | 'left' | 'top' | 'bottom'   (default 'right': the arm comes from the right edge)
 *   o.pose 'point' | 'press' | 'pinch' | 'hold' | 'drop' | 'open' (palm up, four fingers + thumb; item at holdAt)
 *   o.press 0..1 finger push (default 0 for 'point', 1 for 'press'): the tip travels o.push (16) px further in
 *   o.mitten false → terracotta knit mitten with a pointing mitten-finger
 *   o.sleeve colour (default C.blue), o.reach sleeve length (1600), o.hold fn(ctx) item at the grip,
 *   o.mirror swaps thumb side
 *
 * CAST.visitor(ctx, x, y, t, o) → { head, hands, feet }
 *   Googly-eyed gallery visitor (~215 px tall at scale 1: big head, short legs). (x, y) = ground point.
 *   o.pose 'walk' (0.62 s cycle; ground speed CAST.VISITOR_WALK_SPEED ≈ 90 px/s × scale) | 'stop' (momentum
 *          settle) | 'clap' | 'ooh' (hands to cheeks)
 *   o.color shirt / dress colour (default C.sky)
 *   o.outfit 'tee' (+ trousers) | 'dress' | 'overalls' | 'skirt'   default: picked from o.id (CAST.OUTFITS)
 *   o.hair 0 bun | 1 bob | 2 curls | 3 beret          default: picked from o.id; skin tone also varies with o.id
 *   o.bottoms colour of trousers / skirt / overalls (default picked from o.id; overalls default denim)
 *   o.poseT, o.look, o.flip
 *
 * CAST.HELPER_POSES, CAST.AGENT_POSES, CAST.AGENT_KINDS, CAST.STICKY (colour map), CAST.HAMMER_HIT (0.35),
 * CAST.HELPER_WALK_SPEED, CAST.VISITOR_WALK_SPEED, CAST.OUTFITS
 */
(function () {
  'use strict'
  const C = K.C
  const TAU = Math.PI * 2
  const { clamp, clamp01, lerp, seg } = K
  const E = K.ease

  // ───────── small math ─────────
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
  const mul = (a, s) => [a[0] * s, a[1] * s]
  const mix = (a, b, p) => [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p]
  const rot2 = (p, a) => {
    const c = Math.cos(a)
    const s = Math.sin(a)
    return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
  }
  const vlen = (a) => Math.hypot(a[0], a[1])
  const num = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d)
  const wave = (t, period, ph = 0) => Math.sin((TAU * t) / period + ph)
  const polar = (c, a, r) => [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]
  const springOut = (x, k = 8, w = 16) => (x <= 0 ? 0 : 1 - Math.exp(-k * x) * Math.cos(w * x))
  const ring = (x, k = 8, w = 16) => (x <= 0 ? 0 : Math.exp(-k * x) * Math.cos(w * x))
  function clampLen(v, m) {
    const l = vlen(v)
    return l > m ? mul(v, m / l) : v
  }

  // ───────── shared paper + pencil helpers ─────────
  /** Map points from the current local frame back into the caller's frame (captured as `base`). */
  function mapper(ctx, base) {
    const m = base.inverse().multiply(ctx.getTransform())
    return (p) => [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f]
  }
  function bbox(pts) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of pts) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
    return [x0, y0, x1, y1]
  }
  /** Stadium polygon between centres a and b. */
  function capsule(a, b, r, n = 5) {
    const d = sub(b, a)
    const ang = Math.atan2(d[1], d[0])
    const pts = []
    for (let i = 0; i <= n; i++) {
      const q = ang + Math.PI / 2 + (i / n) * Math.PI
      pts.push([a[0] + Math.cos(q) * r, a[1] + Math.sin(q) * r])
    }
    for (let i = 0; i <= n; i++) {
      const q = ang - Math.PI / 2 + (i / n) * Math.PI
      pts.push([b[0] + Math.cos(q) * r, b[1] + Math.sin(q) * r])
    }
    return pts
  }
  const rrect = (x, y, w, h, r, steps = 4) => K.roundRectPts(x, y, w, h, r, steps)
  /** Boiling rough.js pencil outline of a closed polygon. */
  function ink(ctx, pts, id, t, o = {}) {
    K.pencil.poly(ctx, pts, id, t, { stroke: o.stroke || C.ink, strokeWidth: o.w || 2.3, roughness: num(o.rough, 0.8), bowing: 0.5 })
  }
  /** A cut paper piece with grain + drop shadow + pencil outline. */
  function piece(ctx, pts, color, seed, t, o = {}) {
    const shape = K.paper(ctx, pts, color, { cut: num(o.cut, 1.3), shadow: num(o.shadow, 0.8), lift: o.lift || 0, seed, torn: o.torn || 0 })
    if (o.line !== false) ink(ctx, o.linePts || pts, seed + ':o', t, o)
    return shape
  }
  /** Hole-punch confetti dot (hands / feet). */
  function punch(ctx, p, r, color, seed, o = {}) {
    K.at(ctx, p[0], p[1], o.rot || 0, 1, () => {
      const shape = K.paper(ctx, K.ellipsePts(0, 0, r * (o.sx || 1), r * (o.sy || 1), 14), color, { cut: 0.6, shadow: num(o.shadow, 0.75), seed })
      K.pathPoly(ctx, shape)
      ctx.lineWidth = o.lw || 1.8
      ctx.strokeStyle = 'rgba(42,34,26,0.85)'
      ctx.stroke()
      ctx.beginPath()
      ctx.ellipse(-r * 0.3 * (o.sx || 1), -r * 0.34 * (o.sy || 1), r * 0.3, r * 0.2, -0.5, 0, TAU)
      ctx.fillStyle = 'rgba(255,255,255,0.32)'
      ctx.fill()
    })
  }
  /** Rubber-hose pencil limb from a to b (nominal length L; bows when shorter). Returns the unit
   *  direction the limb arrives at b with (forearm direction). */
  function hose(ctx, a, b, L, bend, id, t, o = {}) {
    const d = sub(b, a)
    const dl = vlen(d) || 1
    if (o.slack) L = Math.max(L, dl * (1 + o.slack)) // stretched limbs keep a gentle bow instead of a ruler line
    const off = Math.sqrt(Math.max(0, L * L - dl * dl)) * 0.5 * bend
    const n = [-d[1] / dl, d[0] / dl]
    const c = [(a[0] + b[0]) / 2 + n[0] * off, (a[1] + b[1]) / 2 + n[1] * off]
    const m = [0.25 * a[0] + 0.5 * c[0] + 0.25 * b[0], 0.25 * a[1] + 0.5 * c[1] + 0.25 * b[1]]
    K.pencil.curve(ctx, [a, m, b], id, t, { stroke: o.color || C.inkDim, strokeWidth: o.w || 3.4, roughness: num(o.rough, 0.55), bowing: 0.4 })
    const dir = sub(b, c)
    const dd = vlen(dir) || 1
    return [dir[0] / dd, dir[1] / dd]
  }
  /** Bend sign that bows a limb away from the body centreline (side -1 = left limb, +1 = right). */
  function autoBend(a, b, side) {
    const d = sub(b, a)
    return -d[1] * side >= 0 ? 1 : -1
  }
  /** Diagonal washi stripes clipped to pts. */
  function stripes(ctx, pts, color, alpha, gap, w) {
    const [x0, y0, x1, y1] = bbox(pts)
    const h = y1 - y0
    ctx.save()
    K.pathPoly(ctx, pts)
    ctx.clip()
    ctx.globalAlpha *= alpha
    ctx.strokeStyle = color
    ctx.lineWidth = w
    ctx.beginPath()
    for (let x = x0 - h; x < x1 + h; x += gap) {
      ctx.moveTo(x, y1)
      ctx.lineTo(x + h, y0)
    }
    ctx.stroke()
    ctx.restore()
  }
  /** Translucent striped washi-tape piece. */
  function washi(ctx, pts, base, stripe, o = {}) {
    const sh = num(o.shadow, 0.5)
    if (sh > 0) K.dropShadow(ctx, pts, sh, 0)
    ctx.save()
    K.pathPoly(ctx, pts)
    ctx.globalAlpha *= num(o.alpha, 0.96)
    ctx.fillStyle = K.paperPattern(ctx, base)
    ctx.fill()
    ctx.restore()
    stripes(ctx, pts, stripe, num(o.stripeAlpha, 0.7), o.gap || 13, o.sw || 4.5)
  }
  /** Boiling crayon hachure strokes clipped to a shape (cheap stand-in for rough.js hachure fills). */
  function hatch(ctx, shape, color, alpha, gap, ang, seed, t, lw = 2) {
    const [x0, y0, x1, y1] = bbox(shape)
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const L = x1 - x0 + (y1 - y0)
    const dx = Math.cos(ang)
    const dy = Math.sin(ang)
    const r = K.rng('hatch', seed, K.boil(t))
    ctx.save()
    K.pathPoly(ctx, shape)
    ctx.clip()
    ctx.beginPath()
    for (let s = -L / 2; s <= L / 2; s += gap) {
      const o1 = s + (r() - 0.5) * gap * 0.45
      const o2 = s + (r() - 0.5) * gap * 0.45
      const ax = cx - dy * o1 - (dx * L) / 2
      const ay = cy + dx * o1 - (dy * L) / 2
      const bx = cx - dy * o2 + (dx * L) / 2
      const by = cy + dx * o2 + (dy * L) / 2
      ctx.moveTo(ax, ay)
      ctx.quadraticCurveTo((ax + bx) / 2 + (r() - 0.5) * 5, (ay + by) / 2 + (r() - 0.5) * 5, bx, by)
    }
    ctx.globalAlpha *= alpha
    ctx.strokeStyle = color
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.stroke()
    ctx.restore()
  }
  /** Paper eyelid sliding over a googly eye (amt 0..1 from the top), optional lower lid + slant.
   *  o.tex() is called clipped to the lid (e.g. the body's own hachure, so the lid shows no circular seam). */
  function eyelid(ctx, x, y, r, amt, color, o = {}) {
    const slant = o.slant || 0
    const low = o.low || 0
    if (amt <= 0 && low <= 0) return
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, r + 2.6, 0, TAU)
    ctx.clip()
    ctx.fillStyle = K.paperPattern(ctx, color)
    const top = y - r - 3.5
    const h = (2 * r + 5) * amt
    const yl = top + h - slant * r
    const yr = top + h + slant * r
    if (amt > 0) {
      ctx.beginPath()
      ctx.moveTo(x - r - 4, top)
      ctx.lineTo(x + r + 4, top)
      ctx.lineTo(x + r + 4, yr)
      ctx.quadraticCurveTo(x, (yl + yr) / 2 + r * 0.5 * Math.min(1, amt * 2.2), x - r - 4, yl)
      ctx.closePath()
      ctx.fill()
      if (o.tex) {
        ctx.save()
        ctx.clip()
        o.tex()
        ctx.restore()
      }
    }
    if (low > 0) {
      const yb = y + r + 2 - (2 * r + 4) * low
      ctx.beginPath()
      ctx.moveTo(x - r - 4, y + r + 4)
      ctx.lineTo(x + r + 4, y + r + 4)
      ctx.lineTo(x + r + 4, yb)
      ctx.quadraticCurveTo(x, yb - r * 0.18, x - r - 4, yb)
      ctx.closePath()
      ctx.fill()
      if (o.tex) {
        ctx.save()
        ctx.clip()
        o.tex()
        ctx.restore()
      }
    }
    ctx.lineWidth = Math.max(2.4, r * 0.15)
    ctx.strokeStyle = C.ink
    ctx.lineCap = 'round'
    if (amt > 0.04) {
      ctx.beginPath()
      ctx.moveTo(x - r - 1, yl)
      ctx.quadraticCurveTo(x, (yl + yr) / 2 + r * 0.5 * Math.min(1, amt * 2.2), x + r + 1, yr)
      ctx.stroke()
    }
    ctx.restore()
    if (amt > 0.75) {
      // closed: lashes curve downward (sleepy U)
      ctx.save()
      ctx.beginPath()
      ctx.arc(x, y - r * 0.25, r * 0.82, 0.18 * Math.PI, 0.82 * Math.PI)
      ctx.lineWidth = Math.max(2.6, r * 0.16)
      ctx.strokeStyle = C.ink
      ctx.lineCap = 'round'
      ctx.stroke()
      ctx.restore()
    }
  }
  /** Second, tiny catch-light on a K.googly pupil (mirrors googly's pupil maths). */
  function sparkle2(ctx, x, y, r, t, id, look, pupil) {
    const tr = r * (1 - pupil) * 0.9
    const px = x + (look[0] + K.noise1(t * 3, 'jig', id) * 0.18) * tr
    const py = y + (look[1] + K.noise1(t * 3 + 9, 'jig', id) * 0.15) * tr
    ctx.beginPath()
    ctx.arc(px + r * pupil * 0.42, py + r * pupil * 0.36, Math.max(1, r * pupil * 0.15), 0, TAU)
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.fill()
  }
  function happyEye(ctx, x, y, r, id, t, w = 4.4) {
    K.pencil.curve(ctx, [[x - r * 0.78, y + r * 0.28], [x, y - r * 0.5], [x + r * 0.78, y + r * 0.28]], id, t, { strokeWidth: w, roughness: 0.45, bowing: 0.2 })
  }
  function shutEye(ctx, x, y, r, dir, id, t, w = 4) {
    const p = [[x - dir * r * 0.62, y - r * 0.5], [x + dir * r * 0.5, y], [x - dir * r * 0.62, y + r * 0.5]]
    K.rc(ctx).linearPath(p, K.ro(id, t, { strokeWidth: w, roughness: 0.5, bowing: 0.2 }))
  }
  const MOUTH_DARK = '#5e2b1f'
  const TONGUE = '#ef8a7a'
  /** Crayon mouths. (x, y) = mouth centre, s = size. */
  function mouth(ctx, kind, x, y, s, id, t) {
    const pen = { strokeWidth: 3.4, roughness: 0.5, bowing: 0.25 }
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(s, s)
    const filled = (d, tongue, teeth) => {
      const p = new Path2D(d)
      ctx.fillStyle = MOUTH_DARK
      ctx.fill(p)
      ctx.save()
      ctx.clip(p)
      if (teeth) {
        ctx.fillStyle = '#fffaf0'
        ctx.fillRect(-14, -9, 28, 6.5)
      }
      if (tongue) {
        ctx.beginPath()
        ctx.ellipse(tongue[0], tongue[1], tongue[2], tongue[3], 0, 0, TAU)
        ctx.fillStyle = TONGUE
        ctx.fill()
      }
      ctx.restore()
      K.pencil.path(ctx, d, id, t, pen)
    }
    switch (kind) {
      case 'grin':
        filled('M -17 -5 Q 0 -8 17 -5 Q 15 15 0 16 Q -15 15 -17 -5 Z', [3, 13, 9, 6], true)
        break
      case 'open':
        filled('M -14 -7 Q 0 -11 14 -7 Q 16 18 0 20 Q -16 18 -14 -7 Z', [2, 16, 10, 7], false)
        break
      case 'o':
        filled('M 0 -8 Q 7 -8 7 1 Q 7 10 0 10 Q -7 10 -7 1 Q -7 -8 0 -8 Z', null, false)
        break
      case 'flat':
        K.pencil.line(ctx, -11, 1, 11, 1, id, t, pen)
        break
      case 'wobbly':
        K.pencil.curve(ctx, [[-15, 2], [-9, -3], [-3, 2], [3, -3], [9, 2], [15, -2]], id, t, { strokeWidth: 3, roughness: 0.4, bowing: 0.1 })
        break
      case 'tongue': {
        const tp = new Path2D('M 2 3 Q 1 14 8 14 Q 14 14 13 2 Z')
        ctx.fillStyle = TONGUE
        ctx.fill(tp)
        K.pencil.path(ctx, 'M 2 3 Q 1 14 8 14 Q 14 14 13 2', id + 't', t, { strokeWidth: 2, roughness: 0.4 })
        K.pencil.curve(ctx, [[-15, -4], [0, 6], [15, -4]], id, t, pen)
        break
      }
      default:
        K.pencil.curve(ctx, [[-15, -4], [0, 6], [15, -4]], id, t, pen)
    }
    ctx.restore()
  }
  /** Rosy blush dab + three tiny crayon ticks. */
  function blushDot(ctx, x, y, a, rx = 11) {
    if (a <= 0.01) return
    ctx.save()
    ctx.globalAlpha *= clamp01(a)
    K.cheek(ctx, x, y, rx * 1.7)
    ctx.beginPath()
    ctx.ellipse(x, y, rx, rx * 0.6, 0, 0, TAU)
    ctx.fillStyle = 'rgba(236,128,112,0.5)'
    ctx.fill()
    if (a > 0.45) {
      ctx.strokeStyle = 'rgba(184,82,52,0.75)'
      ctx.lineWidth = Math.max(1.4, rx * 0.16)
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(x + i * rx * 0.45 - rx * 0.16, y + rx * 0.26)
        ctx.lineTo(x + i * rx * 0.45 + rx * 0.16, y - rx * 0.26)
      }
      ctx.stroke()
    }
    ctx.restore()
  }
  const BROWS = {
    // right brows stop short of the dog-ear flap (drawn over the face) so they never tuck under it
    determined: [[[-44, -183], [-13, -174]], [[11, -171], [38, -179]]],
    worried: [[[-44, -176], [-14, -186]], [[12, -183], [38, -175]]],
    squint: [[[-47, -175], [-10, -168]], [[10, -175], [25, -188], [39, -183]]],
    focus: [[[-43, -181], [-14, -176]], [[12, -174], [38, -178]]],
    raised: [[[-46, -183], [-28, -192], [-10, -186]], [[10, -182], [25, -190], [39, -184]]],
  }
  function brows(ctx, kind, id, t, sx = 1, sy = 1, ox = 0, oy = 0) {
    const b = BROWS[kind]
    if (!b) return
    b.forEach((pts, i) => {
      const p = pts.map(([x, y]) => [ox + x * sx, oy + y * sy])
      K.pencil.curve(ctx, p.length === 2 ? [p[0], mix(p[0], p[1], 0.5), p[1]] : p, id + 'b' + i, t, { strokeWidth: 3.6, roughness: 0.45, bowing: 0.2 })
    })
  }
  /** Synchronised blink for a pair of eyes (0 open → 1 shut). Occasional double blink. */
  function blinkAt(t, id) {
    const per = 3.3 + (K.hash(id, 'per') % 90) / 60
    const off = (K.hash(id, 'off') % 100) / 29
    const k = Math.floor((t + off) / per)
    const ph = t + off - k * per
    const prof = (x) => clamp01(2.2 * Math.sin(Math.PI * x)) // snaps shut: at 15 fps mostly open/closed frames
    if (ph < 0.2) return prof(ph / 0.2)
    if (K.hash(id, k) % 3 === 0 && ph > 0.3 && ph < 0.5) return prof((ph - 0.3) / 0.2)
    return 0
  }

  // ───────── follow-through without state ─────────
  // Damped-spring impulse response sampled every 1/30 s. lagOf re-samples a pose's own motion over the
  // recent past (poseT - τ) and returns (spring-filtered position − current position): the offset a
  // loosely attached part (pupil, flap, tail) shows — it trails, overshoots and rattles to rest.
  const LAG_DT = 1 / 30
  function kernel(freq, damp, n) {
    const w = []
    for (let k = 1; k <= n; k++) {
      const tau = k * LAG_DT
      w.push(Math.exp(-damp * tau) * Math.sin(freq * tau))
    }
    return w
  }
  const K_EYE = kernel(17, 6, 15)
  const K_FLAP = kernel(12, 3.6, 18)
  function lagOf(sample, pT, W) {
    const p0 = sample(pT)
    let sx = 0
    let sy = 0
    let sw = 0
    for (let k = 0; k < W.length; k++) {
      const s = sample(Math.max(0, pT - (k + 1) * LAG_DT))
      sx += W[k] * (s[0] - p0[0])
      sy += W[k] * (s[1] - p0[1])
      sw += W[k]
    }
    return [sx / sw, sy / sw]
  }

  // ═══════════════════════════════ PIP ═══════════════════════════════
  const BW = 150
  const BH = 200
  const LEG = 40
  const EAR = 38
  const SH = [[-72, -60], [72, -60]]
  const HIP = [[-30, 0], [30, 0]]
  const EYE = [{ x: -27, y: -150, r: 22 }, { x: 29, y: -146, r: 18 }]
  const MOUTH_AT = [2, -110]
  const SCARF_Y = -72
  const KNOT = [-71, -69]
  const ARM_L = 84
  const LEG_L = 46
  const PEEK_SINK = 162
  const FOLD_Y = -86 // 'bow' hinge, just above the scarf
  const HAND_R = 9.5
  const THROW_RELEASE = 0.38
  const THWACK_HIT = 0.42
  const CATCH_AT = 0.25
  const BOW = { down: 0.4, up: 1.2 }
  const WALK_P = 0.56
  const WALK_A = 18
  const WALK_SPEED = (4 * WALK_A) / WALK_P // ≈ 128.6 px/s at scale 1, stride 1
  const BODY_COL = '#eac368' // butter lifted a touch toward lemon so the honey hachure reads on it
  const HATCH_COL = '#c68f2c'
  const HATCH_A = 0.42
  const CAP_COL = '#3b5286' // navy, but lifted off the C.night sky so the cap reads at night
  const POSES = ['idle', 'hop', 'cheer', 'clap', 'point', 'carry', 'thwack', 'peek', 'squint', 'bow', 'sit', 'hug', 'wave', 'slide', 'ride', 'catch', 'throw', 'fold', 'walk', 'give']
  const MOUTHS = ['smile', 'grin', 'o', 'open', 'flat', 'wobbly', 'tongue']

  function bodyPts() {
    const pts = []
    const arc = (cx, cy, r, a0, a1) => {
      for (let i = 0; i <= 4; i++) {
        const a = a0 + ((a1 - a0) * i) / 4
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
      }
    }
    arc(-75 + 17, -200 + 17, 17, Math.PI, Math.PI * 1.5)
    pts.push([75 - EAR, -200])
    pts.push([75, -200 + EAR])
    arc(75 - 21, -21, 21, 0, Math.PI / 2)
    arc(-75 + 21, -21, 21, Math.PI / 2, Math.PI)
    return pts
  }
  const PIP_BODY = bodyPts()
  const EAR_A = [75 - EAR, -200]
  const EAR_B = [75, -200 + EAR]
  const EAR_M = mix(EAR_A, EAR_B, 0.5)
  const EAR_T = [75 - EAR, -200 + EAR] // reflection of the corner = folded tip

  /** Jump-arc helper (pure). y ≤ 0 is up. */
  function hop(t, t0, o = {}) {
    const dur = num(o.dur, 0.5)
    const height = num(o.height, 90)
    const pre = num(o.pre, 0.1)
    const x = t - t0
    if (x < -pre) return { y: 0, p: 0, squash: 1, air: false }
    if (x < 0) {
      const a = (x + pre) / pre
      return { y: 0, p: 0, squash: 1 - 0.16 * Math.sin((a * Math.PI) / 2), air: false }
    }
    if (x < dur) {
      const p = x / dur
      const squash = p < 0.45 ? 1 + 0.15 * Math.pow(1 - p / 0.45, 2) : 1 + 0.08 * Math.pow((p - 0.45) / 0.55, 2)
      return { y: -height * 4 * p * (1 - p), p, squash, air: true }
    }
    const a = x - dur
    return { y: 0, p: 1, squash: clamp(1 - 0.2 * ring(a, 9, 17), 0.8, 1.15), air: false }
  }

  /** One foot of a walk cycle → [dx, dy, footRot]. The stance half is LINEAR (the planted foot slides back at
   *  exactly 4A/P px/s), so a caller moving the character forward at that speed gets zero foot-slide; the
   *  swing half is eased with a lift arc. off = phase offset (0 / 0.5 for the two feet). */
  function gait(q, P, A, lift, off) {
    let u = q / P + off
    u -= Math.floor(u)
    if (u < 0.5) return [A - 4 * A * u, 0, 0]
    const w = (u - 0.5) * 2
    return [-A + 2 * A * E.inOutQuad(w), -lift * Math.sin(Math.PI * w), -0.28 * Math.sin(Math.PI * w)]
  }
  const bez = (a, b, c, u) => [(1 - u) * (1 - u) * a[0] + 2 * u * (1 - u) * b[0] + u * u * c[0], (1 - u) * (1 - u) * a[1] + 2 * u * (1 - u) * b[1] + u * u * c[1]]

  /** The pose rig: body transform (hip-centred, body frame y up = negative), hands, feet, face. Pure.
   *  Layering flags: behind[i] draws arm i behind the card; handFront[i] (null = !behind[i]) lets a hand that is
   *  clear of the card sit in front even though its arm runs behind (paper-doll overhead reach). */
  function rig(pose, pT, o) {
    const q = Math.max(0, pT)
    const R = {
      root: [0, -LEG],
      rot: 0,
      sx: 1,
      sy: 1,
      hands: [[-93, -12], [93, -12]],
      handsG: [null, null],
      behind: [false, false],
      handFront: [null, null],
      mitt: [null, null],
      feet: [[-34, 0], [34, 0]],
      feetRot: [0, 0],
      eyes: 'normal',
      look: [0, 0],
      mouth: 'smile',
      brows: null,
      blush: 1,
      holdAt: [0, -60],
      holdHand: -1,
      holdRot: 0,
      glue: false,
      finger: null,
      fx: null,
      speed: 0,
      released: false,
      seat: false,
      fold: 0,
      antSquash: 0,
    }
    const sq = (s) => {
      R.sy = s
      R.sx = 1 + (1 - s) * 0.7
    }
    const breathe = (per = 2.6, amp = 0.02) => {
      const b = wave(q, per)
      sq(1 + amp * b)
      return b
    }
    switch (pose) {
      case 'walk': {
        const st = num(o.stride, 1)
        const g0 = gait(q, WALK_P, WALK_A * st, 12, 0)
        const g1 = gait(q, WALK_P, WALK_A * st, 12, 0.5)
        const s = Math.sin((TAU * q) / WALK_P)
        R.root = [0, -LEG - 5 * Math.abs(s)]
        R.rot = 0.06 + 0.02 * s
        sq(1 + 0.03 * Math.cos((2 * TAU * q) / WALK_P))
        R.feet = [[-28 + g0[0], g0[1]], [28 + g1[0], g1[1]]]
        R.feetRot = [g0[2], g1[2]]
        // arms swing against the same-side foot
        R.hands = [[-92 - 0.7 * g0[0], -14], [92 - 0.7 * g1[0], -14]]
        R.look = [0.45, 0]
        break
      }
      case 'hop': {
        const P = 0.72
        const lt = q - Math.floor(q / P) * P
        const h = hop(lt, 0.12, { dur: 0.46, height: 72, pre: 0.12 })
        R.root = [0, -LEG + h.y]
        sq(h.squash)
        const up = h.air ? Math.sin(Math.PI * Math.min(1, h.p * 1.4)) : 0
        R.hands = [mix([-90, -22], [-114, -160], up), mix([90, -22], [114, -160], up)]
        if (h.air) R.feet = [[-26, h.y - 8 * up], [26, h.y - 8 * up]]
        R.mouth = 'grin'
        R.look = [0, -0.35 * up]
        break
      }
      case 'cheer': {
        const P = 0.5
        const lt = q - Math.floor(q / P) * P
        const h = hop(lt, 0.07, { dur: 0.3, height: 20, pre: 0.07 })
        R.root = [0, -LEG + h.y]
        sq(h.squash)
        if (h.air) R.feet = [[-30, h.y - 3], [30, h.y - 3]]
        const w = wave(q, 0.5)
        R.hands = [[-112 - 8 * w, -178 + 10 * w], [112 - 8 * w, -178 - 10 * w]]
        R.mitt = ['open', 'open']
        R.eyes = 'happy'
        R.mouth = 'open'
        R.blush = 1.25
        break
      }
      case 'clap': {
        const P = 0.42
        const ph = (q - Math.floor(q / P) * P) / P
        const sep = 10 + 50 * Math.abs(Math.cos(Math.PI * ph))
        const lift = Math.sin(Math.PI * ph)
        R.hands = [[-sep, -50 - 8 * lift], [sep, -50 - 8 * lift]]
        R.root = [0, -LEG - 4 * lift]
        sq(Math.abs(ph - 0.5) < 0.09 ? 0.965 : 1.01)
        R.fx = Math.abs(ph - 0.52) < 0.14 ? { kind: 'clap', p: (ph - 0.38) / 0.28 } : null
        R.mouth = 'grin'
        R.look = [0, -0.25]
        break
      }
      case 'point': {
        const a = num(o.aim, -0.3)
        const e = E.outBack(seg(q, 0, 0.32))
        const dir = [Math.cos(a), Math.sin(a)]
        breathe()
        // reach capped at ~100 px so the rubber-hose arm keeps a gentle bow; the mitt's index finger does the rest
        R.hands = [[-66, -24], add(SH[1], mul(dir, 24 + 76 * e))]
        R.finger = { hand: 1, dir }
        R.mitt = [null, 'point']
        R.rot = 0.07 * e * Math.sign(dir[0] || 1)
        R.look = [dir[0] * 0.9, dir[1] * 0.9]
        R.fx = q > 0.13 && q < 0.47 ? { kind: 'jab', p: seg(q, 0.13, 0.47) } : null
        break
      }
      case 'carry': {
        const st = num(o.stride, 0)
        const g0 = gait(q, WALK_P, WALK_A * st, 9, 0)
        const g1 = gait(q, WALK_P, WALK_A * st, 9, 0.5)
        const s = Math.sin((TAU * q) / WALK_P)
        const c = Math.cos((TAU * q) / WALK_P)
        R.rot = 0.05 * s
        R.root = [0, -LEG - 4 * Math.abs(s)]
        R.feet = [[-30 + g0[0], g0[1]], [30 + g1[0], g1[1]]]
        R.feetRot = [g0[2], g1[2]]
        if (o.carryLow) {
          R.hands = [[-40, -62 + 3 * c], [40, -62 - 3 * c]]
          R.holdAt = [0, -64]
          R.holdRot = 0.04 * c
        } else {
          // held OVER the head: the item's bottom edge rides ~10 px above the card, hands grip its sides; the
          // arms run behind the card (outside its silhouette) so no pencil line crosses the face.
          const cw = Math.max(20, num(o.carryW, 170))
          const ch = Math.max(10, num(o.carryH, 120))
          const bot = -210
          const hx = cw / 2 + 4
          const hy = bot - Math.min(ch * 0.3, 40)
          R.hands = [[-hx, hy + 4 * c], [hx, hy - 4 * c]]
          R.holdAt = [0, bot - ch / 2]
          R.holdRot = Math.atan2(-8 * c, 2 * hx)
          R.behind = [true, true]
          R.handFront = [true, true]
          R.antSquash = 1
        }
        R.mouth = 'grin'
        R.look = [0.2, -0.25]
        break
      }
      case 'thwack': {
        const sh = SH[1]
        const a = E.inOutCubic(seg(q, 0, 0.32))
        const s = E.inCubic(seg(q, 0.32, THWACK_HIT))
        const f = q - THWACK_HIT
        let hand
        // wind-up swings OUTSIDE the card (arm behind it), then the strike comes down in front
        if (q < 0.32) hand = bez([98, -38], [136, -170], [52, -236], a)
        else if (q < THWACK_HIT) hand = polar(sh, lerp(-1.684, 0.567, s), lerp(177, 78, s))
        else hand = mix(polar(sh, 0.567, 78), [118, -52], springOut(f, 6, 13))
        R.hands = [mix([-93, -12], [-120, -118], Math.min(1, a + s)), hand]
        const over = Math.abs(hand[0]) < 76 && hand[1] > -200
        R.behind = [false, q < 0.36]
        R.handFront = [null, q < 0.36 ? !over : null]
        R.rot = q < 0.32 ? -0.14 * a : q < THWACK_HIT ? lerp(-0.14, 0.16, s) : 0.16 * ring(f, 5, 9)
        sq(q < 0.32 ? 1 + 0.06 * a : q < THWACK_HIT ? 1.06 - 0.06 * s : 1 - 0.15 * ring(f, 8, 16))
        R.glue = true
        R.eyes = f > 0 && f < 0.18 ? 'shut' : 'normal'
        R.look = [0.75, 0.55]
        R.mouth = q < 0.32 ? 'flat' : q < THWACK_HIT ? 'o' : 'grin'
        R.brows = q < THWACK_HIT ? 'determined' : null
        R.fx = f > 0 && f < 0.26 ? { kind: 'impact', p: f / 0.26 } : null
        break
      }
      case 'peek': {
        const sink = clamp01(num(o.peek, 0)) * PEEK_SINK
        const lx = Math.tanh(3 * Math.sin((TAU * q) / 1.9))
        R.look = [lx, -0.15]
        R.root = [3 * lx, -LEG + 6]
        sq(0.95)
        R.handsG = [[-52 + 3 * lx, -sink - 3], [52 + 3 * lx, -sink - 3]]
        R.mouth = 'o'
        R.shadowOff = true
        break
      }
      case 'squint': {
        R.rot = 0.08 + 0.05 * Math.sin((TAU * q) / 1.5)
        breathe()
        R.hands = [[-66, -24], [104, -138]]
        R.mitt = [null, 'open']
        R.holdAt = [124, -140]
        R.holdRot = -0.12
        R.eyes = 'squint'
        R.brows = 'squint'
        R.mouth = 'wobbly'
        R.look = [0.95, -0.1]
        break
      }
      case 'bow': {
        // a real bow: 0.1 s rise/stretch anticipation, the card FOLDS forward at the scarf line (upper half tips
        // toward the viewer), holds, rises from 0.9 with an outBack overshoot (a hair past upright) by 1.2.
        const pre = Math.sin(Math.PI * seg(q, 0, 0.14))
        const dn = E.inOutCubic(seg(q, 0.1, BOW.down))
        const d = dn * (1 - E.outBack(seg(q, 0.9, BOW.up)))
        const dd = clamp01(d)
        R.fold = d
        R.root = [0, -LEG - 5 * pre + 5 * dd]
        sq(1 + 0.05 * pre - 0.05 * dd + (d < 0 ? -0.35 * d : 0))
        R.rot = 0.03 * dd
        R.hands = [mix([-92, -12], [-136, -44], dd), mix([92, -12], [12, -44], dd)]
        R.mitt = [dd > 0.3 ? 'open' : null, null]
        R.eyes = dd > 0.4 ? 'happy' : 'normal'
        R.mouth = 'grin'
        R.look = [0.2, 0.6 * dd]
        R.blush = 1 + 0.4 * dd
        break
      }
      case 'sit': {
        R.root = [0, 0]
        R.seat = true
        const k = wave(q, 1.1)
        const kl = Math.max(0, k)
        const kr = Math.max(0, -k)
        R.feet = [[-30 - 8 * kl, 42 - 14 * kl], [30 + 8 * kr, 42 - 14 * kr]]
        R.feetRot = [0.3 * kl, -0.3 * kr]
        R.handsG = [[-90, -4], [90, -4]]
        R.rot = 0.025 * wave(q, 2.3)
        breathe(2.8, 0.015)
        R.shadowOff = true
        break
      }
      case 'hug': {
        R.rot = 0.07 * wave(q, 1.3)
        sq(1 - 0.03 * (0.5 + 0.5 * wave(q, 0.65)))
        R.hands = [[-20, -64], [22, -58]]
        R.holdAt = [0, -58]
        R.eyes = 'happy'
        R.mouth = 'grin'
        R.blush = 1.4
        break
      }
      case 'wave': {
        const w = wave(q, 0.5)
        breathe()
        R.hands = [[-92, -12], [110 + 20 * w, -172 + 6 * Math.abs(w)]]
        R.mitt = [null, 'open']
        R.rot = 0.035 * wave(q, 1.0)
        R.mouth = 'grin'
        R.look = [0.2, -0.1]
        break
      }
      case 'slide': {
        const f = wave(q, 0.3)
        R.root = [0, -LEG + 9]
        R.rot = -0.17 + 0.03 * f
        R.feet = [[-44, 0], [44, 0]]
        R.hands = [[-132, -116 + 12 * f], [128, -142 - 10 * f]]
        R.mitt = ['open', 'open']
        R.mouth = 'open'
        R.eyes = 'wide'
        R.look = [0.85, 0]
        R.speed = 1
        R.fx = { kind: 'speed' }
        break
      }
      case 'ride': {
        R.root = [0, 0]
        R.seat = true
        const r = wave(q, 0.9)
        R.rot = 0.09 * r
        R.feet = [[-34, 38 + 6 * r], [34, 38 - 6 * r]]
        R.handsG = [[-66, -3], null]
        R.hands = [[-92, -12], [106 + 16 * wave(q, 0.45), -182]]
        R.mitt = [null, 'open']
        R.mouth = 'open'
        R.look = [0.55, -0.25]
        R.shadowOff = true
        break
      }
      case 'catch': {
        // hands sweep up OUTSIDE the card (arms behind it) and meet over the head at CATCH_AT, then bring the
        // item down to the chest; arms come back in front once the hands are below the eyes.
        const reach = E.outCubic(seg(q, 0, CATCH_AT))
        const down = E.inOutCubic(seg(q, 0.32, 0.62))
        const hit = q - CATCH_AT
        sq(hit > 0 ? 1 - 0.13 * ring(hit, 9, 18) : 1 + 0.05 * reach)
        R.root = [0, -LEG + (hit > 0 ? 10 * Math.max(0, ring(hit, 9, 18)) : 0)]
        const upL = bez([-92, -12], [-130, -178], [-40, -236], reach)
        const upR = [-upL[0], upL[1]]
        R.hands = [mix(upL, [-34, -64], down), mix(upR, [34, -64], down)]
        R.behind = [R.hands[0][1] < -118, R.hands[1][1] < -118]
        R.handFront = [true, true]
        R.mitt = q < 0.3 ? ['open', 'open'] : [null, null]
        R.holdAt = mix([0, -254], [0, -62], down)
        R.look = [0, lerp(-1, 0.45, down)]
        R.eyes = q < 0.3 ? 'wide' : 'normal'
        R.mouth = q < CATCH_AT ? 'o' : 'grin'
        R.fx = hit > 0 && hit < 0.22 ? { kind: 'catch', p: hit / 0.22 } : null
        break
      }
      case 'throw': {
        // wind-up behind the head (arm, hand and item all behind the card), a quick 0.30→0.40 forward snap that
        // lets go at THROW_RELEASE with the hand already forward-up, then follow-through.
        const sh = SH[1]
        const w = E.inOutCubic(seg(q, 0, 0.3))
        const s = E.inOutQuad(seg(q, 0.3, 0.4))
        const f = q - 0.4
        let hand
        if (q < 0.3) hand = bez([92, -20], [70, -262], [-58, -236], w)
        else if (q < 0.4) hand = polar(sh, lerp(-2.207, -0.83, s), lerp(219, 95, s))
        else hand = mix(polar(sh, -0.83, 95), [104, -26], E.outCubic(seg(q, 0.4, 0.78)))
        R.hands = [mix([-92, -12], [-100, -122], w * (1 - seg(q, 0.4, 0.9))), hand]
        R.behind = [false, q < 0.4 && hand[0] < 80]
        R.rot = q < 0.3 ? -0.13 * w : q < 0.4 ? lerp(-0.13, 0.15, s) : 0.15 * (1 - E.inOutCubic(seg(q, 0.4, 1.0)))
        sq(q < 0.3 ? 1 - 0.06 * w : q < 0.4 ? lerp(0.94, 1.07, s) : 1 + 0.07 * ring(f, 6, 12))
        R.released = q >= THROW_RELEASE
        R.holdHand = 1
        R.look = [0.9, -0.3]
        R.mouth = q < 0.3 ? 'flat' : 'grin'
        R.brows = q < 0.3 ? 'determined' : null
        break
      }
      case 'fold': {
        const P = 0.8
        const ph = (q - Math.floor(q / P) * P) / P
        const k = E.inOutCubic(ph < 0.5 ? ph * 2 : 2 - ph * 2)
        breathe()
        R.hands = [[-36, -62], mix([40, -62], [-12, -80], k)]
        R.holdAt = [0, -58]
        R.look = [0, 0.75]
        R.mouth = 'tongue'
        R.brows = 'focus'
        break
      }
      case 'give': {
        const b = wave(q, 0.9)
        R.rot = 0.07
        R.hands = [[84, -84 + 2 * b], [110, -100 + 2 * b]]
        R.mitt = ['open', 'open']
        R.holdAt = [126, -104 + 2 * b]
        R.look = [0.9, 0]
        break
      }
      default: {
        // idle
        const b = breathe()
        R.rot = 0.05 * wave(q, 3.4)
        R.hands = [[-92, -10 + 3 * b], [92 + 3 * wave(q, 3.4, 1), -10 - 3 * b]]
        R.look = [0.22 * Math.sin((TAU * q) / 5.3), 0.08 * Math.sin((TAU * q) / 4.1)]
      }
    }
    return R
  }
  const foldK = (f) => 1 - 0.45 * f
  const FOLD_W = 0.1 // the tipped-forward flap is closer to the camera → a touch wider than the lower card
  function bodyToG(R, p) {
    let px = p[0]
    let py = p[1]
    if (R.fold && py < FOLD_Y) {
      py = FOLD_Y + (py - FOLD_Y) * foldK(R.fold)
      px *= 1 + FOLD_W * R.fold
    }
    const q = rot2([px * R.sx, py * R.sy], R.rot)
    return [R.root[0] + q[0], R.root[1] + q[1]]
  }
  function sampler(pose, o, bp) {
    return (tt) => bodyToG(rig(pose, tt, o), bp)
  }

  /** Pip's expressive hands: a sage paper mitt (palm + thumb nub), with an index finger for 'point'.
   *  dir = unit vector the hand faces (the finger direction for 'point', the forearm otherwise). */
  function mitt(ctx, p, dir, kind, seed, t) {
    const ang = Math.atan2(dir[1], dir[0])
    K.at(ctx, p[0], p[1], ang, 1, () => {
      if (kind === 'point') piece(ctx, capsule([3, -1.5], [27, -2.5], 5.2, 4), C.sage, seed + 'f', t, { cut: 0.4, shadow: 0.6, w: 1.8, rough: 0.5 })
      piece(ctx, K.ellipsePts(kind === 'point' ? 0 : 3, -10, 5.4, 4.4, 10), C.sage, seed + 'th', t, { cut: 0.3, shadow: 0.5, w: 1.7, rough: 0.5 })
      const palm = kind === 'point' ? K.ellipsePts(-1, 1, 11.5, 10.5, 16) : capsule([-3, 0.5], [7, 0.5], 10.8, 5)
      const sh = K.paper(ctx, palm, C.sage, { cut: 0.6, shadow: 0.75, seed: seed + 'p' })
      K.pathPoly(ctx, sh)
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(42,34,26,0.85)'
      ctx.stroke()
      ctx.beginPath()
      ctx.ellipse(-4, -4, 3.6, 2.4, -0.5, 0, TAU)
      ctx.fillStyle = 'rgba(255,255,255,0.32)'
      ctx.fill()
      if (kind !== 'point') {
        // two finger nicks at the mitt's tip
        ctx.strokeStyle = 'rgba(42,34,26,0.55)'
        ctx.lineWidth = 1.6
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(18, -3.5)
        ctx.lineTo(12.5, -3)
        ctx.moveTo(18, 4)
        ctx.lineTo(12.5, 3.6)
        ctx.stroke()
      }
    })
  }

  /** The droopy navy nightcap, body frame. droop = [dx, dy] tip offset; lantern 0..1 brightens the rim light. */
  function nightcap(ctx, id, t, droop, lantern) {
    // two explicit quadratic edges (outer over the top, inner back under the droop) → no self-intersection
    const BL = [-76, -206]
    const BR = [76, -206]
    const CO = [-44, -346]
    const P2 = [100 + droop[0], -222 + droop[1]]
    const q = (a, c, b, s) => [(1 - s) * (1 - s) * a[0] + 2 * (1 - s) * s * c[0] + s * s * b[0], (1 - s) * (1 - s) * a[1] + 2 * (1 - s) * s * c[1] + s * s * b[1]]
    const cone = []
    for (let i = 0; i <= 12; i++) cone.push(q(BL, CO, P2, i / 12))
    for (let i = 1; i < 10; i++) cone.push(q(P2, [52, -272], BR, i / 10))
    const cs = piece(ctx, cone, CAP_COL, id + 'cap', t, { cut: 1.6, shadow: 0.9, lift: 2, w: 2.3 })
    // cream flannel stripes + a moon-dot print
    stripes(ctx, cs, C.cream, 0.24, 24, 7)
    ctx.save()
    K.pathPoly(ctx, cs)
    ctx.clip()
    ctx.fillStyle = C.moon
    for (const [x, y, r] of [[-44, -236, 4.6], [-14, -268, 4], [20, -240, 4.4], [44, -256, 3.4], [-60, -214, 3], [70, -228, 3.2], [-26, -300, 3.4]]) {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
    // moonlit rim along the side facing the antenna lantern
    ctx.save()
    ctx.globalAlpha *= 0.5 + 0.45 * lantern
    ctx.strokeStyle = C.moon
    ctx.lineWidth = 3.2
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let i = 1; i <= 8; i++) {
      const p = q(BL, CO, P2, i / 12)
      if (i === 1) ctx.moveTo(p[0] + 4, p[1] + 3)
      else ctx.lineTo(p[0] + 4, p[1] + 4)
    }
    ctx.stroke()
    ctx.restore()
    // cream brim band
    const brim = []
    for (let i = 0; i <= 8; i++) {
      const x = -86 + (172 * i) / 8
      brim.push([x, -220 + 4 * Math.pow(x / 86, 2)])
    }
    for (let i = 8; i >= 0; i--) {
      const x = -86 + (172 * i) / 8
      brim.push([x, -197 + 4 * Math.pow(x / 86, 2)])
    }
    piece(ctx, brim, C.cream, id + 'brim', t, { cut: 1.8, shadow: 0.8, w: 2.1 })
    ctx.save()
    ctx.setLineDash([5, 6])
    ctx.strokeStyle = 'rgba(42,34,26,0.35)'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(-78, -208)
    ctx.quadraticCurveTo(0, -212, 78, -206)
    ctx.stroke()
    ctx.restore()
    // pom-pom
    const pp = add(P2, [4, 10])
    const pom = K.paper(ctx, K.ellipsePts(pp[0], pp[1], 16, 16, 20), C.cream, { cut: 3.4, shadow: 0.9, seed: id + 'pom' })
    K.pencil.circle(ctx, pp[0], pp[1], 30, id + 'pomo', t, { strokeWidth: 1.8, roughness: 1.6, stroke: 'rgba(42,34,26,0.7)' })
    return pom
  }

  function drawPip(ctx, x, y, t, o = {}) {
    const pose = POSES.includes(o.pose) ? o.pose : 'idle'
    const pT = num(o.poseT, t)
    const id = String(o.id || 'pip')
    const s = num(o.scale, 1)
    const flip = !!o.flip
    const peek = clamp01(num(o.peek, 0))
    const R = rig(pose, pT, o)
    if (typeof o.squash === 'number') {
      R.sy = o.squash
      R.sx = 1 + (1 - o.squash) * 0.7
    }
    if (R.sy < 1 && !R.seat) R.root = [R.root[0], R.root[1] + (1 - R.sy) * 26]
    const nd = K.nudge(id, t, 0.5)
    R.root = [R.root[0] + nd.dx, R.root[1] + nd.dy]
    R.rot += nd.rot
    const air = Math.max(0, num(o.air, 0)) / (s || 1) // o.air is WORLD px → Pip-local units
    const lantern = clamp01(num(o.lantern, 0))
    const cap = !!o.nightcap
    const glue = R.glue || !!o.glue
    const mouthKind = MOUTHS.includes(o.mouth) ? o.mouth : R.mouth
    const eyeMode = o.eyes || R.eyes
    let browKind = o.brows !== undefined ? o.brows : R.brows
    if (browKind == null && o.brows === undefined) {
      if (mouthKind === 'wobbly') browKind = 'worried'
      else if (eyeMode === 'wide') browKind = 'raised'
    }
    const fold = R.fold || 0

    // caller motion → local lag (px)
    let velLag = [0, 0]
    if (Array.isArray(o.vel)) {
      const v = rot2([flip ? -o.vel[0] : o.vel[0], o.vel[1]], -(o.rot || 0) * (flip ? -1 : 1))
      velLag = clampLen(mul(v, -0.075 / (s || 1)), 60)
    }
    const eyeLag = add(lagOf(sampler(pose, o, [0, -148]), pT, K_EYE), velLag)
    const earLag = add(lagOf(sampler(pose, o, EAR_M), pT, K_FLAP), velLag)
    const knotLag = add(lagOf(sampler(pose, o, KNOT), pT, K_FLAP), velLag)

    const base = ctx.getTransform()
    ctx.save()
    ctx.translate(x, y)
    if (o.rot) ctx.rotate(o.rot)
    ctx.scale(flip ? -s : s, s)
    if (peek > 0) {
      ctx.beginPath()
      ctx.rect(-500, -1000, 1000, 1000)
      ctx.clip()
      ctx.translate(0, peek * PEEK_SINK)
    }
    const map = mapper(ctx, base)
    const T = (p) => bodyToG(R, p)

    // antenna geometry (body frame)
    const sway = clamp(earLag[0] * 0.55, -22, 22) + 2.5 * Math.sin((TAU * t) / 2.3)
    const antBase = cap ? [-36, -246] : [-26, -214]
    let antKink = [antBase[0] + 7 + sway * 0.35, antBase[1] - 20]
    let antTip = [antBase[0] - 5 + sway, antBase[1] - 44 + clamp(earLag[1] * 0.25, -7, 7)]
    if (R.antSquash > 0) {
      // squashed flat under an overhead load, the bulb peeking out at the side
      antKink = add(antBase, [-15, -6])
      antTip = add(antBase, [-40, 1 + 1.5 * Math.sin((TAU * t) / 0.9)])
    }
    if (fold > 0) antTip = add(antTip, [5 * fold, 10 * fold]) // flops forward with the bow
    const bulbR = 9.5 * (1 + 0.18 * Math.max(0, fold))
    const bulbG = T(antTip)

    // ground contact shadow
    if (o.shadow !== false && !R.shadowOff && peek === 0 && !R.seat) {
      const hgt = air + Math.max(0, -(R.root[1] + LEG))
      const k = 1 - clamp01(hgt / 240) * 0.55
      ctx.save()
      ctx.beginPath()
      ctx.ellipse(R.root[0] * 0.3, air + 2, 66 * k, 11 * k, 0, 0, TAU)
      ctx.fillStyle = `rgba(58,36,14,${0.17 * k})`
      ctx.fill()
      ctx.restore()
    }
    // lantern halo (behind everything)
    if (lantern > 0) {
      ctx.save()
      const hr = 40 + 55 * lantern
      const g = ctx.createRadialGradient(bulbG[0], bulbG[1], 0, bulbG[0], bulbG[1], hr)
      g.addColorStop(0, `rgba(255,240,170,${0.85 * lantern})`)
      g.addColorStop(0.3, `rgba(244,204,110,${0.42 * lantern})`)
      g.addColorStop(1, 'rgba(228,184,90,0)')
      ctx.fillStyle = g
      ctx.fillRect(bulbG[0] - hr, bulbG[1] - hr, hr * 2, hr * 2)
      ctx.restore()
    }

    // legs + feet
    for (let i = 0; i < 2; i++) {
      const hip = T(HIP[i])
      const f = R.feet[i]
      hose(ctx, hip, f, LEG_L, autoBend(hip, f, i ? 1 : -1), id + 'leg' + i, t, { w: 3.6 })
    }
    for (let i = 0; i < 2; i++) punch(ctx, add(R.feet[i], [i ? 3 : -3, 0]), 11, C.sage, id + 'ft' + i, { sx: 1.08, sy: 0.66, rot: R.feetRot[i] })

    // arms + hands: resolve positions and layers
    const hands = [0, 1].map((i) => R.handsG[i] || T(R.hands[i]))
    const shoulders = [T(SH[0]), T(SH[1])]
    const handFront = [0, 1].map((i) => (R.handFront[i] == null ? !R.behind[i] : R.handFront[i]))
    const fdir = [null, null]
    let toolG = null
    let tipG = null
    const drawArm = (i) => {
      fdir[i] = hose(ctx, shoulders[i], hands[i], ARM_L, autoBend(shoulders[i], hands[i], i ? 1 : -1), id + 'arm' + i, t, { w: 3.5, slack: 0.035 })
    }
    const drawGlue = () => {
      let d = fdir[1] || [0, 1]
      if (pose !== 'thwack' && d[1] > 0.35) d = [Math.sin(0.28), -Math.cos(0.28)] // held upright, proudly
      const ang = Math.atan2(d[1], d[0])
      const hd = hands[1]
      K.at(ctx, hd[0], hd[1], ang, 1, () => {
        piece(ctx, rrect(-14, -8, 48, 16, 3), C.sage, id + 'glue', t, { cut: 0.8, shadow: 0.8, w: 2 })
        ctx.fillStyle = K.paperPattern(ctx, C.cream)
        ctx.fillRect(4, -7, 13, 14)
        ctx.strokeStyle = 'rgba(42,34,26,0.5)'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(7, -3)
        ctx.lineTo(14, -3)
        ctx.moveTo(7, 2)
        ctx.lineTo(12, 2)
        ctx.stroke()
        piece(ctx, rrect(32, -9.5, 17, 19, 6), C.paperWhite, id + 'gcap', t, { cut: 0.6, shadow: 0.6, w: 2 })
      })
      toolG = add(hd, mul(d, 49))
    }
    const drawHand = (i) => {
      if (glue && i === 1) drawGlue()
      const kind = glue && i === 1 ? null : R.mitt[i]
      if (kind) {
        const d = kind === 'point' && R.finger ? R.finger.dir : fdir[i] || [i ? 1 : -1, 0]
        mitt(ctx, hands[i], d, kind, id + 'mt' + i, t)
        if (kind === 'point') tipG = add(hands[i], mul(d, 33))
      } else punch(ctx, hands[i], HAND_R, C.sage, id + 'hd' + i)
    }
    const hasHold = typeof o.hold === 'function' && !R.released
    const holdG = R.holdHand >= 0 ? hands[R.holdHand] : T(R.holdAt)
    const holdBehind = R.holdHand >= 0 && !handFront[R.holdHand]
    const drawHold = () => K.at(ctx, holdG[0], holdG[1], R.rot + R.holdRot, flip ? [-1, 1] : 1, (c) => o.hold(c))

    // ── behind pass: arms tucked behind the card (+ their hands / held item when those are hidden too) ──
    for (let i = 0; i < 2; i++) if (R.behind[i]) drawArm(i)
    if (hasHold && holdBehind) drawHold()
    for (let i = 0; i < 2; i++) if (!handFront[i]) drawHand(i)

    // ── the card body (body frame) ──
    ctx.save()
    ctx.translate(R.root[0], R.root[1])
    ctx.rotate(R.rot)
    ctx.scale(R.sx, R.sy)
    const hgtNow = air + Math.max(0, -(R.root[1] + LEG))
    const hatchBody = (shape) => hatch(ctx, shape, HATCH_COL, HATCH_A, 11, -0.9, id, t, 2.6)
    const drawCardBase = () => {
      const shape = K.paper(ctx, PIP_BODY, BODY_COL, { cut: 1.5, shadow: 1, lift: 3 + hgtNow / 14, seed: id + 'body' })
      ctx.save()
      K.pathPoly(ctx, shape)
      ctx.clip()
      hatchBody(shape)
      // index-card ruling: three blue rules + the terracotta margin
      ctx.lineCap = 'round'
      ctx.strokeStyle = 'rgba(90,130,196,0.34)'
      ctx.lineWidth = 2.2
      ctx.beginPath()
      for (const ry of [-48, -30, -12]) {
        ctx.moveTo(-80, ry)
        ctx.quadraticCurveTo(0, ry + 1.5, 80, ry - 1)
      }
      ctx.stroke()
      ctx.strokeStyle = 'rgba(184,92,52,0.8)'
      ctx.lineWidth = 2.6
      ctx.beginPath()
      ctx.moveTo(-57, -206)
      ctx.quadraticCurveTo(-55.5, -100, -57.5, 6)
      ctx.stroke()
      // paper edge: light top-left rim, darker lower-right
      ctx.lineWidth = 5
      ctx.strokeStyle = 'rgba(255,248,225,0.35)'
      ctx.beginPath()
      ctx.moveTo(-76, -4)
      ctx.lineTo(-76, -183)
      ctx.quadraticCurveTo(-76, -202, -57, -202)
      ctx.lineTo(EAR_A[0], -202)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(120,80,20,0.14)'
      ctx.lineWidth = 7
      ctx.beginPath()
      ctx.moveTo(77, EAR_B[1])
      ctx.lineTo(77, -20)
      ctx.quadraticCurveTo(77, 2, 55, 2)
      ctx.lineTo(-58, 2)
      ctx.stroke()
      ctx.restore()
      ink(ctx, PIP_BODY, id + 'bo', t, { w: 2.6, rough: 0.75 })
      return shape
    }
    const drawEar = () => {
      // dog-ear cowlick: folded honey flap that flops with follow-through. θ: 0 = folded flat, π/2 = edge-on,
      // > π/2 = flipped open past the corner. It flies open while the card falls / lands and slaps back down.
      const open = clamp(Math.max(0, -earLag[1]) * 0.03 + Math.max(0, 1 - R.sy) * 4.2 + 0.1 + 0.06 * Math.sin((TAU * t) / 1.7), 0, 2.0)
      const flop = clamp(-earLag[0] * 0.012, -0.4, 0.4)
      const c0 = Math.cos(open)
      const k = Math.abs(c0) < 0.3 ? (c0 >= 0 ? 0.3 : -0.3) : c0 // snap through edge-on: clearly open or closed
      const tip = add(EAR_M, mul(rot2(sub(EAR_T, EAR_M), flop), k))
      const flap = [EAR_A, EAR_B, tip]
      const lift = Math.sin(Math.min(open, Math.PI / 2))
      K.dropShadow(ctx, flap, 0.7, 2 + 7 * lift)
      K.paper(ctx, flap, k >= 0 ? C.honey : C.butter, { cut: 0.5, shadow: 0, seed: id + 'ear' })
      ctx.save()
      K.pathPoly(ctx, flap)
      ctx.clip()
      ctx.fillStyle = `rgba(255,236,190,${0.16 + 0.22 * lift})`
      ctx.beginPath()
      ctx.moveTo(EAR_A[0], EAR_A[1])
      ctx.lineTo(EAR_B[0], EAR_B[1])
      ctx.lineTo(mix(EAR_M, tip, 0.45)[0], mix(EAR_M, tip, 0.45)[1])
      ctx.fill()
      ctx.restore()
      ink(ctx, flap, id + 'eo', t, { w: 2.3, rough: 0.6 })
    }
    const drawFace = (shape) => {
      const look = Array.isArray(o.look) ? [flip ? -o.look[0] : o.look[0], o.look[1]] : R.look
      const blink = typeof o.blink === 'number' ? clamp01(o.blink) : (eyeMode === 'normal' || eyeMode === 'wide') && browKind !== 'determined' ? blinkAt(t, id) : 0
      const spin = clamp01(num(o.eyeSpin, 0))
      const lidTex = () => hatchBody(shape) // the lid carries the body's own hachure → no seam
      for (let i = 0; i < 2; i++) {
        const { x: ex, y: ey, r } = EYE[i]
        if (eyeMode === 'happy') happyEye(ctx, ex, ey + 4, r, id + 'he' + i, t)
        else if (eyeMode === 'shut') shutEye(ctx, ex, ey, r, i ? -1 : 1, id + 'se' + i, t)
        else {
          const pupil = eyeMode === 'wide' ? 0.33 : i ? 0.5 : 0.47
          const travel = r * (1 - pupil) * 0.9
          let lk = add(look, mul(eyeLag, 1 / travel))
          if (i === 0 && spin > 0 && spin < 1) {
            const a = -Math.PI / 2 + E.inOutCubic(spin) * TAU * 1.25
            lk = mix(lk, [Math.cos(a) * 1.05, Math.sin(a) * 1.05], Math.min(1, Math.sin(Math.PI * spin) * 4))
          } else lk = clampLen(lk, 1.12)
          K.googly(ctx, ex, ey, r, t, id + 'eye' + i, lk, { blink: false, pupil })
          sparkle2(ctx, ex, ey, r, t, id + 'eye' + i, lk, pupil)
          if (eyeMode === 'squint') eyelid(ctx, ex, ey, r, i ? 0.42 : 0.55, BODY_COL, { slant: i ? -0.12 : 0.18, low: i ? 0.12 : 0.2, tex: lidTex })
          else if (blink > 0) eyelid(ctx, ex, ey, r, blink, BODY_COL, { tex: lidTex })
        }
      }
      if (browKind) brows(ctx, browKind, id, t)
      const bl = clamp01(num(o.blush, 1)) * R.blush
      blushDot(ctx, -52, -116, bl, 11)
      blushDot(ctx, 55, -113, bl, 10)
      mouth(ctx, mouthKind, MOUTH_AT[0], MOUTH_AT[1], 1, id + 'mo', t)
    }
    const drawScarf = () => {
      // washi scarf: band + knot + two fluttering fishtail tails
      const band = []
      for (let i = 0; i <= 8; i++) {
        const bx = -81 + (162 * i) / 8
        band.push([bx, SCARF_Y - 9 + 3 * (1 - Math.pow(bx / 81, 2))])
      }
      for (let i = 8; i >= 0; i--) {
        const bx = -81 + (162 * i) / 8
        band.push([bx, SCARF_Y + 9 + 3 * (1 - Math.pow(bx / 81, 2))])
      }
      washi(ctx, band, C.terracotta, C.peach, { shadow: 0.55 })
      const flutterAmp = 5 + Math.min(10, vlen(knotLag) * 0.25) + R.speed * 6
      const tailSwing = clamp((-knotLag[0] - knotLag[1] * 0.6) * 0.016, -0.6, 1.05) + R.speed * 0.95
      const tails = [
        { ang: 1.78, L: 58, ph: 0 },
        { ang: 2.28, L: 46, ph: 1.9 },
      ]
      for (let k = 0; k < 2; k++) {
        const tl = tails[k]
        const ang = tl.ang + tailSwing * (k ? 0.8 : 1)
        const along = [Math.cos(ang), Math.sin(ang)]
        const nrm = [-along[1], along[0]]
        const Lft = []
        const Rgt = []
        const n = 6
        for (let i = 0; i <= n; i++) {
          const u = i / n
          const off = flutterAmp * Math.pow(u, 1.4) * Math.sin(TAU * t * (1.5 + R.speed * 2.5) - u * 4.2 + tl.ph)
          const c = add(KNOT, add(mul(along, tl.L * u), mul(nrm, off)))
          const w = lerp(8.5, 7, u)
          Lft.push(add(c, mul(nrm, w)))
          Rgt.push(sub(c, mul(nrm, w)))
        }
        const endC = mix(Lft[n], Rgt[n], 0.5)
        const notch = sub(endC, mul(along, 7))
        const poly = [...Lft, notch, ...Rgt.reverse()]
        washi(ctx, poly, C.terracotta, C.peach, { shadow: 0.5, gap: 12, sw: 4 })
        ink(ctx, poly, id + 'tail' + k, t, { w: 1.6, rough: 0.6, stroke: 'rgba(42,34,26,0.7)' })
      }
      const knotPts = K.ellipsePts(KNOT[0], KNOT[1], 12, 13, 12)
      washi(ctx, knotPts, C.terracotta, C.peach, { shadow: 0.6, gap: 10, sw: 4 })
      ink(ctx, knotPts, id + 'knot', t, { w: 1.8, rough: 0.7, stroke: 'rgba(42,34,26,0.75)' })
    }
    const drawAntenna = () => {
      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = C.hiveTeal
      ctx.lineWidth = 3.4
      if (!cap) {
        // the paperclip loop hugging the card's top edge
        const jr = K.rng('clip', id, K.boil(t))
        const j = () => (jr() - 0.5) * 0.8
        ctx.beginPath()
        ctx.moveTo(antBase[0] + 8 + j(), -188)
        ctx.lineTo(antBase[0] + 8 + j(), -214)
        ctx.arc(antBase[0] + 2, -214, 6, 0, Math.PI, true)
        ctx.lineTo(antBase[0] - 4 + j(), -192)
        ctx.arc(antBase[0] + 0.5, -192, 4.5, Math.PI, 0, true)
        ctx.lineTo(antBase[0] + 5 + j(), -206)
        ctx.stroke()
      }
      ctx.restore()
      K.pencil.curve(ctx, [antBase, antKink, antTip], id + 'ant', t, { stroke: C.hiveTeal, strokeWidth: 3.4, roughness: 0.4, bowing: 0.3 })
      ctx.save()
      if (fold > 0) {
        ctx.translate(antTip[0], antTip[1])
        ctx.scale(1 / (1 + FOLD_W * fold), 1 / foldK(fold))
        ctx.translate(-antTip[0], -antTip[1])
      }
      const bulb = K.paper(ctx, K.ellipsePts(antTip[0], antTip[1], bulbR, bulbR, 14), C.butter, { cut: 0.6, shadow: lantern > 0.5 ? 0.3 : 0.8, seed: id + 'bulb' })
      K.pathPoly(ctx, bulb)
      if (lantern > 0) {
        ctx.fillStyle = `rgba(255,246,196,${0.85 * lantern})`
        ctx.fill()
      }
      ctx.lineWidth = 2
      ctx.strokeStyle = C.ink
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(antTip[0] - 3, antTip[1] - 3.5, 2.6, 0, TAU)
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.fill()
      ctx.restore()
    }
    const drawTop = () => {
      if (cap) nightcap(ctx, id, t, [clamp(earLag[0] * 0.5, -14, 14), clamp(earLag[1] * 0.4, -8, 12) + 2 * Math.sin((TAU * t) / 2.9)], lantern)
      drawAntenna()
    }
    if (Math.abs(fold) < 0.002) {
      const shape = drawCardBase()
      drawFace(shape)
      drawEar()
      drawScarf()
      drawTop()
    } else {
      // BOW: the card folds forward at FOLD_Y. The lower card stays put; the upper half tips toward the viewer
      // (foreshortened about the hinge, a hair wider because it is closer), is shaded, and casts a shadow.
      const fp = Math.max(0, fold)
      ctx.save()
      ctx.beginPath()
      ctx.rect(-400, FOLD_Y, 800, 600)
      ctx.clip()
      drawCardBase()
      ctx.restore()
      drawScarf()
      if (fp > 0.02) {
        ctx.save()
        K.pathPoly(ctx, PIP_BODY)
        ctx.clip()
        const g = ctx.createLinearGradient(0, FOLD_Y, 0, FOLD_Y + 38)
        g.addColorStop(0, `rgba(70,40,10,${0.46 * fp})`)
        g.addColorStop(1, 'rgba(70,40,10,0)')
        ctx.fillStyle = g
        ctx.fillRect(-90, FOLD_Y, 180, 38)
        ctx.restore()
      }
      ctx.save()
      ctx.translate(0, FOLD_Y)
      ctx.scale(1 + FOLD_W * fold, foldK(fold))
      ctx.translate(0, -FOLD_Y)
      ctx.beginPath()
      ctx.rect(-400, -900, 800, 900 + FOLD_Y)
      ctx.clip()
      const sh2 = drawCardBase()
      drawFace(sh2)
      drawEar()
      if (fp > 0.02) {
        ctx.save()
        K.pathPoly(ctx, sh2)
        ctx.clip()
        const g = ctx.createLinearGradient(0, FOLD_Y, 0, -BH)
        g.addColorStop(0, `rgba(96,56,12,${0.4 * fp})`)
        g.addColorStop(0.35, `rgba(96,56,12,${0.18 * fp})`)
        g.addColorStop(1, `rgba(96,56,12,${0.08 * fp})`)
        ctx.fillStyle = g
        ctx.fillRect(-90, -BH - 10, 180, BH + 10 + FOLD_Y)
        ctx.restore()
      }
      drawTop()
      ctx.restore()
      if (fp > 0.05) {
        const wv = 75 * (1 + FOLD_W * fold)
        K.pencil.curve(ctx, [[-wv, FOLD_Y + 1], [0, FOLD_Y + 3.5], [wv, FOLD_Y]], id + 'crease', t, { stroke: C.ink, strokeWidth: 2.8, roughness: 0.5, bowing: 0.3 })
      }
    }
    ctx.restore() // body frame

    // ── front pass: held item, arms, hands (+ glue stick, mitts) ──
    if (hasHold && !holdBehind) drawHold()
    for (let i = 0; i < 2; i++) if (!R.behind[i]) drawArm(i)
    for (let i = 0; i < 2; i++) if (handFront[i]) drawHand(i)

    // effects
    if (R.fx) {
      const fx = R.fx
      if (fx.kind === 'impact' && toolG) {
        K.withAlpha(ctx, 1 - fx.p, () => K.sparkle(ctx, toolG[0], toolG[1], 16 + 18 * fx.p, id + 'imp', t, { n: 4, w: 3.4 }))
      } else if (fx.kind === 'clap') {
        const m = mix(hands[0], hands[1], 0.5)
        K.withAlpha(ctx, clamp01(1 - Math.abs(fx.p - 0.5) * 1.6), () => K.sparkle(ctx, m[0], m[1] - 6, 22, id + 'clp', t, { n: 3, w: 3 }))
      } else if (fx.kind === 'catch') {
        K.withAlpha(ctx, 1 - fx.p, () => K.sparkle(ctx, holdG[0], holdG[1], 30 + 16 * fx.p, id + 'cat', t, { n: 4, w: 3 }))
      } else if (fx.kind === 'jab' && tipG && R.finger) {
        // three short "boop" ticks fanning out ahead of the fingertip
        const a0 = Math.atan2(R.finger.dir[1], R.finger.dir[0])
        K.withAlpha(ctx, 1 - fx.p * fx.p, () => {
          for (let k = -1; k <= 1; k++) {
            const a = a0 + k * 0.75
            const r1 = 10 + 12 * fx.p
            const r2 = r1 + 20 - 5 * Math.abs(k)
            K.pencil.line(ctx, tipG[0] + Math.cos(a) * r1, tipG[1] + Math.sin(a) * r1, tipG[0] + Math.cos(a) * r2, tipG[1] + Math.sin(a) * r2, id + 'jab' + k, t, { stroke: C.ink, strokeWidth: 4, roughness: 0.5 })
          }
        })
      } else if (fx.kind === 'speed') {
        for (let i = 0; i < 3; i++) {
          const yy = -70 - i * 52
          K.pencil.line(ctx, -100 - i * 8, yy, -160 - i * 22, yy + 6, id + 'spd' + i, t, { stroke: C.inkDim, strokeWidth: 3, roughness: 0.9 })
        }
      }
    }

    const out = {
      hands: [map(hands[0]), map(hands[1])],
      head: map(T([0, -BH])),
      antenna: map(bulbG),
      feet: [map(R.feet[0]), map(R.feet[1])],
      eyes: [map(T([EYE[0].x, EYE[0].y])), map(T([EYE[1].x, EYE[1].y]))],
      holdAt: map(holdG),
      center: map(T([0, -BH / 2])),
      tool: toolG ? map(toolG) : null,
      tip: tipG ? map(tipG) : null,
      released: R.released,
    }
    ctx.restore()
    return out
  }

  // ═══════════════════════════════ CAST ═══════════════════════════════
  const STICKY = { sage: '#a6b67e', teal: '#62b2a6', peach: '#eeae90', butter: '#f0cd72', pink: '#f4b3c6', mint: '#b4dcc6', lemon: '#f7de8a' }
  function shade(hex, k) {
    // k < 0 darker, k > 0 lighter
    const n = parseInt(hex.slice(1), 16)
    let r = (n >> 16) & 255
    let g = (n >> 8) & 255
    let b = n & 255
    const f = (c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)
    r = f(r)
    g = f(g)
    b = f(b)
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)
  }
  /** Shared frame for small characters: world placement + flip + look conversion. */
  function stage(ctx, x, y, o, fn) {
    const s = num(o.scale, 1)
    const flip = !!(o.flip === true || o.mirror)
    const base = ctx.getTransform()
    ctx.save()
    ctx.translate(x, y)
    if (o.rot) ctx.rotate(o.rot)
    ctx.scale(flip ? -s : s, s)
    const map = mapper(ctx, base)
    const look = Array.isArray(o.look) ? [flip ? -o.look[0] : o.look[0], o.look[1]] : null
    const out = fn(map, look, flip)
    ctx.restore()
    return out
  }
  function contact(ctx, x, w, a = 0.16) {
    ctx.beginPath()
    ctx.ellipse(x, 2, w, w * 0.17, 0, 0, TAU)
    ctx.fillStyle = `rgba(58,36,14,${a})`
    ctx.fill()
  }

  // ───────── helper (sticky-note job helper) ─────────
  const HP = { W: 84, LEG: 24, SH: [[-40, -30], [40, -30]], HIP: [[-17, 0], [17, 0]], EYE: [{ x: -16, y: -52, r: 11.5 }, { x: 16, y: -50, r: 9.5 }] }
  const HAMMER_HIT = 0.35
  const HELPER_P = 0.44
  const HELPER_A = 13
  const HELPER_WALK_SPEED = (4 * HELPER_A) / HELPER_P // ≈ 118 px/s at scale 1
  function helperRig(pose, q, o) {
    const R = { root: [0, -HP.LEG], rot: 0, sx: 1, sy: 1, hands: [[-54, -8], [54, -8]], handsG: [null, null], feet: [[-20, 0], [20, 0]], eyes: 'normal', mouth: 'smile', look: [0, 0], tool: null, seat: false, fx: null }
    const sq = (v) => {
      R.sy = v
      R.sx = 1 + (1 - v) * 0.7
    }
    switch (pose) {
      case 'walk': {
        const g0 = gait(q, HELPER_P, HELPER_A, 8, 0)
        const g1 = gait(q, HELPER_P, HELPER_A, 8, 0.5)
        const sn = Math.sin((TAU * q) / HELPER_P)
        R.root = [0, -HP.LEG - 4 * Math.abs(sn)]
        R.rot = 0.07 + 0.03 * sn
        R.feet = [[-16 + g0[0], g0[1]], [16 + g1[0], g1[1]]]
        R.hands = [[-54 - 0.6 * g0[0], -10], [54 - 0.6 * g1[0], -10]]
        R.look = [0.5, 0]
        break
      }
      case 'hammer': {
        const P = 0.5
        const ph = (q - Math.floor(q / P) * P) / P
        const up = [44, -84]
        const hit = [60, -30]
        let hand
        let ang
        if (ph < 0.55) {
          const a = E.inOutCubic(ph / 0.55)
          hand = mix(hit, up, a)
          ang = lerp(0.12, -1.95, a)
        } else if (ph < 0.7) {
          const a = E.inCubic((ph - 0.55) / 0.15)
          hand = mix(up, hit, a)
          ang = lerp(-1.95, 0.12, a)
        } else {
          const a = (ph - 0.7) / 0.3
          hand = add(hit, [0, -4 * Math.sin(Math.PI * a)])
          ang = 0.12 - 0.18 * Math.sin(Math.PI * a)
        }
        const f = ph - 0.7
        R.hands = [[-50, -18], hand]
        R.rot = ph > 0.55 && ph < 0.8 ? 0.08 : 0.02
        sq(f >= 0 && f < 0.16 ? 0.92 : 1)
        R.tool = { kind: 'hammer', hand: 1, ang }
        R.look = [0.7, 0.55]
        R.mouth = ph < 0.55 ? 'flat' : 'grin'
        R.fx = f >= 0 && f < 0.2 ? { kind: 'impact', p: f / 0.2 } : null
        break
      }
      case 'magnify': {
        const sc = Math.sin((TAU * q) / 1.6)
        R.rot = 0.05 * sc
        R.hands = [[-54, -10], [40 + 6 * sc, -18]]
        R.tool = { kind: 'magnify', lens: [16 + 5 * sc, -50 - 1.5 * Math.cos((TAU * q) / 0.8)] }
        R.look = [0.4 * sc, 0.3]
        R.mouth = 'o'
        break
      }
      case 'check': {
        const p = E.inOutCubic(seg(q, 0.12, 0.5))
        const C0 = [76, -44]
        const mx = o.flip === true ? -1 : 1 // pre-mirror so the check never reads backwards when flipped
        const path = [add(C0, [-14 * mx, -2]), add(C0, [-4 * mx, 10]), add(C0, [18 * mx, -18])]
        const at = p < 0.35 ? mix(path[0], path[1], p / 0.35) : mix(path[1], path[2], (p - 0.35) / 0.65)
        const lift = seg(q, 0.5, 0.7)
        const dir = [Math.cos(0.95), Math.sin(0.95)]
        const handG = sub(add(at, [0, -12 * lift]), mul(dir, 16))
        R.handsG = [null, handG]
        R.hands = [[-54, -8], [0, 0]]
        R.tool = { kind: 'check', p, center: C0, path, crayon: add(at, [0, -12 * lift]), dir }
        R.look = [0.8, 0.4]
        R.eyes = q > 0.62 ? 'happy' : 'normal'
        R.mouth = q > 0.55 ? 'grin' : 'smile'
        R.rot = 0.05
        break
      }
      case 'tea': {
        R.root = [0, 0]
        R.seat = true
        const P = 2.6
        const ph = q - Math.floor(q / P) * P
        const sip = Math.sin(Math.PI * seg(ph, 1.2, 1.9))
        R.hands = [mix([-34, -4], [-8, -28], sip), mix([54, -10], [22, -28], sip)]
        R.tool = { kind: 'tea', at: mix([40, -14], [8, -30], sip), tilt: -0.5 * sip, steam: 1 - sip }
        R.feet = [[-34, 4], [34, 4]]
        R.eyes = sip > 0.3 ? 'happy' : 'normal'
        R.mouth = sip > 0.3 ? 'o' : 'smile'
        R.rot = 0.02 * wave(q, 3.1)
        R.look = [0.2, 0.3]
        break
      }
      case 'sit': {
        R.root = [0, 0]
        R.seat = true
        R.handsG = [[-52, -3], [52, -3]]
        const k = wave(q, 1.2)
        R.feet = [[-34 - 3 * Math.max(0, k), 4 - 6 * Math.max(0, k)], [34 + 3 * Math.max(0, -k), 4 - 6 * Math.max(0, -k)]]
        R.rot = 0.03 * wave(q, 2.4)
        R.look = [0.2 * Math.sin((TAU * q) / 4), 0]
        break
      }
      case 'hop': {
        const P = 0.6
        const lt = q - Math.floor(q / P) * P
        const h = hop(lt, 0.1, { dur: 0.36, height: 40, pre: 0.1 })
        R.root = [0, -HP.LEG + h.y + (h.squash < 1 ? (1 - h.squash) * 16 : 0)]
        sq(h.squash)
        const up = h.air ? Math.sin(Math.PI * h.p) : 0
        R.hands = [mix([-54, -10], [-62, -86], up), mix([54, -10], [62, -86], up)]
        if (h.air) R.feet = [[-16, h.y - 4], [16, h.y - 4]]
        R.mouth = 'grin'
        break
      }
      case 'cheer': {
        const P = 0.45
        const lt = q - Math.floor(q / P) * P
        const h = hop(lt, 0.06, { dur: 0.26, height: 12, pre: 0.06 })
        R.root = [0, -HP.LEG + h.y]
        sq(h.squash)
        const w = wave(q, 0.45)
        R.hands = [[-64 - 6 * w, -96 + 8 * w], [64 - 6 * w, -96 - 8 * w]]
        R.eyes = 'happy'
        R.mouth = 'open'
        break
      }
      default: {
        const b = wave(q, 2.4)
        sq(1 + 0.025 * b)
        R.rot = 0.04 * wave(q, 3)
        R.hands = [[-54, -6 + 2 * b], [54, -6 - 2 * b]]
        R.look = [0.25 * Math.sin((TAU * q) / 4.7), 0]
      }
    }
    return R
  }
  function helper(ctx, x, y, t, o = {}) {
    const pose = o.pose || 'idle'
    const q = Math.max(0, num(o.poseT, t))
    const id = String(o.id || 'helper')
    const col = STICKY[o.color] || (typeof o.color === 'string' && o.color[0] === '#' ? o.color : STICKY.sage)
    return stage(ctx, x, y, o, (map, lookW) => {
      const R = helperRig(pose, q, o)
      const nd = K.nudge(id, t, 0.5)
      R.root = [R.root[0] + nd.dx, R.root[1] + nd.dy]
      R.rot += nd.rot
      const T = (p) => {
        const r = rot2([p[0] * R.sx, p[1] * R.sy], R.rot)
        return [R.root[0] + r[0], R.root[1] + r[1]]
      }
      const eyeLag = lagOf((tt) => {
        const r = helperRig(pose, tt, o)
        return add(r.root, rot2([0, -52 * r.sy], r.rot))
      }, q, K_EYE)
      if (!R.seat) contact(ctx, 0, 44 * (1 - clamp01(-(R.root[1] + HP.LEG) / 120) * 0.5))
      else contact(ctx, 0, 50, 0.12)
      // legs
      for (let i = 0; i < 2; i++) {
        const hip = T(HP.HIP[i])
        hose(ctx, hip, R.feet[i], 28, autoBend(hip, R.feet[i], i ? 1 : -1), id + 'lg' + i, t, { w: 3, color: C.ink })
      }
      for (let i = 0; i < 2; i++) punch(ctx, add(R.feet[i], [i ? 3 : -3, -1]), 8, C.ink, id + 'ft' + i, { sx: 1.1, sy: 0.62, shadow: 0.5 })
      const hands = [0, 1].map((i) => R.handsG[i] || T(R.hands[i]))
      const shoulders = [T(HP.SH[0]), T(HP.SH[1])]
      // body
      ctx.save()
      ctx.translate(R.root[0], R.root[1])
      ctx.rotate(R.rot)
      ctx.scale(R.sx, R.sy)
      const W = HP.W
      const curl = 16
      const note = [[-W / 2, -W], [W / 2, -W], [W / 2, -curl], [W / 2 - curl, 0], [-W / 2, 0]]
      const sh = K.paper(ctx, note, col, { cut: 1.2, shadow: 1, lift: 3, seed: id + 'n' })
      ctx.save()
      K.pathPoly(ctx, sh)
      ctx.clip()
      ctx.fillStyle = 'rgba(0,0,0,0.05)'
      ctx.fillRect(-W / 2 - 4, -W - 4, W + 8, 18)
      ctx.fillStyle = 'rgba(255,255,255,0.14)'
      ctx.fillRect(-W / 2 - 4, -W + 14, W + 8, 3)
      ctx.restore()
      ink(ctx, note, id + 'no', t, { w: 2.2, rough: 0.7 })
      // curled corner
      const cp = [[W / 2, -curl], [W / 2 - curl, 0], [W / 2 - curl - 3, -curl - 5]]
      K.dropShadow(ctx, cp, 0.8, 3)
      K.paper(ctx, cp, shade(col, 0.35), { cut: 0.3, shadow: 0, seed: id + 'cl' })
      ink(ctx, cp, id + 'clo', t, { w: 1.8, rough: 0.5 })
      // face
      const lk0 = lookW || R.look
      const blink = R.eyes === 'normal' ? blinkAt(t, id) : 0
      for (let i = 0; i < 2; i++) {
        const e = HP.EYE[i]
        if (R.eyes === 'happy') happyEye(ctx, e.x, e.y + 3, e.r, id + 'he' + i, t, 3.4)
        else {
          const travel = e.r * 0.5 * 0.9
          K.googly(ctx, e.x, e.y, e.r, t, id + 'e' + i, clampLen(add(lk0, mul(eyeLag, 1 / travel)), 1.12), { blink: false, pupil: 0.5 })
          if (blink > 0) eyelid(ctx, e.x, e.y, e.r, blink, col)
        }
      }
      blushDot(ctx, -28, -36, 1, 7)
      blushDot(ctx, 29, -35, 1, 6.5)
      mouth(ctx, R.mouth, 1, -30, 0.62, id + 'm', t)
      ctx.restore()

      const tool = R.tool
      let toolAnchor = null
      // tea cup sits in front of the body, behind the hands
      if (tool && tool.kind === 'tea') {
        const tc = T(tool.at)
        K.at(ctx, tc[0], tc[1], tool.tilt, 1, () => {
          piece(ctx, K.ellipsePts(0, 10, 18, 4.5, 16), C.kraft, id + 'sau', t, { cut: 0.5, shadow: 0.6, w: 1.6 })
          K.pencil.circle(ctx, 12, 0, 11, id + 'cuph', t, { strokeWidth: 2.4, roughness: 0.5, stroke: C.ink })
          piece(ctx, [[-11, -8], [11, -8], [8, 8], [-8, 8]], C.cream, id + 'cup', t, { cut: 0.5, shadow: 0.5, w: 1.8 })
          ctx.fillStyle = C.peach
          ctx.fillRect(-10, -3, 20, 4)
        })
        if (tool.steam > 0.2) {
          K.withAlpha(ctx, tool.steam * 0.8, () => {
            for (let k = 0; k < 2; k++) {
              const b = K.boil(t)
              const sx0 = tc[0] - 5 + k * 9
              const sy0 = tc[1] - 14
              K.pencil.curve(ctx, [[sx0, sy0], [sx0 + 4, sy0 - 8 - (b % 2)], [sx0 - 3, sy0 - 16], [sx0 + 3, sy0 - 25]], id + 'st' + k, t, { strokeWidth: 2, roughness: 0.8, stroke: C.inkFaint })
            }
          })
        }
      }
      // arms
      const fdir = [0, 1].map((i) => hose(ctx, shoulders[i], hands[i], 50, autoBend(shoulders[i], hands[i], i ? 1 : -1), id + 'ar' + i, t, { w: 2.8, color: C.ink }))
      if (tool && tool.kind === 'hammer') {
        const hd = hands[1]
        const d = [Math.cos(tool.ang), Math.sin(tool.ang)]
        K.at(ctx, hd[0], hd[1], tool.ang, 1, () => {
          piece(ctx, rrect(-6, -3.5, 34, 7, 2), C.mustard, id + 'hh', t, { cut: 0.3, shadow: 0.6, w: 1.5 })
          piece(ctx, rrect(24, -12, 12, 24, 3), C.pink, id + 'hhd', t, { cut: 0.4, shadow: 0.7, w: 1.8 })
          ctx.fillStyle = C.kraftDark
          ctx.fillRect(24, -12, 12, 4)
        })
        toolAnchor = add(add(hd, mul(d, 30)), mul([-d[1], d[0]], 12))
      }
      if (tool && tool.kind === 'check') {
        const cpth = tool.path
        const p = tool.p
        if (p > 0) {
          const pts = [cpth[0]]
          if (p < 0.35) pts.push(mix(cpth[0], cpth[1], p / 0.35))
          else {
            pts.push(cpth[1])
            pts.push(mix(cpth[1], cpth[2], (p - 0.35) / 0.65))
          }
          K.rc(ctx).linearPath(pts, K.ro(id + 'ck', t, { stroke: C.crayonGreen, strokeWidth: 6, roughness: 0.9, bowing: 0.4 }))
          K.rc(ctx).linearPath(pts, K.ro(id + 'ck2', t, { stroke: '#4fae45', strokeWidth: 2.5, roughness: 1.2, bowing: 0.6 }))
        }
        const cr = tool.crayon
        const ang = Math.atan2(tool.dir[1], tool.dir[0])
        K.at(ctx, cr[0], cr[1], ang, 1, () => {
          piece(ctx, [[-2, -4], [-24, -5], [-24, 5], [-2, 4], [4, 0]], C.crayonGreen, id + 'cry', t, { cut: 0.2, shadow: 0.6, w: 1.5 })
          ctx.fillStyle = 'rgba(255,255,255,0.55)'
          ctx.fillRect(-19, -4.5, 8, 9)
        })
        toolAnchor = tool.center
      }
      // hands (cream cartoon-glove dots)
      for (let i = 0; i < 2; i++) punch(ctx, hands[i], 6.5, C.paperWhite, id + 'hd' + i, { lw: 1.6 })
      if (tool && tool.kind === 'magnify') {
        const L = T(tool.lens)
        const e = HP.EYE[1]
        const eyeG = T([e.x, e.y])
        const hd = hands[1]
        const rr = 17
        K.pencil.line(ctx, hd[0], hd[1], L[0] + rr * 0.7, L[1] + rr * 0.7, id + 'mh', t, { stroke: C.kraftDark, strokeWidth: 6, roughness: 0.4 })
        punch(ctx, hd, 6.5, C.paperWhite, id + 'hd1b', { lw: 1.6 })
        ctx.save()
        ctx.beginPath()
        ctx.arc(L[0], L[1], rr, 0, TAU)
        ctx.clip()
        ctx.fillStyle = 'rgba(214,236,244,0.55)'
        ctx.fillRect(L[0] - rr, L[1] - rr, rr * 2, rr * 2)
        const mag = add(L, mul(sub(eyeG, L), 1.6))
        K.googly(ctx, mag[0], mag[1], e.r * 1.65, t, id + 'mag', clampLen(add(lookW || R.look, [0.1, 0]), 1), { blink: false, pupil: 0.5 })
        ctx.restore()
        ctx.beginPath()
        ctx.arc(L[0] - 5, L[1] - 6, rr * 0.55, 3.6, 4.6)
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'
        ctx.lineWidth = 2.5
        ctx.stroke()
        K.pencil.circle(ctx, L[0], L[1], rr * 2 + 3, id + 'mr', t, { stroke: C.hiveTeal, strokeWidth: 5, roughness: 0.4 })
        toolAnchor = L
      }
      if (R.fx && R.fx.kind === 'impact' && toolAnchor) K.withAlpha(ctx, 1 - R.fx.p, () => K.sparkle(ctx, toolAnchor[0] + 4, toolAnchor[1] + 6, 10 + 10 * R.fx.p, id + 'im', t, { n: 3, w: 2.6 }))
      return {
        hands: [map(hands[0]), map(hands[1])],
        head: map(T([0, -HP.W])),
        tool: toolAnchor ? map(toolAnchor) : null,
        feet: [map(R.feet[0]), map(R.feet[1])],
        center: map(T([0, -HP.W / 2])),
      }
    })
  }

  // ───────── agent (paper-doll trading card) ─────────
  const AGENT = {
    architect: { border: C.honey, accent: C.terracotta },
    devlead: { border: C.hiveTeal, accent: C.butter },
    validator: { border: C.sage, accent: C.peach },
  }
  const AG = { W: 116, H: 160, LEG: 30, SH: [[-56, -58], [56, -58]], HIP: [[-24, 0], [24, 0]], EYE: [{ x: -20, y: -112, r: 15.5 }, { x: 21, y: -110, r: 13 }] }
  function agentRig(pose, q) {
    const R = { root: [0, -AG.LEG], rot: 0, sx: 1, sy: 1, hands: [[-74, -14], [74, -14]], feet: [[-26, 0], [26, 0]], eyes: 'normal', mouth: 'smile', brows: null, look: [0, 0], holdAt: [0, -62] }
    const sq = (v) => {
      R.sy = v
      R.sx = 1 + (1 - v) * 0.7
    }
    switch (pose) {
      case 'wave': {
        const w = wave(q, 0.5)
        R.hands = [[-74, -14], [92 + 16 * w, -150 + 5 * Math.abs(w)]]
        R.rot = 0.03 * wave(q, 1)
        R.mouth = 'grin'
        R.look = [0.2, -0.1]
        break
      }
      case 'hop': {
        const P = 0.7
        const lt = q - Math.floor(q / P) * P
        const h = hop(lt, 0.12, { dur: 0.42, height: 56, pre: 0.12 })
        R.root = [0, -AG.LEG + h.y + (h.squash < 1 ? (1 - h.squash) * 20 : 0)]
        sq(h.squash)
        const up = h.air ? Math.sin(Math.PI * h.p) : 0
        R.hands = [mix([-72, -18], [-92, -130], up), mix([72, -18], [92, -130], up)]
        if (h.air) R.feet = [[-22, h.y - 6], [22, h.y - 6]]
        R.mouth = 'grin'
        break
      }
      case 'tear': {
        const P = 0.55
        const ph = (q - Math.floor(q / P) * P) / P
        const jerk = ph < 0.25 ? E.outBack(ph / 0.25) : 1 - E.inOutCubic((ph - 0.25) / 0.75) * 0.7
        const d = 18 + 22 * jerk
        R.hands = [[-d, -58 - 3 * jerk], [d, -54 + 3 * jerk]]
        R.holdAt = [0, -56]
        R.rot = 0.03 * (jerk - 0.5)
        sq(1 + 0.03 * jerk)
        R.brows = 'determined'
        R.mouth = 'grin'
        R.look = [0, 0.5]
        break
      }
      case 'fan': {
        R.hands = [[-94, -92 + 4 * wave(q, 0.9)], [94, -92 - 4 * wave(q, 0.9)]]
        R.feet = [[-12, 0], [12, 0]]
        R.rot = 0.04 * wave(q, 1.4)
        R.mouth = 'grin'
        break
      }
      default: {
        const b = wave(q, 2.5)
        sq(1 + 0.02 * b)
        R.rot = 0.04 * wave(q, 3.2)
        R.hands = [[-74, -12 + 2 * b], [74, -12 - 2 * b]]
        R.look = [0.2 * Math.sin((TAU * q) / 4.9), 0]
      }
    }
    return R
  }
  function agentAccessoryBack(ctx, kind, id, t, mini) {
    if (kind === 'devlead' && !mini) {
      // pencil tucked behind the "ear"
      K.at(ctx, 52, -150, 0.9, 1, () => {
        piece(ctx, rrect(-26, -5, 40, 10, 2), C.mustard, id + 'pcl', t, { cut: 0.3, shadow: 0.7, w: 1.6 })
        piece(ctx, [[14, -5], [26, 0], [14, 5]], C.kraft, id + 'pct', t, { cut: 0.2, shadow: 0, w: 1.4 })
        ctx.fillStyle = C.pink
        ctx.fillRect(-30, -5, 6, 10)
      })
    }
  }
  function agentHat(ctx, kind, id, t, mini, back) {
    if (kind !== 'architect') return
    const s = mini ? 0.58 : 1
    const top = mini ? -88 : -AG.H + 4
    ctx.save()
    ctx.translate(0, top)
    ctx.scale(s, s)
    const tri = [[-50, -4], [-44, -24], [-26, -40], [-6, -50], [6, -50], [26, -40], [44, -24], [50, -4]]
    piece(ctx, tri, back ? shade(C.terracotta, -0.2) : C.terracotta, id + 'hat', t, { cut: 1, shadow: 0.9, lift: 2, w: 2.3 })
    if (!back) {
      // centre ridge + a highlight streak
      piece(ctx, [[-8, -4], [-6, -52], [6, -52], [8, -4]], shade(C.terracotta, 0.25), id + 'ridge', t, { cut: 0.4, shadow: 0.5, w: 1.6 })
      ctx.save()
      K.pathPoly(ctx, tri)
      ctx.clip()
      ctx.strokeStyle = 'rgba(255,240,210,0.5)'
      ctx.lineWidth = 4
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.arc(0, -4, 36, 3.5, 4.3)
      ctx.stroke()
      ctx.restore()
    }
    piece(ctx, rrect(-62, -9, 124, 13, 6), back ? shade(C.terracotta, -0.3) : '#9c4a28', id + 'brim', t, { cut: 0.8, shadow: 0.8, w: 2.1 })
    if (!mini) {
      // paper-doll fold tabs
      for (const sx of [-1, 1]) piece(ctx, [[sx * 60, -7], [sx * 72, -3], [sx * 72, 3], [sx * 60, 3]], C.paperWhite, id + 'tab' + sx, t, { cut: 0.2, shadow: 0.4, w: 1.4 })
    }
    ctx.restore()
  }
  function agentFace(ctx, kind, R, id, t, lookW, eyeLag, sz) {
    const lk0 = lookW || R.look
    const blink = R.eyes === 'normal' ? blinkAt(t, id) : 0
    const eyes = sz.eyes
    for (let i = 0; i < 2; i++) {
      const e = eyes[i]
      const travel = e.r * 0.5 * 0.9
      if (R.eyes === 'happy') happyEye(ctx, e.x, e.y + 3, e.r, id + 'he' + i, t, 3.6)
      else {
        K.googly(ctx, e.x, e.y, e.r, t, id + 'e' + i, clampLen(add(lk0, mul(eyeLag, 1 / travel)), 1.12), { blink: false, pupil: 0.5 })
        if (blink > 0) eyelid(ctx, e.x, e.y, e.r, blink, C.cream)
      }
    }
    if (R.brows && !sz.mini) {
      const b = [[[-34, -134], [-8, -127]], [[9, -126], [34, -132]]]
      b.forEach((p, i) => K.pencil.line(ctx, p[0][0], p[0][1], p[1][0], p[1][1], id + 'br' + i, t, { strokeWidth: 3, roughness: 0.4 }))
    }
    blushDot(ctx, sz.blush[0][0], sz.blush[0][1], 1, sz.mini ? 5.5 : 8)
    blushDot(ctx, sz.blush[1][0], sz.blush[1][1], 1, sz.mini ? 5 : 7.5)
    mouth(ctx, R.mouth, sz.mouth[0], sz.mouth[1], sz.mini ? 0.5 : 0.8, id + 'm', t)
  }
  function magnifier(ctx, L, rr, handle, eye, id, t, lk) {
    if (handle) K.pencil.line(ctx, handle[0], handle[1], L[0] + rr * 0.72, L[1] + rr * 0.72, id + 'mh', t, { stroke: C.kraftDark, strokeWidth: rr * 0.42, roughness: 0.4 })
    ctx.save()
    ctx.beginPath()
    ctx.arc(L[0], L[1], rr, 0, TAU)
    ctx.clip()
    ctx.fillStyle = 'rgba(214,236,244,0.6)'
    ctx.fillRect(L[0] - rr, L[1] - rr, rr * 2, rr * 2)
    if (eye) {
      const mag = add(L, mul(sub([eye.x, eye.y], L), 1.5))
      K.googly(ctx, mag[0], mag[1], eye.r * 1.55, t, id + 'mag', lk, { blink: false, pupil: 0.5 })
    }
    ctx.restore()
    ctx.beginPath()
    ctx.arc(L[0] - rr * 0.3, L[1] - rr * 0.35, rr * 0.55, 3.6, 4.6)
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = Math.max(1.5, rr * 0.14)
    ctx.stroke()
    K.pencil.circle(ctx, L[0], L[1], rr * 2 + 3, id + 'mr', t, { stroke: C.hiveTeal, strokeWidth: Math.max(3, rr * 0.28), roughness: 0.4 })
  }
  function cardBack(ctx, w, h, col, id, t) {
    const outer = rrect(-w / 2, -h, w, h, 10)
    piece(ctx, outer, col, id + 'bk', t, { cut: 1.2, shadow: 1, lift: 3, w: 2.4 })
    const inner = rrect(-w / 2 + 9, -h + 9, w - 18, h - 18, 7)
    piece(ctx, inner, shade(col, 0.28), id + 'bki', t, { cut: 0.8, shadow: 0.35, w: 1.6 })
    ctx.save()
    K.pathPoly(ctx, inner)
    ctx.clip()
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let k = -h; k < w + h; k += 16) {
      ctx.moveTo(-w / 2 + k, -h)
      ctx.lineTo(-w / 2 + k - h, 0)
      ctx.moveTo(-w / 2 + k - h, -h)
      ctx.lineTo(-w / 2 + k, 0)
    }
    ctx.stroke()
    ctx.restore()
    const cy = -h / 2
    piece(ctx, K.ellipsePts(0, cy, w * 0.26, w * 0.26, 18), C.cream, id + 'bke', t, { cut: 1, shadow: 0.7, w: 2 })
    // paperclip doodle in the emblem
    ctx.save()
    ctx.strokeStyle = C.hiveTeal
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(4, cy + 12)
    ctx.lineTo(4, cy - 10)
    ctx.arc(-1, cy - 10, 5, 0, Math.PI, true)
    ctx.lineTo(-6, cy + 10)
    ctx.arc(-2.5, cy + 10, 3.5, Math.PI, 0, true)
    ctx.lineTo(1, cy - 5)
    ctx.stroke()
    ctx.restore()
  }
  /** Kind emblem for a mini card's name plate: hard-hat glyph | wrench | lens. (x, y) = plate centre. */
  function emblem(ctx, kind, x, y, id, t) {
    K.at(ctx, x, y, 0, 1, () => {
      if (kind === 'architect') {
        const dome = [[-12, 3], [-10.5, -4.5], [-6, -9.5], [0, -11.5], [6, -9.5], [10.5, -4.5], [12, 3]]
        piece(ctx, dome, C.terracotta, id + 'emh', t, { cut: 0.3, shadow: 0.4, w: 1.5, rough: 0.4 })
        piece(ctx, [[-2, 2], [-2, -11], [2, -11], [2, 2]], shade(C.terracotta, 0.25), id + 'emr', t, { cut: 0.1, shadow: 0, line: false })
        piece(ctx, rrect(-16, 1.5, 32, 5.5, 2.5), '#9c4a28', id + 'emb', t, { cut: 0.2, shadow: 0.3, w: 1.4, rough: 0.4 })
      } else if (kind === 'devlead') {
        K.at(ctx, 0, 1, -0.5, 0.42, () => {
          ctx.translate(-26, 0)
          wrench(ctx, id + 'em', t, 3.6)
        })
      } else {
        K.pencil.line(ctx, 3.5, 3.5, 12, 10.5, id + 'emh', t, { stroke: C.kraftDark, strokeWidth: 4.2, roughness: 0.3 })
        ctx.beginPath()
        ctx.arc(-2, -2, 7.5, 0, TAU)
        ctx.fillStyle = 'rgba(214,236,244,0.85)'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(-4.5, -4.5, 3.2, 3.4, 4.8)
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth = 1.6
        ctx.stroke()
        K.pencil.circle(ctx, -2, -2, 17, id + 'emr', t, { stroke: C.hiveTeal, strokeWidth: 3.4, roughness: 0.3 })
      }
    })
  }
  function agent(ctx, x, y, t, o = {}) {
    const kind = AGENT[o.kind] ? o.kind : 'architect'
    const pal = AGENT[kind]
    const pose = o.pose || 'idle'
    const q = Math.max(0, num(o.poseT, t))
    const id = String(o.id || 'agent-' + kind)
    // o.flip is the CARD FLIP when it is a number; flip === true (the boolean every other fn uses) mirrors instead
    const mirror = !!o.mirror || o.flip === true
    const fl = typeof o.flip === 'number' ? clamp01(num(o.flip, 0)) : 0
    const opts = Object.assign({}, o, { flip: false, mirror })
    const cosF = Math.cos(Math.PI * fl)
    const back = cosF < 0
    const fx = Math.max(0.02, Math.abs(cosF))
    if (o.mini) {
      return stage(ctx, x, y, opts, (map, lookW) => {
        const w = 68
        const h = 92
        const nd = K.nudge(id, t, 0.4)
        ctx.translate(nd.dx, nd.dy + h / 2)
        ctx.rotate(nd.rot)
        ctx.scale(fx, 1)
        if (back) {
          cardBack(ctx, w, h, pal.border, id, t)
        } else {
          piece(ctx, rrect(-w / 2, -h, w, h, 8), pal.border, id + 'c', t, { cut: 1, shadow: 1, lift: 2, w: 2.2 })
          piece(ctx, rrect(-w / 2 + 6, -h + 6, w - 12, 50, 5), C.cream, id + 'p', t, { cut: 0.6, shadow: 0.3, w: 1.4 })
          piece(ctx, rrect(-w / 2 + 6, -35, w - 12, 28, 4), C.paperWhite, id + 'pl', t, { cut: 0.4, shadow: 0.3, w: 1.3 })
          const sz = { mini: true, eyes: [{ x: -12, y: -66, r: 10.5 }, { x: 13, y: -65, r: 9 }], blush: [[-22, -53], [23, -52]], mouth: [1, -50] }
          agentFace(ctx, kind, { eyes: 'normal', look: [0, 0], mouth: 'smile' }, id, t, lookW, [0, 0], sz)
          emblem(ctx, kind, 0, -21, id, t)
          agentHat(ctx, kind, id, t, true, false)
        }
        const F = (p) => [p[0] * fx + nd.dx, p[1] + nd.dy + h / 2]
        return { center: map(F([0, -h / 2])), head: map(F([0, -h])) }
      })
    }
    return stage(ctx, x, y, opts, (map, lookW) => {
      const R = agentRig(pose, q)
      const nd = K.nudge(id, t, 0.5)
      R.root = [R.root[0] + nd.dx, R.root[1] + nd.dy]
      R.rot += nd.rot
      const T = (p) => {
        const r = rot2([p[0] * R.sx, p[1] * R.sy], R.rot)
        return [R.root[0] + r[0], R.root[1] + r[1]]
      }
      // The WHOLE doll goes through the card flip (ctx.scale(fx, 1) below); F maps a doll point to the stage frame.
      const F = (p) => [p[0] * fx, p[1]]
      const limbA = seg(fx, 0.1, 0.3) // arms + props fade out as the card goes edge-on → just the paper sliver
      const eyeLag = lagOf((tt) => {
        const r = agentRig(pose, tt)
        return add(r.root, rot2([0, -110 * r.sy], r.rot))
      }, q, K_EYE)
      contact(ctx, 0, 58 * (0.35 + 0.65 * fx) * (1 - clamp01(-(R.root[1] + AG.LEG) / 150) * 0.5))
      const hands = R.hands.map((h) => T(h))
      const shoulders = AG.SH.map((p) => T(p))
      // legs stay full-width pencil lines (they converge to the centre instead of vanishing)
      for (let i = 0; i < 2; i++) {
        const hip = F(T(AG.HIP[i]))
        const ft = F(R.feet[i])
        hose(ctx, hip, ft, 36, autoBend(hip, ft, i ? 1 : -1), id + 'lg' + i, t, { w: 3.2, color: C.ink })
      }
      for (let i = 0; i < 2; i++) punch(ctx, F(add(R.feet[i], [i ? 3 : -3, -1])), 9, C.ink, id + 'ft' + i, { sx: 1.1 * Math.max(0.4, fx), sy: 0.62, shadow: 0.5 })
      ctx.save()
      ctx.scale(fx, 1)
      const arms = () => [0, 1].map((i) => hose(ctx, shoulders[i], hands[i], 66, autoBend(shoulders[i], hands[i], i ? 1 : -1), id + 'ar' + i, t, { w: 3.1, color: C.ink, slack: 0.03 }))
      if (back && limbA > 0) K.withAlpha(ctx, limbA, arms)
      // card body
      ctx.save()
      ctx.translate(R.root[0], R.root[1])
      ctx.rotate(R.rot)
      ctx.scale(R.sx, R.sy)
      if (back) {
        agentHat(ctx, kind, id, t, false, true)
        cardBack(ctx, AG.W, AG.H, pal.border, id, t)
      } else {
        agentAccessoryBack(ctx, kind, id, t, false)
        const W = AG.W
        const H = AG.H
        piece(ctx, rrect(-W / 2, -H, W, H, 11), pal.border, id + 'c', t, { cut: 1.2, shadow: 1, lift: 3 + Math.max(0, -(R.root[1] + AG.LEG)) / 12, w: 2.5 })
        const panel = rrect(-W / 2 + 9, -H + 9, W - 18, H - 58, 7)
        piece(ctx, panel, C.cream, id + 'p', t, { cut: 0.8, shadow: 0.4, w: 1.6 })
        hatch(ctx, panel, pal.border, 0.12, 12, -0.9, id + 'ph', t, 2)
        const plate = rrect(-W / 2 + 10, -42, W - 20, 30, 5)
        piece(ctx, plate, C.paperWhite, id + 'pl', t, { cut: 0.6, shadow: 0.4, w: 1.6 })
        K.pencil.curve(ctx, [[-40, -33], [-22, -30], [-5, -34], [14, -31]], id + 'sq1', t, { strokeWidth: 1.8, roughness: 1, stroke: C.inkFaint })
        K.pencil.curve(ctx, [[-40, -22], [-26, -20], [-12, -23]], id + 'sq2', t, { strokeWidth: 1.8, roughness: 1, stroke: C.inkFaint })
        if (kind === 'validator') {
          const m = mirror ? -1 : 1
          K.rc(ctx).linearPath([[24 * m, -28], [30 * m, -21], [42 * m, -36]], K.ro(id + 'vck', t, { stroke: '#4fae45', strokeWidth: 3.4, roughness: 0.7 }))
        }
        const sz = { mini: false, eyes: AG.EYE, blush: [[-36, -88], [37, -86]], mouth: [1, -84] }
        agentFace(ctx, kind, R, id, t, lookW, eyeLag, sz)
        agentHat(ctx, kind, id, t, false, false)
      }
      ctx.restore()
      if (limbA > 0) {
        K.withAlpha(ctx, limbA, () => {
          if (typeof o.hold === 'function') {
            const hg = T(R.holdAt)
            K.at(ctx, hg[0], hg[1], R.rot, 1, (c) => o.hold(c))
          }
          if (!back) {
            // props held in hand
            const fd = arms()
            if (kind === 'architect' && pose !== 'tear') {
              const hd = hands[0]
              K.at(ctx, hd[0], hd[1], -0.5 + (pose === 'hop' ? -0.3 : 0), 1, () => {
                piece(ctx, rrect(-11, -50, 22, 84, 9), '#4f79bd', id + 'bp', t, { cut: 0.6, shadow: 0.8, w: 2 })
                ctx.strokeStyle = 'rgba(255,255,255,0.75)'
                ctx.lineWidth = 1.4
                ctx.beginPath()
                for (const yy of [-30, -16, -2, 12]) {
                  ctx.moveTo(-7, yy)
                  ctx.lineTo(7, yy)
                }
                ctx.moveTo(-3, -40)
                ctx.lineTo(-3, 26)
                ctx.moveTo(4, -40)
                ctx.lineTo(4, 26)
                ctx.stroke()
                // loose sheet edge peeling off the roll
                piece(ctx, [[11, -46], [22, -40], [20, 22], [11, 30]], '#6d93cf', id + 'bps', t, { cut: 0.3, shadow: 0.5, w: 1.5 })
                piece(ctx, K.ellipsePts(0, -50, 11, 5, 14), '#9db8e2', id + 'bpe', t, { cut: 0.2, shadow: 0.3, w: 1.6 })
                ctx.strokeStyle = '#2d4f86'
                ctx.lineWidth = 1.5
                ctx.beginPath()
                ctx.ellipse(0, -50, 6, 2.6, 0, 0.3, 5.6)
                ctx.stroke()
              })
            }
            if (kind === 'devlead' && pose !== 'tear') {
              const hd = hands[1]
              const d = fd[1]
              K.at(ctx, hd[0], hd[1], Math.atan2(d[1], d[0]) - 0.3, 1, () => wrench(ctx, id, t))
            }
            if (kind === 'validator' && pose !== 'tear') {
              const e = AG.EYE[1]
              const eyeG = T([e.x, e.y])
              const L = add(eyeG, [4, 2])
              const lk = clampLen(add(lookW || R.look, mul(eyeLag, 1 / 8)), 1)
              magnifier(ctx, L, 22, hands[1], { x: eyeG[0], y: eyeG[1], r: e.r }, id, t, lk)
            }
            for (let i = 0; i < 2; i++) punch(ctx, hands[i], 7.5, C.paperWhite, id + 'hd' + i, { lw: 1.6 })
          }
        })
      }
      ctx.restore()
      return {
        hands: [map(F(hands[0])), map(F(hands[1]))],
        head: map(F(T([0, -AG.H]))),
        feet: [map(F(R.feet[0])), map(F(R.feet[1]))],
        center: map(F(T([0, -AG.H / 2]))),
        holdAt: map(F(T(R.holdAt))),
      }
    })
  }
  function wrench(ctx, id, t, lw = 1.8) {
    // handle along +x from the grip, open jaw at the far end
    const steel = '#c9d1d3'
    piece(ctx, rrect(-10, -5.5, 52, 11, 5), steel, id + 'wh', t, { cut: 0.4, shadow: 0.7, w: lw })
    const jaw = []
    for (let i = 0; i <= 14; i++) {
      const a = 0.75 + (i / 14) * (TAU - 1.5)
      jaw.push([50 + Math.cos(a) * 14, Math.sin(a) * 14])
    }
    jaw.push([56, -4], [50, -3], [50, 3], [56, 4])
    piece(ctx, jaw, steel, id + 'wj', t, { cut: 0.4, shadow: 0.7, w: lw })
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillRect(0, -3.5, 30, 2.5)
  }

  // ───────── YOU (stick figure + paper bed) ─────────
  const SKIN = '#f1c6a2'
  const HAIR = '#4a3426'
  function head(ctx, c, r, id, t, o = {}) {
    piece(ctx, K.ellipsePts(c[0], c[1], r, r * 1.02, 20), o.skin || SKIN, id + 'hd', t, { cut: 0.8, shadow: 0.8, w: 2.2 })
  }
  function pajamaTop(ctx, pts, id, t) {
    piece(ctx, pts, C.sky, id + 'pj', t, { cut: 1, shadow: 0.8, w: 2.1 })
    stripes(ctx, pts, C.paperWhite, 0.6, 12, 3.5)
  }
  function zzz(ctx, x, y, t, id, color) {
    for (let i = 0; i < 3; i++) {
      const P = 2.4
      const ph = (((t + i * 0.8) % P) + P) % P / P
      const a = ph < 0.15 ? ph / 0.15 : ph > 0.72 ? 1 - (ph - 0.72) / 0.28 : 1
      const sz = 10 + 14 * ph
      const cx = x + 26 * ph + 10 * Math.sin(ph * 5 + i)
      const cy = y - 90 * ph
      K.withAlpha(ctx, a, () => {
        K.rc(ctx).linearPath([[cx - sz / 2, cy - sz / 2], [cx + sz / 2, cy - sz / 2], [cx - sz / 2, cy + sz / 2], [cx + sz / 2, cy + sz / 2]], K.ro(id + 'z' + i, t, { stroke: color, strokeWidth: 4, roughness: 0.8, bowing: 0.3 }))
      })
    }
  }
  function you(ctx, x, y, t, o = {}) {
    const pose = ['sleep', 'stretch', 'wake'].includes(o.pose) ? o.pose : 'sleep'
    const q = Math.max(0, num(o.poseT, t))
    const id = String(o.id || 'you')
    const inBed = o.inBed !== false
    const bf = inBed ? clamp01(num(o.bedFlat, 0)) : 1
    const zCol = o.zzzColor || C.moon
    return stage(ctx, x, y, o, (map, lookW) => {
      const nd = K.nudge(id, t, 0.4)
      const fx = inBed ? -70 : 0
      // the bed is mostly gone before the legs arrive, so YOU never stands "through" the bed frame
      const stand = inBed ? E.inOutCubic(seg(bf, 0.5, 0.9)) : 1
      const breath = Math.sin((TAU * t) / 3.2)
      const lying = pose === 'sleep' && inBed && bf < 0.3
      let anchors = {}
      // the bed (flattens away)
      const drawBed = (layer) => {
        if (!inBed || bf >= 1) return
        const sy = 1 - E.inCubic(bf)
        const a = 1 - seg(bf, 0.35, 0.75)
        if (a <= 0) return
        ctx.save()
        ctx.globalAlpha *= a
        ctx.scale(1, Math.max(0.02, sy))
        if (layer === 'back') {
          piece(ctx, rrect(-198, -200, 40, 200, 20), C.kraft, id + 'hb', t, { cut: 1.4, shadow: 0.9, w: 2.3 })
          piece(ctx, K.ellipsePts(-178, -178, 8, 8, 12), C.terracotta, id + 'knob', t, { cut: 0.4, shadow: 0.5, w: 1.6 })
          piece(ctx, rrect(162, -128, 30, 128, 14), C.kraft, id + 'fb', t, { cut: 1.2, shadow: 0.9, w: 2.2 })
          piece(ctx, rrect(-166, -64, 334, 30, 6), C.kraftDark, id + 'rail', t, { cut: 1, shadow: 0.8, w: 2.2 })
          piece(ctx, rrect(-160, -34, 16, 34, 4), C.kraftDark, id + 'lg1', t, { cut: 0.5, shadow: 0.6, w: 1.8 })
          piece(ctx, rrect(144, -34, 16, 34, 4), C.kraftDark, id + 'lg2', t, { cut: 0.5, shadow: 0.6, w: 1.8 })
          piece(ctx, rrect(-164, -98, 330, 38, 12), C.paperWhite, id + 'mat', t, { cut: 1.2, shadow: 0.7, w: 2 })
          piece(ctx, rrect(-162, -130, 84, 38, 18), C.cream, id + 'pil', t, { cut: 1.4, shadow: 0.8, w: 2 })
          K.pencil.curve(ctx, [[-140, -112], [-120, -108], [-100, -113]], id + 'pils', t, { strokeWidth: 1.6, roughness: 1, stroke: C.inkFaint })
        } else {
          // patchwork quilt
          const hump = lying ? 1 : 0
          const top = []
          for (let i = 0; i <= 10; i++) {
            const xx = -96 + (266 * i) / 10
            let yy = -104
            if (hump) yy -= 18 * Math.exp(-Math.pow((xx + 30) / 60, 2)) + 10 * Math.exp(-Math.pow((xx - 70) / 50, 2)) + 14 * Math.exp(-Math.pow((xx - 138) / 18, 2)) + 2.5 * breath * Math.exp(-Math.pow((xx + 30) / 60, 2))
            else yy -= 12 * Math.exp(-Math.pow((xx - 40) / 70, 2)) + 13 * Math.exp(-Math.pow((xx - 138) / 18, 2))
            top.push([xx, yy])
          }
          const qpts = [...top, [172, -54], [-96, -54]]
          const qs = piece(ctx, qpts, C.peach, id + 'q', t, { cut: 1.6, shadow: 1, lift: 2, w: 2.3 })
          ctx.save()
          K.pathPoly(ctx, qs)
          ctx.clip()
          const cols = [C.butter, C.mint, C.pink, C.sky, C.peach, C.lemon]
          let k = 0
          for (let gx = -96; gx < 180; gx += 44) {
            for (let gy = -150; gy < -50; gy += 36) {
              if ((k + (gx / 44) | 0) % 2 === 0) {
                ctx.fillStyle = K.paperPattern(ctx, cols[k % cols.length])
                ctx.fillRect(gx, gy, 44, 36)
              }
              k++
            }
          }
          ctx.setLineDash([5, 5])
          ctx.strokeStyle = 'rgba(42,34,26,0.4)'
          ctx.lineWidth = 1.6
          ctx.beginPath()
          for (let gx = -96; gx < 180; gx += 44) {
            ctx.moveTo(gx, -150)
            ctx.lineTo(gx, -50)
          }
          for (let gy = -150; gy < -50; gy += 36) {
            ctx.moveTo(-100, gy)
            ctx.lineTo(180, gy)
          }
          ctx.stroke()
          ctx.restore()
          ink(ctx, qpts, id + 'qo', t, { w: 2.3 })
        }
        ctx.restore()
      }
      ctx.translate(nd.dx, nd.dy)
      if (inBed && bf < 1) contact(ctx, 0, 180, 0.08 * (1 - bf))
      drawBed('back')
      if (lying) {
        // asleep on the pillow, one arm over the quilt
        const hc = [-116, -126 + breath * 1.2]
        head(ctx, hc, 29, id, t)
        K.pencil.curve(ctx, [[hc[0] - 24, hc[1] - 18], [hc[0] - 6, hc[1] - 34], [hc[0] + 16, hc[1] - 26], [hc[0] + 10, hc[1] - 38]], id + 'hair', t, { stroke: HAIR, strokeWidth: 5, roughness: 1.2 })
        happyEye(ctx, hc[0] - 9, hc[1] + 2, 7, id + 'ze0', t, 3)
        happyEye(ctx, hc[0] + 10, hc[1] + 1, 6.5, id + 'ze1', t, 3)
        mouth(ctx, 'o', hc[0] + 2, hc[1] + 14, 0.45 + 0.08 * breath, id + 'm', t)
        blushDot(ctx, hc[0] - 17, hc[1] + 9, 1, 6)
        blushDot(ctx, hc[0] + 20, hc[1] + 8, 1, 5.5)
        drawBed('front')
        hose(ctx, [-84, -104], [-36, -114 + breath], 60, -1, id + 'arm', t, { w: 3.2, color: C.ink })
        punch(ctx, [-34, -114 + breath], 7, SKIN, id + 'hand')
        if (o.zzz) zzz(ctx, hc[0] + 18, hc[1] - 40, t, id, zCol)
        anchors = { head: map(hc), hands: [map([-34, -114]), map([-34, -114])], feet: [map([140, -118]), map([140, -118])], zzz: map([hc[0] + 18, hc[1] - 40]) }
      } else {
        // sitting up in bed → standing as the bed flattens
        const sitHip = [fx, -98]
        const standHip = [fx, -104]
        const hip = mix(sitHip, standHip, stand)
        const pop = pose === 'wake' ? 10 * ring(q, 7, 14) * (q > 0 ? 1 : 0) : 0
        const torsoTop = [hip[0], hip[1] - 76 - pop]
        const hc = [hip[0] + (pose === 'stretch' ? 0 : 2), torsoTop[1] - 34]
        // legs (hidden under the quilt while in bed)
        if (stand > 0.02) {
          for (let i = 0; i < 2; i++) {
            const hp = [hip[0] + (i ? 10 : -10), hip[1]]
            const ft = [fx + (i ? 18 : -18), 0]
            const ftUp = mix([hp[0], hp[1] + 20], ft, stand)
            K.withAlpha(ctx, clamp01(stand * 2), () => {
              piece(ctx, capsule(hp, ftUp, 8, 3), C.sky, id + 'pant' + i, t, { cut: 0.6, shadow: 0.6, w: 1.8 })
              punch(ctx, add(ftUp, [i ? 5 : -5, 0]), 9, SKIN, id + 'ft' + i, { sx: 1.2, sy: 0.6 })
            })
          }
        }
        const w = 50
        const torso = rrect(hip[0] - w / 2, torsoTop[1], w, hip[1] - torsoTop[1] + 4, 14)
        pajamaTop(ctx, torso, id, t)
        const sh = [[hip[0] - 20, torsoTop[1] + 10], [hip[0] + 20, torsoTop[1] + 10]]
        let hands
        if (pose === 'stretch') {
          const wig = Math.sin((TAU * q) / 0.9) * 6
          const up = E.outBack(seg(q, 0, 0.5))
          hands = [mix([hip[0] - 34, hip[1] - 20], [hip[0] - 46 - wig, torsoTop[1] - 70], up), mix([hip[0] + 34, hip[1] - 20], [hip[0] + 46 + wig, torsoTop[1] - 70], up)]
        } else if (pose === 'wake') {
          const wv = q > 0.45 ? Math.sin((TAU * q) / 0.5) : 0
          hands = [[hip[0] - 36, hip[1] - 14], mix([hip[0] + 34, hip[1] - 14], [hip[0] + 60 + 12 * wv, torsoTop[1] - 56], E.outBack(seg(q, 0.3, 0.6)))]
        } else {
          hands = [[hip[0] - 34, hip[1] - 14], [hip[0] + 34, hip[1] - 14]]
        }
        drawBed('front')
        head(ctx, hc, 29, id, t)
        // bed-head hair
        K.pencil.curve(ctx, [[hc[0] - 26, hc[1] - 10], [hc[0] - 14, hc[1] - 30], [hc[0] + 6, hc[1] - 29], [hc[0] + 24, hc[1] - 14]], id + 'hair', t, { stroke: HAIR, strokeWidth: 6, roughness: 1 })
        K.pencil.curve(ctx, [[hc[0] + 2, hc[1] - 28], [hc[0] + 8, hc[1] - 44], [hc[0] + 16, hc[1] - 40]], id + 'tuft', t, { stroke: HAIR, strokeWidth: 4, roughness: 1 })
        if (pose === 'stretch') {
          shutEye(ctx, hc[0] - 10, hc[1] + 1, 7, 1, id + 'se0', t, 3)
          shutEye(ctx, hc[0] + 11, hc[1], 6.5, -1, id + 'se1', t, 3)
          mouth(ctx, 'open', hc[0] + 1, hc[1] + 13, 0.5, id + 'm', t)
        } else if (pose === 'wake') {
          const lk = lookW || [0.3, -0.1]
          const bl = blinkAt(t, id)
          const ye = [[hc[0] - 10, hc[1] - 2, 10], [hc[0] + 12, hc[1] - 1, 8.5]]
          ye.forEach(([ex, ey, r], i) => {
            K.googly(ctx, ex, ey, r, t, id + 'e' + i, lk, { blink: false, pupil: 0.5 })
            if (bl > 0) eyelid(ctx, ex, ey, r, bl, SKIN)
          })
          mouth(ctx, 'smile', hc[0] + 1, hc[1] + 14, 0.5, id + 'm', t)
        } else {
          happyEye(ctx, hc[0] - 9, hc[1] + 2, 7, id + 'ze0', t, 3)
          happyEye(ctx, hc[0] + 10, hc[1] + 1, 6.5, id + 'ze1', t, 3)
          mouth(ctx, 'o', hc[0] + 1, hc[1] + 14, 0.42, id + 'm', t)
        }
        blushDot(ctx, hc[0] - 17, hc[1] + 9, 1, 6)
        blushDot(ctx, hc[0] + 19, hc[1] + 8, 1, 5.5)
        for (let i = 0; i < 2; i++) {
          hose(ctx, sh[i], hands[i], 56, autoBend(sh[i], hands[i], i ? 1 : -1), id + 'ar' + i, t, { w: 3.2, color: C.ink })
          punch(ctx, hands[i], 7.5, SKIN, id + 'hn' + i)
        }
        if (o.zzz) zzz(ctx, hc[0] + 22, hc[1] - 44, t, id, zCol)
        anchors = { head: map(hc), hands: [map(hands[0]), map(hands[1])], feet: [map([fx - 18, 0]), map([fx + 18, 0])], zzz: map([hc[0] + 22, hc[1] - 44]) }
      }
      return anchors
    })
  }

  // ───────── the cut-out human hand ─────────
  const SKIN_HAND = '#f0c39f'
  const NAIL = '#f9e0d0'
  function knit(ctx, pts, color) {
    const [x0, y0, x1, y1] = bbox(pts)
    ctx.save()
    K.pathPoly(ctx, pts)
    ctx.clip()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.8
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let yy = y0 + 6; yy < y1; yy += 10) {
      for (let xx = x0 + ((yy / 10) % 2 ? 5 : 0); xx < x1; xx += 10) {
        ctx.moveTo(xx - 3, yy - 3)
        ctx.lineTo(xx, yy + 2)
        ctx.lineTo(xx + 3, yy - 3)
      }
    }
    ctx.stroke()
    ctx.restore()
  }
  function hand(ctx, x, y, t, o = {}) {
    const pose = ['point', 'press', 'pinch', 'hold', 'drop', 'open'].includes(o.pose) ? o.pose : 'point'
    const id = String(o.id || 'hand')
    const from = ['right', 'left', 'top', 'bottom'].includes(o.from) ? o.from : 'right'
    const mitten = !!o.mitten
    const sleeve = o.sleeve || C.blue
    const reach = num(o.reach, 1600)
    const press = clamp01(num(o.press, pose === 'press' ? 1 : 0))
    const push = num(o.push, 16)
    const s = num(o.scale, 1)
    const base = ctx.getTransform()
    ctx.save()
    ctx.translate(x, y)
    if (o.rot) ctx.rotate(o.rot)
    if (from === 'top') ctx.rotate(-Math.PI / 2)
    else if (from === 'bottom') ctx.rotate(Math.PI / 2)
    ctx.scale(from === 'left' ? -s : s, o.mirror ? -s : s)
    const nd = K.nudge(id, t, 0.5)
    ctx.translate(nd.dx, nd.dy)
    ctx.rotate(nd.rot)
    const map = mapper(ctx, base)
    const skin = mitten ? C.terracotta : SKIN_HAND
    const knitCol = 'rgba(232,169,136,0.7)'
    const P = (pts, sd, o2 = {}) => {
      const sh = piece(ctx, pts, skin, id + sd, t, Object.assign({ cut: mitten ? 1.6 : 1.1, shadow: 0.8, w: 2.2 }, o2))
      if (mitten) knit(ctx, sh, knitCol)
      return sh
    }
    const crease = (a, b, sd) => K.pencil.line(ctx, a[0], a[1], b[0], b[1], id + sd, t, { stroke: mitten ? '#7a3a1f' : '#b57e5c', strokeWidth: 1.8, roughness: 0.6 })
    const sleeveAndCuff = (cx, y0, y1) => {
      piece(ctx, [[cx + 22, y0 - 8], [cx + 22 + reach, y0 - 14], [cx + 22 + reach, y1 + 14], [cx + 22, y1 + 8]], sleeve, id + 'slv', t, { cut: 2.2, shadow: 1, lift: 3, line: false })
      const ex = cx + 22 + Math.min(reach, 320)
      K.pencil.line(ctx, cx + 22, y0 - 8, ex, y0 - 8 - (ex - cx - 22) * 0.02, id + 'sl1', t, { strokeWidth: 2.2, roughness: 0.8 })
      K.pencil.line(ctx, cx + 22, y1 + 8, ex, y1 + 8 + (ex - cx - 22) * 0.02, id + 'sl2', t, { strokeWidth: 2.2, roughness: 0.8 })
      K.pencil.curve(ctx, [[cx + 70, y0 + 6], [cx + 90, (y0 + y1) / 2], [cx + 76, y1 - 4]], id + 'sl3', t, { strokeWidth: 1.8, roughness: 0.8, stroke: 'rgba(42,34,26,0.45)' })
      const cuff = rrect(cx - 12, y0 - 4, 38, y1 - y0 + 8, 6)
      const cs = piece(ctx, cuff, mitten ? C.cream : C.paperWhite, id + 'cuff', t, { cut: 1, shadow: 0.8, w: 2 })
      if (mitten) {
        ctx.save()
        K.pathPoly(ctx, cs)
        ctx.clip()
        ctx.strokeStyle = 'rgba(184,144,94,0.6)'
        ctx.lineWidth = 2
        ctx.beginPath()
        for (let xx = cx - 8; xx < cx + 26; xx += 6) {
          ctx.moveTo(xx, y0 - 6)
          ctx.lineTo(xx, y1 + 6)
        }
        ctx.stroke()
        ctx.restore()
      }
    }
    let anchors = {}
    ctx.save()
    if (pose === 'point' || pose === 'press') {
      ctx.translate(-push * press, 0)
      ctx.rotate(0.04 * press)
      sleeveAndCuff(200, -30, 58)
      if (mitten) {
        P(rrect(56, -30, 150, 88, 34), 'mb')
        P(capsule([124, -26], [98, -52], 13, 4), 'mt')
        P(capsule([15, 0], [92, -6], 14, 5), 'mf')
      } else {
        P(rrect(60, -26, 146, 80, 26), 'fist')
        P(capsule([54, 22], [96, 22], 9.5, 4), 'c1', { shadow: 0.6 })
        P(capsule([58, 39], [98, 39], 9, 4), 'c2', { shadow: 0.6 })
        P(capsule([66, 52], [98, 52], 7.5, 4), 'c3', { shadow: 0.6 })
        const fl = 1 - 0.08 * press
        P(capsule([13, 0], [13 + 74 * fl, -8], 13, 5), 'idx')
        P(capsule([118, 6], [80, 16], 11, 4), 'thm')
        piece(ctx, rrect(9, -9, 17, 11, 5), NAIL, id + 'nail', t, { cut: 0.4, shadow: 0.2, w: 1.4 })
        crease([50, -12], [52, 6], 'k1')
        crease([150, 0], [162, 30], 'k2')
      }
      anchors = { tip: map([0, 0]), palm: map([130, 12]), wrist: map([206, 14]), holdAt: map([0, 0]) }
    } else if (pose === 'pinch') {
      sleeveAndCuff(196, -48, 40)
      if (mitten) {
        P(rrect(40, -50, 160, 92, 36), 'mb')
        P(capsule([10, -6], [70, -44], 13, 4), 'mf')
        P(capsule([10, 7], [66, 30], 13, 4), 'mt')
      } else {
        P(rrect(50, -48, 150, 90, 30), 'fist')
        P(capsule([46, -8], [90, -8], 10, 4), 'c1', { shadow: 0.6 })
        P(capsule([52, 10], [92, 10], 9, 4), 'c2', { shadow: 0.6 })
        if (typeof o.hold === 'function') K.at(ctx, 0, 0, 0, 1, (c) => o.hold(c))
        P(capsule([40, -34], [86, -38], 12, 4), 'idx1')
        P(capsule([11, -7], [42, -34], 11.5, 4), 'idx2')
        P(capsule([10, 7], [70, 30], 12.5, 4), 'thm')
        piece(ctx, rrect(5, -15, 13, 9, 4), NAIL, id + 'nail', t, { cut: 0.3, shadow: 0.2, w: 1.3 })
        crease([40, -46], [44, -24], 'k1')
      }
      if (mitten && typeof o.hold === 'function') K.at(ctx, 0, 0, 0, 1, (c) => o.hold(c))
      anchors = { tip: map([0, 0]), palm: map([120, -4]), wrist: map([200, -4]), holdAt: map([0, 0]) }
    } else if (pose === 'hold') {
      sleeveAndCuff(196, -46, 46)
      P(rrect(4, -48, 196, 96, 36), 'palm', { shadow: 0.9 })
      if (typeof o.hold === 'function') K.at(ctx, 0, 0, 0, 1, (c) => o.hold(c))
      if (mitten) {
        P(rrect(-22, -40, 56, 82, 22), 'mf')
        P(capsule([60, -44], [16, -52], 13, 4), 'mt')
      } else {
        for (let i = 0; i < 4; i++) P(capsule([-12, -30 + i * 20], [34, -30 + i * 20], 10, 4), 'f' + i, { shadow: 0.6 })
        P(capsule([70, -44], [14, -50], 11, 4), 'thm')
      }
      anchors = { tip: map([-20, 0]), palm: map([100, 0]), wrist: map([200, 0]), holdAt: map([0, 0]) }
    } else if (pose === 'drop') {
      sleeveAndCuff(200, -42, 42)
      if (mitten) {
        P(rrect(-40, -42, 246, 84, 40), 'mb')
        P(capsule([100, -40], [70, -72], 13, 4), 'mt')
      } else {
        P(rrect(40, -42, 166, 84, 30), 'palm')
        const spread = [[-0.35, 58], [-0.12, 66], [0.12, 62], [0.36, 52]]
        spread.forEach(([a, L], i) => {
          const b = [44, -27 + i * 18]
          P(capsule(b, add(b, [-Math.cos(a) * L, Math.sin(a) * L + 14]), 9.5, 4), 'f' + i, { shadow: 0.7 })
        })
        P(capsule([120, -36], [84, -70], 11, 4), 'thm')
      }
      anchors = { tip: map([-20, 10]), palm: map([0, 0]), wrist: map([206, 0]), holdAt: map([0, 0]) }
    } else {
      // open palm, offering — palm up, seen a little from above: four fingers side by side with a gentle curl
      // and fan, the thumb on top. The mitten is a short knit mitt with a thumb bump (not a baguette).
      sleeveAndCuff(150, -34, 38)
      if (mitten) {
        P(rrect(-46, -30, 214, 70, 33), 'mb')
        P(capsule([56, -26], [14, -50], 14, 4), 'mt')
        crease([-8, -18], [-26, -14], 'mc1')
      } else {
        P(rrect(-34, -28, 198, 66, 26), 'palm')
        // fingers: [root y, fan angle (rad, + = down), length, radius]
        const fingers = [[-17, -0.07, 60, 8.4], [0, -0.01, 68, 8.6], [16.5, 0.05, 64, 8.3], [31, 0.13, 50, 7.4]]
        fingers.forEach(([fy, fa, L, r], i) => {
          const a = [-24, fy]
          const b = [-24 - Math.cos(fa) * L, fy + Math.sin(fa) * L]
          const tipPt = add(b, [2, -2.5]) // tips curl up a hair
          P(capsule(a, tipPt, r, 4), 'f' + i, { shadow: 0.6 })
          const k1 = mix(a, tipPt, 0.55)
          crease(add(k1, [0, -r * 0.55]), add(k1, [1.5, r * 0.5]), 'fk' + i)
        })
        crease([4, -10], [48, 2], 'c1')
        crease([6, 14], [52, 18], 'c2')
        P(capsule([66, -28], [8, -44], 11.5, 4), 'thm')
        piece(ctx, rrect(2, -50, 13, 10, 4.5), NAIL, id + 'tnail', t, { cut: 0.3, shadow: 0.2, w: 1.3 })
      }
      if (typeof o.hold === 'function') K.at(ctx, 0, -20, 0, 1, (c) => o.hold(c))
      anchors = { tip: map([-92, 2]), palm: map([0, 0]), wrist: map([150, 2]), holdAt: map([0, -20]) }
    }
    ctx.restore()
    ctx.restore()
    return anchors
  }

  // ───────── gallery visitor ─────────
  const SKINS = ['#f1c6a2', '#e3a983', '#c98d63', '#9a6445', '#f5d6ba']
  const BOTTOMS = ['#3f5d8c', C.kraftDark, '#4b4a5a', C.sage, C.terracotta]
  const OUTFITS = ['tee', 'dress', 'overalls', 'skirt']
  const VIS_P = 0.62
  const VIS_A = 14
  const VISITOR_WALK_SPEED = (4 * VIS_A) / VIS_P // ≈ 90 px/s at scale 1
  function visitor(ctx, x, y, t, o = {}) {
    const pose = ['walk', 'stop', 'clap', 'ooh'].includes(o.pose) ? o.pose : 'stop'
    const q = Math.max(0, num(o.poseT, t))
    const id = String(o.id || 'visitor')
    const shirt = o.color || C.sky
    const hv = K.hash(id, 'look')
    const skin = SKINS[hv % SKINS.length]
    const hairStyle = Number.isInteger(o.hair) ? ((o.hair % 4) + 4) % 4 : (hv >> 4) % 4
    const hairCol = ['#4a3426', '#8a5a34', '#2e2522', '#b8905e'][(hv >> 7) % 4]
    const outfit = OUTFITS.includes(o.outfit) ? o.outfit : OUTFITS[(hv >> 10) % 4]
    const bottomCol = o.bottoms || (outfit === 'overalls' ? '#4f79bd' : BOTTOMS[(hv >> 13) % BOTTOMS.length])
    const HIPY = -62
    return stage(ctx, x, y, o, (map, lookW) => {
      const nd = K.nudge(id, t, 0.5)
      let root = [0, HIPY]
      let rot = 0
      let feet = [[-13, 0], [13, 0]]
      let footRot = [0, 0]
      let hands
      let lk = [0, 0]
      let mouthK = 'smile'
      let eyes = 'normal'
      if (pose === 'walk') {
        const g0 = gait(q, VIS_P, VIS_A, 10, 0)
        const g1 = gait(q, VIS_P, VIS_A, 10, 0.5)
        root = [0, HIPY - 4 * Math.abs(Math.sin((TAU * q) / VIS_P))]
        rot = 0.05
        feet = [[-7 + g0[0], g0[1]], [7 + g1[0], g1[1]]]
        footRot = [g0[2], g1[2]]
        hands = [[-34 - 0.8 * g0[0], -80], [34 - 0.8 * g1[0], -80]]
        lk = [0.5, 0]
      } else if (pose === 'clap') {
        const P = 0.4
        const ph = (q - Math.floor(q / P) * P) / P
        const sep = 5 + 28 * Math.abs(Math.cos(Math.PI * ph))
        hands = [[-sep, -120], [sep, -120]]
        root = [0, HIPY - 3 * Math.sin(Math.PI * ph)]
        mouthK = 'grin'
        eyes = Math.abs(ph - 0.5) < 0.12 ? 'happy' : 'normal'
        lk = [0.2, -0.4]
      } else if (pose === 'ooh') {
        const b = E.outBack(seg(q, 0, 0.35))
        hands = [mix([-36, -80], [-30, -164], b), mix([36, -80], [31, -163], b)]
        rot = -0.06 * b
        mouthK = 'o'
        eyes = 'wide'
        lk = [0.3, -0.6]
      } else {
        rot = 0.12 * ring(q, 6, 11) + 0.02 * wave(q, 3)
        hands = [[-38, -78], [38, -78]]
        lk = [0.4, -0.2]
      }
      if (lookW) lk = lookW
      root = [root[0] + nd.dx, root[1] + nd.dy]
      rot += nd.rot
      // standing frame (feet on y = 0, hips at HIPY) → rotated about the hip
      const T = (p) => {
        const r = rot2([p[0], p[1] - HIPY], rot)
        return [root[0] + r[0], root[1] + r[1]]
      }
      contact(ctx, 0, 40)
      const hips = [T([-10, HIPY]), T([10, HIPY])]
      const trousers = outfit === 'tee' || outfit === 'overalls'
      // legs: paper trouser legs, or pencil legs under a skirt / dress
      for (let i = 0; i < 2; i++) {
        const ankle = add(feet[i], [0, -7])
        if (trousers) {
          piece(ctx, capsule(hips[i], ankle, 9.5, 4), bottomCol, id + 'tl' + i, t, { cut: 0.8, shadow: 0.7, w: 2 })
        } else hose(ctx, hips[i], ankle, 64, autoBend(hips[i], ankle, i ? 1 : -1), id + 'lg' + i, t, { w: 3.4, color: C.ink })
      }
      for (let i = 0; i < 2; i++) punch(ctx, add(feet[i], [6, -2]), 10, C.ink, id + 'sh' + i, { sx: 1.3, sy: 0.6, shadow: 0.5, rot: footRot[i] })
      // clothes
      const torsoTop = -150
      const P2 = (pts, col, sd, w = 2.1) => piece(ctx, pts.map(T), col, id + sd, t, { cut: 1.2, shadow: 0.85, w })
      if (outfit === 'dress') {
        P2([[-21, torsoTop], [21, torsoTop], [30, -96], [46, -34], [-46, -34], [-30, -96]], shirt, 'dress')
        ctx.save()
        ctx.strokeStyle = 'rgba(255,255,255,0.45)'
        ctx.lineWidth = 3
        ctx.beginPath()
        const w0 = T([-29, -98])
        const w1 = T([29, -98])
        ctx.moveTo(w0[0], w0[1])
        ctx.lineTo(w1[0], w1[1])
        ctx.stroke()
        ctx.restore()
      } else {
        const tee = outfit === 'skirt' ? [[-23, torsoTop], [23, torsoTop], [28, -78], [-28, -78]] : [[-23, torsoTop], [23, torsoTop], [30, -58], [-30, -58]]
        P2(tee, shirt, 'shirt')
        if (outfit === 'skirt') P2([[-28, -82], [28, -82], [42, -42], [-42, -42]], bottomCol, 'skirt')
        if (outfit === 'overalls') {
          P2([[-18, -114], [18, -114], [21, -58], [-21, -58]], bottomCol, 'bib', 1.8)
          for (const sx of [-1, 1]) {
            const a = T([sx * 14, -112])
            const b = T([sx * 20, torsoTop + 2])
            K.pencil.line(ctx, a[0], a[1], b[0], b[1], id + 'strap' + sx, t, { stroke: bottomCol, strokeWidth: 6, roughness: 0.3 })
            const bt = T([sx * 12, -108])
            ctx.beginPath()
            ctx.arc(bt[0], bt[1], 3, 0, TAU)
            ctx.fillStyle = C.lemon
            ctx.fill()
          }
          const pk = T([0, -96])
          K.pencil.rect(ctx, pk[0] - 8, pk[1] - 6, 16, 12, id + 'pkt', t, { stroke: 'rgba(42,34,26,0.5)', strokeWidth: 1.6, roughness: 0.6 })
        }
      }
      // collar highlight
      ctx.save()
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      const cc = T([0, torsoTop + 2])
      ctx.beginPath()
      ctx.ellipse(cc[0], cc[1], 12, 7, rot, 0, TAU)
      ctx.fill()
      ctx.restore()
      // head
      const hc = T([0, -180])
      const HR = 34
      if (hairStyle === 1) piece(ctx, K.ellipsePts(hc[0], hc[1] + 5, HR + 6, HR + 4, 18), hairCol, id + 'hb', t, { cut: 1.4, shadow: 0.7, w: 2 })
      if (hairStyle === 0) piece(ctx, K.ellipsePts(hc[0] + 2, hc[1] - HR - 6, 15, 14, 14), hairCol, id + 'bun', t, { cut: 1, shadow: 0.6, w: 2 })
      head(ctx, hc, HR, id, t, { skin })
      if (hairStyle === 0 || hairStyle === 1) {
        const capP = []
        for (let i = 0; i <= 10; i++) {
          const a = Math.PI + (i / 10) * Math.PI
          capP.push([hc[0] + Math.cos(a) * (HR + 1), hc[1] + Math.sin(a) * (HR + 1) + 2])
        }
        capP.push([hc[0] + 23, hc[1] - 13], [hc[0] - 4, hc[1] - 18], [hc[0] - 29, hc[1] - 9])
        piece(ctx, capP, hairCol, id + 'cap', t, { cut: 1, shadow: 0.5, w: 1.8 })
      } else if (hairStyle === 2) {
        for (let i = 0; i < 5; i++) piece(ctx, K.ellipsePts(hc[0] - 27 + i * 13.5, hc[1] - 29 + Math.abs(i - 2) * 4.5, 11, 11, 10), hairCol, id + 'cur' + i, t, { cut: 1, shadow: 0.4, w: 1.6 })
      } else {
        K.at(ctx, hc[0] + 4, hc[1] - 31, 0.18, 1, () => {
          piece(ctx, K.ellipsePts(0, 0, 36, 12, 16), C.terracotta, id + 'beret', t, { cut: 1, shadow: 0.7, w: 2 })
          piece(ctx, capsule([0, -11], [0, -17], 3, 3), C.terracotta, id + 'stem', t, { cut: 0.2, shadow: 0.3, w: 1.4 })
        })
      }
      const eye = [[hc[0] - 12, hc[1] - 1, 11.5], [hc[0] + 13, hc[1], 10]]
      for (let i = 0; i < 2; i++) {
        const [ex, ey, r] = eye[i]
        if (eyes === 'happy') happyEye(ctx, ex, ey + 2, r, id + 'he' + i, t, 3.2)
        else K.googly(ctx, ex, ey, r, t, id + 'e' + i, lk, { blink: false, pupil: eyes === 'wide' ? 0.36 : 0.5 })
      }
      if (eyes === 'normal') {
        const b = blinkAt(t, id)
        if (b > 0) for (const [ex, ey, r] of eye) eyelid(ctx, ex, ey, r, b, skin)
      }
      blushDot(ctx, hc[0] - 21, hc[1] + 12, 1, 6.5)
      blushDot(ctx, hc[0] + 22, hc[1] + 11, 1, 6)
      mouth(ctx, mouthK, hc[0] + 1, hc[1] + 17, 0.52, id + 'm', t)
      // arms + sleeve stubs + hands
      const shoulders = [T([-23, -140]), T([23, -140])]
      const hs = hands.map((h) => T(h))
      for (let i = 0; i < 2; i++) {
        hose(ctx, shoulders[i], hs[i], 74, autoBend(shoulders[i], hs[i], i ? 1 : -1), id + 'ar' + i, t, { w: 3.2, color: C.ink, slack: 0.03 })
        const s0 = sub(hs[i], shoulders[i])
        const sl = vlen(s0) || 1
        const sd = mul(s0, 1 / sl)
        piece(ctx, capsule(add(shoulders[i], mul(sd, 2)), add(shoulders[i], mul(sd, 13)), 8.5, 4), shirt, id + 'slv' + i, t, { cut: 0.6, shadow: 0.5, w: 1.8 })
        punch(ctx, hs[i], 8, skin, id + 'hn' + i)
      }
      return { head: map(hc), hands: [map(hs[0]), map(hs[1])], feet: [map(feet[0]), map(feet[1])] }
    })
  }

  window.PIP = {
    draw: drawPip,
    hop,
    size: { w: BW, h: BH },
    POSES,
    MOUTHS,
    THROW_RELEASE,
    THWACK_HIT,
    CATCH_AT,
    BOW,
    WALK_SPEED,
  }
  window.CAST = {
    helper,
    agent,
    you,
    hand,
    visitor,
    HAMMER_HIT,
    HELPER_WALK_SPEED,
    VISITOR_WALK_SPEED,
    OUTFITS,
    HELPER_POSES: ['idle', 'walk', 'hammer', 'magnify', 'check', 'tea', 'sit', 'hop', 'cheer'],
    AGENT_POSES: ['idle', 'wave', 'hop', 'tear', 'fan'],
    AGENT_KINDS: ['architect', 'devlead', 'validator'],
    STICKY,
  }
})()

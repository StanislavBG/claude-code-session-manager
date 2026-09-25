/* props/show.js — collage props for s6 (files), s7 (memory), s8 (showcase), s9 (end card).
 * Owner: props-show. Extends window.PROPS (other prop files add their own keys).
 *
 * LAWS (script/BRIEF.md §2): every function is a PURE function of its arguments — no state
 * survives between calls, randomness only via K.rng / K.seedOf / K.boil, never shadowBlur /
 * ctx.filter. Paper pieces are placed with K.at so grain travels with the piece; paper colours
 * fed to K.paperPattern are a fixed set (never animated), tints are overlays. Hero silhouettes get
 * a bold boiling pencil outline (local `outline()`), matching day.js's rough outlines; torn white
 * fibre rims are never outlined. Every stroke respects an outer K.withAlpha fade.
 *
 * COMMON OPTIONS (every draw function): fn(ctx, x, y, t, o = {})
 *   t        scene-local seconds (drives pencil boil, blinks, sways)
 *   o.id     seed string (default: a fixed per-prop string) — give two copies different ids
 *   o.scale  uniform scale (default 1)       o.rot  rotation in radians (default 0)
 *   o.nudge  stop-motion hand-placed jitter amplitude (default 0.5; 0 = rock steady)
 * (x, y) is the visual centre unless noted. Every function returns anchor points
 * mapped back into the CALLER's coordinate space (whatever transform was current at call time).
 *
 * ── s6 files ──────────────────────────────────────────────────────────────────────────────
 * fileTree(ctx,x,y,t,o) — potted picture-book tree, pot lettered "File Explorer" (~960 x 950 at
 *     scale 1: pot bottom at local y +432, canopy top ≈ -515). A round torn-paper cloud crown
 *     (4 overlapping scalloped blobs) sits behind thick crayon branches hung with file/folder leaves.
 *     o.grow 0..1 (1)   trunk, then branches draw on; canopy blobs (0.44–0.86), green leaves and
 *                       file/folder leaves pop in with overshoot
 *     o.leafScale (1.3) size of every file/folder leaf (greens grow 60% as much)
 *     o.pluck 0..1 (0)  the "M" leaf pulls off its twig; at 1 it is NOT drawn (draw it yourself
 *                       with fileLeaf in the hand, at scale = anchors.mLeafScale); o.pluckT seconds
 *                       since it came off → twig springs back (default -1 = no spring)
 *     o.sway 0..1 (1)   leaf flutter + canopy bob      o.label ('File Explorer')   o.pot (true)
 *   → { leaves:[{x,y,kind,m}], mLeaf:[x,y], mLeafScale (tree scale × leafScale × 1.15),
 *       branches:[[[x,y]...] x5], slide:[[x,y]...], slideJoin (index), trunkTop, potTop }
 *     slide = dense path for Pip's feet: along the TOP edge of the thick left-high branch (a gentle
 *     playground-slide S, flat at the tip, steeper toward the trunk), from its tip to the trunk
 *     (slide[slideJoin]), then down the trunk to the soil. Branch 2's top edge is kept clear of leaves.
 * fileLeaf(ctx,x,y,t,o) — one leaf: o.kind 'file'|'folder' ('file'), o.m (false) terracotta
 *     "M" sticker, o.color.  ~70x90 (file) / 96x72 (folder) at scale 1.  → { center, top }
 * notebookPage(ctx,x,y,t,o) — ruled notebook page (560x720) with sticky-note file tabs on top
 *     (the first tab carries a tiny terracotta "M" sticker).
 *     (x, y) = centre of the FULLY unfolded page; the top edge stays put while it unfolds.
 *     o.unfold 0..1 (1) 3-panel accordion   o.strike 0..1 (0) angry tomato pencil scribble-out of
 *     line 5 (irregular zig-zag + a looser second pass)   o.rewrite 0..1 (0) teal line writes on
 *     below with a ^ caret   o.saved 0..1 (0) perforated postage stamp "All changes / saved" drops
 *     in (impact at 0.3, postmark 0.45–0.7)   o.tabs (3)   o.pencil (true) yellow pencil at the
 *     writing tip while strike/rewrite are mid-way
 *   → { top, bottom, corners:{tl,tr,bl,br}, tabs:[[x,y]...], stamp:[x,y], pen:[x,y]|null, strikeLine:[[x,y],[x,y]] }
 * paperAirplane(ctx,x,y,t,o) — o.fold 0..1:
 *       0         flat notebook page (260x340): rules, terracotta margin, punched holes, code
 *                 tokens and an "M" sticker (o.page, see below) — continuity with notebookPage
 *       0–0.3     the top corners fold in: each flap swings up out of the page (never thinner than
 *                 8 px) and shows its back (rules turn perpendicular) past halfway
 *       0.3–0.6   the left half folds over (the corner flaps end up hidden inside the fold)
 *       0.6–0.63  anticipation squash;  0.63–0.72 the wedge snaps nose-right (outBack) with 3
 *                 speed-tick arcs;  0.72–1 the wings open (outCubic)
 *       1         side-view plane ~410 long flying RIGHT; heading = o.rot (e.g. trailAt()[2])
 *     o.flip (false) face left: the nose points along o.rot + π (stamp + M stay readable).
 *     o.bank (true): the plane always flies upright — whichever way its nose points, a leftward
 *       heading is drawn mirrored instead of upside down, so it can follow any trail with
 *       rot = trailAt()[2] (it mirrors as the heading passes vertical). Backward compatible with
 *       flip:true + rot = heading − π. Pass bank:false for a deliberate upside-down loop top.
 *     o.stamp 0..1 terracotta rubber stamp "Send to chat" on the near wing (only once fold ≥ 0.95;
 *       legible from scale ≈ 0.7 up — stamp it close-up, shrink for the flight); a small "M" sticker
 *       sits beside it.   o.flutter 0..1 (0) wing flap in flight.
 *     o.page ({ margin:true, code:true, m:true } | false) what is printed on the page.
 *   → { nose, tail (computed from the folded geometry — always on the paper), center, stamp|null }
 * dottedTrail(ctx,x,y,t,o) — dashed pencil trail through o.pts (points RELATIVE to (x, y); pass
 *     x = y = 0 for stage coordinates) as a Catmull-Rom curve.  o.p 0..1 (1) draw-on head,
 *     o.from 0..1 (0) erase behind, o.gap (24) o.dash (11) o.color (ink) o.w (4) o.alpha (0.8)
 *     o.style 'dash'|'dot'   nudge defaults to 0
 *   → { x, y, angle, len }  (head position + heading, radians, caller space)
 * trailAt(pts, p) → [x, y, angle] — same curve as dottedTrail, no drawing (fly the plane on it).
 *
 * ── s7 memory ─────────────────────────────────────────────────────────────────────────────
 * corkboard(ctx,x,y,t,o) — wood-framed cork board (1200x720) with a "Memory" header strip
 *     pinned on top (two teal tacks) and a sage "Workspace" folder tab.  o.w o.h
 *     o.title ('Memory')  o.tab ('Workspace')  o.titleIn 0..1 (1) header pops in
 *   → { slots:[[x,y] x6] (3x2 grid of card spots), title, tab, corners:{tl,tr,bl,br} }
 * memoryCard(ctx,x,y,t,o) — torn-top index card (260x180): red header rule, blue rules, hand
 *     text o.text (wraps to 3 lines; none → varied cursive scribbles), bold pencil outline.
 *     o.color 'cream'|'butter'|'sage'|'peach'|'mint'|hex ('cream')
 *     o.pin (true) thumbtack at the top edge; o.pinColor (tomato) o.pinR (12) o.pinPress 0..1 (1)
 *     o.pinPop 0..1 (0) the pin pops out: anticipation grow → shrinks away with a little hop (gone at 1)
 *     o.stale (false) → faded, inkFaint text, coffee ring, dog-ear   o.staleStamp 0..1 (0) "STALE"
 *       rubber-stamp thunk (impact at 0.25)
 *     o.lift 0..1 (0) the flap, hinged at the top edge, swings toward the viewer: clamped at 0.33π
 *       (never below ~50% height, text stays clear of the pin), keystoned (free edge 14% wider than
 *       the hinge), brighter, with an underside curl lip below the free edge and a cast shadow
 *       pushed down onto the board; the board under it gets a shade that fades out downward.
 *     o.part 'both'|'under'|'flap' ('both') — like basket's back/front: draw part:'under', then
 *       whatever peeks out (Pip), then part:'flap' (card + shadow + lip + stamp + pin).
 *     o.under (optional) text written on the board under the flap
 *     o.w o.h  o.textSize (30)
 *   → { pin, center (of the visible face), bottom (free edge), grip:[[x,y],[x,y]] (free-edge hand
 *       holds for Pip), under (spot under the flap) }
 * thumbtack(ctx,x,y,t,o) — push pin seen from above. o.color (tomato) o.r (15)
 *     o.press 0..1 (1): 0 = hovering, 1.4x with a long shadow; 1 = pushed in (outBack).  nudge 0
 *   → { center }
 * yarn(ctx,x,y,t,o) — red plied yarn from o.from to o.to (RELATIVE to (x, y)), sagging o.sag (16).
 *     o.twang 0..1 (0) decaying standing-wave twang   o.p 0..1 (1) strings out from `from`
 *     o.color o.w (5)   nudge 0   → { mid, end }
 * clipBundle(ctx,x,y,t,o) — three memory cards pulled into a paper-clipped bundle tagged "Clusters".
 *     o.cards [{text,color}] x3 (default 'tests: npm test' cream, 'likes small commits' butter,
 *       a sage scribble card)   o.spread ([[-300,-50],[0,30],[300,-40]])
 *     o.gather 0..1 (1) timeline: 0–0.3 the pin-to-pin yarn twangs (cards tug outward a hair),
 *       pins pop 0.18–0.3, the yarn is gone by 0.44 (before any overlap); 0.3–0.82 the cards slide
 *       together (slow-in, small overshoot, settle); 0.62–0.86 two crossing strands wrap the stack
 *       and tuck behind its edges; 0.84–0.96 the bow pops. One fixed draw order (no swaps).
 *     o.clip 0..1 (1) a small hive-teal paperclip slides onto the top edge (stays above the front
 *       card's header rule, clear of its text)   o.tagIn 0..1 (1) kraft tag swings in on baker's
 *       twine tied to the clip (outElastic)   o.tag ('Clusters')
 *   → { tag, clip, center, cards:[[x,y]x3] }
 * crumple(ctx,x,y,t,o) — o.p 0..1: card (260x180) → lumpy, creased, faceted paper ball (r≈58).
 *     The card's outline melts round as it squashes (stop-motion steps, never spiky).
 *     o.stale (true) same face as memoryCard({stale:true}) — pass the card's id and it swaps in
 *     seamlessly at p 0   o.text (else scribbles)   o.color (faded card)   o.w o.h o.r
 *   → { center, r }
 * basket(ctx,x,y,t,o) — wicker waste basket (300 wide at the rim, 200 tall): 9 upright stakes,
 *     over/under weavers, rope rim.  o.part 'both'|'back'|'front' ('both') — draw 'back', then
 *     your ball, then 'front' to drop things IN.  o.bounce 0..1 (0) catch squash-wobble
 *     o.contents (0) crumpled balls peeking out   → { mouth, rimL, rimR, bottom }
 *
 * ── s8 showcase ───────────────────────────────────────────────────────────────────────────
 * posterPage(ctx,x,y,t,o) — cream one-page project home (600x800) collaged from scraps.
 *     Header: butter band with a lightbulb + three paper dots over a wavy crayon line, or o.title.
 *     o.scraps 0..1 (1) README scrap / folder-tree doodle / crayon "> _" command strip / mini
 *       console window with a tiny card friend fly in from the four corners (~±980 px) along arcs,
 *       landing with a squash + glue smear
 *     o.headings 0..1 (1) "What it is" / "Who it's for" / "How to run it" letter on in turn
 *     o.tag 0..1 (1) taped caption "one page, written from real code"   o.frame 0..1 (0) kraft
 *     frame snaps on (1.22 → 1, outBack)   o.title ('') optional title (none in s8's onScreenText)
 *   → { top (frame top-centre, hang it here), grips:[[x,y],[x,y]] (left/right frame edges),
 *       tag, corners:{tl,tr,bl,br} (outer frame corners) }
 * house(ctx,x,y,t,o) — little project house. (x, y) = GROUND centre. 180x150 body, scalloped
 *     roof, chimney, door, two windows, grass tufts, pencil outlines.  o.color (sage)
 *     o.roof (auto contrast)  o.w (180) o.h (150)  o.lit 0..1 (0) window glow
 *     o.label (none) tiny name sign on the gable, shrunk to fit inside the roof triangle
 *   → { door, roofTop, windows:[[x,y],[x,y]] }
 * signpost(ctx,x,y,t,o) — wooden post + honey finial, kraft arrow board "bilko.run/projects",
 *     fluttering terracotta pennant "Host on Bilko.run". (x, y) = GROUND point.
 *     o.flutter 0..1 (1)  o.text o.pennant (override strings)   → { board, pennant, top }
 * galleryWall(ctx,x,y,t,o) — "Showcase" swallowtail banner (local y -300) + framed mini posters on
 *     nails with picture wire (~1600x720).
 *     o.posters (['garden-app','recipe-bot','Session Manager'])  o.emptySlot (3) index of the
 *     free slot (-1 = none)  o.reveal 0..1 (1) frames pop on in turn  o.sway 0..1 (0.6)
 *     o.hint 0..1 (0) dashed pencil outline where the new frame goes
 *     o.emptyNail (true) the free slot's nail; false → hang the new frame with a thumbtack at
 *       newSlot.pin instead   o.newWire 0..1 (0) draws the new frame's picture wire on from the
 *       nail to its top corners (draw the wall first, then the poster over it)
 *   → { slots:[{x,y,w,h}], newSlot:{x,y,nail,pin,wire:[left,nail,right],scale}, banner }
 *     (draw posterPage(ctx, newSlot.x, newSlot.y, t, {frame:1, scale:newSlot.scale}); newSlot.scale
 *     is height-based, so a framed poster is a few px narrower than the dashed hint)
 * heartPop(ctx,x,y,t,o) — paper heart doodle: o.p 0..1 pops (overshoot), floats up, fades
 *     (drawn only while 0 < p < 1).  o.color (pink) o.r (34)   → { center }
 *
 * ── s9 end card ───────────────────────────────────────────────────────────────────────────
 * luggageTag(ctx,x,y,t,o) — kraft luggage tag (~2.6:1) on baker's twine to a pin, stitched border,
 *     airline stripes, a butter sticker dot.
 *     o.text ('bilko.run/products/session-manager') — wrapped after the last '/' into two lines
 *       (o.wrap false = one line)   o.sub ('Linux & macOS') third, smaller line
 *     o.swing 0..1 (1) sway around the eyelet   o.string ([-46,-124]) hook offset from the eyelet
 *     o.nail (true)   o.size (48)   nudge default 0.35
 *   → { hook, eyelet, center, w, h }
 * tapeTyper(ctx,x,y,t,o) — black label-maker tape typing embossed cream mono text; V-notch left
 *     end, angled right cut, embossed ridges, a hair of droop as it extrudes.
 *     o.text ('npx claude-code-session-manager@latest') o.reveal 0..1 (1) o.caret (true) blinks
 *     once typed   o.grow (true) tape extrudes as it types   o.prompt ('>') green crayon prompt
 *     ('' = none)   o.size (46)   layout is centred on the FULL text, so it types rightwards
 *     (mono font: Fira Mono → Ubuntu Mono → DejaVu Sans Mono system fonts)
 *   → { w, h, caret, left, right }
 * washiLabel(ctx,x,y,t,o) — terracotta washi strip lettered o.text ('free & open · MIT').
 *     o.color (terracotta) o.textColor (paperWhite) o.size (42) o.slap 0..1 (1) lands with a
 *     squash (hidden at 0)   → { w, h }
 */
;(function () {
  'use strict'
  const C = K.C
  const E = K.ease
  const seg = K.seg
  const clamp01 = K.clamp01
  const lerp = K.lerp
  const TAU = Math.PI * 2
  const def = (v, d) => (v === undefined || v === null ? d : v)

  // ───────────────────────── local helpers ─────────────────────────
  /** Place a prop: nudge + rot + scale, and hand fn a `map(lx,ly)` → caller-space point. */
  function stage(ctx, x, y, t, o, idDef, fn) {
    const id = def(o.id, idDef)
    const s = def(o.scale, 1)
    const inv = ctx.getTransform().inverse()
    const map = (lx, ly) => {
      const p = inv.multiply(ctx.getTransform()).transformPoint(new DOMPoint(lx, ly))
      return [p.x, p.y]
    }
    const amp = def(o.nudge, 0.5)
    const n = amp ? K.nudge(id, t, amp) : { dx: 0, dy: 0, rot: 0 }
    let out = {}
    K.at(ctx, x + n.dx, y + n.dy, def(o.rot, 0) + n.rot, s, () => {
      out = fn(ctx, map, id) || {}
    })
    return out
  }
  function hex(c) {
    const v = parseInt(c.slice(1), 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  }
  /** Mix two hex colours (static palette tints only — never animate this into K.paper). */
  function mix(a, b, k) {
    const A = hex(a)
    const B = hex(b)
    const m = A.map((v, i) => Math.round(v + (B[i] - v) * k))
    return '#' + ((1 << 24) + (m[0] << 16) + (m[1] << 8) + m[2]).toString(16).slice(1)
  }
  function fillPoly(ctx, pts, style) {
    K.pathPoly(ctx, pts)
    ctx.fillStyle = style
    ctx.fill()
  }
  /** Catmull-Rom through pts → dense polyline. */
  function spline(pts, per = 8) {
    if (pts.length < 2) return pts.map((p) => p.slice())
    const out = []
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[Math.min(pts.length - 1, i + 2)]
      for (let k = 0; k < per; k++) {
        const s = k / per
        const s2 = s * s
        const s3 = s2 * s
        const f = (j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * s + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * s2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * s3)
        out.push([f(0), f(1)])
      }
    }
    out.push(pts[pts.length - 1].slice())
    return out
  }
  function cumLen(pl) {
    const c = [0]
    for (let i = 1; i < pl.length; i++) c.push(c[i - 1] + Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]))
    return c
  }
  /** Point + heading at fraction p of a polyline's length. */
  function along(pl, p, cum) {
    cum = cum || cumLen(pl)
    const L = cum[cum.length - 1]
    const d = clamp01(p) * L
    let i = 1
    while (i < pl.length - 1 && cum[i] < d) i++
    const a = pl[i - 1]
    const b = pl[i]
    const sl = cum[i] - cum[i - 1] || 1
    const k = clamp01((d - cum[i - 1]) / sl)
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.atan2(b[1] - a[1], b[0] - a[0])]
  }
  /** Sub-polyline from fraction a to b. */
  function cut(pl, a, b) {
    const cum = cumLen(pl)
    const L = cum[cum.length - 1]
    const da = clamp01(a) * L
    const db = clamp01(b) * L
    if (db - da < 0.5) return []
    const out = []
    const pa = along(pl, a, cum)
    out.push([pa[0], pa[1]])
    for (let i = 1; i < pl.length - 1; i++) if (cum[i] > da && cum[i] < db) out.push(pl[i])
    const pb = along(pl, b, cum)
    out.push([pb[0], pb[1]])
    return out
  }
  /** Boiling pencil stroke along a polyline (native canvas — cheap). */
  function inkLine(ctx, pl, id, t, o = {}) {
    if (!pl || pl.length < 2) return
    const w = def(o.w, 2.4)
    const jit = def(o.jit, 1.1)
    const b = K.boil(t)
    ctx.save()
    const ga = ctx.globalAlpha // respect an outer K.withAlpha fade
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = o.color || C.ink
    const passes = def(o.passes, 2)
    for (let pass = 0; pass < passes; pass++) {
      const r = K.rng('ink', id, b, pass)
      const ox = (r() - 0.5) * jit
      const oy = (r() - 0.5) * jit
      ctx.globalAlpha = ga * def(o.alpha, 0.9) * (pass ? 0.55 : 1)
      ctx.lineWidth = pass ? w * 0.7 : w
      ctx.beginPath()
      pl.forEach((p, i) => {
        const jx = ox + (r() - 0.5) * jit * 0.6
        const jy = oy + (r() - 0.5) * jit * 0.6
        if (i === 0) ctx.moveTo(p[0] + jx, p[1] + jy)
        else ctx.lineTo(p[0] + jx, p[1] + jy)
      })
      if (o.closed) ctx.closePath()
      ctx.stroke()
    }
    ctx.restore()
  }
  /**
   * Bold boiling pencil outline for hero silhouettes — the show props' answer to day.js's rough.js
   * outlines. The shape is resampled so long straight edges wobble too; two passes (the second
   * looser, fainter) re-jitter every boil frame. Never used on torn white fibre rims.
   */
  function outline(ctx, pts, id, t, o = {}) {
    if (!pts || pts.length < 2) return
    const closed = o.closed !== false
    const step = def(o.step, 20)
    let pl = pts
    if (closed) pl = K.resample(pts, step)
    else {
      pl = []
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i]
        const [bx, by] = pts[i + 1]
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
        for (let k = 0; k < n; k++) pl.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n])
      }
      pl.push(pts[pts.length - 1])
    }
    const w = def(o.w, 2.6)
    const jit = def(o.jit, 1.8)
    const b = K.boil(t)
    ctx.save()
    const ga = ctx.globalAlpha
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = o.color || C.ink
    for (let pass = 0; pass < 2; pass++) {
      const r = K.rng('outl', id, b, pass)
      const ox = (r() - 0.5) * jit * (pass ? 1.2 : 0.5)
      const oy = (r() - 0.5) * jit * (pass ? 1.2 : 0.5)
      ctx.globalAlpha = ga * def(o.alpha, 0.75) * (pass ? 0.5 : 1)
      ctx.lineWidth = pass ? w * 0.6 : w
      ctx.beginPath()
      for (let i = 0; i < pl.length; i++) {
        const px = pl[i][0] + ox + (r() - 0.5) * jit * 0.7
        const py = pl[i][1] + oy + (r() - 0.5) * jit * 0.7
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      if (closed) ctx.closePath()
      ctx.stroke()
    }
    ctx.restore()
  }
  /** Classic ease-in-back (anticipation before a pop-off). */
  const inBack = (p) => 2.70158 * p * p * p - 1.70158 * p * p
  /** Waxy crayon ribbon along a polyline, tapering w0 → w1. */
  function crayon(ctx, pl, w0, w1, color, id, t, o = {}) {
    if (!pl || pl.length < 2) return
    const r = K.rng('cray', id, K.boil(t))
    const L = []
    const R = []
    const n = pl.length
    for (let i = 0; i < n; i++) {
      const a = pl[Math.max(0, i - 1)]
      const b = pl[Math.min(n - 1, i + 1)]
      let tx = b[0] - a[0]
      let ty = b[1] - a[1]
      const d = Math.hypot(tx, ty) || 1
      tx /= d
      ty /= d
      const hw = (lerp(w0, w1, i / (n - 1)) / 2) * (1 + (r() - 0.5) * 0.16)
      L.push([pl[i][0] - ty * hw, pl[i][1] + tx * hw])
      R.push([pl[i][0] + ty * hw, pl[i][1] - tx * hw])
    }
    const poly = L.concat(R.reverse())
    ctx.save()
    const ga = ctx.globalAlpha
    if (o.shadow !== false) {
      ctx.translate(3, 4)
      fillPoly(ctx, poly, 'rgba(58,36,14,0.16)')
      ctx.translate(-3, -4)
    }
    fillPoly(ctx, poly, K.paperPattern(ctx, color))
    // round cap at the growing tip
    const e = pl[n - 1]
    ctx.beginPath()
    ctx.arc(e[0], e[1], w1 / 2, 0, TAU)
    ctx.fill()
    // waxy streaks
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const streak = (off, col, lw, al) => {
      ctx.beginPath()
      pl.forEach((p, i) => {
        const a = pl[Math.max(0, i - 1)]
        const b = pl[Math.min(n - 1, i + 1)]
        let tx = b[0] - a[0]
        let ty = b[1] - a[1]
        const d = Math.hypot(tx, ty) || 1
        const hw = lerp(w0, w1, i / (n - 1)) / 2
        const px = p[0] - (ty / d) * hw * off
        const py = p[1] + (tx / d) * hw * off
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.globalAlpha = ga * al
      ctx.strokeStyle = col
      ctx.lineWidth = lw
      ctx.stroke()
    }
    streak(0.55 + (r() - 0.5) * 0.1, 'rgba(40,20,5,1)', Math.max(1.5, w1 * 0.22), 0.28)
    streak(-0.35 + (r() - 0.5) * 0.1, 'rgba(255,240,220,1)', Math.max(1.2, w1 * 0.16), 0.22)
    ctx.setLineDash([w0 * 0.9, w0 * 0.5])
    streak(0.1, 'rgba(40,20,5,1)', Math.max(1, w1 * 0.12), 0.18)
    ctx.setLineDash([])
    ctx.restore()
    if (o.edge) {
      inkLine(ctx, L, id + 'eL', t, { w: 1.6, alpha: 0.4, passes: 1, color: '#3b2412' })
      inkLine(ctx, R.slice().reverse(), id + 'eR', t, { w: 1.6, alpha: 0.4, passes: 1, color: '#3b2412' })
    }
  }
  /** A line of "code" drawn as syntax-coloured token bars. Returns the x where it ends. */
  function codeLine(ctx, x, y, len, id, t, o = {}) {
    const r = K.rng('code', id)
    const jr = K.rng('codej', id, K.boil(t))
    const p = def(o.p, 1)
    const end = x + len * p
    const colors = o.colors || [C.terracotta, C.hiveTeal, C.sage, C.honey]
    let cx = x
    let i = 0
    let last = x
    // tokens are batched into one path per colour (one stroke each — cheap in CPU raster)
    const byCol = new Map()
    while (cx < x + len - 2 && cx < end) {
      const tw = Math.min(10 + r() * 52, x + len - cx)
      const pick = r()
      const col = o.color ? o.color : i === 0 ? colors[Math.floor(pick * colors.length)] : pick < 0.25 ? colors[Math.floor((pick / 0.25) * colors.length) % colors.length] : o.base || C.inkDim
      const e = Math.min(cx + tw, end)
      if (!byCol.has(col)) byCol.set(col, [])
      byCol.get(col).push([cx + (jr() - 0.5) * 1.2, y + (jr() - 0.5) * 1.6, Math.max(cx + 0.5, e), y + (jr() - 0.5) * 1.6])
      last = e
      cx += tw + 10 + r() * 5
      i++
    }
    ctx.save()
    ctx.lineCap = 'round'
    ctx.globalAlpha *= def(o.alpha, 0.85)
    ctx.lineWidth = def(o.w, 6)
    byCol.forEach((segs, col) => {
      ctx.strokeStyle = col
      ctx.beginPath()
      segs.forEach(([x0, y0, x1, y1]) => {
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
      })
      ctx.stroke()
    })
    ctx.restore()
    return last
  }
  /**
   * Cursive handwriting squiggle — reads as writing without inventing words. Every "letter" picks one
   * of five glyph shapes (e/l loop, o/a oval, n/m humps, i/t stroke + dot/cross lifted separately,
   * g/y descender loop) with its own advance (0.6–1.1 size), so it never reads as "eeee llll".
   * o.size (12) o.p 0..1 draw-on  o.color  o.alpha (0.8)  o.w (2.4)
   */
  function scribble(ctx, x, y, len, id, t, o = {}) {
    const r = K.rng('scrib', id)
    const jr = K.rng('scribj', id, K.boil(t))
    const size = def(o.size, 12)
    const p = def(o.p, 1)
    const xh = size * 0.82 // x-height
    const pts = [] // [x, y, penUp]
    const lifts = [] // { at: index in pts it follows, pl: [[x,y]...] } — i dots / t crosses
    const pt = (px, py, up) => pts.push([x + px, y + py, !!up])
    const oval = (cxo, cyo, rx, ry, n) => {
      for (let s = 1; s <= n; s++) {
        const a = -Math.PI / 6 - (s / n) * TAU
        pt(cxo + Math.cos(a) * rx, cyo + Math.sin(a) * ry)
      }
    }
    let cx = 0
    let prevG = -1
    while (cx < len) {
      const letters = 2 + Math.floor(r() * 5)
      pt(cx - size * 0.22, size * 0.04, true)
      for (let L = 0; L < letters && cx < len; L++) {
        let adv = size * (0.6 + r() * 0.5)
        const g = r()
        const kind = g < 0.28 ? 0 : g < 0.48 ? 1 : g < 0.68 ? 2 : g < 0.84 ? 3 : 4
        const k = kind === prevG && kind !== 0 ? 0 : kind // never the same non-loop glyph twice
        prevG = k
        if (k === 0) {
          // e / l: trochoid loop
          const tall = r() < 0.3 ? 1.9 : 0.85 + r() * 0.3
          const a = adv / TAU
          const b = a * 2.3
          for (let s = 1; s <= 9; s++) {
            const th = (s / 9) * TAU
            pt(cx + a * th + b * Math.sin(th), -xh * 0.5 * (1 - Math.cos(th)) * tall)
          }
        } else if (k === 1) {
          // o / a: closed oval, tail out
          adv *= 1.05
          pt(cx + adv * 0.72, -xh * 0.78)
          oval(cx + adv * 0.45, -xh * 0.5, adv * 0.32, xh * 0.5, 9)
          pt(cx + adv * 0.74, -xh * 0.2)
          pt(cx + adv, -xh * 0.05)
        } else if (k === 2) {
          // n / m: one or two humps, no loops
          const humps = r() < 0.5 ? 1 : 2
          adv *= humps === 2 ? 1.35 : 1
          const hw = adv / humps
          pt(cx + hw * 0.08, -xh * 0.9)
          pt(cx + hw * 0.1, -xh * 0.1)
          for (let hmp = 0; hmp < humps; hmp++) {
            for (let s = 1; s <= 5; s++) {
              const u = s / 5
              pt(cx + hw * (hmp + 0.1 + 0.9 * u), -xh * Math.pow(Math.sin(Math.PI * u), 0.7) * (hmp ? 0.92 : 1))
            }
          }
        } else if (k === 3) {
          // i / t: short stroke + a separate lift (dot or cross)
          const isT = r() < 0.45
          const hgt = isT ? xh * 1.55 : xh * 0.95
          adv *= 0.8
          pt(cx + adv * 0.3, -hgt * 0.55)
          pt(cx + adv * 0.42, -hgt)
          pt(cx + adv * 0.46, -hgt * 0.35)
          pt(cx + adv * 0.62, -xh * 0.02)
          pt(cx + adv, -xh * 0.28)
          if (isT) lifts.push({ at: pts.length, pl: [[x + cx + adv * 0.12, y - xh * 1.06], [x + cx + adv * 0.8, y - xh * 1.12]] })
          else lifts.push({ at: pts.length, pl: [[x + cx + adv * 0.46, y - xh * 1.42], [x + cx + adv * 0.5 + 1.2, y - xh * 1.48]] })
        } else {
          // g / y: small bowl + descender loop below the baseline
          adv *= 1.05
          pt(cx + adv * 0.62, -xh * 0.74)
          oval(cx + adv * 0.4, -xh * 0.48, adv * 0.26, xh * 0.44, 8)
          pt(cx + adv * 0.66, -xh * 0.2)
          pt(cx + adv * 0.6, xh * 0.55)
          pt(cx + adv * 0.44, xh * 0.95)
          pt(cx + adv * 0.28, xh * 0.72)
          pt(cx + adv * 0.52, xh * 0.18)
          pt(cx + adv, -xh * 0.14)
        }
        cx += adv
      }
      pt(cx + size * 0.18, 0)
      cx += size * 0.95
    }
    pts[0][2] = true
    const show = Math.floor(pts.length * p)
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = o.color || C.ink
    ctx.globalAlpha *= def(o.alpha, 0.8)
    ctx.lineWidth = def(o.w, 2.4)
    ctx.beginPath()
    let pen = false
    for (let i = 0; i < show; i++) {
      const [px, py, lift] = pts[i]
      const jx = (jr() - 0.5) * 0.6
      const jy = (jr() - 0.5) * 0.6
      if (lift || !pen) ctx.moveTo(px + jx, py + jy)
      else ctx.lineTo(px + jx, py + jy)
      pen = true
    }
    lifts.forEach((lf) => {
      if (lf.at > show) return
      ctx.moveTo(lf.pl[0][0] + (jr() - 0.5) * 0.6, lf.pl[0][1] + (jr() - 0.5) * 0.6)
      ctx.lineTo(lf.pl[1][0] + (jr() - 0.5) * 0.6, lf.pl[1][1] + (jr() - 0.5) * 0.6)
    })
    ctx.stroke()
    ctx.restore()
    return show > 0 ? pts[show - 1] : [x, y]
  }
  /** Rubber-stamp ink impression, thunking in: invisible until p 0.25, impact, settle. */
  function inkStamp(ctx, x, y, t, o = {}) {
    const p = def(o.p, 1)
    if (p <= 0.25) return
    const k = seg(p, 0.25, 0.62)
    const sc = 1 + 0.32 * (1 - E.outBack(k))
    const text = o.text || 'STAMP'
    const size = def(o.size, 40)
    const color = o.color || C.terracotta
    const id = o.id || text
    K.font(ctx, o.family || 'chunky', size, o.weight || '600')
    const tw = ctx.measureText(text).width
    const w = def(o.w, tw + size * 1.1)
    const h = def(o.h, size * 1.55)
    K.at(ctx, x, y, def(o.rot, -0.12), sc, () => {
      ctx.save()
      ctx.globalAlpha *= Math.min(1, k * 4) * def(o.alpha, 0.86)
      const rr = K.roundRectPts(-w / 2, -h / 2, w, h, 10, 3)
      ctx.lineJoin = 'round'
      ctx.strokeStyle = color
      ctx.lineWidth = 5
      K.pathPoly(ctx, K.wobble(rr, 1.2, id, 'st'))
      ctx.stroke()
      ctx.lineWidth = 2
      K.pathPoly(ctx, K.wobble(K.roundRectPts(-w / 2 + 7, -h / 2 + 7, w - 14, h - 14, 6, 3), 1, id, 'st2'))
      ctx.stroke()
      K.font(ctx, o.family || 'chunky', size, o.weight || '600')
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, 0, size * 0.05)
      // dry-ink specks
      const r = K.rng('speck', id)
      ctx.fillStyle = 'rgba(255,250,240,0.55)'
      for (let i = 0; i < 16; i++) ctx.fillRect((r() - 0.5) * w * 0.92, (r() - 0.5) * h * 0.8, 1.5 + r() * 3, 1 + r() * 2)
      ctx.restore()
    })
    if (p > 0.25 && p < 0.7) K.at(ctx, x, y, def(o.rot, -0.12), 1, () => impactTicks(ctx, w, h, id, t, 1 - seg(p, 0.25, 0.7)))
  }
  /** Four short "thunk" ticks off the corners of a w x h impact (≤ 4 marks — never a starburst). */
  function impactTicks(ctx, w, h, id, t, alpha) {
    if (alpha <= 0) return
    ;[[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy], i) => {
      const x0 = sx * (w / 2 + 8)
      const y0 = sy * (h / 2 + 8)
      inkLine(ctx, [[x0, y0], [x0 + sx * 16, y0 + sy * 12]], id + 'tk' + i, t, { w: 3, color: C.inkDim, alpha: 0.8 * alpha, passes: 1 })
    })
  }
  /** Baker's twine between points (cream with red twist). */
  function twine(ctx, pl, o = {}) {
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    pl.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])))
    ctx.strokeStyle = 'rgba(58,36,14,0.18)'
    ctx.lineWidth = def(o.w, 4) + 2
    ctx.stroke()
    ctx.strokeStyle = o.base || '#f3e9d6'
    ctx.lineWidth = def(o.w, 4)
    ctx.stroke()
    ctx.setLineDash([5, 6])
    ctx.strokeStyle = o.twist || '#c9463b'
    ctx.lineWidth = def(o.w, 4) * 0.8
    ctx.stroke()
    ctx.restore()
  }
  /** Little yellow pencil whose graphite tip sits at (0,0), pointing down-left. */
  function pencilProp(ctx, x, y, t, id) {
    K.at(ctx, x, y, -0.75, 1, () => {
      const L = 150
      const body = [[18, -9], [18 + L, -9], [18 + L, 9], [18, 9]]
      K.paper(ctx, [[0, 0], [18, -9], [18, 9]], '#e8c9a0', { seed: id + 'pw', cut: 0, shadow: 0.9, lift: 8 })
      fillPoly(ctx, [[0, 0], [6, -3], [6, 3]], C.ink)
      K.paper(ctx, body, C.mustard, { seed: id + 'pb', cut: 0.8, shadow: 0.9, lift: 8 })
      fillPoly(ctx, [[18, -3], [18 + L, -3], [18 + L, 1], [18, 1]], 'rgba(255,255,255,0.25)')
      K.paper(ctx, [[18 + L, -9], [18 + L + 14, -9], [18 + L + 14, 9], [18 + L, 9]], '#b8bcc0', { seed: id + 'pf', cut: 0, shadow: 0 })
      K.paper(ctx, [[18 + L + 14, -9], [18 + L + 34, -8], [18 + L + 36, 0], [18 + L + 34, 8], [18 + L + 14, 9]], C.pink, { seed: id + 'pe', cut: 0.5, shadow: 0 })
    })
  }
  /** Postage-stamp outline: rectangle with perforation bites. */
  function perfPts(w, h, r = 5.5, step = 17) {
    const pts = []
    const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    for (let e = 0; e < 4; e++) {
      const [x0, y0] = corners[e]
      const [x1, y1] = corners[(e + 1) % 4]
      const len = Math.hypot(x1 - x0, y1 - y0)
      const n = Math.max(1, Math.round(len / step))
      const ux = (x1 - x0) / len
      const uy = (y1 - y0) / len
      const nx = -uy
      const ny = ux
      for (let i = 0; i < n; i++) {
        const sx = x0 + ux * (len * i) / n
        const sy = y0 + uy * (len * i) / n
        pts.push([sx, sy])
        const mx = sx + (ux * len) / (2 * n)
        const my = sy + (uy * len) / (2 * n)
        for (let k = 0; k <= 6; k++) {
          const a = (Math.PI * k) / 6
          pts.push([mx - ux * r * Math.cos(a) + nx * r * Math.sin(a), my - uy * r * Math.cos(a) + ny * r * Math.sin(a)])
        }
      }
    }
    return pts
  }
  /** Wooden (kraft) picture frame around a w x h opening, border fw. */
  function woodFrame(ctx, w, h, fw, color, id, t, o = {}) {
    const W2 = w / 2 + fw
    const H2 = h / 2 + fw
    const iw = w / 2
    const ih = h / 2
    const strips = [
      [[-W2, -H2], [W2, -H2], [iw, -ih], [-iw, -ih]],
      [[W2, -H2], [W2, H2], [iw, ih], [iw, -ih]],
      [[W2, H2], [-W2, H2], [-iw, ih], [iw, ih]],
      [[-W2, H2], [-W2, -H2], [-iw, -ih], [-iw, ih]],
    ]
    const tint = ['rgba(255,245,225,0.16)', 'rgba(40,20,5,0.1)', 'rgba(40,20,5,0.16)', 'rgba(255,245,225,0.08)']
    // shadow per strip: the frame's own shadow never darkens the picture inside it
    strips.forEach((s) => K.dropShadow(ctx, s, def(o.shadow, 1) * 0.85, def(o.lift, 0)))
    strips.forEach((s, i) => {
      K.paper(ctx, s, color, { seed: id + 'fr' + i, cut: 0.6, shadow: 0 })
      fillPoly(ctx, s, tint[i])
      // grain
      ctx.save()
      K.pathPoly(ctx, s)
      ctx.clip()
      const r = K.rng('grain', id, i)
      ctx.strokeStyle = 'rgba(70,40,15,0.22)'
      ctx.lineWidth = 1.2
      const horiz = i % 2 === 0
      for (let g = 0; g < 4; g++) {
        const off = (r() - 0.5) * fw * 1.6
        ctx.beginPath()
        if (horiz) {
          const yy = (i === 0 ? -H2 + fw / 2 : H2 - fw / 2) + off * 0.5
          ctx.moveTo(-W2, yy)
          ctx.bezierCurveTo(-W2 / 3, yy + (r() - 0.5) * 8, W2 / 3, yy + (r() - 0.5) * 8, W2, yy)
        } else {
          const xx = (i === 1 ? W2 - fw / 2 : -W2 + fw / 2) + off * 0.5
          ctx.moveTo(xx, -H2)
          ctx.bezierCurveTo(xx + (r() - 0.5) * 8, -H2 / 3, xx + (r() - 0.5) * 8, H2 / 3, xx, H2)
        }
        ctx.stroke()
      }
      ctx.restore()
    })
    // mitre joints + lip
    ;[[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy], i) => inkLine(ctx, [[sx * W2, sy * H2], [sx * iw, sy * ih]], id + 'mi' + i, t, { w: 1.6, alpha: 0.45 }))
    ctx.save()
    ctx.strokeStyle = 'rgba(40,22,8,0.45)'
    ctx.lineWidth = 3
    ctx.strokeRect(-iw, -ih, w, h)
    ctx.restore()
  }
  function wrap(ctx, text, maxW) {
    const words = String(text).split(/\s+/)
    const lines = []
    let cur = ''
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w
      if (cur && ctx.measureText(next).width > maxW) {
        lines.push(cur)
        cur = w
      } else cur = next
    }
    if (cur) lines.push(cur)
    return lines
  }
  function heartPts(r, n = 40) {
    const pts = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU
      const hx = 16 * Math.pow(Math.sin(a), 3)
      const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a))
      pts.push([(hx * r) / 16, (hy * r) / 16 + r * 0.1])
    }
    return pts
  }

  const P = {}

  // ───────────────────────── s6: files ─────────────────────────
  const MANILA = '#ecd08c'
  const MANILA_HI = '#f6e2a8'
  const BROWN = '#8a5a34'

  function mSticker(ctx, x, y, r, id, t, rot = -0.12) {
    K.at(ctx, x, y, rot, r / 21, () => {
      const s = K.paper(ctx, K.ellipsePts(0, 0, 21, 21, 24), C.terracotta, { seed: id + 'ms', cut: 1, shadow: 0.9 })
      outline(ctx, s, id + 'mso', t, { w: 2, alpha: 0.55, jit: 1.2 })
      ctx.save()
      K.font(ctx, 'chunky', 27, '600')
      ctx.fillStyle = C.paperWhite
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('M', 0, 1.5)
      ctx.beginPath()
      ctx.arc(0, 0, 16, -2.6, -1.7)
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = 2.5
      ctx.lineCap = 'round'
      ctx.stroke()
      ctx.restore()
    })
  }
  function drawLeaf(ctx, kind, m, id, t, color) {
    if (kind === 'folder') {
      const body = [[-48, -24], [-45, -38], [-14, -38], [-8, -27], [48, -27], [48, 34], [-48, 34]]
      const s1 = K.paper(ctx, body, color || MANILA, { seed: id + 'f', cut: 1.6, shadow: 0.85 })
      outline(ctx, s1, id + 'fo', t)
      const s2 = K.paper(ctx, [[-50, -11], [50, -16], [48, 34], [-48, 34]], color ? mix(color, '#ffffff', 0.25) : MANILA_HI, { seed: id + 'fl', cut: 1.4, shadow: 0.4 })
      outline(ctx, s2, id + 'fo2', t, { w: 2.2, alpha: 0.6 })
    } else {
      const body = [[-34, -44], [15, -44], [34, -25], [34, 44], [-34, 44]]
      const s = K.paper(ctx, body, color || C.paperWhite, { seed: id + 'd', cut: 1.2, shadow: 0.85 })
      fillPoly(ctx, [[15, -44], [15, -25], [34, -25]], '#e3d2b0')
      inkLine(ctx, [[15, -44], [15, -25], [34, -25]], id + 'de', t, { w: 1.6, alpha: 0.55, passes: 1 })
      outline(ctx, s, id + 'do', t)
      codeLine(ctx, -24, -20, 30, id + 'l1', t, { w: 4 })
      codeLine(ctx, -24, -6, 46, id + 'l2', t, { w: 4 })
      codeLine(ctx, -16, 8, 36, id + 'l3', t, { w: 4 })
      codeLine(ctx, -24, 22, 26, id + 'l4', t, { w: 4 })
      if (m) mSticker(ctx, 12, 20, 21, id, t)
    }
  }

  P.fileLeaf = function fileLeaf(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'leaf', (ctx, map, id) => {
      drawLeaf(ctx, o.kind || 'file', !!o.m, id, t, o.color)
      return { center: map(0, 0), top: map(0, o.kind === 'folder' ? -38 : -44) }
    })
  }

  const TREE = {
    trunk: [[0, 246], [-12, 150], [6, 60], [-4, -40], [2, -150]],
    branches: [
      { pts: [[-4, 44], [-120, 4], [-236, -34], [-326, -36]], w: [26, 10], at: 0.2 }, // 0 left low
      { pts: [[4, 20], [122, -10], [240, -48], [336, -40]], w: [26, 10], at: 0.26 }, // 1 right low (M leaf)
      // 2 left high — Pip's playground slide: thick, gentle S, flat at the tip, steeper toward the trunk
      { pts: [[-3, -58], [-80, -110], [-170, -150], [-260, -170]], w: [40, 20], at: 0.34 },
      { pts: [[2, -96], [90, -168], [178, -236], [248, -262]], w: [20, 8], at: 0.4 }, // 3 right high
      { pts: [[2, -150], [-6, -236], [8, -318], [0, -372]], w: [18, 7], at: 0.46 }, // 4 crown
      { pts: [[-178, -20], [-200, -84], [-226, -130]], w: [12, 5], at: 0.52 }, // 5 twig off 0
      { pts: [[182, -30], [204, -92], [226, -136]], w: [12, 5], at: 0.56 }, // 6 twig off 1
    ],
    // b: branch index, s: position along it, side: 0 tip / +1 hangs below / -1 sits above
    // (branch 2's top edge stays clear: it is the slide)
    leaves: [
      { b: 0, s: 1, side: 0, kind: 'folder' },
      { b: 0, s: 0.58, side: 1, kind: 'file' },
      { b: 1, s: 1, side: 0, kind: 'file', m: true },
      { b: 1, s: 0.56, side: 1, kind: 'folder', color: '#f2b99a' },
      { b: 2, s: 0.94, side: 1, kind: 'folder' },
      { b: 2, s: 0.52, side: 1, kind: 'file' },
      { b: 3, s: 1, side: 0, kind: 'folder', color: '#bfe0c8' },
      { b: 3, s: 0.52, side: -1, kind: 'file', color: '#fbe7b0' },
      { b: 4, s: 1, side: 0, kind: 'folder' },
      { b: 5, s: 1, side: 0, kind: 'file' },
      { b: 6, s: 1, side: 0, kind: 'folder' },
    ],
    // torn-paper canopy blobs behind the branches: a round picture-book crown
    canopy: [
      { c: [0, -318], r: [276, 186], col: 'deep', at: 0.44, lumps: 9 },
      { c: [-250, -200], r: [204, 146], col: 'grass', at: 0.5, lumps: 7 },
      { c: [256, -214], r: [198, 142], col: 'grass', at: 0.56, lumps: 7 },
      { c: [-26, -404], r: [166, 104], col: 'grassHi', at: 0.62, lumps: 6 },
    ],
  }
  const TREE_DENSE = {
    trunk: spline(TREE.trunk, 8),
    branches: TREE.branches.map((b) => spline(b.pts, 8)),
  }
  const CANOPY_COL = { deep: mix(C.sage, C.grass, 0.35), grass: C.grass, grassHi: mix(C.grass, '#ffffff', 0.18) }
  /** A scalloped cloud-crown outline (lumps bulge out, cusps between them), fixed per seed. */
  function cloudPts(rx, ry, lumps, seed) {
    const r = K.rng('cloud', seed)
    const ph = r() * TAU
    const pts = []
    const n = 60
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU
      const k = 0.9 + 0.12 * Math.abs(Math.sin((a * lumps) / 2 + ph)) + 0.03 * K.noise1(i * 0.3, 'cl', seed)
      pts.push([Math.cos(a) * rx * k, Math.sin(a) * ry * k])
    }
    return pts
  }
  // Pip's slide: branch 2's TOP edge (offset by half its width along the upward normal, tapering to
  // the centreline where it meets the trunk), then down the trunk to the soil. Fixed at load — pure.
  const SLIDE = (() => {
    const pl = TREE_DENSE.branches[2]
    const w = TREE.branches[2].w
    const n = pl.length
    const top = pl.map((p, i) => {
      const a = pl[Math.max(0, i - 1)]
      const b = pl[Math.min(n - 1, i + 1)]
      let nx = -(b[1] - a[1])
      let ny = b[0] - a[0]
      const d = Math.hypot(nx, ny) || 1
      nx /= d
      ny /= d
      if (ny > 0) {
        nx = -nx
        ny = -ny
      }
      const s = i / (n - 1)
      const hw = lerp(w[0], w[1], s) / 2
      const taper = s < 0.22 ? E.inOutCubic(s / 0.22) : 1
      return [p[0] + nx * hw * taper, p[1] + ny * hw * taper]
    }).reverse()
    const trunk = cut(TREE_DENSE.trunk, 0, 0.76).reverse()
    return { pts: top.concat(trunk.slice(1)), join: top.length - 1 }
  })()
  // small green paper leaves: along the branches + clustered at every tip (fixed at load — pure)
  const GREENS = (() => {
    const r = K.rng('greens')
    const out = []
    const spots = [[0, 0.3], [0, 0.78], [1, 0.34], [1, 0.8], [2, 0.3], [2, 0.74], [3, 0.3], [3, 0.8], [4, 0.45], [4, 0.78], [5, 0.6], [6, 0.6], [2, 0.9], [3, 0.92], [0, 0.95], [1, 0.95]]
    spots.forEach(([b, s], i) => {
      out.push({ b, s, side: b === 2 || i % 2 ? 1 : -1, len: 30 + r() * 14, rot: (r() - 0.5) * 0.5, col: [C.grass, C.sage, C.mint, C.grass][i % 4] })
    })
    // tip clusters: 1–2 leaves fanned around each branch tip (not on the slide's top edge)
    const tips = [[0, [-0.9, 0.7]], [1, [0.9, -0.8]], [2, [1.2]], [3, [-0.9, 0.8]], [4, [-1.0, 0.95]], [5, [0.8]], [6, [-0.8]]]
    tips.forEach(([b, sides], k) => sides.forEach((sd, j) => {
      out.push({ b, s: 0.97, side: sd, tip: true, len: 34 + r() * 16, rot: (r() - 0.5) * 0.3, col: [C.grass, C.mint, C.sage][(k + j) % 3] })
    }))
    return out
  })()
  function greenLeaf(ctx, len, col, id, t) {
    const wid = len * 0.36
    const pts = [[0, 0], [len * 0.25, -wid * 0.9], [len * 0.62, -wid], [len, 0], [len * 0.62, wid], [len * 0.25, wid * 0.9]]
    const s = K.paper(ctx, pts, col, { seed: id, cut: 0.6, shadow: 0.6 })
    outline(ctx, s, id + 'o', t, { w: 1.6, alpha: 0.45, jit: 1, step: 14 })
    ctx.save()
    ctx.strokeStyle = 'rgba(40,60,20,0.35)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(2, 0)
    ctx.quadraticCurveTo(len * 0.5, -2, len * 0.85, 0)
    ctx.stroke()
    ctx.restore()
  }

  P.fileTree = function fileTree(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'tree', (ctx, map, id) => {
      const g = clamp01(def(o.grow, 1))
      const pluck = clamp01(def(o.pluck, 0))
      const pluckT = def(o.pluckT, -1)
      const sway = def(o.sway, 1)
      const label = def(o.label, 'File Explorer')
      const ls = def(o.leafScale, 1.3)
      const gs = 1 + (ls - 1) * 0.6 // green leaves grow a little less than the file leaves
      // ── pot (back body + soil)
      if (o.pot !== false) {
        const body = [[-170, 268], [170, 268], [128, 432], [-128, 432]]
        const pb = K.paper(ctx, body, C.terracotta, { seed: id + 'pot', cut: 2, shadow: 1 })
        fillPoly(ctx, [[60, 268], [170, 268], [128, 432], [40, 432]], 'rgba(60,20,5,0.12)')
        outline(ctx, pb, id + 'poto', t, { alpha: 0.6 })
        K.paper(ctx, K.ellipsePts(0, 244, 158, 20, 30), '#5e3b22', { seed: id + 'soil', cut: 1.5, shadow: 0 })
      }
      // ── canopy: overlapping torn-paper blobs pop in behind the branches
      TREE.canopy.forEach((cb, i) => {
        const sc = E.outBack(seg(g, cb.at, cb.at + 0.24))
        if (sc <= 0) return
        const bob = Math.sin(t * 1.3 + i * 1.9) * 2.5 * sway
        K.at(ctx, cb.c[0], cb.c[1] + bob, (i - 1.5) * 0.04, sc, () => {
          K.paper(ctx, cloudPts(cb.r[0], cb.r[1], cb.lumps, 'cn' + i), CANOPY_COL[cb.col], { seed: id + 'cn' + i, torn: 2, shadow: 0.6, lift: 2 })
          // a few crayon leaf-vein ticks for texture (short, never radiating from one point)
          const r = K.rng('cnv', id, i)
          ctx.save()
          ctx.strokeStyle = 'rgba(40,70,25,0.22)'
          ctx.lineWidth = 2.2
          ctx.lineCap = 'round'
          ctx.beginPath()
          for (let k = 0; k < 7; k++) {
            const px = (r() - 0.5) * cb.r[0] * 1.3
            const py = (r() - 0.5) * cb.r[1] * 1.2
            const a = -0.6 + r() * 0.5
            ctx.moveTo(px, py)
            ctx.quadraticCurveTo(px + 8, py - 6, px + Math.cos(a) * 22, py + Math.sin(a) * 22)
          }
          ctx.stroke()
          ctx.restore()
        })
      })
      // ── trunk
      const tp = E.outCubic(seg(g, 0, 0.3))
      // ── branches first (their roots tuck under the trunk)
      const bps = TREE.branches.map((b) => E.outCubic(seg(g, b.at, b.at + 0.3)))
      TREE.branches.forEach((b, i) => {
        if (bps[i] > 0) crayon(ctx, cut(TREE_DENSE.branches[i], 0, bps[i]), b.w[0], lerp(b.w[0], b.w[1], bps[i]), BROWN, id + 'br' + i, t, { edge: true })
      })
      if (tp > 0) crayon(ctx, cut(TREE_DENSE.trunk, 0, tp), 58, lerp(58, 24, tp), BROWN, id + 'trunk', t, { edge: true })
      // ── little green paper leaves
      GREENS.forEach((G, i) => {
        const br = TREE.branches[G.b]
        const g0 = br.at + 0.3 * G.s * 0.8
        const sc = E.outBack(seg(g, g0, g0 + 0.1)) * gs
        if (sc <= 0) return
        const [bx, by, ba] = along(TREE_DENSE.branches[G.b], G.s)
        const a = ba + G.side * (G.tip ? 1 : 1.05) + G.rot + Math.sin(t * 2.1 + i) * 0.08 * sway
        K.at(ctx, bx, by, a, sc, () => greenLeaf(ctx, G.len, G.col, id + 'g' + i, t))
      })
      // ── file / folder leaves
      const leaves = []
      let mLeaf = null
      TREE.leaves.forEach((L, i) => {
        const pl = TREE_DENSE.branches[L.b]
        const [bx, by, ba] = along(pl, L.s)
        const br = TREE.branches[L.b]
        const g0 = br.at + 0.3 * L.s * 0.8
        const sc = E.outBack(seg(g, g0, g0 + 0.12))
        const r = K.rng('leaf', id, i)
        let lx
        let ly
        if (L.side === 0) {
          lx = bx + Math.cos(ba) * 46 * ls
          ly = by + Math.sin(ba) * 46 * ls - 6
        } else {
          lx = bx + (r() - 0.5) * 14
          ly = by + L.side * 52 * ls
        }
        let rot = (r() - 0.5) * 0.6 + Math.sin(t * 1.7 + i * 1.3) * 0.06 * sway
        let dx = 0
        let dy = 0
        let hide = false
        let stretch = 1
        if (L.m) {
          mLeaf = map(lx, ly)
          if (pluck > 0) {
            const pe = E.outCubic(pluck)
            dx = Math.cos(ba) * 70 * pe
            dy = -26 * pe
            rot += 0.35 * pe
            stretch = 1 + 0.12 * Math.sin(Math.PI * pluck)
            hide = pluck >= 1
          }
        }
        // twig
        let twigEnd = [lx + dx * 0.5, ly + dy * 0.5]
        if (L.m && pluck > 0) {
          const k = pluckT >= 0 ? Math.exp(-5 * pluckT) * Math.sin(20 * pluckT) : 0
          twigEnd = hide ? [bx + Math.cos(ba) * 18, by + Math.sin(ba) * 18 + k * 14] : [lx + dx * 0.3, ly + dy * 0.3]
        }
        if (sc > 0.05) inkLine(ctx, [[bx, by], twigEnd], id + 'tw' + i, t, { w: 4.5, color: BROWN, alpha: 0.95 })
        if (sc > 0 && !hide) {
          K.at(ctx, lx + dx, ly + dy, rot, sc * stretch * ls * (L.m ? 1.15 : 1), () => drawLeaf(ctx, L.kind, !!L.m, id + 'lf' + i, t, L.color))
        }
        const lp = map(lx + dx, ly + dy)
        leaves.push({ x: lp[0], y: lp[1], kind: L.kind, m: !!L.m })
      })
      // ── pot rim (in front of the trunk base) + label
      if (o.pot !== false) {
        const rim = [[-186, 236], [186, 236], [180, 276], [-180, 276]]
        const rs = K.paper(ctx, rim, mix(C.terracotta, '#ffffff', 0.12), { seed: id + 'rim', cut: 1.5, shadow: 0.9 })
        fillPoly(ctx, [[-180, 268], [180, 268], [180, 276], [-180, 276]], 'rgba(60,20,5,0.18)')
        outline(ctx, rs, id + 'rimo', t, { alpha: 0.6 })
        if (label) K.hand(ctx, label, 0, 368, { family: 'marker', size: 46, color: C.cream, t, id: id + 'lbl', jitter: 0.5 })
        inkLine(ctx, [[-110, 385], [110, 383]], id + 'ul', t, { w: 3, color: C.cream, alpha: 0.7, passes: 1 })
      }
      const branches = TREE_DENSE.branches.slice(0, 5).map((pl) => pl.map((p) => map(p[0], p[1])))
      return {
        leaves,
        mLeaf,
        mLeafScale: def(o.scale, 1) * ls * 1.15,
        branches,
        slide: SLIDE.pts.map((p) => map(p[0], p[1])),
        slideJoin: SLIDE.join,
        trunkTop: map(2, -150),
        potTop: map(0, 240),
      }
    })
  }

  // notebook page
  const RULE_Y0 = 124
  const RULE_GAP = 44
  const NB_LINES = [[0, 0.62], [1, 0.5], [2, 0.56], [2, 0.36], [1, 0.52], null, [1, 0.3], [0, 0.46], [0, 0.18], [1, 0.54], [1, 0.4], [0, 0.26]]
  const STRIKE_IDX = 4
  function nbGeom(w, h, k) {
    const L = -w / 2
    const T = -h / 2
    const ln = NB_LINES[k] || [1, 0.44]
    const x0 = L + 104 + ln[0] * 34
    const len = (w - 150 - ln[0] * 34) * ln[1]
    const yy = T + RULE_Y0 + RULE_GAP * k - 12
    return { x0, len, y: yy }
  }
  function drawSavedStamp(ctx, x, y, t, p, id) {
    if (p <= 0) return null
    const k1 = seg(p, 0, 0.3)
    const inAir = p < 0.3
    const sc = inAir ? lerp(1.7, 1, E.inCubic(k1)) : 1 - 0.07 * Math.sin(seg(p, 0.3, 0.6) * Math.PI) * (1 - seg(p, 0.3, 0.6))
    const sy = inAir ? 1 : 1 - 0.1 * Math.sin(seg(p, 0.3, 0.5) * Math.PI)
    const w = 216
    const h = 150
    K.withAlpha(ctx, Math.min(1, p * 6), () => {
      K.at(ctx, x, y, lerp(-0.4, -0.1, E.outCubic(k1)), [sc, sc * sy], () => {
        K.paper(ctx, perfPts(w, h), C.peach, { seed: id + 'ps', cut: 0, shadow: 1, lift: inAir ? 30 * (1 - k1) : 0 })
        K.paper(ctx, K.rectPts(-w / 2 + 14, -h / 2 + 14, w - 28, h - 28), C.cream, { seed: id + 'pi', cut: 0.8, shadow: 0 })
        inkLine(ctx, K.rectPts(-w / 2 + 20, -h / 2 + 20, w - 40, h - 40), id + 'pb', t, { w: 1.6, alpha: 0.5, closed: true, passes: 1 })
        K.hand(ctx, 'All changes', 0, -8, { family: 'marker', size: 33, color: C.ink, t, id: id + 's1', jitter: 0.35 })
        K.hand(ctx, 'saved', -14, 30, { family: 'marker', size: 36, color: C.terracotta, t, id: id + 's2', jitter: 0.35 })
        inkLine(ctx, [[34, 18], [44, 30], [66, 2]], id + 'chk', t, { w: 4.5, color: C.sage, alpha: 0.95 })
        // postmark ring + wavy cancel lines hanging off the top-left
        ctx.save()
        ctx.globalAlpha *= 0.45 * seg(p, 0.45, 0.7)
        ctx.strokeStyle = C.inkDim
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.arc(-w / 2 + 6, -h / 2 + 4, 34, 0, TAU)
        ctx.stroke()
        for (let i = 0; i < 3; i++) {
          ctx.beginPath()
          for (let s = 0; s <= 12; s++) {
            const xx = -w / 2 - 110 + s * 9
            const yy = -h / 2 - 10 + i * 12 + Math.sin(s * 0.9) * 4
            if (s) ctx.lineTo(xx, yy)
            else ctx.moveTo(xx, yy)
          }
          ctx.stroke()
        }
        ctx.restore()
      })
    })
    if (p > 0.3 && p < 0.65) K.at(ctx, x, y, -0.1, 1, () => impactTicks(ctx, w, h, id + 'thk', t, 1 - seg(p, 0.3, 0.65)))
    return [x, y]
  }
  function nbContent(ctx, w, h, id, t, o, st) {
    const L = -w / 2
    const T = -h / 2
    const pageShape = K.paper(ctx, K.boxPts(w, h), C.paperWhite, { seed: id + 'pg', cut: 2, shadow: 0 })
    outline(ctx, pageShape, id + 'pgo', t, { alpha: 0.7 })
    // punched holes (Pip's hole-punch hands, echoed)
    for (const f of [0.18, 0.5, 0.82]) {
      ctx.beginPath()
      ctx.arc(L + 34, T + h * f, 12, 0, TAU)
      ctx.fillStyle = 'rgba(92,64,36,0.30)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(L + 35, T + h * f + 2, 9, 0, TAU)
      ctx.fillStyle = 'rgba(92,64,36,0.22)'
      ctx.fill()
    }
    // rules + margin
    ctx.save()
    ctx.strokeStyle = 'rgba(110,160,195,0.42)'
    ctx.lineWidth = 2
    for (let yy = T + RULE_Y0; yy < h / 2 - 24; yy += RULE_GAP) {
      ctx.beginPath()
      ctx.moveTo(L + 8, yy)
      ctx.lineTo(L + w - 8, yy)
      ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(184,92,52,0.55)'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(L + 78, T + 4)
    ctx.lineTo(L + 78, T + h - 4)
    ctx.stroke()
    ctx.restore()
    // code lines
    NB_LINES.forEach((ln, k) => {
      if (!ln) return
      const g = nbGeom(w, h, k)
      if (T + RULE_Y0 + RULE_GAP * k > h / 2 - 24) return
      codeLine(ctx, g.x0, g.y, g.len, id + 'cl' + k, t, { w: 7, alpha: k === STRIKE_IDX && o.strike > 0 ? 0.55 : 0.85 })
    })
    // strike-through (terracotta crayon, wavy)
    const gs = nbGeom(w, h, STRIKE_IDX)
    const sx0 = gs.x0 - 12
    const sx1 = gs.x0 + gs.len + 14
    st.strikeLine = [[sx0, gs.y], [sx1, gs.y]]
    if (o.strike > 0) {
      // angry pencil scribble-out: irregular zig-zag (step 9–14 px, amplitude 6–11 px) with a slight
      // upward slant, plus a second looser pass; the tokens still peek through
      const slope = Math.tan(0.03)
      const pl = []
      const pl2 = []
      let xx = sx0
      for (let i = 0; xx < sx1; i++) {
        const rr = K.rng(id, 'strike', i)
        const amp = 6 + rr() * 5
        const yy = gs.y - (xx - sx0) * slope
        pl.push([xx, yy + (i % 2 ? -amp : amp)])
        pl2.push([xx + 2 + (rr() - 0.5) * 4, yy + 2 + (i % 2 ? -amp * 1.15 : amp * 1.1)])
        xx += 9 + rr() * 5
      }
      pl.push([sx1, gs.y - (sx1 - sx0) * slope])
      const part = cut(pl, 0, o.strike)
      inkLine(ctx, part, id + 'strike', t, { w: 3.6, color: C.tomato, alpha: 0.95, jit: 1.4 })
      const part2 = cut(pl2, 0, clamp01(o.strike * 1.08 - 0.08))
      inkLine(ctx, part2, id + 'strike2', t, { w: 2.6, color: C.tomato, alpha: 0.6, jit: 1.6, passes: 1 })
      if (o.strike < 1 && part.length) st.pen = part[part.length - 1]
    }
    // rewrite on the blank line below (teal), with an insertion caret
    if (o.rewrite > 0) {
      const gr = nbGeom(w, h, STRIKE_IDX + 1)
      const x0 = gs.x0
      inkLine(ctx, [[x0 - 26, gr.y + 8], [x0 - 18, gr.y - 6], [x0 - 10, gr.y + 8]], id + 'caret', t, { w: 3, color: C.terracotta, alpha: Math.min(1, o.rewrite * 5) })
      const endX = codeLine(ctx, x0, gr.y, gs.len * 0.95, id + 'rw', t, { w: 7, p: o.rewrite, colors: [C.hiveTeal, C.sage, C.teal] })
      if (o.rewrite < 1) st.pen = [endX, gr.y]
    }
    // sticky-note file tabs
    const tabCols = [C.butter, C.pink, C.mint, C.sky]
    const nt = Math.max(0, Math.min(4, def(o.tabs, 3)))
    st.tabs = []
    for (let i = 0; i < nt; i++) {
      const tx = L + 150 + i * 128
      const act = i === 0
      const th = act ? 74 : 62
      const ty = T - (act ? 16 : 8)
      const r = K.rng('tab', id, i)
      K.at(ctx, tx, ty, (r() - 0.5) * 0.12, 1, () => {
        const tbS = K.paper(ctx, K.boxPts(112, th), act ? tabCols[0] : mix(tabCols[i % 4], C.paperWhite, 0.15), { seed: id + 'tb' + i, cut: 1.5, shadow: 0.7 })
        outline(ctx, tbS, id + 'tbo' + i, t, { alpha: 0.55, w: 2.2 })
        fillPoly(ctx, K.rectPts(-56, -th / 2, 112, 12), 'rgba(40,20,5,0.07)')
        codeLine(ctx, -38, -th / 2 + 30, act ? 58 : 50, id + 'tbs' + i, t, { w: 5, color: C.inkDim, alpha: 0.7 })
        if (act) {
          // the M sticker from the leaf this page unfolded from
          ctx.save()
          ctx.beginPath()
          ctx.arc(36, -th / 2 + 26, 11, 0, TAU)
          ctx.fillStyle = C.terracotta
          ctx.fill()
          K.font(ctx, 'chunky', 14, '700')
          ctx.fillStyle = C.paperWhite
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText('M', 36, -th / 2 + 27)
          ctx.restore()
        }
      })
      st.tabs.push([tx, ty - 10])
    }
    // saved postage stamp
    st.stamp = [w / 2 - 128, h / 2 - 100]
    if (o.saved > 0) drawSavedStamp(ctx, st.stamp[0], st.stamp[1], t, o.saved, id + 'sv')
  }

  P.notebookPage = function notebookPage(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'nb', (ctx, map, id) => {
      const w = def(o.w, 560)
      const h = def(o.h, 720)
      const unfold = clamp01(def(o.unfold, 1))
      const oo = { strike: clamp01(def(o.strike, 0)), rewrite: clamp01(def(o.rewrite, 0)), saved: clamp01(def(o.saved, 0)), tabs: def(o.tabs, 3) }
      const ph = h / 3
      const T = -h / 2
      const e = [1, E.outCubic(seg(unfold, 0, 0.5)), E.outCubic(seg(unfold, 0.5, 1))]
      const tops = [T, T + ph * e[0], T + ph * (e[0] + e[1])]
      const total = ph * (e[0] + e[1] + e[2])
      K.dropShadow(ctx, K.rectPts(-w / 2, T, w, total), 1, unfold < 1 ? 6 : 0)
      const st = { pen: null }
      if (unfold >= 1) nbContent(ctx, w, h, id, t, oo, st)
      else {
        for (let k = 0; k < 3; k++) {
          if (e[k] < 0.004) continue
          ctx.save()
          ctx.translate(0, tops[k])
          ctx.scale(1, e[k])
          ctx.translate(0, -(T + k * ph))
          ctx.beginPath()
          const extraTop = k === 0 ? 140 : 0
          const extraBot = k === 2 ? 90 : 0
          ctx.rect(-w / 2 - 80, T + k * ph - extraTop, w + 160, ph + extraTop + extraBot)
          ctx.clip()
          nbContent(ctx, w, h, id, t, oo, st)
          if (e[k] < 1) fillPoly(ctx, K.rectPts(-w / 2 - 4, T + k * ph, w + 8, ph), `rgba(70,45,20,${0.32 * (1 - e[k])})`)
          ctx.restore()
        }
      }
      // fold creases stay visible
      // fold creases stay visible; while the next panel is still tucked, the crease IS the page's
      // bottom edge, so it gets the full pencil outline weight
      for (let k = 1; k < 3; k++) {
        const tucked = e[k] < 0.02
        if (tucked && e[k - 1] < 0.02) continue
        inkLine(ctx, [[-w / 2 + 2, tops[k]], [w / 2 - 2, tops[k]]], id + 'cr' + k, t, { w: tucked ? 2.6 : 1.4, alpha: tucked ? 0.72 : lerp(0.5, 0.18, e[k]), passes: tucked ? 2 : 1, jit: 1.6 })
      }
      // pencil prop at the writing tip
      let pen = null
      if (st.pen && o.pencil !== false) {
        pencilProp(ctx, st.pen[0], st.pen[1], t, id + 'pen')
        pen = map(st.pen[0], st.pen[1])
      }
      // anchor mapping for points in the (possibly still folded) page
      const mapPage = (px, py) => {
        const k = Math.max(0, Math.min(2, Math.floor((py - T) / ph)))
        return map(px, tops[k] + (py - (T + k * ph)) * e[k])
      }
      return {
        top: map(0, T),
        bottom: map(0, T + total),
        corners: { tl: map(-w / 2, T), tr: map(w / 2, T), bl: map(-w / 2, T + total), br: map(w / 2, T + total) },
        tabs: (st.tabs || []).map((p) => map(p[0], p[1])),
        stamp: mapPage(st.stamp[0], st.stamp[1]),
        pen,
        strikeLine: st.strikeLine.map((p) => mapPage(p[0], p[1])),
      }
    })
  }

  // paper airplane
  const AP = { hw: 130, hh: 170 }
  const AP_FRONT = C.paperWhite
  const AP_BACK = '#eee2cb'
  const AP_KEEL = '#dccdb0'
  const AP_FAR = '#e4d7bd'
  const AP_CODE = [[0, 0.62], [1, 0.5], [2, 0.56], [1, 0.4], [0, 0.46], [1, 0.54]]
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
  /** What is printed on the plane's page, in page coords (-hw..hw, -hh..hh). face 'front' | 'back'. */
  function apContent(ctx, face, id, t, pg) {
    const { hw, hh } = AP
    ctx.save()
    ctx.strokeStyle = 'rgba(110,160,195,0.42)'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let yy = -hh + 40; yy < hh; yy += 34) {
      ctx.moveTo(-hw - 20, yy)
      ctx.lineTo(hw + 20, yy)
    }
    ctx.stroke()
    // punched holes go through both faces
    ctx.fillStyle = 'rgba(92,64,36,0.26)'
    for (const f of [0.2, 0.5, 0.8]) {
      ctx.beginPath()
      ctx.arc(-hw + 15, -hh + 2 * hh * f, 6, 0, TAU)
      ctx.fill()
    }
    if (face === 'front' && pg.margin) {
      ctx.strokeStyle = 'rgba(184,92,52,0.55)'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(-hw + 36, -hh)
      ctx.lineTo(-hw + 36, hh)
      ctx.stroke()
    }
    ctx.restore()
    if (face !== 'front') return
    if (pg.code) {
      AP_CODE.forEach((ln, k) => {
        const yy = -hh + 40 + 34 * (k + 2) - 11
        const x0 = -hw + 50 + ln[0] * 16
        codeLine(ctx, x0, yy, (hw - 12 - x0) * ln[1] * 1.6, id + 'apc' + k, t, { w: 5 })
      })
    }
    if (pg.m) mSticker(ctx, hw - 40, hh - 44, 17, id + 'apm', t)
  }
  P.paperAirplane = function paperAirplane(ctx, x, y, t, o = {}) {
    // bank: the plane always flies upright — whichever way the nose points (o.rot, or o.rot + π
    // when flipped), heading left draws it mirrored instead of upside down
    let rotIn = def(o.rot, 0)
    let flip = !!o.flip
    if (o.bank !== false) {
      const H = flip ? rotIn + Math.PI : rotIn
      flip = Math.cos(H) < 0
      rotIn = flip ? H - Math.PI : H
    }
    return stage(ctx, x, y, t, Object.assign({}, o, { rot: rotIn }), 'plane', (ctx, map, id) => {
      const fold = clamp01(def(o.fold, 1))
      const { hw, hh } = AP
      const pg = Object.assign({ margin: true, code: true, m: true }, o.page === false ? { margin: false, code: false, m: false } : o.page || {})
      const fa = E.inOutCubic(seg(fold, 0, 0.3))
      const fb = E.inOutCubic(seg(fold, 0.3, 0.6))
      // polys: { pts, color, face: 'front'|'back'|null, M: page→here affine, key, crease, wing }
      const polys = []
      let squashL = 1 // stage C anticipation squash along the wedge's long axis
      let ticks = null
      let keel = null
      if (fold < 0.6) {
        // ── stage A/B: two halves; the top corners fold in, then the left half folds over
        const A = [0, -hh]
        const B = [-hw, -hh + hw]
        const c0 = [-hw, -hh]
        const mir = [0, -hh + hw] // c0 reflected across the crease A–B
        // the flap swings up out of the page: straight-line travel + a lift toward the viewer, and
        // its apex never gets thinner than 8 px from the crease (no "cut-off corner" frame)
        const up = [-0.25, -1]
        let v = [lerp(c0[0], mir[0], fa) + up[0] * Math.sin(Math.PI * fa) * 44, lerp(c0[1], mir[1], fa) + up[1] * Math.sin(Math.PI * fa) * 44]
        const cn = [-Math.SQRT1_2, -Math.SQRT1_2] // crease normal toward c0
        const sd = (v[0] - A[0]) * cn[0] + (v[1] - A[1]) * cn[1]
        if (fa > 0 && Math.abs(sd) < 8) {
          const want = (fa < 0.5 ? 8 : -8) - sd
          v = [v[0] + cn[0] * want, v[1] + cn[1] * want]
        }
        const flapFace = fa < 0.5 ? 'front' : 'back'
        const k = Math.cos(Math.PI * fb)
        const mxp = (pts, sx) => pts.map((p) => [p[0] * sx, p[1]])
        const baseL = [A, B, [-hw, hh], [0, hh]]
        const flat = fold <= 0.004
        const fM = triAffine([A, B, c0], [A, B, v])
        const R = { base: flat ? K.boxPts(hw * 2, hh * 2) : mxp(baseL, -1), flap: mxp([A, B, v], -1), M: [1, 0, 0, 1, 0, 0], fM: [fM[0], -fM[1], -fM[2], fM[3], -fM[4], fM[5]] }
        // right half = mirror of the left: conjugate the flap affine by x → -x
        const pushHalf = (pts, flap, baseM, flapM, baseFace, key) => {
          polys.push({ pts, color: baseFace === 'front' ? AP_FRONT : AP_BACK, face: baseFace, M: baseM, key: key + 'b' })
          if (flap && fa > 0.004) polys.push({ pts: flap, color: flapFace === 'front' ? AP_FRONT : AP_BACK, face: flapFace, M: flapM, key: key + 'f', crease: fa > 0.02 && fa < 0.98 })
        }
        const mul = (m1, m2) => [m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1], m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3], m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]]
        const S = [k, 0, 0, 1, 0, 0]
        if (flat) {
          polys.push({ pts: R.base, color: AP_FRONT, face: 'front', M: [1, 0, 0, 1, 0, 0], key: 'flat' })
        } else if (k >= 0) {
          pushHalf(mxp(baseL, k), mxp([A, B, v], k), S, mul(S, fM), 'front', 'L')
          pushHalf(R.base, R.flap, R.M, R.fM, 'front', 'R')
        } else {
          // the left half flips over onto the right: its corner flap ends up hidden inside the fold
          pushHalf(R.base, R.flap, R.M, R.fM, 'front', 'R')
          polys.push({ pts: mxp(baseL, k), color: AP_BACK, face: 'back', M: S, key: 'Lb' })
        }
      } else {
        // ── stage C1 (0.6–0.72): anticipation squash, then the wedge snaps nose-right (outBack);
        //    stage C2 (0.72–1): the wings open (outCubic)
        const k0 = seg(fold, 0.6, 0.63)
        const k1 = seg(fold, 0.63, 0.72)
        const ang = fold < 0.63 ? -0.1 * E.outQuad(k0) : lerp(-0.1, Math.PI / 2, E.outBack(k1))
        squashL = fold < 0.63 ? lerp(1, 0.86, E.outQuad(k0)) : fold < 0.72 ? lerp(0.86, 1, k1) + 0.2 * Math.sin(Math.PI * k1) : 1
        const wgt = E.outCubic(seg(fold, 0.72, 1))
        const rot = (p) => {
          const px = p[0]
          const py = p[1] * squashL
          return [px * Math.cos(ang) - py * Math.sin(ang), px * Math.sin(ang) + py * Math.cos(ang)]
        }
        // the wedge is the left half's BACK, mirrored onto the right (x_page = -x)
        const wedge = [[0, -hh], [hw, -hh + hw], [hw, hh], [0, hh]].map(rot)
        const keelF = [[210, 0], [-20, 34], [-160, 44], [-160, 6]]
        keel = wedge.map((p, i) => [lerp(p[0], keelF[i][0], wgt), lerp(p[1], keelF[i][1], wgt)])
        const fl = def(o.flutter, 0)
        const fy = Math.sin(t * 14) * 8 * fl
        const fy2 = Math.sin(t * 14 + 1.1) * 6 * fl
        const nose = keel[0]
        const farF = [[-172, -164 + fy2], [-116, -10]]
        const nearF = [[-200, -130 + fy], [-150, 12]]
        const root = [keel[3][0], keel[3][1]]
        const g = (f) => [lerp(root[0], f[0], wgt), lerp(root[1], f[1], wgt)]
        const ca = Math.cos(ang)
        const sa = Math.sin(ang)
        const wedgeM = [-ca, -sa, -sa * squashL, ca * squashL, 0, 0] // page → wedge: mirror x, squash, rotate
        if (wgt > 0.01) polys.push({ pts: [nose, g(farF[0]), g(farF[1])], color: AP_FAR, key: 'far' })
        polys.push({ pts: keel, color: wgt > 0.5 ? AP_KEEL : AP_BACK, face: wgt < 0.5 ? 'back' : null, M: wedgeM, key: 'keel' })
        if (wgt > 0.01) polys.push({ pts: [nose, g(nearF[0]), g(nearF[1])], color: AP_FRONT, key: 'near', wing: wgt > 0.6 })
        if (fold >= 0.63 && fold < 0.74) ticks = { ang, fade: 1 - seg(fold, 0.68, 0.74) }
      }
      // centre on the bbox (so every fold stage stays put)
      let x0 = 1e9
      let x1 = -1e9
      let y0 = 1e9
      let y1 = -1e9
      polys.forEach((pp) => pp.pts.forEach(([px, py]) => {
        x0 = Math.min(x0, px)
        x1 = Math.max(x1, px)
        y0 = Math.min(y0, py)
        y1 = Math.max(y1, py)
      }))
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      let out = {}
      K.at(ctx, 0, 0, 0, [flip ? -1 : 1, 1], () => {
        ctx.translate(-cx, -cy)
        // one shared shadow
        polys.forEach((pp) => K.dropShadow(ctx, pp.pts, 0.55, fold >= 1 ? 14 : 4))
        polys.forEach((pp) => {
          K.paper(ctx, pp.pts, pp.color, { seed: id + pp.key, cut: 0, shadow: 0 })
          if (pp.face) {
            ctx.save()
            K.pathPoly(ctx, pp.pts)
            ctx.clip()
            ctx.transform(pp.M[0], pp.M[1], pp.M[2], pp.M[3], pp.M[4], pp.M[5])
            apContent(ctx, pp.face, id, t, pg)
            ctx.restore()
            if (pp.face === 'back') fillPoly(ctx, pp.pts, 'rgba(120,90,50,0.05)')
          }
          if (pp.wing) {
            ctx.save()
            K.pathPoly(ctx, pp.pts)
            ctx.clip()
            ctx.strokeStyle = 'rgba(110,160,195,0.4)'
            ctx.lineWidth = 2
            ctx.beginPath()
            for (let i = 1; i <= 4; i++) {
              ctx.moveTo(210, 0 + i * 2)
              ctx.lineTo(-200, -130 + i * 30)
            }
            ctx.stroke()
            ctx.restore()
          }
          outline(ctx, pp.pts, id + 'o' + pp.key, t, { alpha: 0.75, w: 2.4 })
          if (pp.crease) inkLine(ctx, [pp.pts[0], pp.pts[1]], id + 'cr' + pp.key, t, { w: 1.6, alpha: 0.4, passes: 1 })
        })
        if (fold >= 0.3 && fold < 0.6) inkLine(ctx, [[0, -hh], [0, hh]], id + 'mid', t, { w: 1.4, alpha: 0.3, passes: 1 })
        // speed ticks while the wedge snaps round (3 short arcs — never radiating)
        if (ticks && ticks.fade > 0) {
          const na = ticks.ang - Math.PI / 2
          ;[[186, 0.6, 0.2], [210, 0.45, 0.16], [184, 0.5, Math.PI + 0.12]].forEach(([rr, span, off], i) => {
            const pl = []
            for (let s = 0; s <= 6; s++) {
              const a = na - off - span * (s / 6)
              pl.push([Math.cos(a) * rr, Math.sin(a) * rr * squashL])
            }
            inkLine(ctx, pl, id + 'tk' + i, t, { w: 3, color: C.inkDim, alpha: 0.7 * ticks.fade, passes: 1 })
          })
        }
        // near wing: M sticker + "Send to chat" stamp
        const sp = def(o.stamp, 0)
        let stampAt = null
        if (fold >= 0.95) {
          stampAt = [-50, -38]
          if (pg.m) K.at(ctx, 80, -16, 0, [flip ? -1 : 1, 1], () => mSticker(ctx, 0, 0, 15, id + 'wm', t, 0.1))
          if (sp > 0) {
            K.at(ctx, stampAt[0], stampAt[1], 0, [flip ? -1 : 1, 1], () => {
              inkStamp(ctx, 0, 0, t, { p: sp, text: 'Send to chat', size: 28, family: 'hand', weight: '', rot: flip ? -0.15 : 0.15, color: C.terracotta, id: id + 'st' })
            })
          }
        }
        out = {
          nose: keel ? map(keel[0][0], keel[0][1]) : map(0, -hh),
          tail: keel ? map((keel[2][0] + keel[3][0]) / 2, (keel[2][1] + keel[3][1]) / 2) : map(0, hh),
          center: map(cx, cy),
          stamp: stampAt ? map(stampAt[0], stampAt[1]) : null,
        }
      })
      return out
    })
  }

  // dotted trail
  function trailCurve(pts) {
    return spline(pts, 12)
  }
  P.trailAt = function trailAt(pts, p) {
    const pl = trailCurve(pts)
    return along(pl, p)
  }
  P.dottedTrail = function dottedTrail(ctx, x, y, t, o = {}) {
    const pts = o.pts || [[-300, 0], [0, -120], [300, 0]]
    return stage(ctx, x, y, t, Object.assign({ nudge: 0 }, o), 'trail', (ctx, map, id) => {
      const pl = trailCurve(pts)
      const cum = cumLen(pl)
      const L = cum[cum.length - 1]
      const p = clamp01(def(o.p, 1))
      const from = clamp01(def(o.from, 0))
      const gap = def(o.gap, 24)
      const dash = def(o.dash, 11)
      const b = K.boil(t)
      ctx.save()
      ctx.lineCap = 'round'
      ctx.strokeStyle = o.color || C.ink
      ctx.fillStyle = o.color || C.ink
      ctx.lineWidth = def(o.w, 4)
      ctx.globalAlpha *= def(o.alpha, 0.8)
      const dot = o.style === 'dot'
      ctx.beginPath()
      for (let d = Math.ceil((from * L) / gap) * gap; d <= p * L; d += gap) {
        const r = K.rng('tr', id, Math.round(d), b)
        const [px, py, a] = along(pl, d / L, cum)
        const jx = (r() - 0.5) * 1.6
        const jy = (r() - 0.5) * 1.6
        if (dot) {
          ctx.moveTo(px + jx + 2.6, py + jy)
          ctx.arc(px + jx, py + jy, 2.6, 0, TAU)
        } else {
          const hl = Math.min(dash, (p * L - d) + 1) / 2
          ctx.moveTo(px + jx - Math.cos(a) * hl, py + jy - Math.sin(a) * hl)
          ctx.lineTo(px + jx + Math.cos(a) * hl, py + jy + Math.sin(a) * hl)
        }
      }
      if (dot) ctx.fill()
      else ctx.stroke()
      ctx.restore()
      const [hx, hy, ha] = along(pl, p, cum)
      const m = map(hx, hy)
      return { x: m[0], y: m[1], angle: ha + def(o.rot, 0), len: L }
    })
  }

  // ───────────────────────── s7: memory ─────────────────────────
  const CORK = '#c99558'
  const WOOD = '#9a6a40'
  const CARD_COLORS = { cream: C.cream, butter: '#f0d38e', sage: '#bcc79e', peach: '#f3c6ad', mint: '#cfe6d6' }
  const STALE_CARD = '#e2d7c2'

  P.thumbtack = function thumbtack(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, Object.assign({ nudge: 0 }, o), 'tack', (ctx, map, id) => {
      const r = def(o.r, 15)
      const press = clamp01(def(o.press, 1))
      const pe = E.outBack(press)
      const s = lerp(1.4, 1, pe)
      const lift = lerp(16, 3, pe)
      const color = o.color || C.tomato
      ctx.save()
      ctx.beginPath()
      ctx.arc(lift * 0.6, lift, r * s, 0, TAU)
      ctx.fillStyle = `rgba(58,36,14,${lerp(0.14, 0.3, pe)})`
      ctx.fill()
      ctx.restore()
      K.at(ctx, 0, 0, 0, s, () => {
        ctx.save()
        ctx.beginPath()
        ctx.arc(0, 0, r, 0, TAU)
        ctx.fillStyle = K.paperPattern(ctx, color)
        ctx.fill()
        ctx.lineWidth = 2.4
        ctx.strokeStyle = 'rgba(42,34,26,0.8)'
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(r * 0.08, r * 0.1, r * 0.6, 0, TAU)
        ctx.fillStyle = 'rgba(40,10,0,0.14)'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(-r * 0.08, -r * 0.06, r * 0.52, 0, TAU)
        ctx.fillStyle = K.paperPattern(ctx, color)
        ctx.fill()
        ctx.beginPath()
        ctx.arc(-r * 0.05, -r * 0.05, r * 0.72, -2.7, -1.6)
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'
        ctx.lineWidth = r * 0.2
        ctx.lineCap = 'round'
        ctx.stroke()
        ctx.restore()
      })
      return { center: map(0, 0) }
    })
  }

  function cardPoly(w, h, id) {
    const r = K.rng('torn', id)
    const pts = []
    const n = Math.max(6, Math.round(w / 9))
    for (let i = 0; i <= n; i++) pts.push([-w / 2 + (w * i) / n, -h / 2 + (i === 0 || i === n ? 0 : (r() - 0.35) * 7)])
    pts.push([w / 2, h / 2], [-w / 2, h / 2])
    return pts
  }
  /** The card's outline: torn top, plus the dog-eared bottom-right corner when stale. */
  function cardFacePoly(w, h, id, stale) {
    const pts = cardPoly(w, h, id)
    return stale ? pts.slice(0, -2).concat([[w / 2, h / 2 - 34], [w / 2 - 34, h / 2], [-w / 2, h / 2]]) : pts
  }
  function cardBase(o) {
    return o.stale ? STALE_CARD : CARD_COLORS[o.color] || o.color || C.cream
  }
  /** Everything printed/written on the card (no paper base). textY: baseline of the first text line. */
  function drawCardFace(ctx, w, h, id, t, o, textY) {
    const stale = !!o.stale
    const pts = cardFacePoly(w, h, id, stale)
    // index-card rules
    ctx.save()
    ctx.strokeStyle = stale ? 'rgba(184,92,52,0.25)' : 'rgba(200,90,80,0.5)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(-w / 2 + 6, -h / 2 + 40)
    ctx.lineTo(w / 2 - 6, -h / 2 + 40)
    ctx.stroke()
    ctx.strokeStyle = stale ? 'rgba(110,160,195,0.18)' : 'rgba(110,160,195,0.35)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let yy = -h / 2 + 76; yy < h / 2 - 8; yy += 34) {
      ctx.moveTo(-w / 2 + 6, yy)
      ctx.lineTo(w / 2 - 6, yy)
    }
    ctx.stroke()
    ctx.restore()
    if (stale) {
      fillPoly(ctx, [[w / 2, h / 2 - 34], [w / 2 - 34, h / 2], [w / 2 - 30, h / 2 - 30]], '#cdbf9f')
      inkLine(ctx, [[w / 2, h / 2 - 34], [w / 2 - 30, h / 2 - 30], [w / 2 - 34, h / 2]], id + 'dog', t, { w: 1.6, alpha: 0.5, passes: 1 })
      // coffee ring
      ctx.save()
      ctx.strokeStyle = 'rgba(120,72,30,0.32)'
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.arc(w * 0.18, h * 0.06, 46, 0.4, TAU - 0.3)
      ctx.stroke()
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(120,72,30,0.22)'
      ctx.beginPath()
      ctx.arc(w * 0.18 + 2, h * 0.06 + 1, 38, 0, TAU)
      ctx.stroke()
      ctx.restore()
    }
    // text
    const size = def(o.textSize, 30)
    const textColor = stale ? C.inkFaint : C.ink
    const ty = def(textY, -h / 2 + 70)
    if (o.text) {
      K.font(ctx, 'hand', size)
      const lines = wrap(ctx, o.text, w - 40).slice(0, 3)
      lines.forEach((ln, i) => K.hand(ctx, ln, -w / 2 + 20, ty + i * 34, { size, color: textColor, align: 'left', t, id: id + 'tx' + i, jitter: 0.5 }))
    } else {
      scribble(ctx, -w / 2 + 22, ty, w * 0.6, id + 'sc1', t, { size: 16, color: textColor })
      scribble(ctx, -w / 2 + 22, ty + 34, w * 0.42, id + 'sc2', t, { size: 16, color: textColor })
    }
    if (stale) fillPoly(ctx, pts, 'rgba(160,140,110,0.12)')
    return pts
  }
  P.memoryCard = function memoryCard(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'mcard', (ctx, map, id) => {
      const w = def(o.w, 260)
      const h = def(o.h, 180)
      const T = -h / 2
      const part = o.part || 'both'
      const lift = clamp01(def(o.lift, 0))
      // Hinge at the top edge; the flap swings up toward the viewer. Clamped at 0.33π so the face
      // never foreshortens below ~50% — the text stays legible and clear of the pin.
      const MAXA = Math.PI * 0.33
      const ang = E.outQuad(lift) * MAXA
      const c = Math.cos(ang)
      const near = Math.sin(ang) / Math.sin(MAXA) // 0..1: how far the free edge has come toward the camera
      const widen = 0.14 * near // keystone: the free (bottom) edge is nearer → wider than the hinge
      const ks = (px, py) => [px * (1 + (widen * (py - T)) / h), T + (py - T) * c]
      const lipH = 18 * near
      const botY = T + h * c
      const pinY = T + 10
      const lift0 = o.stale ? 6 : 0
      const gx = (w / 2) * 0.62 * (1 + widen)
      const out = {
        pin: map(0, pinY),
        center: map(0, T + (h / 2) * c),
        bottom: map(0, botY),
        grip: [map(-gx, botY + lipH * 0.6), map(gx, botY + lipH * 0.6)],
        under: map(0, 12),
      }
      // ── 'under': the spot on the board beneath the flap
      if (part !== 'flap' && lift > 0) {
        const k = Math.min(1, lift * 3)
        // the flap's shade: darkest at the hinge, fading out toward the free edge (no hard grey box)
        const gr = ctx.createLinearGradient(0, T, 0, h / 2)
        gr.addColorStop(0, `rgba(50,28,8,${0.42 * k})`)
        gr.addColorStop(0.5, `rgba(50,28,8,${0.16 * k})`)
        gr.addColorStop(1, 'rgba(50,28,8,0)')
        fillPoly(ctx, cardPoly(w - 10, h - 4, id), gr)
        if (o.under) K.hand(ctx, o.under, 0, 12, { size: 30, color: C.ink, t, id: id + 'un', jitter: 0.5 })
      }
      if (part === 'under') return out
      // ── 'flap': the card itself
      const facePts = cardFacePoly(w, h, id, o.stale)
      const kPoly = lift > 0 ? K.resample(facePts, 24).map((p) => ks(p[0], p[1])) : facePts
      K.dropShadow(ctx, kPoly, 1, lift0 + near * 34)
      if (lipH > 0.5) {
        // underside curl: a band of the card's darker back showing below the free edge
        const bl = ks(-w / 2, h / 2)
        const br = ks(w / 2, h / 2)
        const lip = [[bl[0] + 2, bl[1] - 3], [br[0] - 2, br[1] - 3], [br[0] + 3 * near, br[1] + lipH], [bl[0] - 3 * near, bl[1] + lipH]]
        const back = mix(cardBase(o), '#8a6a40', 0.22)
        const ls = K.paper(ctx, lip, back, { seed: id + 'lip', cut: 0.6, shadow: 0 })
        fillPoly(ctx, [[bl[0], bl[1] + lipH * 0.55], [br[0], br[1] + lipH * 0.55], [br[0] + 3 * near, br[1] + lipH], [bl[0] - 3 * near, bl[1] + lipH]], 'rgba(60,35,10,0.14)')
        outline(ctx, ls, id + 'lipo', t, { w: 2.2, alpha: 0.6 })
      }
      const shape = K.paper(ctx, kPoly, cardBase(o), { seed: id + 'cd', cut: 0.8, shadow: 0 })
      const textY = T + 70 + 8 * Math.min(1, lift * 4)
      if (lift > 0) {
        ctx.save()
        K.pathPoly(ctx, shape)
        ctx.clip()
        K.at(ctx, 0, T, 0, [1 + widen * 0.5, c], () => {
          ctx.translate(0, h / 2)
          drawCardFace(ctx, w, h, id, t, o, textY)
        })
        // lifted toward the light: a touch brighter
        fillPoly(ctx, shape, `rgba(255,250,240,${0.2 * near})`)
        ctx.restore()
      } else drawCardFace(ctx, w, h, id, t, o, textY)
      outline(ctx, shape, id + 'co', t, { alpha: o.stale ? 0.55 : 0.72 })
      if (o.staleStamp > 0) {
        K.at(ctx, 0, T, 0, [1, c], () => inkStamp(ctx, 8, h / 2 + 18, t, { p: o.staleStamp, text: 'STALE', size: 44, rot: -0.18, color: C.terracotta, id: id + 'stale' }))
      }
      const pop = clamp01(def(o.pinPop, 0))
      if (o.pin !== false && pop < 1) {
        const ps = 1 - inBack(pop)
        const hop = -16 * Math.sin(Math.PI * pop)
        K.at(ctx, 0, pinY + hop, 0, ps, () => P.thumbtack(ctx, 0, 0, t, { id: id + 'pin', color: o.pinColor || C.tomato, r: def(o.pinR, 12), press: def(o.pinPress, 1) }))
      }
      return out
    })
  }
  P.corkboard = function corkboard(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'cork', (ctx, map, id) => {
      const w = def(o.w, 1200)
      const h = def(o.h, 720)
      const fw = 42
      const title = def(o.title, 'Memory')
      const tab = def(o.tab, 'Workspace')
      // "Workspace" folder tab sticks up behind the frame
      if (tab) {
        K.font(ctx, 'hand', 32)
        const tw = ctx.measureText(tab).width + 56
        const tx = -w / 2 + 70 + tw / 2
        K.paper(ctx, [[tx - tw / 2, -h / 2 + 10], [tx - tw / 2 + 14, -h / 2 - 50], [tx + tw / 2 - 14, -h / 2 - 50], [tx + tw / 2, -h / 2 + 10]], C.sage, { seed: id + 'tab', cut: 1.2, shadow: 0.8 })
        K.hand(ctx, tab, tx, -h / 2 - 16, { size: 32, color: C.paperWhite, t, id: id + 'tabt', jitter: 0.4 })
      }
      // frame
      woodFrame(ctx, w - fw * 2, h - fw * 2, fw, WOOD, id, t)
      // cork
      const iw = w - fw * 2
      const ih = h - fw * 2
      K.paper(ctx, K.boxPts(iw, ih), CORK, { seed: id + 'ck', cut: 0, shadow: 0 })
      ctx.save()
      const r = K.rng('cork', id)
      const n = Math.round((iw * ih) / 1500)
      for (let i = 0; i < n; i++) {
        const dark = r() < 0.62
        ctx.fillStyle = dark ? 'rgba(90,50,20,0.42)' : 'rgba(255,235,200,0.42)'
        const s = 1.5 + r() * 3
        ctx.fillRect(-iw / 2 + r() * (iw - 4), -ih / 2 + r() * (ih - 4), s, s * (0.6 + r() * 0.6))
      }
      // inner shade along the top/left (frame casts onto the cork)
      fillPoly(ctx, [[-iw / 2, -ih / 2], [iw / 2, -ih / 2], [iw / 2, -ih / 2 + 14], [-iw / 2 + 14, -ih / 2 + 14], [-iw / 2 + 14, ih / 2], [-iw / 2, ih / 2]], 'rgba(50,25,5,0.2)')
      ctx.restore()
      // header strip pinned on top
      const ti = def(o.titleIn, 1)
      let titleAt = map(0, -h / 2 + 6)
      if (title && ti > 0) {
        const sc = E.outBack(clamp01(ti))
        K.at(ctx, 0, -h / 2 + 8, -0.02, sc, () => {
          K.font(ctx, 'chunky', 66, '600')
          const tw = ctx.measureText(title).width + 110
          K.paper(ctx, K.boxPts(tw, 96), C.butter, { seed: id + 'hd', torn: 3, shadow: 1, lift: 4 })
          K.hand(ctx, title, 0, 24, { family: 'chunky', weight: '600', size: 66, color: C.ink, t, id: id + 'ttl', jitter: 0.4 })
          P.thumbtack(ctx, -tw / 2 + 26, -22, t, { id: id + 'hp1', color: C.hiveTeal, r: 12 })
          P.thumbtack(ctx, tw / 2 - 26, -22, t, { id: id + 'hp2', color: C.hiveTeal, r: 12 })
        })
      }
      const slots = []
      for (const sy of [-0.1, 0.27]) for (const sx of [-0.3, 0, 0.3]) slots.push(map(sx * w, sy * h))
      return {
        slots,
        title: titleAt,
        tab: map(-w / 2 + 140, -h / 2 - 20),
        corners: { tl: map(-w / 2, -h / 2), tr: map(w / 2, -h / 2), bl: map(-w / 2, h / 2), br: map(w / 2, h / 2) },
      }
    })
  }

  /** Red plied yarn along a polyline (shadow, body, ply twist, highlight). */
  function drawYarn(ctx, part, col, w) {
    if (!part || part.length < 2) return
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    part.forEach((q, i) => (i ? ctx.lineTo(q[0] + 2, q[1] + 4) : ctx.moveTo(q[0] + 2, q[1] + 4)))
    ctx.strokeStyle = 'rgba(58,36,14,0.2)'
    ctx.lineWidth = w + 1
    ctx.stroke()
    ctx.beginPath()
    part.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])))
    ctx.strokeStyle = col
    ctx.lineWidth = w
    ctx.stroke()
    // ply twist
    ctx.setLineDash([3, 6])
    ctx.strokeStyle = 'rgba(90,10,10,0.55)'
    ctx.lineWidth = w * 0.55
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha *= 0.35
    ctx.beginPath()
    part.forEach((q, i) => (i ? ctx.lineTo(q[0] - 0.8, q[1] - 1.4) : ctx.moveTo(q[0] - 0.8, q[1] - 1.4)))
    ctx.strokeStyle = '#ffb3a0'
    ctx.lineWidth = 1.3
    ctx.stroke()
    ctx.restore()
  }
  const YARN_RED = '#c7352f'
  P.yarn = function yarn(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, Object.assign({ nudge: 0 }, o), 'yarn', (ctx, map, id) => {
      const a = o.from || [0, 0]
      const b = o.to || [240, 0]
      const sag = def(o.sag, 16)
      const tw = clamp01(def(o.twang, 0))
      const p = clamp01(def(o.p, 1))
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const d = Math.hypot(dx, dy) || 1
      const nx = -dy / d
      const ny = dx / d
      const amp = tw > 0 && tw < 1 ? 22 * Math.pow(1 - tw, 1.6) * Math.sin(tw * Math.PI * 10) : 0
      const N = 26
      const pl = []
      for (let i = 0; i <= N; i++) {
        const s = i / N
        const bell = Math.sin(Math.PI * s)
        pl.push([a[0] + dx * s + nx * amp * bell, a[1] + dy * s + sag * bell + ny * amp * bell])
      }
      const part = cut(pl, 0, p)
      if (part.length < 2) return { mid: map(pl[N / 2][0], pl[N / 2][1]), end: map(a[0], a[1]) }
      drawYarn(ctx, part, o.color || YARN_RED, def(o.w, 5))
      const end = part[part.length - 1]
      return { mid: map(pl[N / 2][0], pl[N / 2][1]), end: map(end[0], end[1]) }
    })
  }

  /** Little yarn bow: two loops, a knot and two tails, popping in with overshoot (k 0..1). */
  function yarnBow(ctx, x, y, k, id, t) {
    if (k <= 0) return
    K.at(ctx, x, y, -0.08, E.outBack(k), () => {
      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const loops = (ox, oy) => {
        ctx.beginPath()
        ctx.ellipse(ox - 17, oy - 9, 17, 10, -0.45, 0, TAU)
        ctx.moveTo(ox + 34, oy - 11)
        ctx.ellipse(ox + 17, oy - 11, 17, 10, 0.45, 0, TAU)
        ctx.moveTo(ox, oy)
        ctx.quadraticCurveTo(ox - 10, oy + 14, ox - 15, oy + 27)
        ctx.moveTo(ox, oy)
        ctx.quadraticCurveTo(ox + 9, oy + 14, ox + 13, oy + 29)
      }
      loops(2, 4)
      ctx.strokeStyle = 'rgba(58,36,14,0.2)'
      ctx.lineWidth = 6
      ctx.stroke()
      loops(0, 0)
      ctx.strokeStyle = YARN_RED
      ctx.lineWidth = 5
      ctx.stroke()
      ctx.setLineDash([3, 6])
      ctx.strokeStyle = 'rgba(90,10,10,0.5)'
      ctx.lineWidth = 2.6
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(0, -1, 5.5, 0, TAU)
      ctx.fillStyle = '#a82a25'
      ctx.fill()
      ctx.restore()
    })
  }
  P.clipBundle = function clipBundle(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'bundle', (ctx, map, id) => {
      const cards = o.cards || [{ text: 'tests: npm test', color: 'cream' }, { text: 'likes small commits', color: 'butter' }, { color: 'sage' }]
      const gather = clamp01(def(o.gather, 1))
      // timeline: 0–0.3 the yarn twangs in place (cards tug outward a hair — anticipation), pins pop
      // 0.18–0.3, the yarn is gone by 0.44; 0.3–0.82 the cards slide together (slow-in, overshoot,
      // settle); 0.62–0.86 two strands wrap the stack; 0.84–0.96 the bow pops
      const tug = 0.04 * Math.sin(Math.PI * seg(gather, 0, 0.3))
      const mp = seg(gather, 0.3, 0.82)
      const ge = E.inOutCubic(mp) + 0.07 * Math.sin(Math.PI * seg(mp, 0.72, 1))
      const spread = o.spread || [[-300, -50], [0, 30], [300, -40]]
      const stack = [[-16, 10], [0, 0], [14, -8]]
      const rs = [[-0.05, -0.1], [0.04, 0.06], [0.07, -0.03]]
      const CS = 0.92
      const pos = stack.map((s, i) => [lerp(spread[i][0] * (1 + tug), s[0], ge), lerp(spread[i][1], s[1], ge), lerp(rs[i][0], rs[i][1], ge)])
      // pins hold while the cards are spread, then pop off (anticipation grow → gone, with a hop)
      const pinPop = seg(gather, 0.18, 0.3)
      // one fixed draw order: the cards are apart at gather 0, so it only matters once they stack
      ;[0, 2, 1].forEach((i) => {
        if (!cards[i]) return
        P.memoryCard(ctx, pos[i][0], pos[i][1], t, { id: id + 'c' + i, text: cards[i].text, color: cards[i].color || 'cream', rot: pos[i][2], pin: pinPop < 1, pinPop, nudge: 0.4, scale: CS })
      })
      // spread: red yarn pin-to-pin, twanging as the cards pull in; fully gone by gather 0.45
      if (gather < 0.44) {
        const tw = seg(gather, 0.02, 0.36)
        K.withAlpha(ctx, 1 - seg(gather, 0.3, 0.44), () => {
          const po = (90 - 10) * CS
          const pin = (q) => [q[0] + Math.sin(q[2]) * po, q[1] - Math.cos(q[2]) * po]
          P.yarn(ctx, 0, 0, t, { id: id + 'y1', from: pin(pos[0]), to: pin(pos[1]), sag: lerp(18, 2, tw), twang: tw })
          P.yarn(ctx, 0, 0, t, { id: id + 'y2', from: pin(pos[1]), to: pin(pos[2]), sag: lerp(18, 2, tw), twang: tw })
        })
      }
      // gathered: two strands cross over the front of the stack and tuck behind its edges, tied in a bow
      const wrapP = seg(gather, 0.62, 0.86)
      const L = -142
      const R = 139
      const B = [-44, 44]
      if (wrapP > 0) {
        const strands = [
          [[L, 30], [-100, 36], B, [40, 52], [R, 60]],
          [[L, 62], [-100, 55], B, [40, 40], [R, 34]],
        ]
        strands.forEach((st, k) => {
          const pp = clamp01(wrapP * 1.25 - k * 0.25)
          if (pp <= 0) return
          const pl = spline(st, 6)
          // tucks: the yarn disappears round each edge (darker, behind)
          K.withAlpha(ctx, 0.5, () => {
            inkLine(ctx, [[st[0][0] + 1, st[0][1]], [st[0][0] - 3, st[0][1] + 10]], id + 'tkL' + k, t, { w: 4.5, color: '#7a1f1b', alpha: 1, passes: 1, jit: 0.4 })
            if (pp >= 1) inkLine(ctx, [[st[4][0] - 1, st[4][1]], [st[4][0] + 3, st[4][1] + 10]], id + 'tkR' + k, t, { w: 4.5, color: '#7a1f1b', alpha: 1, passes: 1, jit: 0.4 })
          })
          drawYarn(ctx, cut(pl, 0, pp), YARN_RED, 5)
        })
        yarnBow(ctx, B[0], B[1] - 2, seg(gather, 0.84, 0.96), id + 'bow', t)
      }
      // paperclip: small, clipped over the top edge, above the front card's red header rule
      const clip = clamp01(def(o.clip, 1))
      const clipAt = [92, -112]
      const CLS = 0.72
      if (clip > 0) {
        const cy = lerp(-90, 0, E.outBack(clip))
        K.withAlpha(ctx, Math.min(1, clip * 4), () => {
          K.at(ctx, clipAt[0], clipAt[1] + cy, 0.06, CLS, () => {
            const path = () => {
              ctx.beginPath()
              ctx.moveTo(10, 60)
              ctx.lineTo(10, -30)
              ctx.arc(-4, -30, 14, 0, Math.PI, true)
              ctx.lineTo(-18, 70)
              ctx.arc(-2, 70, 16, Math.PI, 0, true)
              ctx.lineTo(14, -44)
              ctx.arc(-4, -44, 18, 0, Math.PI, true)
              ctx.lineTo(-22, 34)
            }
            ctx.save()
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            ctx.translate(3, 5)
            path()
            ctx.strokeStyle = 'rgba(58,36,14,0.22)'
            ctx.lineWidth = 8
            ctx.stroke()
            ctx.translate(-3, -5)
            path()
            ctx.strokeStyle = 'rgba(30,50,45,0.8)'
            ctx.lineWidth = 9.5
            ctx.stroke()
            path()
            ctx.strokeStyle = C.hiveTeal
            ctx.lineWidth = 7
            ctx.stroke()
            path()
            ctx.strokeStyle = 'rgba(255,255,255,0.5)'
            ctx.lineWidth = 2.2
            ctx.stroke()
            ctx.restore()
          })
        })
      }
      // kraft tag on baker's twine, tied to the clip's lower loop
      const ti = clamp01(def(o.tagIn, 1))
      const tagText = def(o.tag, 'Clusters')
      const hook = [clipAt[0] - 1, clipAt[1] + 84 * CLS]
      let tagAt = map(hook[0] + 60, hook[1] + 80)
      if (ti > 0 && tagText) {
        const swing = lerp(-1.3, 0, E.outElastic(ti)) + Math.sin(t * 2.3) * 0.03
        K.at(ctx, hook[0], hook[1], swing, 1, () => {
          twine(ctx, [[0, 0], [30, 40], [52, 62]], { w: 3 })
          K.at(ctx, 52 + 78, 76, 0.12, 1, () => {
            K.font(ctx, 'marker', 38)
            const tw = ctx.measureText(tagText).width + 70
            const th = 66
            const shape = [[-tw / 2 + 20, -th / 2], [tw / 2, -th / 2], [tw / 2, th / 2], [-tw / 2 + 20, th / 2], [-tw / 2, th / 2 - 20], [-tw / 2, -th / 2 + 20]]
            const ts = K.paper(ctx, shape, C.kraft, { seed: id + 'tg', cut: 1, shadow: 1, lift: 6 })
            outline(ctx, ts, id + 'tgo', t)
            ctx.beginPath()
            ctx.arc(-tw / 2 + 20, 0, 7, 0, TAU)
            ctx.fillStyle = 'rgba(42,34,26,0.55)'
            ctx.fill()
            K.hand(ctx, tagText, 14, 13, { family: 'marker', size: 38, color: C.ink, t, id: id + 'tgt', jitter: 0.4 })
          })
          tagAt = map(130, 76)
        })
      }
      return { tag: tagAt, clip: map(clipAt[0], clipAt[1]), center: map(0, 0), cards: pos.map((q) => map(q[0], q[1])) }
    })
  }
  P.crumple = function crumple(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'crumple', (ctx, map, id) => {
      const p = clamp01(def(o.p, 1))
      const e = E.inOutCubic(p)
      const w = def(o.w, 260)
      const h = def(o.h, 180)
      const R = def(o.r, 58)
      const stale = o.stale !== false
      const color = o.color || (stale ? STALE_CARD : C.cream)
      // same outline + face as memoryCard with the same id, so a card swaps to crumple(p 0) seamlessly
      const base = K.resample(cardFacePoly(w, h, id, stale), (2 * (w + h)) / 56)
      const rr = K.rng('ball', id)
      const radii = base.map(() => R * (0.84 + rr() * 0.3))
      const smooth = radii.map((r0, i) => (radii[(i + radii.length - 1) % radii.length] + r0 * 2 + radii[(i + 1) % radii.length]) / 4)
      const stepK = Math.floor(p * 7) // stop-motion crumple steps
      const mid = Math.sin(Math.PI * p)
      // the card's own radial profile melts (progressively smoothed) as it balls up, so its corners
      // round off instead of poking out as spikes; the ball's lumps come from `smooth`
      let rc = base.map(([bx, by]) => Math.hypot(bx, by))
      const nSm = Math.round(12 * Math.min(1, e * 1.8))
      for (let k = 0; k < nSm; k++) {
        const n0 = rc.length
        rc = rc.map((r0, i) => (rc[(i + n0 - 1) % n0] + 2 * r0 + rc[(i + 1) % n0]) / 4)
      }
      const raw = base.map(([bx, by], i) => {
        const a = Math.atan2(by, bx)
        // lumpy, low-frequency, neighbour-correlated squish
        const j = mid * 12 * K.noise1(i * 0.2, 'cr', id, stepK)
        const r1 = lerp(rc[i], smooth[i], e) + j
        return [Math.cos(a) * r1, Math.sin(a) * r1]
      })
      // never spiky: every point sits on its own ray from the centre, so clamp each radius to within
      // ±18% of its neighbours' mean (two passes) — the in-between shapes stay round-ish lumps
      let rad = raw.map((q) => Math.hypot(q[0], q[1]))
      for (let pass = 0; pass < 2; pass++) {
        const n0 = rad.length
        rad = rad.map((r0, i) => {
          const m = (rad[(i + n0 - 1) % n0] + rad[(i + 1) % n0]) / 2
          return K.clamp(r0, m * 0.82, m * 1.18)
        })
      }
      const pts = raw.map((q, i) => {
        const d = Math.hypot(q[0], q[1]) || 1
        return [(q[0] / d) * rad[i], (q[1] / d) * rad[i]]
      })
      K.paper(ctx, pts, color, { seed: id + 'b', cut: 0, shadow: 1, lift: 4 * e })
      ctx.save()
      K.pathPoly(ctx, pts)
      ctx.clip()
      // leftover writing squashes away
      if (p < 0.7) {
        K.withAlpha(ctx, 1 - seg(p, 0.2, 0.7), () => {
          K.at(ctx, 0, 0, 0, [1 - e * 0.7, 1 - e * 0.7], () => drawCardFace(ctx, w, h, id, t, { stale, text: o.text, textSize: o.textSize }, -h / 2 + 70))
        })
      }
      // facets + creases grow in with p
      const fr = K.rng('facet', id)
      const n = pts.length
      for (let i = 0; i < 7; i++) {
        const a = pts[Math.floor(fr() * n)]
        const b = pts[Math.floor(fr() * n)]
        const cx = (fr() - 0.5) * R * 0.8 * e
        const cy = (fr() - 0.5) * R * 0.8 * e
        fillPoly(ctx, [a, b, [cx, cy]], fr() < 0.5 ? `rgba(80,55,25,${0.1 * e})` : `rgba(255,250,240,${0.22 * e})`)
      }
      ctx.strokeStyle = `rgba(60,40,20,${0.45 * e})`
      ctx.lineWidth = 1.6
      ctx.lineCap = 'round'
      for (let i = 0; i < 8; i++) {
        const a = pts[Math.floor(fr() * n)]
        const cx = (fr() - 0.5) * R * 0.9
        const cy = (fr() - 0.5) * R * 0.9
        ctx.beginPath()
        ctx.moveTo(a[0], a[1])
        ctx.lineTo(lerp(a[0], cx, 0.5) + (fr() - 0.5) * 10, lerp(a[1], cy, 0.5) + (fr() - 0.5) * 10)
        ctx.lineTo(cx, cy)
        ctx.stroke()
      }
      fillPoly(ctx, pts, `rgba(90,60,30,${0.08 * e})`)
      ctx.restore()
      outline(ctx, pts, id + 'ol', t, { alpha: 0.55 + 0.25 * e, step: 16 })
      return { center: map(0, 0), r: R }
    })
  }

  const WICKER_A = '#c99c62'
  const WICKER_B = '#b1834d'
  const WICKER_RIM = '#9d6f3e'
  P.basket = function basket(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'basket', (ctx, map, id) => {
      const part = o.part || 'both'
      const W = 300
      const Wb = 222
      const Hh = 200
      const rimY = -Hh / 2
      const bo = clamp01(def(o.bounce, 0))
      const sq = bo > 0 && bo < 1 ? 0.09 * Math.sin(bo * Math.PI * 3) * (1 - bo) : 0
      let out = {}
      K.at(ctx, 0, Hh / 2, 0, [1 + sq * 0.6, 1 - sq], () => {
        ctx.translate(0, -Hh / 2)
        const back = () => {
          // ground shadow
          fillPoly(ctx, K.ellipsePts(8, Hh / 2 + 6, W * 0.46, 16, 28), 'rgba(58,36,14,0.2)')
          // dark interior + back rim
          fillPoly(ctx, K.ellipsePts(0, rimY, W / 2, 34, 36), '#5a3a1c')
          ctx.save()
          ctx.beginPath()
          ctx.ellipse(0, rimY, W / 2 - 4, 32, 0, Math.PI, TAU)
          ctx.strokeStyle = WICKER_RIM
          ctx.lineWidth = 12
          ctx.stroke()
          ctx.restore()
          const nb = Math.round(def(o.contents, 0))
          for (let i = 0; i < nb; i++) {
            P.crumple(ctx, -70 + i * 62, rimY - 6 - (i % 2) * 12, t, { id: id + 'ball' + i, p: 1, scale: 0.55, rot: i * 1.7, color: i % 2 ? C.cream : STALE_CARD })
          }
        }
        const front = () => {
          const body = [[-W / 2, rimY], [W / 2, rimY], [Wb / 2, Hh / 2], [-Wb / 2, Hh / 2]]
          ctx.save()
          K.dropShadow(ctx, body, 0.8)
          K.pathPoly(ctx, body)
          ctx.clip()
          // gaps between the weave
          ctx.fillStyle = '#5a3a1c'
          ctx.fillRect(-W / 2, rimY - 40, W, Hh + 60)
          const hwAt = (yy) => lerp(W / 2, Wb / 2, (yy - rimY) / Hh)
          // 9 upright stakes (behind the weavers; they show in the gaps)
          const NS = 9
          const us = []
          for (let j = 0; j < NS; j++) us.push(-1 + (2 * j + 1) / NS)
          ctx.save()
          ctx.lineCap = 'butt'
          ctx.strokeStyle = K.paperPattern(ctx, WICKER_RIM)
          ctx.lineWidth = 6
          ctx.beginPath()
          us.forEach((u) => {
            ctx.moveTo(u * hwAt(rimY - 10), rimY - 10)
            ctx.lineTo(u * hwAt(Hh / 2 + 10), Hh / 2 + 10)
          })
          ctx.stroke()
          ctx.restore()
          // horizontal weavers: each row goes over one stake and under the next, alternating per row
          const rowH = 22
          const edges = [-1.25].concat(us, [1.25])
          const overP = new Path2D()
          const underP = new Path2D()
          const hiP = new Path2D()
          const front = []
          let row = 0
          for (let y0 = rimY + 7; y0 < Hh / 2 + 4; y0 += rowH, row++) {
            const y1 = y0 + rowH - 5
            for (let j = 0; j < edges.length - 1; j++) {
              const over = (j + row) % 2 === 0
              const bulge = over ? 2.6 : 1
              const path = over ? overP : underP
              const N = 5
              for (let s = 0; s <= N; s++) {
                const u = lerp(edges[j], edges[j + 1], s / N)
                const yy = y0 - Math.sin((Math.PI * s) / N) * bulge
                if (s === 0) path.moveTo(u * hwAt(y0), yy)
                else path.lineTo(u * hwAt(y0), yy)
              }
              for (let s = N; s >= 0; s--) {
                const u = lerp(edges[j], edges[j + 1], s / N)
                path.lineTo(u * hwAt(y1), y1 + Math.sin((Math.PI * s) / N) * bulge)
              }
              path.closePath()
              if (over) {
                const ua = lerp(edges[j], edges[j + 1], 0.2)
                const ub = lerp(edges[j], edges[j + 1], 0.8)
                hiP.moveTo(ua * hwAt(y0), y0 + 3)
                hiP.quadraticCurveTo(((ua + ub) / 2) * hwAt(y0), y0 - bulge + 2, ub * hwAt(y0), y0 + 3)
              }
            }
            // where this row passes BEHIND a stake, the stake shows in front
            for (let j = 0; j < NS; j++) if ((j + row) % 2 === 1) front.push([us[j], y0 - 3, y1 + 3])
          }
          ctx.fillStyle = K.paperPattern(ctx, WICKER_A)
          ctx.fill(overP)
          ctx.fillStyle = K.paperPattern(ctx, WICKER_B)
          ctx.fill(underP)
          ctx.fillStyle = 'rgba(70,40,10,0.14)'
          ctx.fill(underP)
          ctx.save()
          ctx.strokeStyle = 'rgba(255,238,200,0.4)'
          ctx.lineWidth = 2
          ctx.lineCap = 'round'
          ctx.stroke(hiP)
          ctx.restore()
          ctx.fillStyle = K.paperPattern(ctx, WICKER_RIM)
          const fp = new Path2D()
          front.forEach(([u, ya, yb]) => {
            const xa = u * hwAt(ya)
            const xb = u * hwAt(yb)
            fp.moveTo(xa - 4, ya)
            fp.lineTo(xa + 4, ya)
            fp.lineTo(xb + 4, yb)
            fp.lineTo(xb - 4, yb)
            fp.closePath()
          })
          ctx.fill(fp)
          ctx.strokeStyle = 'rgba(60,30,8,0.35)'
          ctx.lineWidth = 1.2
          ctx.stroke(fp)
          // side shading for roundness
          fillPoly(ctx, [[-W / 2, rimY], [-W / 2 + 50, rimY], [-Wb / 2 + 44, Hh / 2], [-Wb / 2, Hh / 2]], 'rgba(60,30,5,0.18)')
          fillPoly(ctx, [[W / 2 - 40, rimY], [W / 2, rimY], [Wb / 2, Hh / 2], [Wb / 2 - 36, Hh / 2]], 'rgba(60,30,5,0.24)')
          ctx.restore()
          // front rim band (rope twist)
          ctx.save()
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.ellipse(0, rimY, W / 2, 34, 0, 0, Math.PI)
          ctx.strokeStyle = 'rgba(58,36,14,0.25)'
          ctx.lineWidth = 22
          ctx.translate(0, 4)
          ctx.stroke()
          ctx.translate(0, -4)
          ctx.beginPath()
          ctx.ellipse(0, rimY, W / 2, 34, 0, -0.08, Math.PI + 0.08)
          ctx.strokeStyle = K.paperPattern(ctx, WICKER_RIM)
          ctx.lineWidth = 20
          ctx.stroke()
          ctx.setLineDash([4, 9])
          ctx.strokeStyle = 'rgba(60,30,8,0.55)'
          ctx.lineWidth = 16
          ctx.stroke()
          ctx.setLineDash([])
          ctx.restore()
          outline(ctx, [[-W / 2 + 2, rimY + 8], [-Wb / 2, Hh / 2], [Wb / 2, Hh / 2], [W / 2 - 2, rimY + 8]], id + 'ol', t, { closed: false, alpha: 0.7 })
        }
        if (part !== 'front') back()
        if (part !== 'back') front()
        out = { mouth: map(0, rimY), rimL: map(-W / 2, rimY), rimR: map(W / 2, rimY), bottom: map(0, Hh / 2) }
      })
      return out
    })
  }

  // ───────────────────────── s8: showcase ─────────────────────────
  function lightbulb(ctx, x, y, s, id, t) {
    K.at(ctx, x, y, -0.1, s, () => {
      K.paper(ctx, K.ellipsePts(0, -8, 30, 32, 26), C.lemon, { seed: id + 'lb', cut: 1.5, shadow: 0.8 })
      K.paper(ctx, K.rectPts(-14, 20, 28, 20), '#b8bcc0', { seed: id + 'lbb', cut: 0.8, shadow: 0.5 })
      inkLine(ctx, [[-14, 27], [14, 27]], id + 'lbl1', t, { w: 1.8, alpha: 0.5, passes: 1 })
      inkLine(ctx, [[-14, 34], [14, 34]], id + 'lbl2', t, { w: 1.8, alpha: 0.5, passes: 1 })
      inkLine(ctx, [[-7, 16], [-5, 2], [-9, -6], [-4, -13], [4, -13], [9, -6], [5, 2], [7, 16]], id + 'fil', t, { w: 2.4, color: C.honey })
      inkLine(ctx, K.ellipsePts(0, -8, 30, 32, 22), id + 'lbo', t, { w: 2.2, alpha: 0.7, closed: true, passes: 1 })
      // three short glow ticks (≤ 4 — no rays)
      K.sparkle(ctx, 0, -8, 46, id + 'glow', t, { n: 3, color: C.honey, w: 3 })
    })
  }
  function miniFolder(ctx, x, y, s, color) {
    K.at(ctx, x, y, 0, s, () => {
      fillPoly(ctx, [[-16, -8], [-14, -14], [-4, -14], [-1, -9], [16, -9], [16, 11], [-16, 11]], color || MANILA)
      ctx.strokeStyle = 'rgba(42,34,26,0.6)'
      ctx.lineWidth = 1.6
      ctx.stroke()
    })
  }
  function readmeScrap(ctx, id, t) {
    K.paper(ctx, K.boxPts(206, 142), C.paperWhite, { seed: id + 'rm', torn: 3, shadow: 1, lift: 3 })
    K.hand(ctx, 'README', -86, -32, { family: 'chunky', weight: '600', size: 30, align: 'left', color: C.terracotta, t, id: id + 'rmt', jitter: 0.3 })
    codeLine(ctx, -84, 0, 150, id + 'r1', t, { w: 5, color: C.inkDim })
    codeLine(ctx, -84, 22, 120, id + 'r2', t, { w: 5, color: C.inkDim })
    codeLine(ctx, -84, 44, 140, id + 'r3', t, { w: 5, color: C.inkDim })
    K.tape(ctx, 0, -72, 70, -0.05, 'rgba(111,125,82,0.55)', { h: 22, seed: id + 'rmtp' })
  }
  function treeScrap(ctx, id, t) {
    outline(ctx, K.paper(ctx, K.boxPts(186, 168), '#f7e7b8', { seed: id + 'ts', cut: 2.5, shadow: 1, lift: 3 }), id + 'tso', t, { alpha: 0.65 })
    inkLine(ctx, [[-58, -46], [-58, 52]], id + 'tl0', t, { w: 2.2, alpha: 0.7 })
    ;[-14, 18, 50].forEach((yy, i) => inkLine(ctx, [[-58, yy], [-30, yy]], id + 'tl' + (i + 1), t, { w: 2.2, alpha: 0.7 }))
    inkLine(ctx, [[-4, 18], [-4, 50], [18, 50]], id + 'tl5', t, { w: 2, alpha: 0.6 })
    miniFolder(ctx, -58, -56, 1.15, MANILA)
    miniFolder(ctx, -10, -14, 1, '#f2b99a')
    miniFolder(ctx, -10, 18, 1, '#bfe0c8')
    fillPoly(ctx, K.rectPts(24, 40, 18, 22), C.paperWhite)
    inkLine(ctx, K.rectPts(24, 40, 18, 22), id + 'fi', t, { w: 1.6, alpha: 0.6, closed: true, passes: 1 })
    fillPoly(ctx, K.rectPts(-24, 42, 18, 22), C.paperWhite)
    ;[-14, 18].forEach((yy, i) => scribble(ctx, 14, yy + 5, 60, id + 'tsc' + i, t, { size: 10, w: 2, alpha: 0.6 }))
    ctx.beginPath()
    ctx.arc(-24 + 18, 40 + 10, 5, 0, TAU)
    ctx.fillStyle = C.terracotta
    ctx.fill()
  }
  function cmdScrap(ctx, id, t) {
    K.paper(ctx, K.boxPts(430, 70), C.termBlack, { seed: id + 'cm', cut: 2, shadow: 1, lift: 3 })
    K.hand(ctx, '>', -190, 16, { family: 'marker', size: 44, color: C.crayonGreen, t, id: id + 'gt', jitter: 0.6, align: 'left' })
    codeLine(ctx, -150, 2, 230, id + 'cmc', t, { w: 7, color: C.cream, alpha: 0.9 })
    const blink = Math.floor(t * 2) % 2 === 0
    if (blink) fillPoly(ctx, K.rectPts(100, 10, 26, 6), C.crayonGreen)
  }
  function windowScrap(ctx, id, t) {
    outline(ctx, K.paper(ctx, K.boxPts(170, 120), C.kraft, { seed: id + 'wn', cut: 2, shadow: 1, lift: 3 }), id + 'wno', t, { alpha: 0.65 })
    fillPoly(ctx, K.rectPts(-74, -34, 148, 86), C.cream)
    ;[[-66, C.terracotta], [-30, C.butter], [6, C.sage]].forEach(([xx, col]) => fillPoly(ctx, K.roundRectPts(xx, -52, 32, 18, 5, 2), col))
    fillPoly(ctx, K.rectPts(-74, -34, 30, 86), '#ece0c6')
    // a tiny index card friend waving from the window
    K.at(ctx, 26, 12, 0.08, 1, () => {
      fillPoly(ctx, K.roundRectPts(-18, -24, 36, 48, 5, 2), C.butter)
      ;[[-7, -8], [7, -8]].forEach(([ex, ey]) => {
        ctx.beginPath()
        ctx.arc(ex, ey, 4.5, 0, TAU)
        ctx.fillStyle = '#fff'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(ex + 0.8, ey + 0.8, 2.3, 0, TAU)
        ctx.fillStyle = C.ink
        ctx.fill()
      })
      inkLine(ctx, [[-6, 4], [0, 8], [6, 4]], id + 'sm', t, { w: 1.8, passes: 1 })
    })
    inkLine(ctx, K.rectPts(-74, -34, 148, 86), id + 'wo', t, { w: 1.6, alpha: 0.5, closed: true, passes: 1 })
  }
  function glueSquiggle(ctx, x, y, id, t, p) {
    if (p <= 0) return
    const pl = []
    for (let i = 0; i <= 14; i++) pl.push([x + i * 4.2, y + Math.sin(i * 0.8) * 3])
    const part = cut(pl, 0, p)
    inkLine(ctx, part.map(([a, b]) => [a + 1, b + 2]), id + 'gs2', t, { w: 8, color: '#8a7a60', alpha: 0.1, passes: 1, jit: 0.6 })
    inkLine(ctx, part, id + 'gs', t, { w: 7, color: '#ffffff', alpha: 0.4, passes: 1, jit: 0.6 })
    inkLine(ctx, part.map(([a, b]) => [a, b - 1.5]), id + 'gs3', t, { w: 2, color: '#ffffff', alpha: 0.7, passes: 1, jit: 0.4 })
  }
  const POSTER_SCRAPS = [
    { draw: readmeScrap, at: [150, -186], rot: 0.06, from: [-980, -760], fromRot: -1.1, glue: [-40, 36] },
    { draw: treeScrap, at: [168, 26], rot: -0.05, from: [980, -700], fromRot: 1.2, glue: [-60, 70] },
    { draw: cmdScrap, at: [-6, 236], rot: -0.025, from: [-980, 760], fromRot: 0.9, glue: [150, 20] },
    { draw: windowScrap, at: [196, 334], rot: 0.08, from: [980, 760], fromRot: -1.0, glue: [-70, 50] },
  ]
  P.posterPage = function posterPage(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'poster', (ctx, map, id) => {
      const w = 600
      const h = 800
      const fw = 44
      const scraps = clamp01(def(o.scraps, 1))
      const heads = clamp01(def(o.headings, 1))
      const tagP = clamp01(def(o.tag, 1))
      const frame = clamp01(def(o.frame, 0))
      const T = -h / 2
      const L = -w / 2
      outline(ctx, K.paper(ctx, K.boxPts(w, h), C.cream, { seed: id + 'pg', cut: 2, shadow: 1, lift: 2 }), id + 'pgo', t, { alpha: 0.7 })
      // header band
      K.paper(ctx, K.rectPts(L + 26, T + 24, w - 52, 104), '#f2d27e', { seed: id + 'hb', torn: 2.5, shadow: 0.6 })
      lightbulb(ctx, L + 82, T + 74, 0.95, id + 'bulb', t)
      if (o.title) {
        K.font(ctx, 'marker', 64)
        const tw = ctx.measureText(o.title).width
        const s = Math.min(1, (w - 190) / tw)
        K.hand(ctx, o.title, 40, T + 98, { family: 'marker', size: 64 * s, color: C.ink, t, id: id + 'ttl', jitter: 0.4 })
      } else {
        // no invented title: a doodle row — three coloured paper dots over a wavy crayon underline
        const wl = []
        for (let i = 0; i <= 40; i++) wl.push([L + 150 + i * 9.4, T + 104 + Math.sin(i * 0.9) * 4])
        inkLine(ctx, wl, id + 'hwv', t, { w: 3.6, color: C.terracotta, alpha: 0.8, jit: 1.2 })
        ;[[C.terracotta, 0], [C.sage, 1], [C.hiveTeal, 2]].forEach(([col, i]) => {
          const r = K.rng('hdot', id, i)
          K.at(ctx, L + 196 + i * 116, T + 68 + (r() - 0.5) * 6, 0, 1, () => {
            const d = K.paper(ctx, K.ellipsePts(0, 0, 21, 21, 22), col, { seed: id + 'hd' + i, cut: 1.4, shadow: 0.8 })
            outline(ctx, d, id + 'hdo' + i, t, { w: 2, alpha: 0.55, step: 12 })
            ctx.beginPath()
            ctx.arc(-6, -7, 5, 0, TAU)
            ctx.fillStyle = 'rgba(255,255,255,0.35)'
            ctx.fill()
          })
        })
      }
      // sections
      const H = [
        { text: 'What it is', y: T + 196 },
        { text: "Who it's for", y: T + 390 },
        { text: 'How to run it', y: T + 578 },
      ]
      H.forEach((hd, i) => {
        const rp = seg(heads, i / 3, (i + 0.85) / 3)
        if (rp > 0) {
          K.hand(ctx, hd.text, L + 40, hd.y, { family: 'kalam', weight: '700', size: 44, color: C.ink, align: 'left', t, id: id + 'h' + i, jitter: 0.4, reveal: rp })
          K.font(ctx, 'kalam', 44, '700')
          const tw = ctx.measureText(hd.text).width
          const up = seg(rp, 0.7, 1)
          if (up > 0) inkLine(ctx, cut([[L + 38, hd.y + 14], [L + 40 + tw * 0.5, hd.y + 18], [L + 44 + tw, hd.y + 11]], 0, up), id + 'hu' + i, t, { w: 4, color: C.terracotta, alpha: 0.85 })
        }
      })
      // body scribbles
      scribble(ctx, L + 42, T + 250, 190, id + 'b1', t, { size: 14, alpha: 0.6 })
      scribble(ctx, L + 42, T + 282, 150, id + 'b2', t, { size: 14, alpha: 0.6 })
      scribble(ctx, L + 42, T + 444, 170, id + 'b3', t, { size: 14, alpha: 0.6 })
      scribble(ctx, L + 42, T + 476, 200, id + 'b4', t, { size: 14, alpha: 0.6 })
      scribble(ctx, L + 42, T + 508, 120, id + 'b5', t, { size: 14, alpha: 0.6 })
      // little doodle hearts/twinkles for charm
      K.twinkle(ctx, L + 60, T + 700, 14, id + 'tw1', t, C.mustard)
      K.twinkle(ctx, L + 96, T + 742, 9, id + 'tw2', t, C.coral)
      // flying scraps
      POSTER_SCRAPS.forEach((s, i) => {
        const sp = seg(scraps, i * 0.16, i * 0.16 + 0.44)
        if (sp <= 0) return
        const fe = E.outCubic(sp)
        const arc = Math.sin(Math.PI * fe) * 140 * (i % 2 ? -1 : 1)
        const dx = s.at[0] - s.from[0]
        const dy = s.at[1] - s.from[1]
        const d = Math.hypot(dx, dy)
        const px = lerp(s.from[0], s.at[0], fe) + (-dy / d) * arc
        const py = lerp(s.from[1], s.at[1], fe) + (dx / d) * arc
        const land = seg(sp, 0.86, 1)
        const squash = land > 0 && land < 1 ? 1 - 0.1 * Math.sin(land * Math.PI) : 1
        const sc = lerp(1.35, 1, fe) * squash
        K.at(ctx, px, py, lerp(s.fromRot, s.rot, E.outBack(sp)), [sc / squash * (2 - squash), sc], () => s.draw(ctx, id + 's' + i, t))
        const gp = seg(scraps, i * 0.16 + 0.44, i * 0.16 + 0.6)
        if (gp > 0) glueSquiggle(ctx, s.at[0] + s.glue[0], s.at[1] + s.glue[1], id + 'g' + i, t, gp)
      })
      // frame snap
      if (frame > 0) {
        const fe = E.outBack(frame)
        K.withAlpha(ctx, Math.min(1, frame * 3.5), () => K.at(ctx, 0, 0, 0, 1 + 0.22 * (1 - fe), () => woodFrame(ctx, w, h, fw, C.kraftDark, id + 'fr', t, { lift: 6 * (1 - frame) })))
      }
      // caption tag
      let tagAt = map(30, h / 2 + 30)
      if (tagP > 0) {
        const s = E.outBack(tagP)
        K.at(ctx, 30, h / 2 + 28, -0.035, s, () => {
          K.label(ctx, 'one page, written from real code', 0, 0, { size: 34, bg: C.paperWhite, t, id: id + 'cap', tapeColor: 'rgba(184,92,52,0.7)', padX: 26, padY: 12 })
        })
      }
      const ox = w / 2 + (frame > 0 ? fw : 0)
      const oy = h / 2 + (frame > 0 ? fw : 0)
      return {
        top: map(0, -oy),
        grips: [map(-ox, 0), map(ox, 0)],
        tag: tagAt,
        corners: { tl: map(-ox, -oy), tr: map(ox, -oy), bl: map(-ox, oy), br: map(ox, oy) },
      }
    })
  }

  P.house = function house(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'house', (ctx, map, id) => {
      const color = o.color || C.sage
      const roof = o.roof || (color === C.terracotta ? C.honey : color === C.butter ? C.terracotta : color === C.sage ? C.terracotta : C.hiveTeal === color ? C.butter : C.terracotta)
      const w = def(o.w, 180)
      const h = def(o.h, 150)
      const lit = clamp01(def(o.lit, 0))
      // chimney
      K.paper(ctx, K.rectPts(w * 0.2, -h - 92, 28, 70), mix(color, '#2a221a', 0.25), { seed: id + 'ch', cut: 1, shadow: 0.8 })
      K.paper(ctx, K.rectPts(w * 0.2 - 4, -h - 98, 36, 12), mix(color, '#2a221a', 0.35), { seed: id + 'chc', cut: 0.8, shadow: 0.4 })
      // body
      const bodyS = K.paper(ctx, K.rectPts(-w / 2, -h, w, h), color, { seed: id + 'bd', cut: 1.6, shadow: 1 })
      fillPoly(ctx, K.rectPts(w / 2 - 26, -h, 26, h), 'rgba(40,20,5,0.1)')
      outline(ctx, bodyS, id + 'bdo', t)
      // roof
      const rf = [[-w / 2 - 22, -h + 8], [w / 2 + 22, -h + 8], [0, -h - 104]]
      const roofS = K.paper(ctx, rf, roof, { seed: id + 'rf', cut: 1.8, shadow: 1 })
      ctx.save()
      K.pathPoly(ctx, rf)
      ctx.clip()
      ctx.strokeStyle = 'rgba(40,15,0,0.25)'
      ctx.lineWidth = 2
      for (let row = 0; row < 4; row++) {
        const yy = -h - 64 + row * 22
        ctx.beginPath()
        for (let xx = -w / 2 - 20; xx < w / 2 + 20; xx += 24) {
          ctx.moveTo(xx + 24, yy)
          ctx.arc(xx + 12, yy, 12, 0, Math.PI)
        }
        ctx.stroke()
      }
      ctx.restore()
      outline(ctx, roofS, id + 'rfo', t)
      // door
      const dw = 48
      const dh = 76
      const door = K.roundRectPts(-dw / 2, -dh, dw, dh + 2, 22, 4)
      outline(ctx, K.paper(ctx, door, C.kraftDark, { seed: id + 'dr', cut: 1, shadow: 0.6 }), id + 'dro', t, { w: 2.2, step: 14 })
      ctx.beginPath()
      ctx.arc(12, -dh / 2 + 4, 4, 0, TAU)
      ctx.fillStyle = C.mustard
      ctx.fill()
      // windows
      const wins = [[-w / 2 + 44, -h + 58], [w / 2 - 44, -h + 58]]
      wins.forEach(([wx, wy], i) => {
        const sq = K.boxPts(42, 42).map(([a, b]) => [a + wx, b + wy])
        K.paper(ctx, sq, C.cream, { seed: id + 'w' + i, cut: 1, shadow: 0.6 })
        if (lit > 0) fillPoly(ctx, sq, `rgba(240,191,76,${0.75 * lit})`)
        inkLine(ctx, [[wx, wy - 21], [wx, wy + 21]], id + 'wv' + i, t, { w: 2, alpha: 0.55, passes: 1 })
        inkLine(ctx, [[wx - 21, wy], [wx + 21, wy]], id + 'wh' + i, t, { w: 2, alpha: 0.55, passes: 1 })
        inkLine(ctx, sq, id + 'wo' + i, t, { w: 2, alpha: 0.6, closed: true, passes: 1 })
        fillPoly(ctx, K.rectPts(wx - 26, wy + 21, 52, 7), mix(color, '#ffffff', 0.35))
      })
      if (o.label) {
        // tiny name sign on the gable, shrunk to fit inside the roof triangle
        const ly = -h - 34
        K.font(ctx, 'hand', 20)
        const lw = ctx.measureText(o.label).width + 16
        const lh = 28
        const roofHalf = (yy) => ((w / 2 + 22) * (yy - (-h - 104))) / (-h + 8 - (-h - 104))
        const fit = Math.min(1, (2 * roofHalf(ly - lh / 2) - 14) / lw, (2 * roofHalf(ly) - 10) / lw)
        K.at(ctx, 0, ly, 0, Math.max(0.45, fit), () => K.label(ctx, o.label, 0, 0, { size: 20, t, id: id + 'lb', padX: 8, padY: 4 }))
      }
      // tuft of grass
      ;[-w / 2 - 6, w / 2 + 8].forEach((gx, i) => {
        const r = K.rng('grass', id, i)
        for (let k = 0; k < 3; k++) {
          const bx = gx + (k - 1) * 9
          const hh = 20 + r() * 14
          fillPoly(ctx, [[bx - 5, 2], [bx + (r() - 0.5) * 12, -hh], [bx + 5, 2]], C.grass)
        }
      })
      return { door: map(0, -dh / 2), roofTop: map(0, -h - 104), windows: wins.map((p) => map(p[0], p[1])) }
    })
  }

  function waveText(ctx, str, x0, yOf, o) {
    K.font(ctx, o.family || 'marker', o.size)
    let cx = x0
    const b = K.boil(o.t)
    ctx.save()
    ctx.fillStyle = o.color
    for (let i = 0; i < str.length; i++) {
      const ch = str[i]
      const cw = ctx.measureText(ch).width
      const mx = cx + cw / 2
      const [yy, ang] = yOf(mx)
      if (ch !== ' ') {
        const r = K.rng('wv', o.id, i, b)
        ctx.save()
        ctx.translate(mx + (r() - 0.5) * 0.8, yy + (r() - 0.5) * 1.2)
        ctx.rotate(ang + (r() - 0.5) * 0.04)
        ctx.fillText(ch, -cw / 2, 0)
        ctx.restore()
      }
      cx += cw
    }
    ctx.restore()
  }

  P.signpost = function signpost(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'sign', (ctx, map, id) => {
      const text = def(o.text, 'bilko.run/projects')
      const pen = def(o.pennant, 'Host on Bilko.run')
      const fl = def(o.flutter, 1)
      const postTop = -520
      // pennant (behind the post)
      const PL = 450
      const PH = 116
      const py0 = postTop + 26
      const wave = (u) => fl * (4 + 14 * u) * Math.sin(t * 6.5 - u * 5.5)
      const waveA = (u) => fl * Math.atan2(-(4 + 14 * u) * 5.5 * Math.cos(t * 6.5 - u * 5.5), PL) * 0.9
      const topE = []
      const botE = []
      const N = 16
      for (let i = 0; i <= N; i++) {
        const u = i / N
        const half = (PH / 2) * (1 - u)
        const cy = py0 + PH / 2 + u * 10 + wave(u)
        topE.push([10 + u * PL, cy - half])
        botE.push([10 + u * PL, cy + half])
      }
      const pennant = topE.concat(botE.reverse())
      const pnS = K.paper(ctx, pennant, C.terracotta, { seed: id + 'pn', cut: 0, shadow: 1, lift: 6 })
      outline(ctx, pnS, id + 'pno', t, { alpha: 0.6 })
      fillPoly(ctx, [[10, py0], [32, py0 + 2], [32, py0 + PH - 2], [10, py0 + PH]], 'rgba(255,240,220,0.25)')
      waveText(ctx, pen, 44, (mx) => {
        const u = (mx - 10) / PL
        return [py0 + PH / 2 + u * 10 + wave(u) + 11, waveA(u)]
      }, { size: 36, color: C.paperWhite, t, id: id + 'pt', family: 'hand' })
      // post
      const post = [[-15, 0], [-13, postTop], [13, postTop], [15, 0]]
      const poS = K.paper(ctx, post, WOOD, { seed: id + 'po', cut: 1.2, shadow: 1 })
      fillPoly(ctx, [[4, 0], [4, postTop], [13, postTop], [15, 0]], 'rgba(40,20,5,0.18)')
      ctx.save()
      ctx.strokeStyle = 'rgba(60,30,10,0.3)'
      ctx.lineWidth = 1.4
      ;[-6, 2].forEach((gx) => {
        ctx.beginPath()
        ctx.moveTo(gx, -8)
        ctx.bezierCurveTo(gx + 3, -200, gx - 3, -340, gx, postTop + 10)
        ctx.stroke()
      })
      ctx.restore()
      outline(ctx, poS, id + 'poo', t, { alpha: 0.65 })
      outline(ctx, K.paper(ctx, K.ellipsePts(0, postTop - 6, 17, 17, 20), C.honey, { seed: id + 'fin', cut: 1, shadow: 0.8 }), id + 'fino', t, { alpha: 0.6, w: 2.2, step: 10 })
      // arrow board
      K.font(ctx, 'marker', 44)
      const tw = ctx.measureText(text).width
      const bw = tw + 130
      const bh = 88
      const bx = bw / 2 - 50
      const by = -330
      const board = [[bx - bw / 2, by - bh / 2], [bx + bw / 2 - 36, by - bh / 2], [bx + bw / 2 + 8, by], [bx + bw / 2 - 36, by + bh / 2], [bx - bw / 2, by + bh / 2]]
      K.at(ctx, 0, 0, -0.03, 1, () => {
        const bdS = K.paper(ctx, board, C.kraft, { seed: id + 'bd', cut: 1.5, shadow: 1, lift: 3 })
        outline(ctx, bdS, id + 'bdo', t, { alpha: 0.72 })
        ctx.save()
        K.pathPoly(ctx, board)
        ctx.clip()
        ctx.strokeStyle = 'rgba(90,55,20,0.18)'
        ctx.lineWidth = 1.3
        for (let k = 0; k < 4; k++) {
          const yy = by - bh / 2 + 14 + k * 20
          ctx.beginPath()
          ctx.moveTo(bx - bw / 2, yy)
          ctx.bezierCurveTo(bx - bw / 6, yy + 5, bx + bw / 6, yy - 5, bx + bw / 2, yy + 2)
          ctx.stroke()
        }
        ctx.restore()
        K.hand(ctx, text, 30 + tw / 2, by + 15, { family: 'marker', size: 44, color: C.ink, t, id: id + 'bt', jitter: 0.35 })
        ;[[0, by - 22], [0, by + 22]].forEach(([nx, ny]) => {
          ctx.beginPath()
          ctx.arc(nx, ny, 4, 0, TAU)
          ctx.fillStyle = '#5b4a36'
          ctx.fill()
        })
      })
      // grass tufts
      const r = K.rng('sgrass', id)
      for (let k = 0; k < 5; k++) {
        const gx = -34 + k * 17
        const hh = 18 + r() * 18
        fillPoly(ctx, [[gx - 6, 3], [gx + (r() - 0.5) * 14, -hh], [gx + 6, 3]], k % 2 ? C.grass : C.sage)
      }
      return { board: map(bx, by), pennant: map(10 + PL * 0.4, py0 + PH / 2), top: map(0, postTop - 20) }
    })
  }

  // gallery
  function doodleSprout(ctx, id, t) {
    K.paper(ctx, [[-30, 10], [30, 10], [22, 52], [-22, 52]], C.terracotta, { seed: id + 'pt', cut: 1, shadow: 0.7 })
    K.paper(ctx, K.rectPts(-34, 2, 68, 14), mix(C.terracotta, '#ffffff', 0.15), { seed: id + 'pr', cut: 0.8, shadow: 0.5 })
    inkLine(ctx, [[0, 4], [2, -20], [-2, -46]], id + 'st', t, { w: 3.5, color: C.sage })
    K.at(ctx, -18, -30, -0.6, 1, () => K.paper(ctx, K.ellipsePts(0, 0, 20, 10, 18), C.grass, { seed: id + 'l1', cut: 1, shadow: 0.5 }))
    K.at(ctx, 18, -44, 0.5, 1, () => K.paper(ctx, K.ellipsePts(0, 0, 22, 11, 18), C.sage, { seed: id + 'l2', cut: 1, shadow: 0.5 }))
    ;[[-9, 30], [9, 30]].forEach(([ex, ey]) => {
      ctx.beginPath()
      ctx.arc(ex, ey, 3, 0, TAU)
      ctx.fillStyle = C.ink
      ctx.fill()
    })
    inkLine(ctx, [[-5, 38], [0, 41], [5, 38]], id + 'sm', t, { w: 1.8, passes: 1 })
  }
  function doodlePotBot(ctx, id, t) {
    ;[-16, 0, 16].forEach((sx, i) => {
      const pl = []
      for (let k = 0; k <= 8; k++) pl.push([sx + Math.sin(k * 0.9 + t * 3 + i) * 5, -36 - k * 5])
      inkLine(ctx, pl, id + 'stm' + i, t, { w: 2.2, alpha: 0.45, color: C.inkDim, passes: 1 })
    })
    K.paper(ctx, K.roundRectPts(-46, -26, 92, 72, 16, 4), C.sky, { seed: id + 'pb', cut: 1.2, shadow: 0.8 })
    K.paper(ctx, K.roundRectPts(-52, -34, 104, 14, 6, 2), C.blue, { seed: id + 'pl', cut: 0.8, shadow: 0.5 })
    fillPoly(ctx, K.rectPts(-60, -8, 16, 8), C.blue)
    fillPoly(ctx, K.rectPts(44, -8, 16, 8), C.blue)
    K.googly(ctx, -15, 4, 11, t, id + 'e1', [0.3, 0.2], { lidColor: C.sky })
    K.googly(ctx, 15, 4, 9, t, id + 'e2', [0.3, 0.2], { lidColor: C.sky })
    inkLine(ctx, [[-10, 26], [0, 32], [10, 26]], id + 'm', t, { w: 2.2, passes: 1 })
    K.cheek(ctx, -30, 24, 8)
    K.cheek(ctx, 30, 24, 8)
  }
  function doodleConsole(ctx, id, t) {
    K.paper(ctx, K.boxPts(150, 104), C.kraft, { seed: id + 'cf', cut: 1.2, shadow: 0.8 })
    ;[[-66, C.terracotta], [-34, C.butter], [-2, C.sage]].forEach(([xx, col], i) => K.paper(ctx, K.roundRectPts(xx, -66, 30, 18, 5, 2), col, { seed: id + 'tb' + i, cut: 0.6, shadow: 0.4 }))
    fillPoly(ctx, K.rectPts(-64, -40, 128, 80), C.cream)
    fillPoly(ctx, K.rectPts(-64, -40, 26, 80), '#ece0c6')
    fillPoly(ctx, K.rectPts(-30, -32, 86, 64), C.termBlack)
    K.hand(ctx, '> _', -24, 8, { family: 'marker', size: 26, color: C.crayonGreen, align: 'left', t, id: id + 'pr', jitter: 0.4 })
  }
  function miniPoster(ctx, title, id, t, pw, ph) {
    K.paper(ctx, K.boxPts(pw, ph), C.cream, { seed: id + 'mp', cut: 1, shadow: 0 })
    const lc = title.toLowerCase()
    K.at(ctx, 0, 14, 0, 1, () => {
      if (lc.includes('garden')) doodleSprout(ctx, id, t)
      else if (lc.includes('recipe')) doodlePotBot(ctx, id, t)
      else if (lc.includes('session')) doodleConsole(ctx, id, t)
      else lightbulb(ctx, 0, 0, 1, id, t)
    })
    K.font(ctx, 'marker', 38)
    const tw = ctx.measureText(title).width
    const s = Math.min(1, (pw - 28) / tw)
    K.hand(ctx, title, 0, -ph / 2 + 52, { family: 'marker', size: 38 * s, color: C.ink, t, id: id + 'tt', jitter: 0.35 })
    inkLine(ctx, [[-pw * 0.3, -ph / 2 + 64], [pw * 0.3, -ph / 2 + 62]], id + 'tu', t, { w: 3, color: C.terracotta, alpha: 0.8, passes: 1 })
    scribble(ctx, -pw / 2 + 26, ph / 2 - 50, pw * 0.6, id + 's1', t, { size: 11, alpha: 0.55 })
    scribble(ctx, -pw / 2 + 26, ph / 2 - 26, pw * 0.42, id + 's2', t, { size: 11, alpha: 0.55 })
  }
  P.galleryWall = function galleryWall(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, o, 'gallery', (ctx, map, id) => {
      const posters = o.posters || ['garden-app', 'recipe-bot', 'Session Manager']
      const empty = def(o.emptySlot, 3)
      const reveal = clamp01(def(o.reveal, 1))
      const sway = def(o.sway, 0.6)
      const nSlots = posters.length + (empty >= 0 ? 1 : 0)
      const gapX = 380
      const xs = []
      for (let i = 0; i < nSlots; i++) xs.push((i - (nSlots - 1) / 2) * gapX)
      const pw = 240
      const ph = 300
      const fw = 22
      const nailY = -150
      const frameY = 60
      const frameCols = [C.kraftDark, C.sage, C.honey, C.hiveTeal]
      const slots = []
      let pi = 0
      let newSlot = null
      xs.forEach((sx, i) => {
        const nail = [sx, nailY]
        if (i === empty) {
          // the free nail (o.emptyNail false → none: hang the new frame with a thumbtack instead)
          const wireY = frameY - ph / 2 - fw + 6
          const nw = clamp01(def(o.newWire, 0))
          if (nw > 0) {
            // picture wire for the new frame, drawn on from the nail down to both frame corners
            ctx.save()
            ctx.strokeStyle = 'rgba(60,50,40,0.7)'
            ctx.lineWidth = 2
            ctx.lineCap = 'round'
            ctx.beginPath()
            ;[-1, 1].forEach((sd) => {
              ctx.moveTo(sx, nailY)
              ctx.lineTo(lerp(sx, sx + sd * (pw / 2 - 10), nw), lerp(nailY, wireY, nw))
            })
            ctx.stroke()
            ctx.restore()
          }
          if (o.emptyNail !== false) {
            ctx.beginPath()
            ctx.arc(sx, nailY, 6, 0, TAU)
            ctx.fillStyle = '#6b5a45'
            ctx.fill()
            ctx.beginPath()
            ctx.arc(sx - 1.5, nailY - 1.5, 2, 0, TAU)
            ctx.fillStyle = 'rgba(255,255,255,0.35)'
            ctx.fill()
          }
          const hint = def(o.hint, 0)
          if (hint > 0) {
            K.withAlpha(ctx, hint, () => {
              ctx.save()
              ctx.setLineDash([12, 10])
              inkLine(ctx, K.rectPts(sx - pw / 2 - fw, frameY - ph / 2 - fw, pw + fw * 2, ph + fw * 2), id + 'hint', t, { w: 3, alpha: 0.5, closed: true, passes: 1 })
              ctx.restore()
            })
          }
          newSlot = {
            x: map(sx, frameY)[0],
            y: map(sx, frameY)[1],
            nail: map(sx, nailY),
            pin: map(sx, frameY - (ph + fw * 2) / 2 + 12),
            wire: [map(sx - pw / 2 + 10, wireY), map(sx, nailY), map(sx + pw / 2 - 10, wireY)],
            scale: (ph + fw * 2) / 888,
          }
          slots.push({ x: map(sx, frameY)[0], y: map(sx, frameY)[1], w: pw + fw * 2, h: ph + fw * 2 })
          return
        }
        const title = posters[pi]
        const k = pi
        pi++
        const rp = seg(reveal, (k / Math.max(1, posters.length)) * 0.7, (k / Math.max(1, posters.length)) * 0.7 + 0.3)
        slots.push({ x: map(sx, frameY)[0], y: map(sx, frameY)[1], w: pw + fw * 2, h: ph + fw * 2 })
        if (rp <= 0) return
        const sc = E.outBack(rp)
        const sw = Math.sin(t * 1.4 + k * 2.1) * 0.025 * sway
        // nail
        ctx.beginPath()
        ctx.arc(sx, nailY, 6, 0, TAU)
        ctx.fillStyle = '#6b5a45'
        ctx.fill()
        K.at(ctx, sx, nailY, sw, sc, () => {
          // picture wire
          ctx.save()
          ctx.strokeStyle = 'rgba(60,50,40,0.7)'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(-pw / 2 + 10, frameY - nailY - ph / 2 - fw + 6)
          ctx.lineTo(0, 0)
          ctx.lineTo(pw / 2 - 10, frameY - nailY - ph / 2 - fw + 6)
          ctx.stroke()
          ctx.restore()
          K.at(ctx, 0, frameY - nailY, 0, 1, () => {
            woodFrame(ctx, pw, ph, fw, frameCols[k % frameCols.length], id + 'f' + k, t)
            miniPoster(ctx, title, id + 'p' + k, t, pw, ph)
          })
        })
      })
      // banner
      const btext = def(o.title, 'Showcase')
      K.font(ctx, 'chunky', 68, '600')
      const bw = ctx.measureText(btext).width + 130
      const bh = 100
      const by = -300
      K.at(ctx, 0, by, -0.015, 1, () => {
        const tailC = mix(C.terracotta, '#2a221a', 0.2)
        ;[-1, 1].forEach((sd) => {
          const tx = sd * (bw / 2 - 10)
          const tail = [[tx, -bh / 2 + 22], [tx + sd * 110, -bh / 2 + 22], [tx + sd * 80, 14 + 22], [tx + sd * 110, bh / 2 + 22], [tx, bh / 2 + 22]]
          K.paper(ctx, tail, tailC, { seed: id + 'bt' + sd, cut: 1, shadow: 0.8 })
        })
        K.paper(ctx, K.boxPts(bw, bh), C.terracotta, { seed: id + 'bn', cut: 1.6, shadow: 1, lift: 4 })
        fillPoly(ctx, K.rectPts(-bw / 2, bh / 2 - 12, bw, 12), 'rgba(40,10,0,0.12)')
        K.hand(ctx, btext, 0, 24, { family: 'chunky', weight: '600', size: 68, color: C.paperWhite, t, id: id + 'btx', jitter: 0.35 })
      })
      return { slots, newSlot, banner: map(0, by) }
    })
  }

  P.heartPop = function heartPop(ctx, x, y, t, o = {}) {
    const p = clamp01(def(o.p, 1))
    if (p <= 0 || p >= 1) return { center: [x, y] }
    return stage(ctx, x, y, t, o, 'heart', (ctx, map, id) => {
      const r = def(o.r, 34)
      const sc = E.outBack(seg(p, 0, 0.3)) * (1 - 0.25 * seg(p, 0.75, 1))
      const rise = -80 * E.outQuad(p)
      const wob = Math.sin(p * 14) * 0.12 * (1 - p)
      const alpha = 1 - seg(p, 0.72, 1)
      K.withAlpha(ctx, alpha, () => {
        K.at(ctx, Math.sin(p * 9) * 8, rise, wob, sc, () => {
          const hp = heartPts(r)
          K.paper(ctx, hp, o.color || C.pink, { seed: id + 'h', cut: 1.2, shadow: 0.8 })
          inkLine(ctx, hp, id + 'ho', t, { w: 2.4, alpha: 0.7, closed: true, passes: 1 })
          ctx.beginPath()
          ctx.arc(-r * 0.42, -r * 0.18, r * 0.2, 0, TAU)
          ctx.fillStyle = 'rgba(255,255,255,0.55)'
          ctx.fill()
        })
        if (p > 0.08 && p < 0.45) K.sparkle(ctx, 0, rise, r * 1.5, id + 'sp', t, { n: 3, color: C.tomato, w: 3 })
      })
      return { center: map(0, rise) }
    })
  }

  // ───────────────────────── s9: end card ─────────────────────────
  P.luggageTag = function luggageTag(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, Object.assign({ nudge: 0.35 }, o), 'ltag', (ctx, map, id) => {
      const text = def(o.text, 'bilko.run/products/session-manager')
      const sub = def(o.sub, 'Linux & macOS')
      const size = def(o.size, 48)
      // wrap after the last '/' so the tag reads as a tag (~2.6:1), not a plank
      let lines = [text]
      const cutAt = text.lastIndexOf('/')
      if (o.wrap !== false && cutAt > 0 && cutAt < text.length - 1) lines = [text.slice(0, cutAt + 1), text.slice(cutAt + 1)]
      K.font(ctx, 'hand', size)
      const tw = Math.max(...lines.map((ln, i) => ctx.measureText(ln).width + i * size * 0.5))
      const lineH = size * 1.1
      const padT = size * 0.72
      const subH = sub ? size * 1.02 : 0
      const w = tw + 200
      const h = padT + size * 0.78 + lineH * (lines.length - 1) + subH + size * 0.62
      const ex = -w / 2 + 52
      const sw = def(o.swing, 1)
      const ang = sw * (0.035 * Math.sin(t * 2.3) + 0.012 * Math.sin(t * 3.7 + 1))
      const str = o.string || [-46, -124]
      const hook = [ex + str[0], str[1]]
      let out = {}
      // string from hook to eyelet (eyelet moves slightly with the swing)
      const eyeX = ex
      const eyeY = 0
      K.at(ctx, eyeX, eyeY, ang, 1, () => {
        // tag body in eyelet-local coords
        ctx.translate(-eyeX, -eyeY)
        const ch = 38
        const shape = [[-w / 2 + ch, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2 + ch, h / 2], [-w / 2, h / 2 - ch], [-w / 2, -h / 2 + ch]]
        const tagS = K.paper(ctx, shape, C.kraft, { seed: id + 'tg', cut: 1.2, shadow: 1, lift: 8 })
        fillPoly(ctx, [[-w / 2 + ch, h / 2 - 14], [w / 2, h / 2 - 14], [w / 2, h / 2], [-w / 2 + ch, h / 2]], 'rgba(90,55,20,0.1)')
        // airline-tag stripes at the far end
        fillPoly(ctx, K.rectPts(w / 2 - 44, -h / 2, 14, h), K.paperPattern(ctx, C.terracotta))
        fillPoly(ctx, K.rectPts(w / 2 - 24, -h / 2, 8, h), K.paperPattern(ctx, C.butter))
        // stitched border
        ctx.save()
        ctx.setLineDash([10, 8])
        ctx.strokeStyle = 'rgba(90,60,30,0.45)'
        ctx.lineWidth = 2.2
        const inset = 14
        K.pathPoly(ctx, [[-w / 2 + ch + 4, -h / 2 + inset], [w / 2 - inset, -h / 2 + inset], [w / 2 - inset, h / 2 - inset], [-w / 2 + ch + 4, h / 2 - inset], [-w / 2 + inset, h / 2 - ch], [-w / 2 + inset, -h / 2 + ch]])
        ctx.stroke()
        ctx.restore()
        // eyelet reinforcement
        ctx.beginPath()
        ctx.arc(ex, 0, 24, 0, TAU)
        ctx.fillStyle = K.paperPattern(ctx, C.cream)
        ctx.fill()
        ctx.strokeStyle = 'rgba(90,60,30,0.4)'
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(ex, 0, 11, 0, TAU)
        ctx.fillStyle = '#4a3522'
        ctx.fill()
        outline(ctx, tagS, id + 'tgo', t, { alpha: 0.7 })
        // a little butter sticker dot on the corner (kraft tags always collect one)
        K.at(ctx, w / 2 - 78, -h / 2 + 30, 0.2, 1, () => {
          const d = K.paper(ctx, K.ellipsePts(0, 0, 13, 13, 18), C.butter, { seed: id + 'sd', cut: 1, shadow: 0.7 })
          outline(ctx, d, id + 'sdo', t, { w: 1.8, alpha: 0.5, step: 10 })
          ctx.beginPath()
          ctx.arc(-4, -4, 3.5, 0, TAU)
          ctx.fillStyle = 'rgba(255,255,255,0.45)'
          ctx.fill()
        })
        // lettering
        const tx = ex + 50
        let by = -h / 2 + padT + size * 0.78
        lines.forEach((ln, i) => K.hand(ctx, ln, tx + i * size * 0.5, by + i * lineH, { size, color: C.ink, align: 'left', t, id: id + 'tx' + i, jitter: 0.3 }))
        by += lineH * (lines.length - 1)
        if (sub) {
          const sy = by + size * 0.92
          K.hand(ctx, sub, tx + 2, sy, { family: 'kalam', weight: '700', size: size * 0.6, color: C.inkDim, align: 'left', t, id: id + 'sb', jitter: 0.3 })
          K.font(ctx, 'kalam', size * 0.6, '700')
          const sw2 = ctx.measureText(sub).width
          inkLine(ctx, [[tx, sy + 10], [tx + sw2, sy + 8]], id + 'sbu', t, { w: 2, color: C.inkDim, alpha: 0.5, passes: 1 })
        }
        out.center = map(0, 0)
      })
      // twine: loop through the eyelet up to the hook
      const loop = [[ex - 8, -6], [ex - 30, -34], [ex - 34, -80], [hook[0] + 10, hook[1] + 40], hook]
      twine(ctx, spline(loop, 6), { w: 4 })
      twine(ctx, [[ex + 6, -4], [ex + 2, -30], [ex - 28, -40]], { w: 4 })
      if (o.nail !== false) P.thumbtack(ctx, hook[0], hook[1], t, { id: id + 'nail', color: C.terracotta, r: 14 })
      return { hook: map(hook[0], hook[1]), eyelet: map(ex, 0), center: out.center || map(0, 0), w, h }
    })
  }

  const MONO = '"Fira Mono", "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono", monospace'
  P.tapeTyper = function tapeTyper(ctx, x, y, t, o = {}) {
    return stage(ctx, x, y, t, Object.assign({ nudge: 0.3 }, o), 'tape', (ctx, map, id) => {
      const text = def(o.text, 'npx claude-code-session-manager@latest')
      const size = def(o.size, 46)
      const reveal = clamp01(def(o.reveal, 1))
      const prompt = def(o.prompt, '>')
      const grow = o.grow !== false
      const cell = size * 0.6
      const pad = size * 0.7
      const promptW = prompt ? size * 1.05 : 0
      const n = text.length
      const fullW = pad + promptW + n * cell + cell * 1.2 + pad * 0.6
      const th = size * 1.8
      const L = -fullW / 2
      const shownF = reveal * n
      const shown = Math.min(n, Math.floor(shownF + 1e-6))
      const typing = reveal < 1
      const textX = L + pad + promptW
      const caretX = textX + shown * cell
      const rightX = grow ? Math.min(-L, caretX + cell * 1.2 + pad * 0.6) : -L
      if (rightX - L < 10) return { w: fullW, h: th, caret: map(caretX, 0), left: map(L, 0), right: map(rightX, 0) }
      // tape strip: slightly wavy long edges, a V-notch cut on the left end and an angled cut on the
      // right; a hair of rotation that grows as the tape extrudes (it droops off the machine)
      const r = K.rng('tp', id)
      const top = []
      const bot = []
      const steps = Math.max(2, Math.round((rightX - L) / 60))
      for (let i = 0; i <= steps; i++) {
        const xx = lerp(L, rightX, i / steps)
        top.push([xx, -th / 2 + (r() - 0.5) * 2])
        bot.push([xx, th / 2 + (r() - 0.5) * 2])
      }
      top[top.length - 1][0] -= 14 // angled cut: top edge shorter than the bottom
      const strip = top.concat(bot.reverse(), [[L + 11, 0]]) // closes through the V-notch on the left
      const droop = ((r() < 0.5 ? -1 : 1) * 0.012 * (rightX - L)) / fullW
      ctx.translate(L, 0) // pivot at the left end so the typed start stays put
      ctx.rotate(droop)
      ctx.translate(-L, 0)
      K.paper(ctx, strip, C.termBlack, { seed: id + 'st', cut: 0, shadow: 1, lift: 3 })
      // embossed tape ridges 4 px inside both long edges + a soft gloss band
      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,0.13)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(L + 9, -th / 2 + 5)
      ctx.lineTo(rightX - 16, -th / 2 + 5)
      ctx.moveTo(L + 9, th / 2 - 5)
      ctx.lineTo(rightX - 4, th / 2 - 5)
      ctx.stroke()
      ctx.restore()
      fillPoly(ctx, [[L + 14, -th / 2 + 8], [rightX - 18, -th / 2 + 8], [rightX - 17, -th / 2 + 13], [L + 12, -th / 2 + 13]], 'rgba(255,255,255,0.06)')
      // prompt
      if (prompt) K.hand(ctx, prompt, L + pad + promptW * 0.3, size * 0.36, { family: 'marker', size: size * 1.1, color: C.crayonGreen, t, id: id + 'pr', jitter: 0.5 })
      // embossed mono letters
      ctx.save()
      ctx.font = `500 ${size}px ${MONO}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const b = K.boil(t)
      for (let i = 0; i < shown; i++) {
        const ch = text[i]
        if (ch === ' ') continue
        const fr = K.rng('ch', id, i)
        const br = K.rng('chb', id, i, b)
        const age = shownF - i
        const pop = typing && age < 1.5 ? 1 + 0.2 * (1 - age / 1.5) : 1
        const cx = textX + i * cell + cell / 2
        const cy = size * 0.04 + (fr() - 0.5) * 2.4 + (br() - 0.5) * 0.5
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate((fr() - 0.5) * 0.05)
        ctx.scale(pop, pop)
        ctx.fillStyle = 'rgba(0,0,0,0.55)'
        ctx.fillText(ch, 1.4, 2)
        ctx.fillStyle = C.cream
        ctx.fillText(ch, 0, 0)
        ctx.restore()
      }
      ctx.restore()
      // caret: solid while typing, blinking after
      const blinkOn = typing || Math.floor(t * 1.9) % 2 === 0
      if (o.caret !== false && blinkOn && shown <= n) {
        fillPoly(ctx, K.rectPts(caretX + 3, -size * 0.42, cell - 6, size * 0.86), 'rgba(251,244,228,0.85)')
      }
      return { w: fullW, h: th, caret: map(caretX + cell / 2, 0), left: map(L, 0), right: map(rightX, 0) }
    })
  }

  P.washiLabel = function washiLabel(ctx, x, y, t, o = {}) {
    const slap = clamp01(def(o.slap, 1))
    if (slap <= 0) return { w: 0, h: 0 }
    return stage(ctx, x, y, t, Object.assign({ nudge: 0.35 }, o), 'washi', (ctx, map, id) => {
      const text = def(o.text, 'free & open · MIT')
      const size = def(o.size, 42)
      const color = o.color || C.terracotta
      K.font(ctx, 'chunky', size, '600')
      const tw = ctx.measureText(text).width
      const w = tw + size * 2.2
      const h = size * 1.62
      const inAir = slap < 0.55
      const k = seg(slap, 0, 0.55)
      const s = inAir ? lerp(1.35, 1, E.inCubic(k)) : 1
      const land = seg(slap, 0.55, 1)
      const sq = inAir ? 1 : 1 - 0.12 * Math.sin(land * Math.PI) * (1 - land)
      const dy = inAir ? lerp(-70, 0, E.inCubic(k)) : 0
      const rot = inAir ? lerp(0.22, 0, E.inCubic(k)) : 0
      K.withAlpha(ctx, Math.min(1, slap * 5), () => {
        K.at(ctx, 0, dy, rot, [s * (2 - sq), s * sq], () => {
          const r = K.rng('wt', id)
          const teeth = 6
          const poly = [[-w / 2, -h / 2], [w / 2, -h / 2]]
          for (let i = 1; i < teeth; i++) poly.push([w / 2 + (i % 2 ? -7 : 3) + (r() - 0.5) * 3, -h / 2 + (i / teeth) * h])
          poly.push([w / 2, h / 2], [-w / 2, h / 2])
          for (let i = teeth - 1; i > 0; i--) poly.push([-w / 2 + (i % 2 ? 7 : -3) + (r() - 0.5) * 3, -h / 2 + (i / teeth) * h])
          K.dropShadow(ctx, poly, 0.7, inAir ? 18 * (1 - k) : 0)
          ctx.save()
          ctx.globalAlpha *= 0.94
          fillPoly(ctx, poly, K.paperPattern(ctx, color))
          ctx.restore()
          // printed pattern only in the edge bands so the lettering stays clean
          ctx.save()
          K.pathPoly(ctx, poly)
          ctx.clip()
          ctx.fillStyle = 'rgba(255,245,230,0.35)'
          for (let xx = -w / 2 + 12; xx < w / 2; xx += 18) {
            ctx.beginPath()
            ctx.arc(xx, -h / 2 + 7, 2.6, 0, TAU)
            ctx.arc(xx + 9, h / 2 - 7, 2.6, 0, TAU)
            ctx.fill()
          }
          ctx.fillStyle = 'rgba(255,245,230,0.18)'
          ctx.fillRect(-w / 2, -h / 2 + 14, w, 2.5)
          ctx.fillRect(-w / 2, h / 2 - 16.5, w, 2.5)
          ctx.restore()
          K.hand(ctx, text, 0, size * 0.35, { family: 'chunky', weight: '600', size, color: o.textColor || C.paperWhite, t, id: id + 'tx', jitter: 0.3 })
          // landing crinkles
          if (!inAir && land < 0.8) inkLine(ctx, [[-w / 2 + 30, -h / 2 + 4], [-w / 2 + 38, h / 2 - 6]], id + 'crk', t, { w: 1.2, color: '#ffffff', alpha: 0.35 * (1 - land), passes: 1 })
        })
      })
      return { w, h }
    })
  }

  window.PROPS = window.PROPS || {}
  Object.assign(window.PROPS, P)
})()

/* props/day.js — paper-collage props for s1 (desk chaos), s2 (the console window),
 * s3 (agents & missions) + a few generic pieces. Owner: props-day. Style = js/kit.js.
 *
 * LAW: every function is a pure function of its arguments. No state survives between
 * calls; randomness only via K.rng/K.seedOf/K.ro keyed on `o.id`; pencil boil via t.
 * No shadowBlur / filter anywhere — depth comes from K.paper / K.dropShadow.
 *
 * ── Common to every prop ─────────────────────────────────────────────────────────────
 *   PROPS.name(ctx, x, y, t, o = {})      (x, y) = visual centre unless noted below.
 *   o.id      seed for all randomness (default: the prop name) — give each instance its own id
 *   o.scale   uniform scale (1)            o.rot     rotation, radians (0)
 *   o.jitter  stop-motion hand-nudge amplitude (1; 0 = rock still)
 *   o.shadow  drop-shadow strength (1)     o.lift    extra shadow offset px — "held up" (0)
 *   o.scale may also be [sx, sy] (squash a terminal flat before it becomes a tab, etc.).
 *   Colours accept a K.C key ('sage') or any CSS colour.
 *   Perf: keep o.rot = 0 on consoleWindow when you can — a rotated 1500 px paper fill takes
 *   Skia's slow path (~2x the cost). Big pieces (≥ 500 px) never add rotation jitter.
 *   Anchors are returned in the CALLER's coordinate space (the transform current at the
 *   call), so a scene can fly things to them even inside its own K.at / camera transform.
 *   Rects are { x, y, w, h, cx, cy } (axis-aligned bounds in caller space).
 *   Canvas state: every prop is wrapped in ctx.save()/restore(), so font, alpha, composite op,
 *   styles, line dash and transform are exactly as the caller left them.
 *   Draw cost (headless CPU, raster flushed, load avg 17–34 on 14 cores): s1 load test (12
 *   terminals + 8 stickies + napkin + ring + "?") 81–114 ms; hero console 59–104 ms; s2+s3 load
 *   test 83–131 ms. stampMark allocates one small offscreen canvas per call (~1 ms).
 *
 * ── s1 desk chaos ────────────────────────────────────────────────────────────────────
 * terminalCard(ctx,x,y,t,o) black paper terminal, rough cream border, 3 title dots,
 *     cream crayon output scribbles, green crayon `> _` with a blinking cursor.
 *     o: w 230, h 160, scribbles 2 (0..4 output lines), label null (tiny cream title text),
 *        typed '' (green text after `>`), typedReveal 1, cursor 'underscore'|'block',
 *        blink true, blinkPhase (auto from id), torn 2.2, tape null (true | colour: crooked
 *        washi strip across the top edge), color termBlack.
 *     → { center, prompt, top }
 * stickyNote(ctx,x,y,t,o) square sticky note with adhesive sheen + bottom-right curl.
 *     o: size 190, color 'butter', text '' ('\n' = new line), textColor ink, textSize auto,
 *        family 'marker', reveal 1 (letters shown 0..1), underline false, curl 0..1,
 *        flutter 0..1 (noise sway, pure of t).   → { center, top, bottom, corner }
 * napkin(ctx,x,y,t,o) scalloped paper napkin with a 3-stroke pencil lightbulb + "big idea!".
 *     o: size 300, doodle 0..1 (1) draw-on: bulb → base → filament → glow ticks → text,
 *        lit 0..1 (default follows doodle) butter crayon fill in the bulb, text 'big idea!',
 *        color paperWhite.   → { center, bulb, top }
 * coffeeRing(ctx,x,y,t,o) brown coffee-cup stain (uneven double ring + drips). Static.
 *     o: r 90, alpha 1 (jitter defaults to 0).   → { center }
 * pencilQuestion(ctx,x,y,t,o) giant sketchy graphite "?" that draws itself: 5 thin rough
 *     passes side by side (tapered, paper shows between them), a hooked flick where the pencil
 *     lands, and a cross-hatched scribbled dot; a cute yellow pencil rides the tip while drawing.
 *     o: size 420 (height), p 0..1 draw-on (1): stroke over 0..0.8, dot pops 0.84..1,
 *        tool true (pencil visible while 0 < p < 0.985), color '#4a4540' graphite.
 *     → { center, tip }
 *
 * ── s2 the console window ────────────────────────────────────────────────────────────
 * consoleWindow(ctx,x,y,t,o) THE hero product shot: torn terracotta border → torn kraft
 *     frame → cream screen; recipe-binder folder tabs on the screen's top edge (inactive
 *     tabs tuck behind the screen, the active one is cream and merges into it); a torn
 *     peach sidebar strip with cut-out word labels (each with a pencil icon); washi-tape
 *     corners; the hand-lettered "Session Manager" plaque top-left; three paper dots top-right.
 *     o: w 1500, h 820,
 *        tabs [{ label, active, lift 0..1, icon, color, p, morph, insert }] (default: Home ·
 *          garden-app · recipe-bot · napkin-idea(active)); icon ∈ home|bulb|leaf|bowl|chat|
 *          folder|clock|pin|flag|dot|null ('Home' → home automatically); tab.p overrides
 *          tabsReveal for that tab (0 hidden → 1 landed, pops with outBack); tab.morph 1→0 is a
 *          PAPER FLIP (see folderTab) about the screen's top edge: black `> _` terminal face →
 *          edge-on kraft sliver at 0.5 → coloured face (the s2 "terminals flatten into tabs"
 *          beat). An active tab stays behind the screen (cream face) while morph > 0 and only
 *          merges into the screen + gets its terracotta "you are here" sticker at morph === 0,
 *        tabsReveal 0..1 (1) staggered tab pop-in,
 *        sidebar [labels] (default Project Home · Sessions · File Explorer · Scheduler ·
 *          Memory · Host on Bilko.run), sidebarReveal 0..1 (1): strip unrolls (0..0.3) then
 *          labels drop in on a stagger, tilted ±4°, sidebarActive index (-1) → terracotta.
 *          The strip unrolls like a scroll (full-size paper revealed down to a travelling peach
 *          roll), its washi tape slaps on over 0.3..0.4; long labels shrink to fit the strip,
 *        title 'Session Manager', plaque 0..1 (1) plaque pop, pins 0..1 (1) washi corners
 *          slap on, dim 0..1 (0) paper veil for staging, content(ctx, rect) callback drawn
 *          in window-local coords after the screen furniture (rect = content area, local),
 *        screenColor cream, sidebarColor peach.
 *     Anchors for tabs / sidebar items are returned even before they are revealed (their
 *     landing spots), so a scene can fly terminals / labels straight to them.
 *     → { center, frame, screen, content, sidebar, sidebarItems:[[x,y]], tabs:[[x,y]] (tab
 *         centres), tabRects:[rect], plaque:[x,y] }  — all in caller space.
 * folderTab(ctx,x,y,t,o) one recipe-binder folder tab (same art the console uses): coloured
 *     tab with a paper label insert.
 *     o: label 'Home', icon auto, color auto (butter), active false (cream, no insert),
 *        lift 0..1, p 0..1 (1) pop-in, insert true, textSize 30, w auto, h 66,
 *        morph 0..1 (0): a paper flip, scaleY = |cos(morph·π)| about the line y = pivot:
 *          morph > 0.5 → terminal face (termBlack, rough cream inner border, 3 title dots,
 *          green `> _`, same language as terminalCard), sy < 0.08 → kraft edge sliver lying on
 *          the pivot line, morph < 0.5 → coloured face. Faces are always full strength (no
 *          crossfade, so no blank frame); a turning shade darkens the face as it tips.
 *        pivot = h/2 (tab-local y of the fold line; default the bottom edge, so it flattens down).
 *     → { center, bottom, w, h }
 * chatTermCard(ctx,x,y,t,o) index card hanging on one strand of terracotta yarn, flipping
 *     about the yarn (scaleX = |cos(flip·π)|). flip 0 = Chat face (cream speech bubble
 *     "Chat" + three bouncing dots), 1 = Terminal face (black, "Terminal", blinking green
 *     `> _`); 2 = Chat again, etc. Exactly one face is ever drawn; edge-on shows a kraft
 *     sliver. The yarn never flips or breaks.
 *     o: w 440, h 300, flip 0, yarn true, yarnLen 240, tapeTop true (washi at yarn top),
 *        swing 0 (radians, pivots the whole thing about the yarn top), chatText 'Chat',
 *        termText 'Terminal', cardColor (chat face card; default a pale sky ruled card so it
 *        separates from a cream screen), lift 10 (shadow offset).
 *     → { center, face:'chat'|'terminal', top (card top edge centre — Pip rides here),
 *         hole, yarnTop, yarnMid (slap the "same session" sticky here), rect }
 *
 * ── s3 agents & missions ─────────────────────────────────────────────────────────────
 * clayButton(ctx,x,y,t,o) chunky squishy clay arcade button, 3/4 view: cream washer → dark
 *     housing collar → clay cylinder → domed cap (lighter crown, thumbprint arcs, paperWhite
 *     rim highlight). The dome squashes flat as it is pressed and bulges past rest on overshoot.
 *     o: r 90, color 'terracotta' (cap is drawn a touch more saturated), label '', press 0..1
 *        (clamped to -0.35..1.25 so a spring can overshoot both ways), depth r·0.44, bezel
 *        cream (washer), icon(ctx, r) callback drawn on the cap (origin = cap centre, y squashed
 *        0.8; e.g. CAST.agent(g, 0, -r*0.05, t, { mini: true, scale: 0.8 })), strip null |
 *        'Hot keys' (torn cream strip ≈ ry·1.55 tall behind the washer, which overhangs it;
 *        lettered at the left), stripColor cream.
 *     → { center, top (dome apex = press point — put the mitten fingertip here), stripLabel }
 * cardBox(ctx,x,y,t,o) kraft recipe-card box, terracotta lid hinged at the back, brass
 *     label holder with "Agent Library". (x, y) = centre of the front face.
 *     o: w 420, h 250, label 'Agent Library', lidOpen 0..1 (may overshoot to ~1.15),
 *        color kraft, lidColor terracotta, inside(ctx) callback drawn between the box's back
 *        and its front (origin = mouth centre) — cards rising out of the box.
 *     → { center, mouth, fan:[[x,y]×3], fanRot:[-0.32, 0, 0.32] }
 * stickerSheet(ctx,x,y,t,o) sticker backing sheet with one sticker per label.
 *     o: labels ['Feature','Bug','Discussion'], colors [sage, tomato, sky], peeled -1,
 *        peel 0..1 (0..0.6 corner curls, 0.6..1 lifts off; ≥1 gone, leaving the die-cut),
 *        w 330.   → { center, stickers:[[x,y]], size:[w,h] }
 * sticker(ctx,x,y,t,o) one die-cut sticker with a white rim and gloss.
 *     o: label 'Feature', color 'sage', curl 0..1, corner 'tr'|'tl'|'br'|'bl', w auto,
 *        h 74, textSize 34.   → { center, w, h }
 * dashedSlot(ctx,x,y,t,o) dashed pencil drop-zone with a two-line label.
 *     o: w 300, h 200, label '1 · agent — who is working' (split at " — ": first part big,
 *        rest smaller on line 2, leading number in terracotta), labelPos 'bottom'|'top',
 *        filled 0..1 (outline turns sage + a check pops in the corner).
 *     → { center, rect, label }
 * envelope(ctx,x,y,t,o) kraft envelope seen from the flap side, with a torn white address
 *     label below the flap tip — the stamp lands on it (light paper, clear of folds + seal).
 *     o: w 440, h 270, color kraft, open 0..1 (flap flips up), stamp 0..1 (stampMark p),
 *        stampText 'Actor → Input → Mission → Goal' (auto-broken before the middle arrow into
 *        two lines when it doesn't fit; '\n' forces a break), stampSize 30, stampColor
 *        terracotta, stampDarken 0.2 (ink darkening), stampTool true, addressLabel true,
 *        seal true (tiny heart on the closed flap), contents(ctx) callback drawn behind the
 *        pocket (origin = mouth centre) — slide cards in by moving them down.
 *     → { center, mouth, stamp (label centre), addressLabel (rect) }
 * stampMark(ctx,x,y,t,o) rubber-stamp ink impression, speckled + uneven, multiplied onto
 *     the paper, with an optional wooden stamp (block with a visible rubber + foam layer,
 *     turned-wood handle with a tomato cap; two handles on stamps wider than 300 px) that
 *     thunks down and lifts away.
 *     o: text 'Actor → Input → Mission → Goal' ('→' is drawn as a hand arrow; '\n' = new
 *        line), color terracotta, darken 0 (0..1 ink darkening), fade 0.2 (dry side
 *        strength), p 0..1 (0..0.35 tool drops, 0.35 THUNK impression, 0.6..0.9 lifts),
 *        tool true, size 30 (font px), shape 'rect'|'round', family 'chunky'.
 *     → { center, w, h }
 * door(ctx,x,y,t,o) paper door in a torn kraft frame, "Session" plate, hinge on the left.
 *     o: w 250, h 400, label 'Session', open 0..1 (door face narrows linearly — 0.1 already
 *        shows a readable crack, 1 ≈ 83° swing), glow 0..1 (lemon light
 *        under the door; plus a crayon light-beam wedge from the crack when open > 0),
 *        color hiveTeal, frameColor kraft.
 *     → { center, gap (bottom-centre slot the envelope slides under), crack, knob, top }
 *
 * ── generic ──────────────────────────────────────────────────────────────────────────
 * indexCard(ctx,x,y,t,o) ruled index card.
 *     o: w 360, h 220, color paperWhite, title null (on the red header line), lines 3
 *        (count of empty rules, or array of strings), checkboxes 0 (count or array of bools
 *        = checked), textSize 28, reveal 1, torn false (top edge ripped off a pad).
 *     → { center, rows:[[x,y]], boxes:[[x,y]] }
 * speedLines(ctx,x,y,t,o) pencil motion lines. (x, y) = the point just BEHIND the mover.
 *     o: dir 0 (radians, direction of MOTION — lines trail the other way), len 160, n 4,
 *        spread 80, p 1 (strength/alpha 0..1), color inkDim, width 3.2, gap 10.
 * doodlePuff(ctx,x,y,t,o) doodle "poof" (for presses/landings): three lumpy 5–6-bump paper
 *     clouds (sizes 1 / 0.8 / 0.65) born overlapping as one cloud, then bursting apart + specks.
 *     o: r 70, p 0..1 (0 and 1 draw nothing; pops out by 0.35, fades by 1), n 3,
 *        color ink, fill paperWhite.
 */
(function () {
  'use strict'
  const K = window.K
  const C = K.C
  const PROPS = (window.PROPS = window.PROPS || {})
  const TAU = Math.PI * 2
  // the props this file defines (wrapped by the canvas-state guard at the bottom)
  const PROPS_DAY = {}
  ;['terminalCard', 'stickyNote', 'napkin', 'coffeeRing', 'pencilQuestion', 'folderTab', 'consoleWindow',
    'chatTermCard', 'clayButton', 'cardBox', 'sticker', 'stickerSheet', 'dashedSlot', 'stampMark', 'envelope',
    'door', 'indexCard', 'speedLines', 'doodlePuff'].forEach((n) => (PROPS_DAY[n] = 1))

  // ───────────────────────── helpers (private) ─────────────────────────
  const def = (v, d) => (v === undefined || v === null ? d : v)
  const col = (c, d) => (c === undefined || c === null ? d : C[c] || c)

  function rgbOf(c) {
    if (typeof c === 'string' && c[0] === '#') {
      let h = c.slice(1)
      if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('')
      const n = parseInt(h.slice(0, 6), 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    const m = typeof c === 'string' && c.match(/rgba?\(([^)]+)\)/)
    if (m) {
      const p = m[1].split(',').map(Number)
      return [p[0], p[1], p[2]]
    }
    return [128, 128, 128]
  }
  const hex2 = (v) => Math.round(K.clamp(v, 0, 255)).toString(16).padStart(2, '0')
  /** amt > 0 lightens toward warm white, amt < 0 darkens toward warm umber. */
  function shade(c, amt) {
    const [r, g, b] = rgbOf(c)
    const tg = amt >= 0 ? [255, 252, 244] : [42, 26, 14]
    const a = Math.min(1, Math.abs(amt))
    return '#' + hex2(r + (tg[0] - r) * a) + hex2(g + (tg[1] - g) * a) + hex2(b + (tg[2] - b) * a)
  }
  function rgba(c, a) {
    const [r, g, b] = rgbOf(c)
    return `rgba(${r},${g},${b},${a})`
  }
  function lum(c) {
    const [r, g, b] = rgbOf(c)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  }
  const inkOn = (bg) => (lum(bg) < 0.55 ? C.paperWhite : C.ink)

  /** Map local points (under whatever transform is current when called) to the caller's space. */
  function mapper(ctx) {
    let inv = null
    try {
      inv = ctx.getTransform().invertSelf()
      if (!(isFinite(inv.a) && isFinite(inv.d) && isFinite(inv.e) && isFinite(inv.f))) inv = null
    } catch (e) {
      inv = null
    }
    return (lx, ly) => {
      const p = ctx.getTransform().transformPoint(new DOMPoint(lx, ly))
      const q = inv ? inv.transformPoint(p) : p
      return [q.x, q.y]
    }
  }
  function mapRect(mk, x, y, w, h) {
    const ps = [mk(x, y), mk(x + w, y), mk(x + w, y + h), mk(x, y + h)]
    const xs = ps.map((p) => p[0])
    const ys = ps.map((p) => p[1])
    const x0 = Math.min(...xs)
    const y0 = Math.min(...ys)
    const r = { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }
    r.cx = r.x + r.w / 2
    r.cy = r.y + r.h / 2
    return r
  }
  /** Place a prop: scale, rotation and a stop-motion nudge (rotation damped for big pieces). */
  function place(ctx, x, y, t, o, id, size, fn) {
    const amp = def(o.jitter, 1)
    const n = amp ? K.nudge(id, t, amp) : { dx: 0, dy: 0, rot: 0 }
    // big pieces nudge by translation only: a rotated 1M-px pattern fill costs ~4x in CPU raster
    const rs = size >= 500 ? 0 : Math.min(1, 240 / Math.max(1, size))
    K.at(ctx, x + n.dx, y + n.dy, def(o.rot, 0) + n.rot * rs, def(o.scale, 1), fn)
  }
  /** Open rough polyline (crayon / pencil stroke). */
  function stroke(ctx, pts, id, t, o) {
    if (pts.length < 2) return
    K.rc(ctx).linearPath(pts, K.ro(id, t, o))
  }
  /** Truncate a polyline to fraction p of its length. */
  function partial(pts, p) {
    if (p >= 1) return pts.slice()
    if (p <= 0) return [pts[0]]
    const seg = []
    let L = 0
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
      seg.push(d)
      L += d
    }
    let rem = L * p
    const out = [pts[0]]
    for (let i = 1; i < pts.length; i++) {
      if (rem >= seg[i - 1]) {
        out.push(pts[i])
        rem -= seg[i - 1]
      } else {
        const f = seg[i - 1] ? rem / seg[i - 1] : 0
        out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f])
        break
      }
    }
    return out
  }
  function quadPts(p0, c, p1, n) {
    const out = []
    for (let i = 0; i <= n; i++) {
      const u = i / n
      out.push([(1 - u) * (1 - u) * p0[0] + 2 * (1 - u) * u * c[0] + u * u * p1[0], (1 - u) * (1 - u) * p0[1] + 2 * (1 - u) * u * c[1] + u * u * p1[1]])
    }
    return out
  }
  /** Text width. Leaves ctx.font untouched (props must not leak canvas state). */
  function measure(ctx, str, family, size, weight) {
    const f = ctx.font
    K.font(ctx, family, size, weight || '')
    const w = ctx.measureText(str).width
    ctx.font = f
    return w
  }
  /** Hand lettering vertically centred on y. */
  function text(ctx, str, x, y, o) {
    const size = o.size || 32
    return K.hand(ctx, str, x, y + size * 0.34, o)
  }
  function circle(ctx, x, y, r, fill) {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.fillStyle = fill
    ctx.fill()
  }

  /** Rect (centred) with corner radius r and one corner folded over by c px. */
  function foldRect(w, h, r, corner, c) {
    const hw = w / 2
    const hh = h / 2
    const spec = { tl: [-hw, -hh, Math.PI], tr: [hw, -hh, -Math.PI / 2], br: [hw, hh, 0], bl: [-hw, hh, Math.PI / 2] }
    const body = []
    let flap = null
    for (const k of ['tl', 'tr', 'br', 'bl']) {
      const [cx, cy, a0] = spec[k]
      const sx = Math.sign(cx)
      const sy = Math.sign(cy)
      if (k === corner && c > 0.5) {
        const hp = [cx - sx * c, cy]
        const vp = [cx, cy - sy * c]
        const first = k === 'tl' || k === 'br' ? vp : hp
        const second = first === vp ? hp : vp
        body.push(first, second)
        flap = [first, second, [cx - sx * c, cy - sy * c]]
      } else if (r > 0) {
        const ox = cx - sx * r
        const oy = cy - sy * r
        for (let i = 0; i <= 4; i++) {
          const a = a0 + (i / 4) * (Math.PI / 2)
          body.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r])
        }
      } else body.push([cx, cy])
    }
    return { body, flap }
  }
  /** Curled-over corner: soft shadow on the body, then the flap's back with a fold gradient. */
  function drawFlap(ctx, flap, back, id, t) {
    const [a, b, tip] = flap
    const mx = (a[0] + b[0]) / 2
    const my = (a[1] + b[1]) / 2
    ctx.save()
    // shadow the curl casts toward the tip
    const dx = (tip[0] - mx) * 0.22
    const dy = (tip[1] - my) * 0.22
    K.pathPoly(ctx, [a, b, [tip[0] + dx, tip[1] + dy]])
    ctx.fillStyle = 'rgba(58,36,14,0.16)'
    ctx.fill()
    // the flap, bowed like a curl
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    ctx.quadraticCurveTo((b[0] + tip[0]) / 2 + dx * 0.4, (b[1] + tip[1]) / 2 + dy * 0.4, tip[0], tip[1])
    ctx.quadraticCurveTo((a[0] + tip[0]) / 2 + dx * 0.4, (a[1] + tip[1]) / 2 + dy * 0.4, a[0], a[1])
    ctx.closePath()
    const g = ctx.createLinearGradient(mx, my, tip[0], tip[1])
    g.addColorStop(0, shade(back, 0.35))
    g.addColorStop(1, shade(back, -0.06))
    ctx.fillStyle = g
    ctx.fill()
    ctx.lineWidth = 1.4
    ctx.strokeStyle = 'rgba(42,34,26,0.35)'
    ctx.stroke()
    ctx.restore()
  }

  function mix(a, b, p) {
    const A = rgbOf(a)
    const B = rgbOf(b)
    return '#' + hex2(A[0] + (B[0] - A[0]) * p) + hex2(A[1] + (B[1] - A[1]) * p) + hex2(A[2] + (B[2] - A[2]) * p)
  }
  /** Nudge a colour's HSL saturation / lightness (ds, dl in 0..1 units). */
  function saturate(c, ds, dl) {
    let [r, g, b] = rgbOf(c).map((v) => v / 255)
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    let hh = 0
    let s = 0
    let l = (mx + mn) / 2
    if (mx !== mn) {
      const d = mx - mn
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
      hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
      hh /= 6
    }
    s = K.clamp01(s + (ds || 0))
    l = K.clamp01(l + (dl || 0))
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    const hue = (tt) => {
      if (tt < 0) tt += 1
      if (tt > 1) tt -= 1
      if (tt < 1 / 6) return p + (q - p) * 6 * tt
      if (tt < 1 / 2) return q
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
      return p
    }
    ;[r, g, b] = s === 0 ? [l, l, l] : [hue(hh + 1 / 3), hue(hh), hue(hh - 1 / 3)]
    return '#' + hex2(r * 255) + hex2(g * 255) + hex2(b * 255)
  }
  /** Path of `poly` with `hole` cut out (fill with 'evenodd'). */
  function ringPath(ctx, poly, hole) {
    K.pathPoly(ctx, poly)
    if (!hole) return
    ctx.moveTo(hole[0][0], hole[0][1])
    for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i][0], hole[i][1])
    ctx.closePath()
  }
  /** K.dropShadow's three fake layers, but ring-shaped (skips the area the piece covers anyway). */
  function ringShadow(ctx, poly, hole, strength, lift) {
    if (strength <= 0) return
    const ox = 3 + lift * 0.5
    const oy = 5 + lift
    ctx.save()
    const layer = (dx, dy, a) => {
      ctx.translate(dx, dy)
      ringPath(ctx, poly, hole)
      ctx.fillStyle = `rgba(58,36,14,${a * strength})`
      ctx.fill('evenodd')
    }
    layer(ox * 1.7, oy * 1.7, 0.07)
    layer(-ox * 0.8, -oy * 0.8, 0.13)
    layer(-ox * 0.5, -oy * 0.5, 0.1)
    ctx.restore()
  }
  /**
   * K.paper look (torn/cut edge, white fibre rim, fake shadow, grain) for a BIG piece whose middle
   * is hidden under the next layer: only the ring outside `hole` is filled. Same art, a fraction
   * of the raster cost. `hole` must lie fully under whatever is drawn on top.
   */
  function paperRing(ctx, pts, hole, color, o) {
    const torn = o.torn || 0
    const cut = o.cut === undefined ? 2.5 : o.cut
    const seed = o.seed || 'p'
    const shape = torn ? K.tear(pts, torn, seed) : cut ? K.wobble(pts, cut, seed) : pts
    const rim = torn ? K.tear(K.grow(pts, torn * 0.9 + 2), torn * 0.8, seed, 'rim') : null
    ringShadow(ctx, rim || shape, hole, def(o.shadow, 1), def(o.lift, 0))
    if (rim) {
      ringPath(ctx, rim, hole)
      ctx.fillStyle = K.paperPattern(ctx, C.paperWhite)
      ctx.fill('evenodd')
    }
    ringPath(ctx, shape, hole)
    ctx.fillStyle = K.paperPattern(ctx, color)
    ctx.fill('evenodd')
    return shape
  }

  /** Tiny pencil icon doodles, centred at (cx, cy), about s px across. */
  function drawIcon(ctx, kind, cx, cy, s, id, t, color, accent) {
    const h = s / 2
    const o = { stroke: color, strokeWidth: Math.max(1.8, s * 0.085), roughness: 0.7, bowing: 0.5 }
    const P = K.pencil
    switch (kind) {
      case 'home':
        if (accent) P.rect(ctx, cx - h * 0.55, cy - h * 0.1, h * 1.1, h * 0.9, id + 'hb', t, { ...o, fill: accent, fillStyle: 'solid' })
        else P.rect(ctx, cx - h * 0.55, cy - h * 0.1, h * 1.1, h * 0.9, id + 'hb', t, o)
        stroke(ctx, [[cx - h * 0.85, cy - h * 0.02], [cx, cy - h * 0.82], [cx + h * 0.85, cy - h * 0.02]], id + 'hr', t, o)
        stroke(ctx, [[cx - h * 0.14, cy + h * 0.8], [cx - h * 0.14, cy + h * 0.32], [cx + h * 0.16, cy + h * 0.32], [cx + h * 0.16, cy + h * 0.8]], id + 'hd', t, { ...o, strokeWidth: o.strokeWidth * 0.8 })
        break
      case 'bulb':
        P.circle(ctx, cx, cy - h * 0.2, h * 1.25, id + 'bc', t, accent ? { ...o, fill: accent, fillStyle: 'solid' } : o)
        stroke(ctx, [[cx - h * 0.28, cy + h * 0.5], [cx + h * 0.28, cy + h * 0.5]], id + 'b1', t, o)
        stroke(ctx, [[cx - h * 0.22, cy + h * 0.78], [cx + h * 0.22, cy + h * 0.78]], id + 'b2', t, o)
        break
      case 'leaf':
        P.path(ctx, `M${cx - h * 0.75},${cy + h * 0.7} Q${cx - h * 0.85},${cy - h * 0.75} ${cx + h * 0.75},${cy - h * 0.75} Q${cx + h * 0.7},${cy + h * 0.6} ${cx - h * 0.75},${cy + h * 0.7} Z`, id + 'lf', t, accent ? { ...o, fill: accent, fillStyle: 'solid' } : o)
        stroke(ctx, [[cx - h * 0.9, cy + h * 0.85], [cx + h * 0.35, cy - h * 0.35]], id + 'lv', t, o)
        break
      case 'bowl':
        P.path(ctx, `M${cx - h * 0.9},${cy} Q${cx - h * 0.8},${cy + h * 0.95} ${cx},${cy + h * 0.9} Q${cx + h * 0.8},${cy + h * 0.95} ${cx + h * 0.9},${cy} Z`, id + 'bw', t, accent ? { ...o, fill: accent, fillStyle: 'solid' } : o)
        stroke(ctx, [[cx - h * 0.25, cy - h * 0.25], [cx - h * 0.1, cy - h * 0.5], [cx - h * 0.25, cy - h * 0.8]], id + 's1', t, o)
        stroke(ctx, [[cx + h * 0.2, cy - h * 0.25], [cx + h * 0.35, cy - h * 0.5], [cx + h * 0.2, cy - h * 0.8]], id + 's2', t, o)
        break
      case 'chat':
        P.ellipse(ctx, cx + h * 0.05, cy - h * 0.12, h * 1.8, h * 1.3, id + 'ce', t, accent ? { ...o, fill: accent, fillStyle: 'solid' } : o)
        stroke(ctx, [[cx - h * 0.45, cy + h * 0.35], [cx - h * 0.75, cy + h * 0.85], [cx - h * 0.05, cy + h * 0.5]], id + 'ct', t, o)
        break
      case 'folder':
        P.poly(ctx, [[cx - h * 0.9, cy - h * 0.6], [cx - h * 0.25, cy - h * 0.6], [cx - h * 0.1, cy - h * 0.38], [cx + h * 0.9, cy - h * 0.38], [cx + h * 0.9, cy + h * 0.7], [cx - h * 0.9, cy + h * 0.7]], id + 'fo', t, accent ? { ...o, fill: accent, fillStyle: 'solid' } : o)
        break
      case 'clock':
        P.circle(ctx, cx, cy, h * 1.75, id + 'ck', t, accent ? { ...o, fill: accent, fillStyle: 'solid' } : o)
        stroke(ctx, [[cx, cy - h * 0.55], [cx, cy], [cx + h * 0.42, cy + h * 0.2]], id + 'kh', t, o)
        break
      case 'pin':
        P.circle(ctx, cx, cy - h * 0.3, h * 1.1, id + 'ph', t, { ...o, fill: accent || C.terracotta, fillStyle: 'solid' })
        stroke(ctx, [[cx, cy + h * 0.25], [cx, cy + h * 0.95]], id + 'pn', t, o)
        break
      case 'flag':
        stroke(ctx, [[cx - h * 0.6, cy + h * 0.95], [cx - h * 0.6, cy - h * 0.9]], id + 'fp', t, o)
        P.poly(ctx, [[cx - h * 0.6, cy - h * 0.9], [cx + h * 0.85, cy - h * 0.55], [cx - h * 0.6, cy - h * 0.15]], id + 'ff', t, { ...o, fill: accent || C.butter, fillStyle: 'solid' })
        break
      default:
        P.circle(ctx, cx, cy, h * 0.9, id + 'dt', t, { ...o, fill: accent || color, fillStyle: 'solid' })
    }
  }

  const WASHI = ['rgba(244,193,69,0.78)', 'rgba(111,125,82,0.66)', 'rgba(63,153,144,0.62)', 'rgba(242,169,192,0.8)', 'rgba(184,92,52,0.62)']

  // ───────────────────────── s1 desk chaos ─────────────────────────

  PROPS.terminalCard = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'term')
    const w = def(o.w, 230)
    const h = def(o.h, 160)
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, Math.max(w, h), () => {
      K.paper(ctx, K.boxPts(w, h), col(o.color, C.termBlack), { torn: def(o.torn, 2.2), shadow: def(o.shadow, 1), lift: def(o.lift, 0), seed: id })
      const cream = C.cream
      K.pencil.rect(ctx, -w / 2 + 9, -h / 2 + 9, w - 18, h - 18, id + 'bd', t, { stroke: rgba(cream, 0.8), strokeWidth: 2.2, roughness: 1.5, bowing: 1.4 })
      // title-bar dots
      for (let i = 0; i < 3; i++) circle(ctx, -w / 2 + 25 + i * 13, -h / 2 + 25, 3.8, rgba(i === 0 ? C.coral : cream, i === 0 ? 0.85 : 0.7))
      if (o.label) text(ctx, o.label, -w / 2 + 70, -h / 2 + 25, { family: 'hand', size: 19, color: rgba(cream, 0.85), align: 'left', t, id: id + 'lb', jitter: 0.5 })
      // cream crayon "output" scribbles
      const r = K.rng('termscr', id)
      const n = Math.max(0, Math.min(4, def(o.scribbles, 2)))
      const lx = -w / 2 + 25
      const py = h / 2 - 40
      const top = -h / 2 + 50
      const step = n > 1 ? Math.min(20, (py - 30 - top) / (n - 1)) : 0
      for (let i = 0; i < n; i++) {
        const yy = top + i * step
        const len = (w - 64) * (0.3 + r() * 0.6)
        stroke(ctx, [[lx, yy], [lx + len * 0.5, yy + (r() - 0.5) * 3], [lx + len, yy + (r() - 0.5) * 3]], id + 's' + i, t, { stroke: rgba(cream, 0.45), strokeWidth: 3, roughness: 1.3 })
      }
      // green crayon prompt
      const g = C.crayonGreen
      stroke(ctx, [[lx, py - 15], [lx + 19, py], [lx, py + 15]], id + 'gt', t, { stroke: g, strokeWidth: 5.6, roughness: 1.1 })
      let cx0 = lx + 33
      if (o.typed) {
        text(ctx, o.typed, cx0, py - 1, { family: 'hand', size: 26, color: g, align: 'left', t, id: id + 'ty', reveal: def(o.typedReveal, 1), jitter: 0.6 })
        cx0 += measure(ctx, o.typed, 'hand', 26) * K.clamp01(def(o.typedReveal, 1)) + 8
      }
      const ph = def(o.blinkPhase, (K.hash(id, 'blink') % 100) / 100)
      const on = !def(o.blink, true) || (t * 0.95 + ph) % 1 < 0.56
      if (on) {
        if (o.cursor === 'block') K.pencil.rect(ctx, cx0, py - 16, 18, 32, id + 'cu', t, { fill: g, fillStyle: 'solid', stroke: g, strokeWidth: 2, roughness: 0.9 })
        else stroke(ctx, [[cx0, py + 15], [cx0 + 25, py + 15]], id + 'cu', t, { stroke: g, strokeWidth: 6.5, roughness: 0.9 })
      }
      if (o.tape) {
        const tr = K.rng('termtape', id)
        const color = typeof o.tape === 'string' ? o.tape : WASHI[Math.floor(tr() * 3)]
        K.tape(ctx, (tr() - 0.5) * w * 0.4, -h / 2 + 3, w * 0.46, (tr() - 0.5) * 0.5, color, { h: 30, seed: id + 'tp', pattern: tr() < 0.5 ? 'dots' : null })
      }
      out = { center: mk(0, 0), prompt: mk(lx + 8, py), top: mk(0, -h / 2) }
    })
    return out
  }

  PROPS.stickyNote = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'sticky')
    const s = def(o.size, 190)
    const color = col(o.color, C.butter)
    const curl = K.clamp01(def(o.curl, 0))
    const fl = def(o.flutter, 0)
    const frot = fl ? K.noise1(t * 2.3, 'flut', id) * 0.09 * fl : 0
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, Object.assign({}, o, { rot: def(o.rot, 0) + frot }), id, s, () => {
      const c = curl * s * 0.34
      const { body, flap } = foldRect(s, s, 3, 'br', c)
      const shape = K.paper(ctx, body, color, { cut: 1.4, shadow: def(o.shadow, 1), lift: def(o.lift, 0) + curl * 5 + fl * 3, seed: id })
      ctx.save()
      K.pathPoly(ctx, shape)
      ctx.clip()
      const gr = ctx.createLinearGradient(0, -s / 2, 0, s / 2)
      gr.addColorStop(0, 'rgba(255,255,255,0.16)')
      gr.addColorStop(0.2, 'rgba(255,255,255,0.05)')
      gr.addColorStop(0.21, 'rgba(0,0,0,0)')
      gr.addColorStop(1, 'rgba(90,60,20,0.1)')
      ctx.fillStyle = gr
      ctx.fillRect(-s / 2 - 4, -s / 2 - 4, s + 8, s + 8)
      ctx.restore()
      if (o.text) {
        const lines = String(o.text).split('\n')
        const fam = def(o.family, 'marker')
        let size = def(o.textSize, s * 0.2)
        const widest = Math.max(...lines.map((l) => measure(ctx, l, fam, size)))
        if (widest > s * 0.84) size *= (s * 0.84) / widest
        const lh = size * 1.1
        const tc = col(o.textColor, lum(color) < 0.5 ? C.paperWhite : C.ink)
        const rev = def(o.reveal, 1)
        const total = lines.reduce((a, l) => a + l.length, 0) || 1
        let used = 0
        K.at(ctx, 0, 0, -0.04, 1, () => {
          lines.forEach((l, i) => {
            const ly = (i - (lines.length - 1) / 2) * lh - s * 0.02
            const lr = K.clamp01((rev * total - used) / Math.max(1, l.length))
            used += l.length
            if (lr > 0) text(ctx, l, 0, ly, { family: fam, size, color: tc, t, id: id + 't' + i, reveal: lr, jitter: 0.8 })
          })
          if (o.underline && rev >= 1) {
            const uw = Math.min(s * 0.7, widest * (size / def(o.textSize, s * 0.2)))
            const uy = ((lines.length - 1) / 2) * lh + size * 0.55
            stroke(ctx, [[-uw / 2, uy], [0, uy + 4], [uw / 2, uy - 2]], id + 'ul', t, { stroke: C.terracotta, strokeWidth: 3.5, roughness: 1.4 })
          }
        })
      }
      if (flap) drawFlap(ctx, flap, color, id, t)
      out = { center: mk(0, 0), top: mk(0, -s / 2), bottom: mk(0, s / 2), corner: mk(s / 2 - c * 0.5, s / 2 - c * 0.5) }
    })
    return out
  }

  function scallopPts(w, h, bump) {
    const hw = w / 2
    const hh = h / 2
    const cs = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
    const pts = []
    for (let e = 0; e < 4; e++) {
      const [ax, ay] = cs[e]
      const [bx, by] = cs[(e + 1) % 4]
      const L = Math.hypot(bx - ax, by - ay)
      const dx = (bx - ax) / L
      const dy = (by - ay) / L
      const nx = dy
      const ny = -dx
      const cnt = Math.max(3, Math.round(L / bump))
      const r = L / cnt / 2
      for (let k = 0; k < cnt; k++) {
        const mx = ax + dx * (2 * k + 1) * r
        const my = ay + dy * (2 * k + 1) * r
        for (let j = 0; j < 6; j++) {
          const th = (j / 6) * Math.PI
          pts.push([mx - Math.cos(th) * r * dx + Math.sin(th) * r * 0.75 * nx, my - Math.cos(th) * r * dy + Math.sin(th) * r * 0.75 * ny])
        }
      }
    }
    return pts
  }

  PROPS.napkin = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'napkin')
    const s = def(o.size, 300)
    const doodle = K.clamp01(def(o.doodle, 1))
    const lit = K.clamp01(def(o.lit, K.seg(doodle, 0.62, 0.8)))
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, s, () => {
      K.paper(ctx, scallopPts(s, s, 30), col(o.color, C.paperWhite), { cut: 0.8, shadow: def(o.shadow, 1), lift: def(o.lift, 0), seed: id })
      // printed emboss border + fold creases
      ctx.save()
      ctx.setLineDash([3, 7])
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(120,100,70,0.22)'
      ctx.strokeRect(-s / 2 + 22, -s / 2 + 22, s - 44, s - 44)
      ctx.setLineDash([])
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(120,100,70,0.1)'
      ctx.beginPath()
      ctx.moveTo(0, -s / 2 + 8)
      ctx.lineTo(0, s / 2 - 8)
      ctx.moveTo(-s / 2 + 8, 0)
      ctx.lineTo(s / 2 - 8, 0)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'
      ctx.beginPath()
      ctx.moveTo(1.5, -s / 2 + 8)
      ctx.lineTo(1.5, s / 2 - 8)
      ctx.moveTo(-s / 2 + 8, 1.5)
      ctx.lineTo(s / 2 - 8, 1.5)
      ctx.stroke()
      ctx.restore()
      // the lightbulb doodle (three strokes), then glow ticks, then "big idea!"
      const k = s / 300
      const bx = 0
      const by = -s * 0.13
      const R = 48 * k
      const bulb = []
      bulb.push([bx - R * 0.42, by + R * 1.28])
      for (let a = 118; a <= 422; a += 12) {
        const rad = (a * Math.PI) / 180
        bulb.push([bx + Math.cos(rad) * R, by + Math.sin(rad) * R])
      }
      bulb.push([bx + R * 0.42, by + R * 1.28])
      const base = [[bx - R * 0.5, by + R * 1.34], [bx + R * 0.5, by + R * 1.34], [bx + R * 0.44, by + R * 1.58], [bx - R * 0.44, by + R * 1.58], [bx - R * 0.3, by + R * 1.8], [bx + R * 0.3, by + R * 1.8]]
      const fil = [[bx - R * 0.3, by + R * 1.2], [bx - R * 0.26, by + R * 0.1], [bx - R * 0.12, by + R * 0.34], [bx, by + R * 0.06], [bx + R * 0.12, by + R * 0.34], [bx + R * 0.26, by + R * 0.1], [bx + R * 0.3, by + R * 1.2]]
      if (lit > 0) {
        ctx.save()
        ctx.globalAlpha *= lit
        ctx.beginPath()
        ctx.arc(bx, by, R * 1.75, 0, TAU)
        ctx.fillStyle = 'rgba(247,222,138,0.35)'
        ctx.fill()
        K.pencil.circle(ctx, bx, by, R * 1.9, id + 'lit', t, { fill: C.lemon, fillStyle: 'hachure', hachureGap: 5, fillWeight: 3.5, hachureAngle: -40, stroke: 'none', roughness: 1.4 })
        ctx.restore()
      }
      const pencilO = { stroke: C.ink, strokeWidth: 3.4 * k, roughness: 1.1, bowing: 0.8 }
      const p1 = K.seg(doodle, 0, 0.3)
      const p2 = K.seg(doodle, 0.3, 0.42)
      const p3 = K.seg(doodle, 0.42, 0.56)
      const p4 = K.seg(doodle, 0.56, 0.66)
      const p5 = K.seg(doodle, 0.64, 1)
      if (p1 > 0) K.pencil.curve(ctx, partial(bulb, p1), id + 'bu', t, pencilO)
      if (p2 > 0) stroke(ctx, partial(base, p2), id + 'ba', t, pencilO)
      if (p3 > 0) stroke(ctx, partial(fil, p3), id + 'fi', t, { ...pencilO, stroke: C.terracotta, strokeWidth: 2.8 * k })
      if (p4 > 0) {
        for (let i = 0; i < 3; i++) {
          const a = (-150 + i * 60) * (Math.PI / 180)
          const q = K.clamp01(p4 * 3 - i)
          if (q <= 0) continue
          const r1 = R * 1.3
          const r2 = R * (1.3 + 0.45 * q)
          stroke(ctx, [[bx + Math.cos(a) * r1, by + Math.sin(a) * r1], [bx + Math.cos(a) * r2, by + Math.sin(a) * r2]], id + 'gk' + i, t, { stroke: C.honey, strokeWidth: 4 * k, roughness: 0.8 })
        }
      }
      if (p5 > 0) text(ctx, def(o.text, 'big idea!'), 0, s * 0.3, { family: 'marker', size: 40 * k, color: C.terracotta, t, id: id + 'tx', reveal: p5, jitter: 0.8 })
      out = { center: mk(0, 0), bulb: mk(bx, by), top: mk(0, -s / 2) }
    })
    return out
  }

  PROPS.coffeeRing = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'coffee')
    const r = def(o.r, 90)
    const a = def(o.alpha, 1)
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, Object.assign({ jitter: 0 }, o), id, r * 2, () => {
      const ring = (cx, cy, rr, from, span, key, wMul, al) => {
        const N = 56
        let prev = null
        for (let i = 0; i <= N * span; i++) {
          const th = from + (i / N) * TAU
          const rad = rr * (1 + K.noise1(i * 0.22, 'cr', id, key) * 0.035)
          const pt = [cx + Math.cos(th) * rad, cy + Math.sin(th) * rad * 0.97]
          if (prev) {
            const wv = (0.5 + 0.9 * K.clamp01(0.5 + K.noise1(i * 0.15, 'cw', id, key))) * wMul
            ctx.beginPath()
            ctx.moveTo(prev[0], prev[1])
            ctx.lineTo(pt[0], pt[1])
            ctx.lineWidth = wv
            ctx.strokeStyle = `rgba(118,70,32,${al * a})`
            ctx.stroke()
          }
          prev = pt
        }
      }
      ctx.save()
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.97, 0, TAU)
      ctx.fillStyle = `rgba(150,96,46,${0.07 * a})`
      ctx.fill()
      ring(0, 0, r * 0.93, 0, 1, 'a', r * 0.09, 0.2)
      ring(0, 0, r, 0.4, 0.9, 'b', r * 0.035, 0.42)
      ring(r * 0.22, r * 0.12, r * 0.96, 2.2, 0.42, 'c', r * 0.03, 0.3)
      circle(ctx, r * 0.95, r * 0.62, r * 0.06, `rgba(118,70,32,${0.28 * a})`)
      circle(ctx, r * 1.12, r * 0.52, r * 0.03, `rgba(118,70,32,${0.25 * a})`)
      ctx.restore()
      out = { center: mk(0, 0) }
    })
    return out
  }

  function questionPts(S) {
    // a little hooked flick where the pencil lands, curling up into the top arc
    const pts = [[-0.198 * S, -0.082 * S], [-0.226 * S, -0.098 * S], [-0.242 * S, -0.122 * S]]
    const cx = 0
    const cy = -0.2 * S
    const RX = 0.25 * S
    const RY = 0.215 * S
    for (let a = 168; a <= 395; a += 9) {
      const rad = (a * Math.PI) / 180
      pts.push([cx + Math.cos(rad) * RX, cy + Math.sin(rad) * RY])
    }
    const e = pts[pts.length - 1]
    quadPts(e, [0.0 * S, 0.02 * S], [0.01 * S, 0.12 * S], 6).slice(1).forEach((p) => pts.push(p))
    pts.push([0.01 * S, 0.21 * S])
    return pts
  }
  // sketch passes for the "?": perpendicular offset (px at size 420), width, alpha, roughness, lag
  const QPASSES = [
    { off: 0.5, w: 6.2, a: 0.9, rough: 1.6, lag: 0, s0: 0, s1: 1 },
    { off: -4, w: 5, a: 0.8, rough: 1.8, lag: 0.03, s0: 0.02, s1: 1 },
    { off: 4.5, w: 4.8, a: 0.78, rough: 1.9, lag: 0.05, s0: 0.05, s1: 0.98 },
    { off: -8, w: 3.8, a: 0.7, rough: 2.1, lag: 0.08, s0: 0.1, s1: 0.94 },
    { off: 8.5, w: 3.6, a: 0.68, rough: 2.2, lag: 0.1, s0: 0.14, s1: 0.9 },
  ]
  /** Offset a polyline sideways by `off` px (plus a slow noise wander of ±wav px). */
  function offsetLine(pts, off, wav, id) {
    const n = pts.length
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)]
      const b = pts[Math.min(n - 1, i + 1)]
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const L = Math.hypot(dx, dy) || 1
      const d = off + K.noise1(i * 0.28, 'qoff', id) * wav
      return [p[0] - (dy / L) * d, p[1] + (dx / L) * d]
    })
  }
  function drawPencilTool(ctx, len, t, id) {
    // along +x from the tip (0,0): graphite, wood cone, yellow body, ferrule, eraser
    const w = len * 0.13
    const hw = w / 2
    const cone = len * 0.16
    const body = len * 0.66
    const fer = len * 0.08
    const er = len * 0.1
    const x1 = cone
    const x2 = cone + body
    const x3 = x2 + fer
    const x4 = x3 + er
    K.dropShadow(ctx, [[0, 0], [x1, -hw], [x4, -hw], [x4, hw], [x1, hw]], 0.9, 10)
    K.pathPoly(ctx, [[0, 0], [x1, -hw], [x1, hw]])
    ctx.fillStyle = K.paperPattern(ctx, '#e9c79a')
    ctx.fill()
    K.pathPoly(ctx, [[0, 0], [x1 * 0.34, -hw * 0.34], [x1 * 0.34, hw * 0.34]])
    ctx.fillStyle = '#3b3631'
    ctx.fill()
    K.pathPoly(ctx, [[x1, -hw], [x2, -hw], [x2, hw], [x1, hw]])
    ctx.fillStyle = K.paperPattern(ctx, C.mustard)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,245,210,0.45)'
    ctx.fillRect(x1, -hw, body, w * 0.26)
    ctx.fillStyle = 'rgba(160,100,20,0.28)'
    ctx.fillRect(x1, hw - w * 0.3, body, w * 0.3)
    ctx.fillStyle = '#bfb9ae'
    ctx.fillRect(x2, -hw - 1, fer, w + 2)
    ctx.strokeStyle = 'rgba(80,70,60,0.5)'
    ctx.lineWidth = 1.5
    for (let i = 1; i < 4; i++) {
      ctx.beginPath()
      ctx.moveTo(x2 + (fer * i) / 4, -hw)
      ctx.lineTo(x2 + (fer * i) / 4, hw)
      ctx.stroke()
    }
    K.pathPoly(ctx, K.roundRectPts(x3 - 2, -hw, er + 2, w, hw * 0.7, 3))
    ctx.fillStyle = K.paperPattern(ctx, C.pink)
    ctx.fill()
    K.pencil.poly(ctx, [[0, 0], [x1, -hw], [x4, -hw], [x4, hw], [x1, hw]], id + 'pt', t, { stroke: C.ink, strokeWidth: 2.2, roughness: 0.7, bowing: 0.3 })
  }

  PROPS.pencilQuestion = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'pencilQ')
    const S = def(o.size, 420)
    const p = K.clamp01(def(o.p, 1))
    const k = S / 420
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, S, () => {
      const pts = questionPts(S)
      const ps = K.seg(p, 0, 0.8)
      const graphite = col(o.color, '#4a4540')
      let tip = pts[0]
      if (ps > 0) {
        // 5 thin, rough graphite passes laid side by side (paper shows between them, edges feather).
        // The centre pass leads; the others trail a touch, like a hand going over the line again.
        tip = null
        QPASSES.forEach((q, i) => {
          const pp = K.clamp01((ps - q.lag) / (1 - q.lag))
          if (pp <= 0) return
          const full = offsetLine(pts, q.off * k, 1.6 * k, id + i)
          // outer passes are shorter at both ends, so the stroke tapers like a real re-traced line
          const line = partial(full, Math.min(pp, q.s1))
          if (!tip) tip = line[line.length - 1]
          const seg = line.slice(Math.min(Math.round(q.s0 * (full.length - 1)), line.length - 1))
          if (seg.length < 2) return
          K.pencil.curve(ctx, seg, id + 'q' + i, t, { stroke: rgba(graphite, q.a), strokeWidth: q.w * k, roughness: q.rough, bowing: 1.2, disableMultiStroke: true })
        })
        if (!tip) tip = pts[0]
      }
      const dp = K.seg(p, 0.84, 1)
      const dot = [0.01 * S, 0.37 * S]
      if (dp > 0) {
        // the dot: a scribbled, cross-hatched blob in two passes (not a solid disc)
        const dr = 0.06 * S * K.ease.outBack(dp)
        K.pencil.circle(ctx, dot[0], dot[1], dr * 2, id + 'd1', t, { fill: rgba(graphite, 0.85), fillStyle: 'zigzag', hachureAngle: -38, hachureGap: 4.2 * k, fillWeight: 3 * k, stroke: rgba(graphite, 0.85), strokeWidth: 3.6 * k, roughness: 1.8, bowing: 1.2 })
        if (dp > 0.35) K.pencil.circle(ctx, dot[0] + 1.5 * k, dot[1] - 1 * k, dr * 1.8, id + 'd2', t, { fill: rgba(graphite, 0.7), fillStyle: 'hachure', hachureAngle: 52, hachureGap: 5 * k, fillWeight: 2.6 * k, stroke: rgba(graphite, 0.75), strokeWidth: 2.6 * k, roughness: 2.1, bowing: 1.2 })
        tip = dot
      }
      if (def(o.tool, true) && p > 0.01 && p < 0.985) {
        const lift = p > 0.8 && p < 0.84 ? -20 * k : 0
        const wig = K.noise1(t * 6, 'pw', id) * 0.08
        K.at(ctx, tip[0], tip[1] + lift, -0.95 + wig, k, () => drawPencilTool(ctx, 300, t, id))
      }
      out = { center: mk(0, 0), tip: mk(tip[0], tip[1]) }
    })
    return out
  }

  // ───────────────────────── s2 the console window ─────────────────────────

  const TAB_COLORS = [C.butter, C.sage, C.peach, C.sky, C.lilac, C.mint, C.coral]
  const DEFAULT_TABS = [
    { label: 'Home', icon: 'home' },
    { label: 'garden-app', icon: 'leaf' },
    { label: 'recipe-bot', icon: 'bowl' },
    { label: 'napkin-idea', icon: 'bulb', active: true },
  ]
  const DEFAULT_SIDEBAR = ['Project Home', 'Sessions', 'File Explorer', 'Scheduler', 'Memory', 'Host on Bilko.run']
  function sideIcon(label) {
    const l = String(label).toLowerCase()
    if (/home/.test(l)) return 'home'
    if (/session/.test(l)) return 'chat'
    if (/file/.test(l)) return 'folder'
    if (/schedul/.test(l)) return 'clock'
    if (/memor/.test(l)) return 'pin'
    if (/host|bilko/.test(l)) return 'flag'
    return 'dot'
  }
  const ICON_ACCENT = { home: C.peach, bulb: C.lemon, leaf: C.grass, bowl: C.coral, chat: C.cream, folder: C.butter, clock: C.cream, pin: C.terracotta, flag: C.butter }

  function tabGeom(ctx, spec) {
    const size = def(spec.textSize, 30)
    const icon = spec.icon === undefined ? (/^home$/i.test(spec.label) ? 'home' : null) : spec.icon
    const tw = measure(ctx, spec.label, 'hand', size)
    const iw = icon ? size * 1.08 : 0
    const w = def(spec.w, Math.max(100, tw + iw + 64))
    const h = def(spec.h, 66)
    return { w, h, tw, iw, size, icon }
  }
  function tabPts(w, h) {
    const hw = w / 2
    const hh = h / 2
    const sl = 10
    const r = 15
    const pts = [[-hw, hh]]
    quadPts([-hw + sl * 0.8, -hh + r], [-hw + sl, -hh], [-hw + sl + r, -hh], 4).forEach((p) => pts.push(p))
    quadPts([hw - sl - r, -hh], [hw - sl, -hh], [hw - sl * 0.8, -hh + r], 4).forEach((p) => pts.push(p))
    pts.push([hw, hh])
    return pts
  }
  /**
   * Tab art at the local origin (visual centre). spec.morph is a PAPER FLIP about the horizontal
   * line y = pivotY (default: the tab's bottom edge), scaleY = |cos(morph·π)|: morph 1 shows the
   * black terminal face (cream inner border, 3 title dots, green `> _`), 0.5 is edge-on (a kraft
   * sliver lying on the pivot line), < 0.5 the coloured face with its insert + label. Faces are
   * always drawn at full strength — never a crossfade, so no in-between frame is blank mud.
   */
  function drawTabArt(ctx, t, g, spec, color, id, shadowClipY, edgeBottom, pivotY) {
    const m = K.clamp01(def(spec.morph, 0))
    const hw0 = g.w / 2
    const hh0 = g.h / 2
    const sy = Math.abs(Math.cos(m * Math.PI))
    const piv = def(pivotY, hh0)
    if (m > 0 && sy < 0.08) {
      // edge-on: just the paper's thickness, lying on the fold line
      K.paper(ctx, K.rectPts(-hw0 + 6, piv - 7, g.w - 12, 7), C.kraftDark, { cut: 0.5, shadow: 0.55, seed: id + 'sv' })
      return
    }
    ctx.save()
    if (m > 0) {
      ctx.translate(0, piv)
      ctx.scale(1, sy)
      ctx.translate(0, -piv)
    }
    drawTabFace(ctx, t, g, spec, m > 0.5 ? 'term' : 'color', color, id, shadowClipY, edgeBottom)
    if (m > 0 && sy < 0.985) {
      // turning shade: the face darkens as it tips away from the light
      K.pathPoly(ctx, tabPts(g.w - 4, g.h - 4))
      ctx.fillStyle = `rgba(40,25,10,${0.32 * (1 - sy)})`
      ctx.fill()
    }
    ctx.restore()
  }
  function drawTabFace(ctx, t, g, spec, face, color, id, shadowClipY, edgeBottom) {
    const term = face === 'term'
    const fillC = term ? C.termBlack : color
    const pts = tabPts(g.w, g.h)
    if (shadowClipY !== undefined) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(-g.w, -g.h * 2, g.w * 2, shadowClipY + g.h * 2)
      ctx.clip()
      K.dropShadow(ctx, pts, 0.8, 0)
      ctx.restore()
      K.paper(ctx, pts, fillC, { cut: 1.1, shadow: 0, seed: id })
    } else {
      K.paper(ctx, pts, fillC, { cut: 1.1, shadow: 0.85, seed: id })
    }
    const hw = g.w / 2
    const hh = g.h / 2
    const ty = -3
    if (term) {
      // the terminal face: same language as terminalCard, so the hand-off from a squashed card reads
      K.pencil.poly(ctx, tabPts(g.w - 18, g.h - 13).map(([a, b]) => [a, b + 1]), id + 'tb', t, { stroke: rgba(C.cream, 0.78), strokeWidth: 2, roughness: 1.3, bowing: 1 })
      for (let i = 0; i < 3; i++) circle(ctx, -hw + 25 + i * 10, -hh + 16, 3, rgba(i === 0 ? C.coral : C.cream, i === 0 ? 0.9 : 0.72))
      stroke(ctx, [[-22, ty - 12], [-7, ty], [-22, ty + 12]], id + 'mg', t, { stroke: C.crayonGreen, strokeWidth: 5.2, roughness: 1 })
      stroke(ctx, [[3, ty + 12], [25, ty + 12]], id + 'mu', t, { stroke: C.crayonGreen, strokeWidth: 5.8, roughness: 0.9 })
      return
    }
    // a pencil edge along the top so tabs read as separate cards
    const eb = def(edgeBottom, hh - 10)
    const ef = (eb + hh) / (2 * hh) // how far down the flared side the edge line runs
    stroke(ctx, [[-hw + 10 * (1 - ef) + 3 * ef, eb], [-hw + 10, -hh + 12], [-hw + 22, -hh + 2], [hw - 22, -hh + 2], [hw - 10, -hh + 12], [hw - 10 * (1 - ef) - 3 * ef, eb]], id + 'ed', t, { stroke: rgba(C.ink, 0.55), strokeWidth: 2, roughness: 0.9, bowing: 0.4 })
    let tc = inkOn(fillC)
    if (!spec.active && def(spec.insert, true)) {
      // recipe-binder divider: a paper label slipped into the coloured tab
      const iw = g.w - 30
      const ih = g.size + 8
      K.paper(ctx, K.roundRectPts(-iw / 2, ty - ih / 2, iw, ih, 8), C.paperWhite, { cut: 0.7, shadow: 0.45, seed: id + 'in' })
      tc = C.ink
    }
    let lx = -(g.tw + g.iw) / 2
    if (g.icon) {
      drawIcon(ctx, g.icon, lx + g.iw * 0.42, ty, g.size * 0.72, id + 'ic', t, tc, ICON_ACCENT[g.icon])
      lx += g.iw
    }
    text(ctx, spec.label, lx, ty, { family: 'hand', size: g.size, color: tc, align: 'left', t, id: id + 'tx', jitter: 0.6 })
  }
  function tabPop(p) {
    if (p <= 0) return null
    const e = K.ease.outBack(K.clamp01(p))
    return { s: 0.55 + 0.45 * e, dy: (1 - e) * -46, rot: (1 - e) * 0.25 }
  }

  PROPS.folderTab = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'tab')
    const spec = Object.assign({ label: 'Home' }, o)
    const g = tabGeom(ctx, spec)
    const pop = tabPop(K.clamp01(def(o.p, 1)))
    if (!pop) return null
    const color = o.active ? C.cream : col(o.color, C.butter)
    const lift = def(o.lift, 0)
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y + pop.dy - lift * 18, t, Object.assign({}, o, { rot: def(o.rot, 0) + pop.rot - lift * 0.05, scale: def(o.scale, 1) * pop.s }), id, g.w, () => {
      drawTabArt(ctx, t, g, spec, color, id, undefined, undefined, def(o.pivot, g.h / 2))
      out = { center: mk(0, 0), bottom: mk(0, g.h / 2), w: g.w, h: g.h }
    })
    return out
  }

  PROPS.consoleWindow = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'console')
    const W = def(o.w, 1500)
    const H = def(o.h, 820)
    const hw = W / 2
    const hh = H / 2
    const TOP = 104
    const SIDE = 34
    const x0 = -hw + SIDE
    const x1 = hw - SIDE
    const y0 = -hh + TOP
    const y1 = hh - SIDE
    const SBW = 282
    const sx0 = x0 + 18
    const sy0 = y0 + 20
    const sy1 = y1 - 18
    const cx0 = sx0 + SBW + 28
    const cx1 = x1 - 22
    const cy0 = y0 + 22
    const cy1 = y1 - 22
    const tabs = def(o.tabs, DEFAULT_TABS)
    const side = def(o.sidebar, DEFAULT_SIDEBAR)
    const tabsReveal = def(o.tabsReveal, 1)
    const sideReveal = K.clamp01(def(o.sidebarReveal, 1))
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, W, () => {
      // 1. torn terracotta border → torn kraft frame. Drawn as rings: their middles are always
      //    covered (border by the kraft, kraft by the screen), so only visible paper is rastered.
      const kraftHole = K.rectPts(x0 + 30, y0 + 30, x1 - x0 - 60, y1 - y0 - 60)
      paperRing(ctx, K.roundRectPts(-hw, -hh, W, H, 34), K.rectPts(-hw + 46, -hh + 46, W - 92, H - 92), C.terracotta, { torn: 5, shadow: def(o.shadow, 1), lift: def(o.lift, 0) + 6, seed: id + 'b' })
      paperRing(ctx, K.roundRectPts(-hw + 15, -hh + 15, W - 30, H - 30, 26), kraftHole, C.kraft, { torn: 3.5, shadow: 0.55, seed: id + 'k' })
      // kraft fibre flecks for a richer frame
      const fr = K.rng('fleck', id)
      ctx.save()
      ctx.fillStyle = 'rgba(120,80,40,0.16)'
      for (let i = 0; i < 70; i++) {
        const side4 = Math.floor(fr() * 4)
        const u = fr()
        const px = side4 < 2 ? -hw + 24 + u * (W - 48) : side4 === 2 ? -hw + 20 + fr() * 12 : hw - 32 + fr() * 12
        const py = side4 === 0 ? -hh + 22 + fr() * (TOP - 30) : side4 === 1 ? hh - 30 + fr() * 12 : -hh + 24 + u * (H - 48)
        ctx.fillRect(px, py, 2 + fr() * 5, 1.2 + fr() * 1.6)
      }
      ctx.restore()
      // 2. inactive folder tabs (tucked behind the screen)
      const tabG = tabs.map((tb) => tabGeom(ctx, tb))
      const tabX = []
      let cur = cx0 + 4
      tabG.forEach((g) => {
        tabX.push(cur + g.w / 2)
        cur += g.w + 14
      })
      const tabY = y0 - 33 + 11 // tab centre (default h 66): 11 px tuck under the screen
      const nT = tabs.length
      const tabP = tabs.map((tb, i) => (tb.p !== undefined ? K.clamp01(tb.p) : K.clamp01((tabsReveal * (nT + 0.8) - i) / 1.1)))
      const tabAt = (i) => {
        const pop = tabPop(tabP[i])
        const lift = def(tabs[i].lift, 0)
        return pop ? { x: tabX[i], y: tabY + pop.dy - lift * 18, rot: pop.rot - lift * 0.05 + K.noise1(t * 3 + i, 'tabw', id) * 0.012 * lift, s: pop.s } : null
      }
      // an active tab only merges into the screen once its flip is done (morph === 0); while it is
      // still turning it lives back here with the others, cream face / terminal face.
      const merged = (tb) => tb.active && !(def(tb.morph, 0) > 0)
      tabs.forEach((tb, i) => {
        if (merged(tb)) return
        const a = tabAt(i)
        if (!a) return
        const color = tb.active ? col(o.screenColor, C.cream) : col(tb.color, TAB_COLORS[i % TAB_COLORS.length])
        // flip about the screen's top edge, so an edge-on tab lies visibly on that edge
        const piv = K.clamp((y0 - a.y) / a.s, -tabG[i].h / 2 + 8, tabG[i].h / 2)
        K.at(ctx, a.x, a.y, a.rot, a.s, () => drawTabArt(ctx, t, tabG[i], tb, color, id + 'tab' + i, undefined, undefined, piv))
      })
      // 3. the cream screen (ring shadow: the fake shadow under the middle is never seen)
      const scr = K.wobble(K.rectPts(x0, y0, x1 - x0, y1 - y0), 1.6, id + 's')
      ringShadow(ctx, scr, kraftHole, 0.75, 0)
      K.pathPoly(ctx, scr)
      ctx.fillStyle = K.paperPattern(ctx, col(o.screenColor, C.cream))
      ctx.fill()
      K.pencil.rect(ctx, x0 + 2, y0 + 2, x1 - x0 - 4, y1 - y0 - 4, id + 'so', t, { stroke: rgba(C.inkDim, 0.55), strokeWidth: 2, roughness: 0.7, bowing: 0.3 })
      // faint dot grid in the content area (bullet-journal paper)
      ctx.save()
      ctx.fillStyle = 'rgba(90,70,40,0.1)'
      ctx.beginPath()
      for (let gx = cx0 + 20; gx < cx1 - 8; gx += 40) for (let gy = cy0 + 16; gy < cy1 - 6; gy += 40) ctx.rect(gx - 1.5, gy - 1.5, 3, 3)
      ctx.fill()
      ctx.restore()
      // 4. active tab — cream, merges into the screen
      tabs.forEach((tb, i) => {
        if (!merged(tb)) return
        const a = tabAt(i)
        if (!a) return
        K.at(ctx, a.x, a.y, a.rot, a.s, () => {
          const g = Object.assign({}, tabG[i], { h: tabG[i].h + 10 })
          ctx.translate(0, 5)
          // shadow + side pencil lines stop exactly at the screen's top edge
          const edge = (y0 - a.y) / a.s - 5
          drawTabArt(ctx, t, g, tb, col(o.screenColor, C.cream), id + 'tab' + i, edge, edge)
          // "you are here": a little terracotta paper sticker dot
          const dx = g.w / 2 - 22
          const dy = -g.h / 2 + 19
          circle(ctx, dx + 1.4, dy + 2.2, 8, 'rgba(58,36,14,0.28)')
          K.paper(ctx, K.ellipsePts(dx, dy, 7.5, 7.5, 16), C.terracotta, { cut: 0.5, shadow: 0, seed: id + 'yah' })
          circle(ctx, dx - 2.4, dy - 2.6, 2.3, 'rgba(255,240,225,0.75)')
        })
      })
      // 5. sidebar: torn strip glues down, then cut-out labels drop in
      const stripP = K.seg(sideReveal, 0, 0.3)
      if (stripP > 0) {
        // unrolls downward like a paper scroll: the full-size strip is revealed down to the roll,
        // which travels ahead of it (no squashed grain, the torn edges keep their shape)
        const sbColor = col(o.sidebarColor, C.peach)
        const SH = sy1 - sy0
        const e = K.ease.inOutCubic(stripP)
        const edgeY = sy0 + e * SH
        ctx.save()
        if (stripP < 1) {
          ctx.beginPath()
          ctx.rect(sx0 - 40, sy0 - 40, SBW + 80, edgeY - sy0 + 40)
          ctx.clip()
        }
        K.paper(ctx, K.rectPts(sx0, sy0, SBW, SH), sbColor, { torn: 3, shadow: 0.8, lift: (1 - stripP) * 6, seed: id + 'sb' })
        ctx.restore()
        if (stripP < 1) {
          // the roll: a peach cylinder that gets thinner as it pays out paper
          const rh = 32 - 13 * e
          const rx0 = sx0 - 6
          const rw = SBW + 12
          const roll = K.roundRectPts(rx0, edgeY - rh / 2, rw, rh, rh / 2, 4)
          K.dropShadow(ctx, roll, 0.9, 5)
          K.pathPoly(ctx, roll)
          ctx.fillStyle = K.paperPattern(ctx, shade(sbColor, -0.04))
          ctx.fill()
          ctx.save()
          K.pathPoly(ctx, roll)
          ctx.clip()
          const cg = ctx.createLinearGradient(0, edgeY - rh / 2, 0, edgeY + rh / 2)
          cg.addColorStop(0, 'rgba(255,245,230,0.1)')
          cg.addColorStop(0.28, 'rgba(255,245,230,0.5)')
          cg.addColorStop(0.5, 'rgba(255,245,230,0.05)')
          cg.addColorStop(1, 'rgba(58,30,14,0.3)')
          ctx.fillStyle = cg
          ctx.fillRect(rx0, edgeY - rh / 2, rw, rh)
          ctx.restore()
          for (const ex of [rx0 + rh * 0.42, rx0 + rw - rh * 0.42]) {
            // spiral ends of the roll
            K.paper(ctx, K.ellipsePts(ex, edgeY, rh * 0.36, rh * 0.48, 16), shade(sbColor, 0.22), { cut: 0.3, shadow: 0, seed: id + 're' + Math.round(ex) })
            stroke(ctx, [[ex, edgeY], [ex + rh * 0.1, edgeY - rh * 0.1], [ex + rh * 0.02, edgeY - rh * 0.26], [ex - rh * 0.2, edgeY - rh * 0.14], [ex - rh * 0.22, edgeY + rh * 0.16], [ex + rh * 0.06, edgeY + rh * 0.36]], id + 'sp' + Math.round(ex), t, { stroke: rgba(C.ink, 0.55), strokeWidth: 1.5, roughness: 0.5, bowing: 0.3 })
          }
          K.pencil.poly(ctx, roll, id + 'ro', t, { stroke: rgba(C.ink, 0.55), strokeWidth: 1.7, roughness: 0.6, bowing: 0.3 })
        }
      }
      // the strip's washi tape slaps on right after it unrolls (scale 1.3 → 1 with a pop)
      const tq = K.seg(sideReveal, 0.3, 0.4)
      if (tq > 0) {
        K.at(ctx, sx0 + SBW / 2 + 6, sy0 + 2, 0, 1.3 - 0.3 * K.ease.outBack(tq), () => {
          K.withAlpha(ctx, K.clamp01(tq * 2.5), () => K.tape(ctx, 0, 0, 118, -0.05, WASHI[0], { h: 30, seed: id + 'sbt' }))
        })
      }
      const nS = side.length
      const itemH = (sy1 - sy0) / Math.max(1, nS)
      const sideItems = []
      side.forEach((lab, i) => {
        const iy = sy0 + itemH * (i + 0.5)
        const ix = sx0 + 16
        const start = 0.24 + (nS > 1 ? (i * 0.48) / (nS - 1) : 0)
        const lp = K.seg(sideReveal, start, start + 0.28)
        const r = K.rng('side', id, i)
        const tilt = (r() - 0.5) * 0.14
        const active = i === def(o.sidebarActive, -1)
        // labels always sit inside the strip: long ones get a slightly smaller hand
        const lwMax = SBW - 30
        let size = 31
        let tw = measure(ctx, lab, 'hand', size)
        if (tw + 76 > lwMax) {
          size = Math.max(22, (size * (lwMax - 76)) / tw)
          tw = measure(ctx, lab, 'hand', size)
        }
        const lw = Math.min(lwMax, Math.max(150, tw + 76))
        const lh = 62
        sideItems.push([ix + lw / 2, iy])
        if (lp <= 0) return
        const e = K.ease.outBack(lp)
        const dropY = (1 - e) * -60
        K.at(ctx, ix + lw / 2 + (r() - 0.5) * 8, iy + dropY, tilt + (1 - e) * 0.3, 0.6 + 0.4 * e + (active ? 0.05 : 0), () => {
          const bg = active ? C.terracotta : C.paperWhite
          K.paper(ctx, K.boxPts(lw, lh), bg, { cut: 2.2, shadow: 0.85, lift: (1 - lp) * 10 + (active ? 4 : 0), seed: id + 'sl' + i })
          const tc = active ? C.paperWhite : C.ink
          drawIcon(ctx, sideIcon(lab), -lw / 2 + 29, 0, 26, id + 'si' + i, t, tc, active ? null : ICON_ACCENT[sideIcon(lab)])
          text(ctx, lab, -lw / 2 + 52, 1, { family: 'hand', size, color: tc, align: 'left', t, id: id + 'st' + i, jitter: 0.6 })
        })
      })
      // 6. plaque, window dots, washi corners
      const plq = K.clamp01(def(o.plaque, 1))
      const plx = sx0 + SBW / 2 - 4
      const ply = (-hh + 15 + y0) / 2 + 1
      if (plq > 0) {
        const title = def(o.title, 'Session Manager')
        const pw = measure(ctx, title, 'marker', 38) + 78
        K.at(ctx, plx, ply, -0.022 + (1 - K.ease.outBack(plq)) * 0.2, K.ease.outBack(plq), () => {
          K.paper(ctx, K.roundRectPts(-pw / 2, -31, pw, 62, 12), C.butter, { cut: 1.4, shadow: 0.95, lift: 2, seed: id + 'pq' })
          K.pencil.rect(ctx, -pw / 2 + 7, -24, pw - 14, 48, id + 'pqb', t, { stroke: C.terracotta, strokeWidth: 2.4, roughness: 1, bowing: 0.6 })
          for (const bx of [-pw / 2 + 21, pw / 2 - 21]) {
            circle(ctx, bx + 1, 2, 7.5, 'rgba(58,36,14,0.25)')
            circle(ctx, bx, 0, 7, C.honey)
            circle(ctx, bx - 2, -2, 2.4, 'rgba(255,250,230,0.8)')
          }
          text(ctx, title, 0, 1, { family: 'marker', size: 38, color: C.ink, t, id: id + 'pqt', jitter: 0.7 })
        })
      }
      ;[C.terracotta, C.butter, C.sage].forEach((c, i) => {
        const dx = x1 - 24 - (2 - i) * 34
        const dy = (-hh + 15 + y0) / 2
        circle(ctx, dx + 1.5, dy + 3, 11, 'rgba(58,36,14,0.22)')
        K.paper(ctx, K.ellipsePts(dx, dy, 11, 11, 18), c, { cut: 0.8, shadow: 0, seed: id + 'wd' + i })
      })
      const pins = K.clamp01(def(o.pins, 1))
      const corners = [[-hw + 22, -hh + 18, -0.72], [hw - 22, -hh + 18, 0.72], [hw - 22, hh - 18, -0.72], [-hw + 22, hh - 18, 0.72]]
      corners.forEach(([cx, cy, rr], i) => {
        const q = K.seg(pins, i * 0.18, i * 0.18 + 0.46)
        if (q <= 0) return
        const e = K.ease.outBack(q)
        const r = K.rng('corner', id, i)
        K.at(ctx, cx, cy, 0, 1.35 - 0.35 * e, () => {
          K.withAlpha(ctx, K.clamp01(q * 3), () => K.tape(ctx, 0, 0, 150, rr + (r() - 0.5) * 0.16, WASHI[[0, 3, 1, 2][i]], { h: 40, seed: id + 'wc' + i, pattern: i % 2 ? 'dots' : null }))
        })
      })
      const content = { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 }
      if (typeof o.content === 'function') o.content(ctx, content)
      const dim = K.clamp01(def(o.dim, 0))
      if (dim > 0) {
        K.pathPoly(ctx, K.roundRectPts(-hw - 8, -hh - 8, W + 16, H + 16, 38))
        ctx.fillStyle = `rgba(239,230,211,${0.62 * dim})`
        ctx.fill()
      }
      out = {
        center: mk(0, 0),
        frame: mapRect(mk, -hw, -hh, W, H),
        screen: mapRect(mk, x0, y0, x1 - x0, y1 - y0),
        content: mapRect(mk, cx0, cy0, cx1 - cx0, cy1 - cy0),
        sidebar: mapRect(mk, sx0, sy0, SBW, sy1 - sy0),
        sidebarItems: sideItems.map(([a, b]) => mk(a, b)),
        tabs: tabX.map((tx) => mk(tx, tabY)),
        tabRects: tabG.map((g, i) => mapRect(mk, tabX[i] - g.w / 2, tabY - g.h / 2, g.w, g.h)),
        plaque: mk(plx, ply),
      }
    })
    return out
  }

  const CHAT_CARD = mix(C.paperWhite, C.sky, 0.3)
  PROPS.chatTermCard = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'chatterm')
    const w = def(o.w, 440)
    const h = def(o.h, 300)
    const flip = def(o.flip, 0)
    const cs = Math.cos(flip * Math.PI)
    const face = cs >= 0 ? 'chat' : 'terminal'
    const sx = Math.abs(cs)
    const yarnLen = def(o.yarnLen, 240)
    const holeY = -h / 2 + 24
    const topY = -h / 2 - yarnLen
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, Math.max(w, h), () => {
      const sw = def(o.swing, 0)
      if (sw) {
        ctx.translate(0, topY)
        ctx.rotate(sw)
        ctx.translate(0, -topY)
      }
      // the yarn (the flip axis — never flips, never breaks)
      if (def(o.yarn, true)) {
        const sway = K.noise1(t * 1.3, 'yarn', id) * 7
        const pts = []
        for (let i = 0; i <= 6; i++) {
          const u = i / 6
          pts.push([Math.sin(u * Math.PI) * sway, topY + (holeY - topY) * u])
        }
        K.pencil.curve(ctx, pts, id + 'yn', t, { stroke: C.terracotta, strokeWidth: 5.5, roughness: 0.9, bowing: 0.5 })
        K.pencil.curve(ctx, pts.map(([a, b]) => [a + 1.5, b]), id + 'yf', t, { stroke: shade(C.terracotta, -0.3), strokeWidth: 1.6, roughness: 2.2, bowing: 1 })
        if (def(o.tapeTop, true)) K.tape(ctx, 0, topY + 8, 78, 0.12, WASHI[0], { h: 28, seed: id + 'tt' })
      }
      // the card: one face at a time
      ctx.save()
      if (sx < 0.07) {
        K.paper(ctx, K.boxPts(9, h), C.kraftDark, { cut: 0.6, shadow: 0.7, seed: id + 'edge' })
      } else {
        ctx.scale(sx, 1 + 0.035 * (1 - sx))
        if (face === 'chat') {
          // a pale sky index card: the cream bubble pops on it, and it never melts into a cream screen
          K.paper(ctx, K.boxPts(w, h), col(o.cardColor, CHAT_CARD), { cut: 1.6, shadow: def(o.shadow, 1), lift: def(o.lift, 10), seed: id + 'cf' })
          ctx.save()
          ctx.lineWidth = 2
          ctx.strokeStyle = rgba(C.sky, 0.5)
          ctx.beginPath()
          for (let ly = -h / 2 + 88; ly < h / 2 - 12; ly += 34) {
            ctx.moveTo(-w / 2 + 10, ly)
            ctx.lineTo(w / 2 - 10, ly)
          }
          ctx.stroke()
          ctx.strokeStyle = rgba(C.tomato, 0.6)
          ctx.beginPath()
          ctx.moveTo(-w / 2 + 10, -h / 2 + 54)
          ctx.lineTo(w / 2 - 10, -h / 2 + 54)
          ctx.stroke()
          ctx.restore()
          // speech bubble with tail
          const bw = w * 0.74
          const bh = h * 0.56
          const by = 24
          const rr = K.roundRectPts(-bw / 2, by - bh / 2, bw, bh, bh * 0.42, 5)
          const bub = rr.slice(0, 12).concat([[-bw * 0.12, by + bh / 2], [-bw * 0.3, by + bh / 2 + 34], [-bw * 0.3, by + bh / 2]]).concat(rr.slice(12))
          const bshape = K.paper(ctx, bub, C.cream, { cut: 1.4, shadow: 0.85, seed: id + 'bb' })
          K.pencil.poly(ctx, bshape, id + 'bo', t, { stroke: C.ink, strokeWidth: 2.6, roughness: 0.8, bowing: 0.4 })
          text(ctx, def(o.chatText, 'Chat'), 0, by - 20, { family: 'marker', size: 60, color: C.ink, t, id: id + 'ct', jitter: 0.8 })
          const dc = [C.terracotta, C.honey, C.sage]
          for (let i = 0; i < 3; i++) {
            const dy = -Math.max(0, Math.sin(t * 7 - i * 0.95)) * 13
            const dx = (i - 1) * 36
            circle(ctx, dx + 1.5, by + 42 + 2.5, 11, 'rgba(58,36,14,0.18)')
            circle(ctx, dx, by + 40 + dy, 11, dc[i])
            circle(ctx, dx - 3.5, by + 36 + dy, 3.2, 'rgba(255,250,235,0.7)')
          }
        } else {
          K.paper(ctx, K.boxPts(w, h), C.termBlack, { cut: 1.6, shadow: def(o.shadow, 1), lift: def(o.lift, 10), seed: id + 'tf' })
          K.pencil.rect(ctx, -w / 2 + 12, -h / 2 + 12, w - 24, h - 24, id + 'tb', t, { stroke: rgba(C.cream, 0.8), strokeWidth: 2.4, roughness: 1.4, bowing: 1.2 })
          for (let i = 0; i < 3; i++) circle(ctx, -w / 2 + 32 + i * 16, -h / 2 + 32, 4.6, rgba(i === 0 ? C.coral : C.cream, 0.75))
          text(ctx, def(o.termText, 'Terminal'), 0, -h / 2 + 84, { family: 'marker', size: 54, color: C.cream, t, id: id + 'tt', jitter: 0.8 })
          stroke(ctx, [[-w / 2 + 46, -14], [-w / 2 + 46 + w * 0.42, -12]], id + 'o1', t, { stroke: rgba(C.cream, 0.4), strokeWidth: 3.5, roughness: 1.2 })
          stroke(ctx, [[-w / 2 + 46, 9], [-w / 2 + 46 + w * 0.27, 10]], id + 'o2', t, { stroke: rgba(C.cream, 0.4), strokeWidth: 3.5, roughness: 1.2 })
          const px = -w / 2 + 52
          const py = 78
          stroke(ctx, [[px, py - 28], [px + 34, py], [px, py + 28]], id + 'pg', t, { stroke: C.crayonGreen, strokeWidth: 10, roughness: 1 })
          if ((t * 0.95) % 1 < 0.56) stroke(ctx, [[px + 58, py + 28], [px + 110, py + 28]], id + 'pc', t, { stroke: C.crayonGreen, strokeWidth: 11, roughness: 0.9 })
        }
        // punched hole for the yarn
        circle(ctx, 0, holeY, 8, 'rgba(58,36,14,0.5)')
        circle(ctx, 0, holeY + 1.5, 5, 'rgba(40,25,10,0.55)')
        // turning shade
        if (sx < 0.985) {
          ctx.fillStyle = `rgba(40,25,10,${0.3 * (1 - sx)})`
          ctx.fillRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8)
        }
      }
      ctx.restore()
      // yarn knot through the hole (drawn unflipped)
      if (def(o.yarn, true)) {
        const tail = K.noise1(t * 2, 'tail', id) * 3
        stroke(ctx, [[0, holeY], [-8 + tail, holeY + 12], [-12 + tail, holeY + 25]], id + 'k1', t, { stroke: C.terracotta, strokeWidth: 4, roughness: 0.9 })
        stroke(ctx, [[0, holeY], [6 + tail, holeY + 14], [3 + tail, holeY + 28]], id + 'k2', t, { stroke: C.terracotta, strokeWidth: 4, roughness: 0.9 })
        circle(ctx, 1.5, holeY + 2.5, 8, 'rgba(58,36,14,0.25)')
        circle(ctx, 0, holeY, 8, C.terracotta)
        circle(ctx, -2.5, holeY - 2.5, 2.6, 'rgba(255,235,215,0.55)')
      }
      out = {
        center: mk(0, 0),
        face,
        top: mk(0, -h / 2),
        hole: mk(0, holeY),
        yarnTop: mk(0, topY),
        yarnMid: mk(0, topY + (holeY - topY) * 0.45),
        rect: mapRect(mk, (-w / 2) * sx, -h / 2, w * sx, h),
      }
    })
    return out
  }

  // ───────────────────────── s3 agents & missions ─────────────────────────

  PROPS.clayButton = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'clay')
    const r = def(o.r, 90)
    const base = col(o.color, C.terracotta)
    const color = saturate(base, 0.1, 0.015) // a touch juicier than the flat paper swatch
    const press = K.clamp(def(o.press, 0), -0.35, 1.25)
    const depth = def(o.depth, r * 0.44)
    const ry = r * 0.6
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, r * 2.4, () => {
      const baseY = depth * 0.5
      const topY = baseY - depth * (1 - 0.74 * press)
      const rx = r * (1 + 0.09 * press)
      const ryy = ry * (1 - 0.06 * press)
      // the clay dome squashes flat as it is pressed and bulges when it springs back past rest
      const domeH = ryy * Math.max(0.08, 0.34 * (1 - 0.6 * press))
      const collarY = baseY - 2
      let stripLabel = null
      if (o.strip) {
        // a torn strip BEHIND the washer (the washer overhangs it top and bottom), lettered at the left
        const lab = String(o.strip)
        const lw = measure(ctx, lab, 'marker', 46)
        const sh = Math.max(64, ry * 1.55)
        const left = -r * 1.36 - lw - 62
        const right = r * 1.52 + 16
        const scy = baseY + 6
        K.paper(ctx, K.rectPts(left, scy - sh / 2, right - left, sh), col(o.stripColor, C.cream), { torn: 3.5, shadow: 0.85, seed: id + 'str' })
        K.tape(ctx, left + 10, scy - sh / 2 + 6, 58, -0.62, WASHI[1], { h: 24, seed: id + 'stt' })
        const lx = left + 32 + lw / 2
        text(ctx, lab, lx, scy - 3, { family: 'marker', size: 46, color: C.ink, t, id: id + 'sl', jitter: 0.8 })
        stroke(ctx, [[lx - lw / 2, scy + 26], [lx + lw / 2, scy + 28]], id + 'su', t, { stroke: C.terracotta, strokeWidth: 3.5, roughness: 1.3 })
        stripLabel = mk(lx, scy - 3)
      }
      // 1. cream washer
      K.paper(ctx, K.ellipsePts(0, baseY + 10, r * 1.38, ry * 1.42, 44), col(o.bezel, C.cream), { cut: 1.2, shadow: def(o.shadow, 1), lift: def(o.lift, 0), seed: id + 'so' })
      K.pencil.ellipse(ctx, 0, baseY + 10, r * 2.76, ry * 2.84, id + 'bz', t, { stroke: rgba(C.ink, 0.65), strokeWidth: 2.2, roughness: 0.9 })
      // 2. the dark housing collar the button sits in (arcade button in its socket)
      const housing = mix(C.ink, color, 0.22)
      K.paper(ctx, K.ellipsePts(0, collarY + 9, r * 1.17, ry * 1.17, 40), shade(housing, -0.2), { cut: 0.6, shadow: 0.6, seed: id + 'hs' })
      K.paper(ctx, K.ellipsePts(0, collarY, r * 1.17, ry * 1.17, 40), housing, { cut: 0.6, shadow: 0, seed: id + 'ht' })
      ctx.save()
      ctx.beginPath()
      ctx.ellipse(0, collarY, r * 1.12, ry * 1.1, 0, Math.PI * 1.08, Math.PI * 1.62)
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(255,236,215,0.35)'
      ctx.stroke()
      ctx.restore()
      K.pathPoly(ctx, K.ellipsePts(0, collarY, r * 1.05, ry * 1.04, 36))
      ctx.fillStyle = '#1c140f'
      ctx.fill()
      // 3. button side (a short clay cylinder), softly shaded left → right
      const sideC = shade(color, -0.18)
      const sidePath = () => {
        ctx.beginPath()
        ctx.ellipse(0, collarY, rx, ryy, 0, 0, Math.PI)
        ctx.lineTo(-rx, topY)
        ctx.ellipse(0, topY, rx, ryy, 0, Math.PI, 0, true)
        ctx.closePath()
      }
      sidePath()
      ctx.fillStyle = K.paperPattern(ctx, sideC)
      ctx.fill()
      const sg = ctx.createLinearGradient(-rx, 0, rx, 0)
      sg.addColorStop(0, 'rgba(255,240,225,0.16)')
      sg.addColorStop(0.35, 'rgba(255,240,225,0)')
      sg.addColorStop(0.75, 'rgba(42,26,14,0.05)')
      sg.addColorStop(1, 'rgba(42,26,14,0.22)')
      sidePath()
      ctx.fillStyle = sg
      ctx.fill()
      // 4. the domed cap: rim ellipse in front, crown bulging above it
      const N = 44
      const cap = []
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU
        const s = Math.sin(a)
        cap.push([Math.cos(a) * rx, topY + s * (s < 0 ? ryy + domeH : ryy)])
      }
      const capShape = K.paper(ctx, cap, color, { cut: 1, shadow: 0, seed: id + 'tp' })
      ctx.save()
      K.pathPoly(ctx, capShape)
      ctx.clip()
      // underside of the dome, shading into the rim
      ctx.beginPath()
      ctx.ellipse(0, topY + ryy * 0.18, rx * 0.97, ryy * 0.9, 0, 0.08 * Math.PI, 0.92 * Math.PI)
      ctx.lineWidth = 7
      ctx.strokeStyle = 'rgba(42,26,14,0.13)'
      ctx.stroke()
      // lighter crown (a second paper layer), soft sheen, specular dot
      const crY = topY - domeH * 0.5 - ryy * 0.08
      K.paper(ctx, K.ellipsePts(-rx * 0.05, crY, rx * 0.72, ryy * 0.62 + domeH * 0.45, 30), shade(color, 0.12), { cut: 1.1, shadow: 0, seed: id + 'cr' })
      ctx.beginPath()
      ctx.ellipse(-rx * 0.36, crY - ryy * 0.24, rx * 0.3, ryy * 0.16, -0.32, 0, TAU)
      ctx.fillStyle = 'rgba(255,246,232,0.36)'
      ctx.fill()
      circle(ctx, -rx * 0.6, crY - ryy * 0.02, r * 0.045, 'rgba(255,250,240,0.7)')
      // thumbprint arcs pressed into the clay
      const tpx = rx * 0.24
      const tpy = crY + ryy * 0.08
      for (let i = 0; i < 3; i++) {
        const rr = r * (0.1 + i * 0.07)
        ctx.beginPath()
        ctx.ellipse(tpx, tpy, rr, rr * 0.62, -0.18, Math.PI * 1.02, Math.PI * 1.86)
        ctx.lineWidth = 1.7
        ctx.strokeStyle = 'rgba(58,30,14,0.16)'
        ctx.stroke()
        ctx.beginPath()
        ctx.ellipse(tpx, tpy + 1.8, rr, rr * 0.62, -0.18, Math.PI * 1.06, Math.PI * 1.8)
        ctx.lineWidth = 1.2
        ctx.strokeStyle = 'rgba(255,238,220,0.2)'
        ctx.stroke()
      }
      ctx.restore()
      // paperWhite rim highlight on the dome's top edge (separates a fingertip from the cap)
      ctx.save()
      ctx.beginPath()
      ctx.ellipse(0, topY, rx * 0.955, (ryy + domeH) * 0.93, 0, Math.PI * 1.1, Math.PI * 1.9)
      ctx.lineWidth = 2.2
      ctx.lineCap = 'round'
      ctx.strokeStyle = 'rgba(255,250,240,0.85)'
      ctx.stroke()
      ctx.restore()
      // pencil outlines
      const po = { stroke: C.ink, strokeWidth: 2.6, roughness: 0.8, bowing: 0.4 }
      K.pencil.poly(ctx, cap, id + 'to', t, po)
      K.pencil.arc(ctx, 0, collarY, rx * 2, ryy * 2, 0.04, Math.PI - 0.04, id + 'bo', t, po)
      stroke(ctx, [[-rx, topY], [-rx, collarY]], id + 'sl1', t, po)
      stroke(ctx, [[rx, topY], [rx, collarY]], id + 'sl2', t, po)
      const tc = inkOn(color)
      const faceY = topY - domeH * 0.5
      K.at(ctx, 0, faceY, 0, [1, 0.8], () => {
        if (typeof o.icon === 'function') {
          o.icon(ctx, r)
          if (o.label) text(ctx, o.label, 0, r * 0.52, { family: 'chunky', weight: '600', size: r * 0.22, color: tc, t, id: id + 'lb', jitter: 0.5 })
        } else if (o.label) {
          text(ctx, o.label, 0, 0, { family: 'chunky', weight: '600', size: r * 0.34, color: tc, t, id: id + 'lb', jitter: 0.5 })
        }
      })
      out = { center: mk(0, 0), top: mk(0, topY - domeH * 0.8), stripLabel }
    })
    return out
  }

  PROPS.cardBox = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'cardbox')
    const w = def(o.w, 420)
    const h = def(o.h, 250)
    const d = 64
    const color = col(o.color, C.kraft)
    const lidColor = col(o.lidColor, C.terracotta)
    const lo = K.clamp(def(o.lidOpen, 0), 0, 1.18)
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, w, () => {
      const yh = -h / 2 - d // hinge (back top edge)
      const inset = 14
      const th = lo * (100 * Math.PI) / 180
      const L = d * 1.9
      const k = d / L
      const yFree = yh + L * k * Math.cos(th) - L * 0.86 * Math.sin(th)
      const lipDy = 28 * (Math.sin(th) * k + Math.cos(th) * 0.86)
      const alpha = Math.asin(k)
      const closedish = th < alpha
      const lidW = w + 16
      const lid = () => {
        const backW = lidW - inset * 2
        const freeW = lidW - (closedish ? 0 : inset * 2 * K.clamp01((th - alpha) / 0.6))
        const quad = [[-backW / 2, yh], [backW / 2, yh], [freeW / 2, yFree], [-freeW / 2, yFree]]
        const lip = [[-freeW / 2, yFree], [freeW / 2, yFree], [freeW / 2, yFree + lipDy], [-freeW / 2, yFree + lipDy]]
        if (closedish) {
          K.paper(ctx, quad, lidColor, { cut: 1, shadow: 0.6, seed: id + 'lq' })
          K.paper(ctx, lip, shade(lidColor, -0.14), { cut: 1, shadow: 0.9, seed: id + 'll' })
          ctx.save()
          ctx.fillStyle = 'rgba(255,240,220,0.18)'
          ctx.fillRect(-backW / 2 + 10, yh + 8, backW - 20, 6)
          ctx.restore()
        } else {
          // lip edge peeking past the free edge, then the lid's lining
          K.paper(ctx, [[-freeW / 2, yFree - 9], [freeW / 2, yFree - 9], [freeW / 2, yFree + 4], [-freeW / 2, yFree + 4]], shade(lidColor, -0.18), { cut: 0.8, shadow: 0.6, seed: id + 'll' })
          K.paper(ctx, quad, shade(lidColor, 0.62), { cut: 1, shadow: 0, seed: id + 'lu' })
          // lid lining: little printed dots
          ctx.save()
          ctx.fillStyle = rgba(lidColor, 0.35)
          const ty0 = Math.min(yh, yFree)
          const ty1 = Math.max(yh, yFree)
          for (let py = ty0 + 16; py < ty1 - 10; py += 22) for (let px = -backW / 2 + 22; px < backW / 2 - 16; px += 26) circle(ctx, px + ((py / 22) % 2) * 13, py, 3, rgba(lidColor, 0.35))
          ctx.restore()
        }
      }
      if (!closedish) lid()
      // interior (the mouth)
      const mouth = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2 - inset, yh], [-w / 2 + inset, yh]]
      K.paper(ctx, mouth, shade(color, -0.42), { cut: 0.8, shadow: 0, seed: id + 'mo' })
      ctx.fillStyle = K.paperPattern(ctx, shade(color, -0.2))
      ctx.fillRect(-w / 2 + inset, yh, w - inset * 2, 10)
      // A–Z style divider cards peeking over the front edge (hidden under the closed lid)
      ;[[C.butter, -w * 0.24, 0], [C.sage, w * 0.06, 8], [C.sky, w * 0.3, 16]].forEach(([dc, tx, dy], i) => {
        const top = -h / 2 - 30 + dy
        const dw = w - inset * 2 - 16 - i * 6
        K.paper(ctx, K.rectPts(-dw / 2, top, dw, h * 0.4), dc, { cut: 0.8, shadow: 0.55, seed: id + 'dv' + i })
        K.paper(ctx, K.roundRectPts(tx - 30, top - 20, 60, 26, 7), dc, { cut: 0.8, shadow: 0, seed: id + 'dt' + i })
      })
      const mx = 0
      const my = -h / 2 - d / 2
      if (typeof o.inside === 'function') {
        ctx.save()
        ctx.translate(mx, my)
        o.inside(ctx)
        ctx.restore()
      }
      // front face
      K.paper(ctx, K.roundRectPts(-w / 2, -h / 2, w, h, 10), color, { cut: 1.4, shadow: def(o.shadow, 1), lift: def(o.lift, 0), seed: id + 'fr' })
      ctx.save()
      ctx.fillStyle = 'rgba(255,245,225,0.25)'
      ctx.fillRect(-w / 2 + 6, -h / 2 + 3, w - 12, 5)
      ctx.restore()
      // darker kraft corner guards, like a real card box
      for (const sx of [-1, 1]) {
        K.paper(ctx, [[sx * (w / 2 - 2), h / 2 - 2], [sx * (w / 2 - 2), h / 2 - 46], [sx * (w / 2 - 46), h / 2 - 2]], shade(color, -0.22), { cut: 0.6, shadow: 0.3, seed: id + 'cg' + sx })
        circle(ctx, sx * (w / 2 - 16), h / 2 - 16, 3.2, shade(C.honey, -0.2))
      }
      // brass label holder + label card
      const lw = w * 0.68
      const lh = h * 0.4
      const ly = h * 0.06
      K.paper(ctx, K.roundRectPts(-lw / 2 - 10, ly - lh / 2 - 10, lw + 20, lh + 20, 8), C.honey, { cut: 0.8, shadow: 0.7, seed: id + 'br' })
      K.paper(ctx, K.rectPts(-lw / 2, ly - lh / 2, lw, lh), C.cream, { cut: 1, shadow: 0.3, seed: id + 'lc' })
      ctx.save()
      ctx.strokeStyle = rgba(C.tomato, 0.5)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(-lw / 2 + 8, ly - lh / 2 + 16)
      ctx.lineTo(lw / 2 - 8, ly - lh / 2 + 16)
      ctx.stroke()
      ctx.restore()
      for (const rx of [-lw / 2 - 2, lw / 2 + 2]) {
        circle(ctx, rx, ly, 4.5, shade(C.honey, -0.3))
        circle(ctx, rx - 1, ly - 1, 1.6, 'rgba(255,250,230,0.8)')
      }
      const lab = def(o.label, 'Agent Library')
      const fs = Math.min(44, (lw * 0.86) / Math.max(1, measure(ctx, lab, 'marker', 44)) * 44)
      text(ctx, lab, 0, ly + 8, { family: 'marker', size: fs, color: C.ink, t, id: id + 'lt', jitter: 0.7 })
      // finger-pull notch
      ctx.beginPath()
      ctx.ellipse(0, -h / 2 + 4, 30, 12, 0, 0, Math.PI)
      ctx.fillStyle = 'rgba(58,36,14,0.22)'
      ctx.fill()
      K.pencil.rect(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, id + 'fo', t, { stroke: rgba(C.ink, 0.45), strokeWidth: 2, roughness: 0.8, bowing: 0.3 })
      if (closedish) lid()
      out = {
        center: mk(0, 0),
        mouth: mk(mx, my),
        fan: [mk(mx - 160, my - 150), mk(mx, my - 200), mk(mx + 160, my - 150)],
        fanRot: [-0.32, 0, 0.32],
      }
    })
    return out
  }

  function stickerArt(ctx, t, spec, id) {
    const size = def(spec.textSize, 34)
    const lab = def(spec.label, 'Feature')
    const w = def(spec.w, measure(ctx, lab, 'chunky', size, '600') + 58)
    const h = def(spec.h, 74)
    const color = col(spec.color, C.sage)
    const curl = K.clamp01(def(spec.curl, 0))
    const corner = def(spec.corner, 'tr')
    // fold size on the white rim; starts past the rounded corner so it never pokes out
    const cr = curl > 0.02 ? K.lerp(26, Math.min(w, h) * 0.66, curl) : 0
    const rim = foldRect(w + 14, h + 14, 20, corner, cr)
    K.paper(ctx, rim.body, C.paperWhite, { cut: 0.8, shadow: def(spec.shadow, 1), lift: def(spec.lift, 0), seed: id + 'rm' })
    const body = foldRect(w, h, 14, corner, cr > 0 ? cr - 4 : 0)
    const bshape = K.paper(ctx, body.body, color, { cut: 0.7, shadow: 0, seed: id + 'bd' })
    ctx.save()
    K.pathPoly(ctx, bshape)
    ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.2)'
    ctx.beginPath()
    ctx.moveTo(-w / 2 + w * 0.12, -h / 2)
    ctx.lineTo(-w / 2 + w * 0.26, -h / 2)
    ctx.lineTo(-w / 2 + w * 0.12, h / 2)
    ctx.lineTo(-w / 2 - w * 0.02, h / 2)
    ctx.fill()
    ctx.restore()
    text(ctx, lab, 0, 0, { family: 'chunky', weight: '600', size, color: inkOn(color), t, id: id + 'tx', jitter: 0.5 })
    if (rim.flap) drawFlap(ctx, rim.flap, '#eee6d6', id, t)
    return { w, h }
  }

  PROPS.sticker = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'sticker')
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, 220, () => {
      const s = stickerArt(ctx, t, o, id)
      out = { center: mk(0, 0), w: s.w, h: s.h }
    })
    return out
  }

  PROPS.stickerSheet = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'stsheet')
    const labels = def(o.labels, ['Feature', 'Bug', 'Discussion'])
    const colors = def(o.colors, [C.sage, C.tomato, C.sky])
    const peeled = def(o.peeled, -1)
    const peel = K.clamp01(def(o.peel, 0))
    const n = labels.length
    const rowH = 104
    const w = def(o.w, 330)
    const h = n * rowH + 56
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, Math.max(w, h), () => {
      K.paper(ctx, K.roundRectPts(-w / 2, -h / 2, w, h, 14), '#f3f1ea', { cut: 1.2, shadow: def(o.shadow, 1), lift: def(o.lift, 0), seed: id + 'bk' })
      // waxy backing sheen + a peel-here corner
      ctx.save()
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.beginPath()
      ctx.moveTo(w * 0.1, -h / 2 + 4)
      ctx.lineTo(w * 0.24, -h / 2 + 4)
      ctx.lineTo(-w * 0.1, h / 2 - 4)
      ctx.lineTo(-w * 0.24, h / 2 - 4)
      ctx.fill()
      ctx.restore()
      drawFlap(ctx, [[w / 2 - 34, h / 2], [w / 2, h / 2 - 34], [w / 2 - 34, h / 2 - 34]], '#e7e2d4', id + 'pf', t)
      const centres = []
      labels.forEach((lab, i) => {
        const sy = -h / 2 + 28 + rowH * (i + 0.5)
        centres.push(mk(0, sy))
        const sw = measure(ctx, lab, 'chunky', 34, '600') + 58
        // die-cut ghost outline (visible once the sticker is gone)
        ctx.save()
        ctx.setLineDash([5, 5])
        ctx.lineWidth = 1.6
        ctx.strokeStyle = 'rgba(90,74,54,0.35)'
        K.pathPoly(ctx, K.roundRectPts(-sw / 2 - 7, sy - 44, sw + 14, 88, 20, 4))
        ctx.stroke()
        ctx.restore()
        const isP = i === peeled
        if (isP && peel >= 1) return
        const curl = isP ? K.clamp01(peel / 0.6) : 0
        const liftP = isP ? K.seg(peel, 0.6, 1) : 0
        const e = K.ease.outCubic(liftP)
        K.at(ctx, e * 40, sy - e * 70, e * -0.22, 1 + e * 0.08, () => {
          stickerArt(ctx, t, { label: lab, color: col(colors[i % colors.length], C.sage), curl: curl * (1 - e), corner: 'tr', lift: e * 16, shadow: isP ? 0.9 : 0.35 }, id + 's' + i)
        })
      })
      out = { center: mk(0, 0), stickers: centres, size: [w, h] }
    })
    return out
  }

  PROPS.dashedSlot = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'slot')
    const w = def(o.w, 300)
    const h = def(o.h, 200)
    const filled = K.clamp01(def(o.filled, 0))
    const label = def(o.label, '1 · agent — who is working')
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, Object.assign({ jitter: 0.6 }, o), id, w, () => {
      K.pathPoly(ctx, K.roundRectPts(-w / 2, -h / 2, w, h, 16))
      ctx.fillStyle = 'rgba(90,60,30,0.07)'
      ctx.fill()
      const lineC = filled > 0.5 ? C.sage : C.inkDim
      K.pencil.path(ctx, rrPath(-w / 2, -h / 2, w, h, 16), id + 'd', t, { stroke: lineC, strokeWidth: 3.2, roughness: 0.9, bowing: 0.5, strokeLineDash: [18, 12], disableMultiStroke: true })
      const parts = String(label).split(/\s+—\s+/)
      const head = parts[0]
      const sub = parts.length > 1 ? '— ' + parts.slice(1).join(' — ') : null
      const below = def(o.labelPos, 'bottom') !== 'top'
      const hy = below ? h / 2 + 38 : -h / 2 - (sub ? 78 : 34)
      const m = head.match(/^(\d+)(\s*·\s*)(.*)$/)
      if (m) {
        const nw = measure(ctx, m[1], 'chunky', 40, '600')
        const rw = measure(ctx, m[2] + m[3], 'marker', 40)
        const lx = -(nw + rw) / 2
        text(ctx, m[1], lx, hy, { family: 'chunky', weight: '600', size: 40, color: C.terracotta, align: 'left', t, id: id + 'n', jitter: 0.5 })
        text(ctx, m[2] + m[3], lx + nw, hy, { family: 'marker', size: 40, color: C.ink, align: 'left', t, id: id + 'h', jitter: 0.7 })
      } else text(ctx, head, 0, hy, { family: 'marker', size: 40, color: C.ink, t, id: id + 'h', jitter: 0.7 })
      if (sub) text(ctx, sub, 0, hy + 40, { family: 'hand', size: 30, color: C.inkDim, t, id: id + 's', jitter: 0.6 })
      if (filled > 0) {
        const e = K.ease.outBack(filled)
        K.at(ctx, w / 2 - 6, -h / 2 + 6, 0, e, () => {
          K.paper(ctx, K.ellipsePts(0, 0, 22, 22, 20), C.sage, { cut: 0.8, shadow: 0.8, seed: id + 'ck' })
          stroke(ctx, [[-10, 1], [-3, 9], [11, -9]], id + 'cm', t, { stroke: C.paperWhite, strokeWidth: 4.5, roughness: 0.6 })
        })
      }
      out = { center: mk(0, 0), rect: mapRect(mk, -w / 2, -h / 2, w, h), label: mk(0, hy) }
    })
    return out
  }
  function rrPath(x, y, w, h, r) {
    return `M${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} L${x},${y + r} Q${x},${y} ${x + r},${y} Z`
  }

  // text with '→' drawn as little hand arrows (fonts don't all carry the glyph)
  function arrowTextWidth(g, str, family, size, weight) {
    const f = g.font
    K.font(g, family, size, weight)
    const parts = str.split('→').map((s) => s.trim())
    const aw = size * 1.15
    const w = parts.reduce((a, s) => a + g.measureText(s).width, 0) + (parts.length - 1) * aw
    g.font = f
    return w
  }
  function drawArrowText(g, str, cx, cy, family, size, weight, color) {
    const parts = str.split('→').map((s) => s.trim())
    const aw = size * 1.15
    const total = arrowTextWidth(g, str, family, size, weight)
    K.font(g, family, size, weight)
    g.fillStyle = color
    g.strokeStyle = color
    g.textBaseline = 'middle'
    g.textAlign = 'left'
    g.lineCap = 'round'
    g.lineJoin = 'round'
    let x = cx - total / 2
    parts.forEach((s, i) => {
      if (s) g.fillText(s, x, cy + size * 0.04)
      x += g.measureText(s).width
      if (i < parts.length - 1) {
        const a0 = x + aw * 0.2
        const a1 = x + aw * 0.8
        g.lineWidth = Math.max(2, size * 0.1)
        g.beginPath()
        g.moveTo(a0, cy)
        g.lineTo(a1, cy)
        g.moveTo(a1 - size * 0.22, cy - size * 0.2)
        g.lineTo(a1, cy)
        g.lineTo(a1 - size * 0.22, cy + size * 0.2)
        g.stroke()
        x += aw
      }
    })
  }
  /** "Actor → Input → Mission → Goal" → "Actor → Input\n→ Mission → Goal" (break before the middle arrow). */
  function splitAtMiddleArrow(s) {
    const idx = []
    for (let i = 0; i < s.length; i++) if (s[i] === '→') idx.push(i)
    let cut = -1
    if (idx.length) cut = idx.reduce((a, b) => (Math.abs(b - s.length / 2) < Math.abs(a - s.length / 2) ? b : a))
    else {
      const sp = s.indexOf(' ', Math.floor(s.length / 2))
      cut = sp > 0 ? sp : -1
    }
    return cut > 0 ? s.slice(0, cut).trim() + '\n' + s.slice(cut).trim() : s
  }
  // turned-wood stamp handle profile: [height fraction, half-width fraction]
  const HANDLE = [[0, 0.56], [0.07, 0.56], [0.12, 0.44], [0.2, 0.25], [0.42, 0.19], [0.52, 0.27], [0.62, 0.43], [0.75, 0.5], [0.87, 0.46], [0.96, 0.31], [1, 0.1]]
  function latheSide(prof, sub) {
    const out = []
    const n = prof.length
    const P = (i) => prof[K.clamp(i, 0, n - 1)]
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < sub; k++) {
        const u = k / sub
        const p0 = P(i - 1)
        const p1 = P(i)
        const p2 = P(i + 1)
        const p3 = P(i + 2)
        const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u)
        out.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])])
      }
    }
    out.push(prof[n - 1])
    return out
  }
  function drawStampHandle(ctx, hx, hy, HH, W0, id, t) {
    const side = latheSide(HANDLE, 3)
    const poly = side.map(([fy, fw]) => [hx + fw * W0, hy - fy * HH]).concat(side.slice().reverse().map(([fy, fw]) => [hx - fw * W0, hy - fy * HH]))
    const shape = K.paper(ctx, poly, C.kraft, { cut: 0.4, shadow: 0.55, seed: id })
    ctx.save()
    K.pathPoly(ctx, shape)
    ctx.clip()
    // painted tomato knob
    const ky = hy - 0.58 * HH
    ctx.beginPath()
    ctx.moveTo(hx - W0, ky)
    ctx.quadraticCurveTo(hx, ky + W0 * 0.2, hx + W0, ky)
    ctx.lineTo(hx + W0, hy - HH - 4)
    ctx.lineTo(hx - W0, hy - HH - 4)
    ctx.closePath()
    ctx.fillStyle = K.paperPattern(ctx, C.tomato)
    ctx.fill()
    // turned grooves
    ctx.lineWidth = 1.6
    ctx.strokeStyle = 'rgba(58,30,14,0.4)'
    for (const f of [0.1, 0.46]) {
      const hw = W0 * (f < 0.2 ? 0.52 : 0.22)
      ctx.beginPath()
      ctx.ellipse(hx, hy - f * HH, hw, hw * 0.22, 0, 0, Math.PI)
      ctx.stroke()
    }
    // round-body shading: light from the upper left
    const g = ctx.createLinearGradient(hx - W0 * 0.6, 0, hx + W0 * 0.6, 0)
    g.addColorStop(0, 'rgba(255,245,228,0.1)')
    g.addColorStop(0.3, 'rgba(255,245,228,0.38)')
    g.addColorStop(0.55, 'rgba(255,245,228,0)')
    g.addColorStop(1, 'rgba(42,26,14,0.3)')
    ctx.fillStyle = g
    ctx.fillRect(hx - W0, hy - HH - 4, W0 * 2, HH + 8)
    ctx.restore()
    circle(ctx, hx - W0 * 0.2, hy - HH * 0.84, Math.max(2.5, W0 * 0.1), 'rgba(255,245,230,0.7)')
    K.pencil.poly(ctx, poly, id + 'o', t, { stroke: rgba(C.ink, 0.55), strokeWidth: 1.8, roughness: 0.6, bowing: 0.3 })
  }
  /** Wooden rubber stamp, (0,0) = centre of the rubber face; everything stacks up (-y). */
  function drawStampTool(ctx, bw, t, id, ink) {
    const bh = Math.max(44, bw * 0.22)
    const rubH = Math.max(8, bh * 0.16)
    const foamH = Math.max(5, bh * 0.1)
    const yFoam = -rubH - foamH
    const yTop = yFoam - bh
    const bev = Math.max(10, bh * 0.26)
    // inked rubber + foam cushion
    K.paper(ctx, K.rectPts(-bw / 2 + 3, -rubH, bw - 6, rubH + 1), shade(ink, -0.22), { cut: 0.5, shadow: 0.9, seed: id + 'rb' })
    K.paper(ctx, K.rectPts(-bw / 2 + 1, yFoam, bw - 2, foamH + 1), '#d9ccb3', { cut: 0.4, shadow: 0, seed: id + 'fm' })
    // wooden block: front face + bevelled top
    K.paper(ctx, K.roundRectPts(-bw / 2 - 4, yTop, bw + 8, bh, 5), C.kraftDark, { cut: 0.7, shadow: 0, seed: id + 'bl' })
    K.pathPoly(ctx, [[-bw / 2 - 4, yTop + 1], [bw / 2 + 4, yTop + 1], [bw / 2 - 10, yTop - bev], [-bw / 2 + 10, yTop - bev]])
    ctx.fillStyle = K.paperPattern(ctx, shade(C.kraftDark, 0.3))
    ctx.fill()
    ctx.save()
    // wood grain on the front face
    const r = K.rng('grain', id)
    ctx.strokeStyle = 'rgba(90,56,24,0.22)'
    ctx.lineWidth = 1.3
    for (let i = 0; i < 4; i++) {
      const gy = yTop + bh * (0.2 + i * 0.2) + (r() - 0.5) * 4
      ctx.beginPath()
      ctx.moveTo(-bw / 2, gy)
      ctx.bezierCurveTo(-bw / 6, gy + (r() - 0.5) * 8, bw / 6, gy + (r() - 0.5) * 8, bw / 2, gy + (r() - 0.5) * 4)
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(255,240,215,0.22)'
    ctx.fillRect(-bw / 2 - 2, yTop + 2, bw + 4, 4)
    ctx.restore()
    K.pencil.rect(ctx, -bw / 2 - 4, yTop, bw + 8, bh, id + 'blo', t, { stroke: rgba(C.ink, 0.55), strokeWidth: 1.8, roughness: 0.7, bowing: 0.3 })
    // index label on the block front, showing the ink colour
    const iw = Math.min(bw * 0.34, 120)
    K.paper(ctx, K.rectPts(-iw / 2, yTop + bh * 0.28, iw, bh * 0.42), C.cream, { cut: 0.5, shadow: 0.35, seed: id + 'ix' })
    ctx.fillStyle = rgba(ink, 0.75)
    ctx.fillRect(-iw * 0.34, yTop + bh * 0.45, iw * 0.68, Math.max(3, bh * 0.08))
    // handle(s): one turned-wood handle with a tomato cap; two on a long stamp
    const HH = K.clamp(bw * 0.35, 58, 128)
    const W0 = K.clamp(bw * 0.2, 32, 60)
    const xs = bw > 300 ? [-bw * 0.28, bw * 0.28] : [0]
    xs.forEach((hx, i) => drawStampHandle(ctx, hx, yTop - bev * 0.45, HH, W0, id + 'hd' + i, t))
  }

  PROPS.stampMark = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'stamp')
    const p = K.clamp01(def(o.p, 1))
    const str = String(def(o.text, 'Actor → Input → Mission → Goal'))
    const lines = str.split('\n')
    const size = def(o.size, 30)
    const family = def(o.family, 'chunky')
    const weight = family === 'chunky' ? '600' : ''
    const base = col(o.color, C.terracotta)
    const color = def(o.darken, 0) ? shade(base, -def(o.darken, 0)) : base
    const fade = def(o.fade, 0.2)
    const round = o.shape === 'round'
    const lh = size * 1.12
    const multi = lines.length > 1
    const tw = Math.max(...lines.map((l) => arrowTextWidth(ctx, l, family, size, weight)))
    const w = round ? Math.max(tw + size * 1.6, size * 4, lines.length * lh + size * 2) : tw + size * 1.4
    const h = round ? w : size * (multi ? 1.62 : 2.1) + lh * (lines.length - 1)
    const inner = multi ? 8 : 11
    const mk = mapper(ctx)
    let out = null
    const HIT = 0.35
    place(ctx, x, y, t, o, id, w, () => {
      if (p >= HIT) {
        const slam = K.seg(p, HIT, HIT + 0.12)
        const sc = 1 + (1 - K.ease.outCubic(slam)) * 0.08
        const m = ctx.getTransform()
        const res = K.clamp(Math.hypot(m.a, m.b) * sc, 0.25, 3)
        const pad = 12
        const cw = Math.ceil((w + pad * 2) * res)
        const ch = Math.ceil((h + pad * 2) * res)
        const off = K.mkCanvas(cw, ch)
        const g = off.getContext('2d')
        g.scale(res, res)
        g.translate(w / 2 + pad, h / 2 + pad)
        g.strokeStyle = color
        g.lineJoin = 'round'
        if (round) {
          g.lineWidth = 5
          g.beginPath()
          g.arc(0, 0, w / 2 - 3, 0, TAU)
          g.stroke()
          g.lineWidth = 2
          g.beginPath()
          g.arc(0, 0, w / 2 - 12, 0, TAU)
          g.stroke()
        } else {
          g.lineWidth = 5
          K.pathPoly(g, K.roundRectPts(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 10, 4))
          g.stroke()
          g.lineWidth = 2
          K.pathPoly(g, K.roundRectPts(-w / 2 + inner, -h / 2 + inner, w - inner * 2, h - inner * 2, 6, 4))
          g.stroke()
        }
        lines.forEach((l, i) => drawArrowText(g, l, 0, 1 + (i - (lines.length - 1) / 2) * lh, family, size, weight, color))
        // uneven inking: speckle gaps, dry streaks and a lighter side (kept light so the words read)
        g.globalCompositeOperation = 'destination-out'
        const r = K.rng('ink', id)
        const nDots = Math.round((w * h) / 120)
        g.fillStyle = 'rgba(0,0,0,0.9)'
        for (let i = 0; i < nDots; i++) {
          g.beginPath()
          g.arc((r() - 0.5) * w, (r() - 0.5) * h, 0.4 + r() * r() * 2, 0, TAU)
          g.fill()
        }
        g.strokeStyle = 'rgba(0,0,0,0.35)'
        for (let i = 0; i < 4; i++) {
          const yy = (r() - 0.5) * h
          g.lineWidth = 0.8 + r() * 1.2
          g.beginPath()
          g.moveTo(-w / 2, yy)
          g.lineTo(w / 2, yy + (r() - 0.5) * 8)
          g.stroke()
        }
        if (fade > 0) {
          const lg = g.createLinearGradient(-w / 2, 0, w / 2, 0)
          const side = r() < 0.5
          lg.addColorStop(0, side ? `rgba(0,0,0,${fade})` : 'rgba(0,0,0,0)')
          lg.addColorStop(1, side ? 'rgba(0,0,0,0)' : `rgba(0,0,0,${fade})`)
          g.fillStyle = lg
          g.fillRect(-w / 2 - pad, -h / 2 - pad, w + pad * 2, h + pad * 2)
        }
        ctx.save()
        ctx.globalAlpha *= 0.92
        ctx.globalCompositeOperation = 'multiply'
        ctx.scale(sc, sc)
        ctx.drawImage(off, -w / 2 - pad, -h / 2 - pad, w + pad * 2, h + pad * 2)
        ctx.restore()
      }
      if (def(o.tool, true) && p > 0 && p < 0.9) {
        let ty = 0
        let sq = 1
        let al = 1
        if (p < HIT) ty = -260 * (1 - K.ease.inQuad(p / HIT))
        else if (p < 0.6) sq = 1 - 0.1 * Math.sin(K.seg(p, HIT, 0.47) * Math.PI)
        else {
          const u = K.seg(p, 0.6, 0.9)
          ty = -260 * K.ease.outCubic(u)
          al = 1 - K.seg(p, 0.76, 0.9)
        }
        // shadow of the tool on the paper grows as it nears
        const near = 1 - Math.min(1, -ty / 260)
        ctx.save()
        ctx.globalAlpha *= 0.22 * near * al
        K.pathPoly(ctx, K.roundRectPts(-w / 2 + 6, -h / 2 + 10, w - 4, h, 12))
        ctx.fillStyle = 'rgb(58,36,14)'
        ctx.fill()
        ctx.restore()
        K.withAlpha(ctx, al, () => K.at(ctx, 0, h / 2 + ty, 0, [1 + (1 - sq) * 0.4, sq], () => drawStampTool(ctx, w + 8, t, id, color)))
      }
      out = { center: mk(0, 0), w, h }
    })
    return out
  }

  PROPS.envelope = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'envelope')
    const w = def(o.w, 440)
    const h = def(o.h, 270)
    const color = col(o.color, C.kraft)
    const open = K.clamp(def(o.open, 0), 0, 1.1)
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, w, () => {
      const cf = Math.cos(open * Math.PI)
      const tipY = -h / 2 + h * 0.64 * cf
      const flapPts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w * 0.04, tipY], [-w * 0.04, tipY]]
      const flap = () => {
        if (Math.abs(cf) < 0.03) return
        if (cf > 0) {
          K.paper(ctx, flapPts, shade(color, 0.08), { cut: 1, shadow: 0.9, lift: 2, seed: id + 'fl' })
          stroke(ctx, [[-w / 2 + 6, -h / 2 + 3], [-w * 0.04, tipY - 3], [w * 0.04, tipY - 3], [w / 2 - 6, -h / 2 + 3]], id + 'fe', t, { stroke: rgba(C.inkDim, 0.5), strokeWidth: 2, roughness: 0.8 })
          if (def(o.seal, true) && cf > 0.7) {
            K.at(ctx, 0, tipY - 4, 0.08, 1, () => {
              K.paper(ctx, heartPts(26), C.terracotta, { cut: 0.6, shadow: 0.8, seed: id + 'ht' })
              circle(ctx, -6, -6, 3, 'rgba(255,240,225,0.6)')
            })
          }
        } else {
          K.paper(ctx, flapPts, shade(color, 0.42), { cut: 1, shadow: 0.6, seed: id + 'fi' })
        }
      }
      if (cf < 0) flap()
      // inside back
      K.paper(ctx, K.rectPts(-w / 2 + 4, -h / 2, w - 8, h - 6), shade(color, -0.4), { cut: 0.8, shadow: def(o.shadow, 1), lift: def(o.lift, 0), seed: id + 'bk' })
      const mx = 0
      const my = -h / 2
      if (typeof o.contents === 'function') {
        ctx.save()
        ctx.translate(mx, my)
        o.contents(ctx)
        ctx.restore()
      }
      // the pocket (front of the envelope body)
      const pocket = K.paper(ctx, K.rectPts(-w / 2, -h / 2 + 10, w, h - 10), color, { cut: 1.2, shadow: 0.5, seed: id + 'pk' })
      ctx.save()
      K.pathPoly(ctx, pocket)
      ctx.clip()
      // side + bottom folds
      ctx.fillStyle = 'rgba(255,245,225,0.16)'
      K.pathPoly(ctx, [[-w / 2, h / 2], [w / 2, h / 2], [0, -h * 0.02]])
      ctx.fill()
      ctx.fillStyle = 'rgba(90,60,30,0.08)'
      K.pathPoly(ctx, [[-w / 2, -h / 2], [-w * 0.05, h * 0.04], [-w / 2, h / 2]])
      ctx.fill()
      ctx.restore()
      stroke(ctx, [[-w / 2 + 4, h / 2 - 4], [0, -h * 0.02], [w / 2 - 4, h / 2 - 4]], id + 'sm', t, { stroke: rgba(C.inkDim, 0.45), strokeWidth: 2, roughness: 0.8 })
      // a torn white address label below the flap tip: the stamp lands on light paper, clear of folds + seal
      const lblY = h * 0.325
      const lblW = w * 0.86
      const lblH = Math.min(88, h * 0.33)
      if (def(o.addressLabel, true)) {
        K.at(ctx, 0, lblY, -0.016, 1, () => K.paper(ctx, K.boxPts(lblW, lblH), C.paperWhite, { torn: 2.2, shadow: 0.55, seed: id + 'al' }))
      }
      if (cf >= 0) flap()
      const sp = def(o.stamp, 0)
      if (sp > 0) {
        const raw = String(def(o.stampText, 'Actor → Input → Mission → Goal'))
        const size = def(o.stampSize, 30)
        const room = lblW * 0.94
        const txt = !raw.includes('\n') && arrowTextWidth(ctx, raw, 'chunky', size, '600') + size * 1.4 > room ? splitAtMiddleArrow(raw) : raw
        const sw = Math.max(...txt.split('\n').map((l) => arrowTextWidth(ctx, l, 'chunky', size, '600'))) + size * 1.4
        const fit = Math.min(1, room / sw)
        PROPS.stampMark(ctx, 0, lblY, t, { id: id + 'st', text: txt, color: def(o.stampColor, C.terracotta), darken: def(o.stampDarken, 0.2), fade: 0.2, p: sp, size, scale: fit, rot: -0.03, tool: def(o.stampTool, true), jitter: 0 })
      }
      out = { center: mk(0, 0), mouth: mk(mx, my), stamp: mk(0, lblY), addressLabel: mapRect(mk, -lblW / 2, lblY - lblH / 2, lblW, lblH) }
    })
    return out
  }
  function heartPts(s) {
    const pts = []
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * TAU
      const hx = 16 * Math.pow(Math.sin(a), 3)
      const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a))
      pts.push([(hx * s) / 34, (hy * s) / 34])
    }
    return pts
  }

  PROPS.door = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'door')
    const w = def(o.w, 250)
    const h = def(o.h, 400)
    const open = K.clamp(def(o.open, 0), 0, 1.15)
    const glow = K.clamp01(def(o.glow, 0))
    const color = col(o.color, C.hiveTeal)
    const sxd = 1 - open * 0.88 // door face width: a small `open` already shows a readable crack
    const ang = Math.acos(K.clamp(sxd, -1, 1))
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, h, () => {
      K.paper(ctx, K.rectPts(-w / 2 - 28, -h / 2 - 28, w + 56, h + 28), col(o.frameColor, C.kraft), { torn: 3, shadow: def(o.shadow, 1), lift: def(o.lift, 0), seed: id + 'fr' })
      K.pencil.rect(ctx, -w / 2 - 14, -h / 2 - 14, w + 28, h + 14, id + 'fo', t, { stroke: rgba(C.ink, 0.35), strokeWidth: 2, roughness: 0.8 })
      // the room beyond: dark, flooding with warm light as glow rises
      ctx.fillStyle = K.paperPattern(ctx, shade(C.kraft, -0.6))
      ctx.fillRect(-w / 2, -h / 2, w, h)
      if (glow > 0) {
        ctx.save()
        ctx.globalAlpha *= glow
        ctx.fillStyle = K.paperPattern(ctx, C.lemon)
        ctx.fillRect(-w / 2, -h / 2, w, h)
        ctx.restore()
      }
      // door panel, hinged on the left
      const ex = -w / 2 + w * sxd
      K.at(ctx, -w / 2, 0, 0, [Math.max(0.02, sxd), 1], () => {
        K.paper(ctx, K.rectPts(0, -h / 2, w, h), color, { cut: 1, shadow: 0.5, seed: id + 'pn' })
        const pc = shade(color, 0.3)
        K.pencil.rect(ctx, 26, -h / 2 + 30, w - 52, h * 0.3, id + 'p1', t, { stroke: pc, strokeWidth: 3, roughness: 0.8 })
        K.pencil.rect(ctx, 26, h * 0.02, w - 52, h * 0.42, id + 'p2', t, { stroke: pc, strokeWidth: 3, roughness: 0.8 })
        const lab = def(o.label, 'Session')
        const lw = measure(ctx, lab, 'marker', 40) + 40
        K.at(ctx, w / 2, -h / 2 + 30 + h * 0.15, -0.03, 1, () => {
          K.paper(ctx, K.roundRectPts(-lw / 2, -27, lw, 54, 8), C.cream, { cut: 1, shadow: 0.8, seed: id + 'pl' })
          circle(ctx, -lw / 2 + 10, 0, 3, C.honey)
          circle(ctx, lw / 2 - 10, 0, 3, C.honey)
          text(ctx, lab, 0, 1, { family: 'marker', size: 40, color: C.ink, t, id: id + 'lt', jitter: 0.7 })
        })
        circle(ctx, w - 34 + 2, 26 + 3, 12, 'rgba(58,36,14,0.3)')
        K.paper(ctx, K.ellipsePts(w - 34, 26, 12, 12, 18), C.honey, { cut: 0.6, shadow: 0, seed: id + 'kn' })
        circle(ctx, w - 37, 22, 3.5, 'rgba(255,250,230,0.8)')
      })
      if (ang > 0.02) {
        ctx.fillStyle = K.paperPattern(ctx, shade(color, -0.35))
        ctx.fillRect(ex, -h / 2, 12 * Math.sin(ang), h)
      }
      const crackX = ex + 12 * Math.sin(ang)
      if (glow > 0) {
        ctx.save()
        ctx.globalAlpha *= glow
        ctx.fillStyle = C.lemon
        ctx.fillRect(-w / 2, h / 2 - 5, w, 5)
        K.pathPoly(ctx, [[-w / 2, h / 2], [w / 2, h / 2], [w / 2 + 70, h / 2 + 56], [-w / 2 - 70, h / 2 + 56]])
        ctx.fillStyle = 'rgba(247,222,138,0.4)'
        ctx.fill()
        if (open > 0.02) {
          const bw = w / 2 - crackX
          const beam = [[crackX, -h / 2 + 8], [w / 2, -h / 2 + 8], [w / 2 + 150 + bw * 0.6, h / 2 + 120], [crackX + 50, h / 2 + 120]]
          K.pathPoly(ctx, beam)
          ctx.fillStyle = 'rgba(247,222,138,0.3)'
          ctx.fill()
          K.pencil.poly(ctx, beam, id + 'bm', t, { fill: 'rgba(240,191,76,0.75)', fillStyle: 'hachure', hachureAngle: 58, hachureGap: 11, fillWeight: 3, stroke: 'none', roughness: 1.5 })
          K.sparkle(ctx, w / 2 + 70, h / 2 + 30, 18, id + 'sp', t, { n: 3, color: C.honey })
        }
        ctx.restore()
      }
      out = { center: mk(0, 0), gap: mk(0, h / 2), crack: mk(crackX, 0), knob: mk(-w / 2 + (w - 34) * sxd, 26), top: mk(0, -h / 2 - 28) }
    })
    return out
  }

  // ───────────────────────── generic ─────────────────────────

  PROPS.indexCard = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'icard')
    const w = def(o.w, 360)
    const h = def(o.h, 220)
    const mk = mapper(ctx)
    let out = null
    place(ctx, x, y, t, o, id, w, () => {
      let pts = K.rectPts(-w / 2, -h / 2, w, h)
      if (o.torn) {
        const r = K.rng('rip', id)
        pts = []
        for (let i = 0; i <= 40; i++) pts.push([-w / 2 + (i / 40) * w, -h / 2 + (r() - 0.5) * 7 + (i % 2) * 3])
        pts.push([w / 2, h / 2], [-w / 2, h / 2])
      }
      K.paper(ctx, pts, col(o.color, C.paperWhite), { cut: o.torn ? 0 : 1.3, shadow: def(o.shadow, 1), lift: def(o.lift, 0), seed: id })
      const headY = -h / 2 + 44
      const rowH = 34
      ctx.save()
      ctx.lineWidth = 1.8
      ctx.strokeStyle = rgba(C.sky, 0.55)
      ctx.beginPath()
      for (let ly = headY + rowH; ly < h / 2 - 8; ly += rowH) {
        ctx.moveTo(-w / 2 + 8, ly)
        ctx.lineTo(w / 2 - 8, ly)
      }
      ctx.stroke()
      ctx.strokeStyle = rgba(C.tomato, 0.65)
      ctx.beginPath()
      ctx.moveTo(-w / 2 + 8, headY)
      ctx.lineTo(w / 2 - 8, headY)
      ctx.stroke()
      ctx.restore()
      if (o.title) text(ctx, o.title, -w / 2 + 22, headY - 18, { family: 'marker', size: 32, color: C.ink, align: 'left', t, id: id + 'ti', jitter: 0.7 })
      const lines = def(o.lines, 3)
      const strs = Array.isArray(lines) ? lines : []
      const nRows = Array.isArray(lines) ? lines.length : lines
      const cb = def(o.checkboxes, 0)
      const cbs = Array.isArray(cb) ? cb : Array.from({ length: cb }, () => false)
      const rows = []
      const boxes = []
      const size = def(o.textSize, 28)
      const rev = def(o.reveal, 1)
      const total = strs.reduce((a, s) => a + s.length, 0) || 1
      let used = 0
      for (let i = 0; i < nRows; i++) {
        const ry = headY + rowH * (i + 1) - rowH * 0.42
        if (ry > h / 2 - 10) break
        let lx = -w / 2 + 22
        if (i < cbs.length) {
          K.pencil.rect(ctx, lx, ry - 11, 22, 22, id + 'cb' + i, t, { stroke: C.ink, strokeWidth: 2.2, roughness: 0.9 })
          boxes.push(mk(lx + 11, ry))
          if (cbs[i]) stroke(ctx, [[lx + 3, ry - 1], [lx + 10, ry + 8], [lx + 26, ry - 16]], id + 'ck' + i, t, { stroke: C.sage, strokeWidth: 4, roughness: 0.8 })
          lx += 34
        }
        rows.push(mk(lx, ry))
        if (strs[i]) {
          const lr = K.clamp01((rev * total - used) / Math.max(1, strs[i].length))
          used += strs[i].length
          if (lr > 0) text(ctx, strs[i], lx, ry, { family: 'hand', size, color: C.ink, align: 'left', t, id: id + 'l' + i, reveal: lr, jitter: 0.6 })
        }
      }
      out = { center: mk(0, 0), rows, boxes }
    })
    return out
  }

  PROPS.speedLines = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'speed')
    const p = K.clamp01(def(o.p, 1))
    if (p <= 0) return null
    const n = def(o.n, 4)
    const len = def(o.len, 160)
    const spread = def(o.spread, 80)
    const gap = def(o.gap, 10)
    const color = col(o.color, C.inkDim)
    const r = K.rng('speed', id)
    K.at(ctx, x, y, def(o.dir, 0), def(o.scale, 1), () => {
      for (let i = 0; i < n; i++) {
        const off = (n > 1 ? i / (n - 1) - 0.5 : 0) * spread + (r() - 0.5) * 10
        const L = len * (0.55 + 0.45 * r()) * (0.4 + 0.6 * p)
        const s0 = -gap - r() * 22 - Math.abs(off) * 0.3
        stroke(ctx, [[s0, off], [s0 - L, off + (r() - 0.5) * 4]], id + i, t, { stroke: rgba(color, 0.85 * p), strokeWidth: def(o.width, 3.2), roughness: 0.9, bowing: 0.8 })
      }
    })
    return null
  }

  /** Lumpy cloud outline: nb scalloped bumps around radius cr (cusps between bumps). */
  function cloudPts(cr, nb, rot, id) {
    const pts = []
    const N = nb * 8
    const r = K.rng('cloud', id)
    const amp = Array.from({ length: nb }, () => 0.85 + r() * 0.3)
    for (let i = 0; i < N; i++) {
      const a = rot + (i / N) * TAU
      const u = (i / N) * nb
      const k = Math.floor(u)
      const b = Math.sin((u - k) * Math.PI) // 0 at the cusp, 1 mid-bump
      pts.push([Math.cos(a) * cr * (0.8 + 0.22 * b * amp[k]), Math.sin(a) * cr * (0.8 + 0.22 * b * amp[k])])
    }
    return pts
  }

  PROPS.doodlePuff = function (ctx, x, y, t, o = {}) {
    const id = def(o.id, 'puff')
    const p = def(o.p, 0.5)
    if (p <= 0 || p >= 1) return null
    const r = def(o.r, 70)
    const n = def(o.n, 3)
    const grow = K.ease.outBack(K.seg(p, 0, 0.35))
    const fade = 1 - K.seg(p, 0.55, 1)
    const drift = K.ease.outCubic(p)
    const rr = K.rng('puff', id)
    const a0 = rr() * TAU
    const SIZES = [1, 0.8, 0.65]
    const ink = col(o.color, C.ink)
    const fill = col(o.fill, C.paperWhite)
    K.at(ctx, x, y, def(o.rot, 0), def(o.scale, 1), () => {
      K.withAlpha(ctx, fade, () => {
        // born overlapping (one cloud bursting), then the lumps drift apart and shrink away
        for (let i = n - 1; i >= 0; i--) {
          const a = a0 + (i / n) * TAU
          const dist = r * (0.1 + 0.62 * drift) * (i === 0 ? 0.7 : 1)
          const cr = r * 0.5 * SIZES[i % 3] * grow * (1 - 0.35 * K.seg(p, 0.5, 1))
          if (cr < 1) continue
          const pts = cloudPts(cr, 5 + (i % 2), a0 + i * 1.3, id + i).map(([px, py]) => [px + Math.cos(a) * dist, py + Math.sin(a) * dist])
          if (p < 0.75) {
            K.pathPoly(ctx, pts)
            ctx.fillStyle = rgba(fill, 0.92)
            ctx.fill()
          }
          K.pencil.poly(ctx, pts, id + 'c' + i, t, { stroke: ink, strokeWidth: 2.6, roughness: 1.1, bowing: 0.8 })
        }
        if (p > 0.25) {
          for (let i = 0; i < n; i++) {
            const a = a0 + ((i + 0.5) / n) * TAU
            const d = r * (0.95 + 0.55 * drift)
            circle(ctx, Math.cos(a) * d, Math.sin(a) * d, 3.5, ink)
          }
        }
      })
    })
    return null
  }

  // Canvas-state guard: every prop leaves the caller's ctx exactly as it found it (font, alpha,
  // composite, styles, transform, …) — some helpers set state outside a save()/restore().
  Object.keys(PROPS_DAY).forEach((name) => {
    const f = PROPS[name]
    PROPS[name] = function (ctx, x, y, t, o) {
      ctx.save()
      try {
        return f(ctx, x, y, t, o || {})
      } finally {
        ctx.restore()
      }
    }
  })
})()

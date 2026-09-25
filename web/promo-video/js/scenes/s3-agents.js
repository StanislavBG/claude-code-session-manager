/* s3-agents.js — "Pick an agent and a mission — Claude arrives briefed. Favorites become one-click buttons."
 * Owner: scene s3 (phase B). Pure function of (t, info): every beat time is derived from info.wordAt /
 * info.nextBeat each frame (see beats()), nothing is cached, randomness only through the kit/props seeds.
 *
 * Set (one floor line at y = FLOOR, the "form" sheet above it):
 *   Agent Library card box (left) · dashed slots "1 · agent — who is working" / "2 · mission — how they work"
 *   and the Feature / Bug / Discussion sticker sheet on a taped paper form (top) · kraft envelope (centre floor)
 *   · teal "Session" door (right) · Pip between envelope and door · later the "Hot keys" strip + clay button.
 * Beats (T.* in beats()):
 *   pan-in      console pans away; desk (-0.35 dx), form (-0.16 dx) and foreground scraps (+0.14 dx) parallax
 *   T.lid       first beat (pre-VO hook, as the pan lands): box squashes, lid pops (outBack); Pip hops
 *   T.fan       "Pick": the three agent cards riffle up out of the box in a staggered fan
 *   T.grab      "agent": hand (from the top) pinches the architect by its hard hat, carries it on an arc
 *               (it waves, swings with the motion), drops it into slot 1 on a beat (T.drop1); Pip points at it
 *   T.peel      "mission": a second hand (from the right) curls the sage Feature sticker's corner, peels it,
 *               carries it to slot 2 and thups it in on a beat (T.press2), then lifts straight up and leaves;
 *               both slot checks sit popped for ~0.27 s; Pip gazes up at it
 *   T.pack      "Claude": both hop out of the slots, arc to the envelope's pocket lip and visibly SINK in behind
 *               the pocket (shrinking to 0.85); the flap shuts over them (heart seal)
 *   T.stamp     beat under "arrives": rubber stamp THUNK "Actor → Input → Mission → Goal", fast lift so the
 *               label reads for ~0.6 s; Pip flinches (> <) then wobbles back
 *   T.slide     envelope leans forward (still upright + readable), lies down only at T.flat0, then zips along
 *               the floor under the Session door; Pip hops over it
 *   T.beam      half-beat inside "briefed": door cracks open, warm halo + floor pool + crayon beam, and a plain
 *               cream speech bubble with typing dots pops out of the doorway (Claude arrived); Pip cheers mid-air
 *   T.favPop    beat before "Favorites": an architect copy hops out of the Agent Library, waving, a pink heart
 *               pops above it and rides along with it
 *   T.favFly    it flies on an arc, squash-shrinks (never edge-on) into the mini card; the Hot keys strip +
 *               terracotta clay button stand up half a beat before it lands on the cap on the beat under
 *               "become" (T.favLand) — the heart pops into the cap and bursts
 *   T.press     beat on "one-click": a bare human hand (blue sleeve, so the finger reads on terracotta) slides in
 *               along its own arm axis, hovers, lifts (anticipation), jabs; the dome squashes and springs back past
 *               rest, doodle puff; Pip claps with a hop, the devlead + validator cards wave from the box.
 * Everything keeps above y ≈ 900 (captions). t outside [0, dur] is clamped for the animation clock.
 */
(function () {
  'use strict'
  const { C } = K
  const E = K.ease
  const seg = K.seg
  const lerp = K.lerp
  const clamp = K.clamp
  const clamp01 = K.clamp01

  // ───────── layout (scene px) ─────────
  const FLOOR = 890
  const BOX = { x: 262, s: 1, w: 420, h: 250 }
  BOX.y = FLOOR - (BOX.h / 2) * BOX.s // front-face centre
  const MOUTH = [BOX.x, BOX.y - (BOX.h / 2 + 32) * BOX.s] // cardBox inside() origin (0, -h/2 - d/2)
  const AS = 0.7 // agent card scale on stage
  const AB = AS / BOX.s // agent scale inside the box frame
  const PINCH = 226 // hard-hat tip above the agent's ground point (scale 1)
  const FAN_Y = 52 // ground y of a risen card, box-mouth frame
  const HID_Y = 210 // ground y of a card still hidden in the box
  const FAV_Y = -34 // the favourite hops right out of the box (legs above the front edge)
  const HOP_UP = 61 // CAST.agent pose 'hop' at poseT 0.3 lifts the card (and feet) this far above its ground point
  const FORM = { x: 990, y: 262, w: 1100, h: 400 }
  const SLOT = { w: 280, h: 210, s: 1 }
  const S1 = [715, 215]
  const S2 = [1035, 215]
  const S1G = [S1[0], S1[1] + 88] // architect ground point inside slot 1
  const SHEET = { x: 1385, y: 245, s: 0.8 }
  const ST0 = [SHEET.x, SHEET.y - 104 * SHEET.s] // "Feature" sticker centre on the sheet
  const ENV = { x: 880, s: 0.95, w: 440, h: 270 }
  const DOOR = { x: 1700, s: 1, w: 250, h: 400 }
  DOOR.y = FLOOR - (DOOR.h / 2) * DOOR.s
  const JAMB = DOOR.x - (DOOR.w / 2) * DOOR.s - 8 // envelope is clipped here once it slips under the door
  const ENV_END = JAMB + (ENV.w / 2) * ENV.s * 1.04 + 12
  const PIPX = 1335
  const PIPS = 0.95
  const BTN = { x: 1030, y: FLOOR - 106, s: 1, r: 90 }
  const HAND_S = 0.8
  const SLEEVE = C.blue
  const HC_ROT = 0.27 // hand C's arm angle (from the top): threads the gap between slot 2 and the sticker sheet
  const HC_OFF = 0.55 // …and presses this far right of the dome apex (·r) so the mini icon stays visible

  // ───────── helpers ─────────
  const qarc = (a, b, lift, p) => {
    const c = [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - lift]
    const u = 1 - p
    return [u * u * a[0] + 2 * u * p * c[0] + p * p * b[0], u * u * a[1] + 2 * u * p * c[1] + p * p * b[1]]
  }
  const mix2 = (a, b, p) => [lerp(a[0], b[0], p), lerp(a[1], b[1], p)]
  // a shallow downward toss: the control point sits a third of the way down, so the half-way frame is half-way
  const dropArc = (a, b, p) => {
    const c = [(a[0] + b[0]) / 2, a[1] + 0.3 * (b[1] - a[1]) - 24]
    const u = 1 - p
    return [u * u * a[0] + 2 * u * p * c[0] + p * p * b[0], u * u * a[1] + 2 * u * p * c[1] + p * p * b[1]]
  }
  const wob = (t, t0, amp, f = 18, d = 7) => (t < t0 ? 0 : amp * Math.exp(-d * (t - t0)) * Math.sin(f * (t - t0)))
  const bump = (t, a, b) => Math.sin(Math.PI * seg(t, a, b))
  const panOf = (x) => clamp((x / K.W) * 1.6 - 0.8, -0.8, 0.8)
  const rotPt = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)]
  function lookAt(from, to) {
    const dx = to[0] - from[0]
    const dy = to[1] - from[1]
    const d = Math.hypot(dx, dy) || 1
    return [dx / d, dy / d]
  }
  function heartPts(s) {
    const pts = []
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2
      const hx = 16 * Math.pow(Math.sin(a), 3)
      const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a))
      pts.push([(hx * s) / 34, (hy * s) / 34])
    }
    return pts
  }
  // CAST.agent always draws a ground contact shadow at its ground point; for a card in mid-air (carried, tossed,
  // flying) that shadow would float, so clip everything below the feet away. (gx, gy) = ground point in the
  // current frame, feetUp = how far above it the feet are (61 for pose 'hop' at poseT 0.3, 0 standing), s = scale.
  function airAgent(ctx, gx, gy, s, feetUp, o, t) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(gx - 400, gy - 800, 800, 800 - (feetUp - 8) * s)
    ctx.clip()
    CAST.agent(ctx, gx, gy, t, Object.assign({ scale: s }, o))
    ctx.restore()
  }
  function stickerW(ctx) {
    ctx.save()
    K.font(ctx, 'chunky', 34, '600')
    const w = ctx.measureText('Feature').width + 58
    ctx.restore()
    return w
  }

  // ───────── the clock: every beat from the narration + the music grid ─────────
  function beats(info) {
    const w = (word, fb) => (info.wordAt ? info.wordAt(word, fb) : fb)
    const nb = (x) => (info.nextBeat ? info.nextBeat(x) : x)
    const beat = info.beat || 0.58
    const half = (x) => {
      const b = nb(x)
      return b - beat / 2 >= x - 1e-6 ? b - beat / 2 : b
    }
    const T = {}
    T.pick = w('pick', 0.45)
    T.lid = Math.max(0.12, nb(T.pick - 0.4)) // pre-VO hook: the lid pops on the first beat
    T.fan = Math.max(T.lid + 0.08, T.pick - 0.05) // the cards riffle up on "Pick", after the pan has landed
    T.grab = Math.max(T.fan + 0.45, w('agent', 0.86))
    T.drop1 = nb(T.grab + 0.33)
    T.mission = w('mission', 1.48)
    T.peel = Math.max(T.drop1 + 0.1, T.mission - 0.06)
    T.press2 = nb(T.peel + 0.4)
    T.claude = w('claude', 2.21)
    T.pack = Math.max(T.press2 + 0.26, T.claude - 0.04) // both hop out of the slots on "Claude"…
    T.packEnd = T.pack + 0.24 // …arc over and sink into the envelope's pocket (visible going IN)
    T.stamp = nb(T.packEnd + 0.04) // THUNK on the beat under "arrives"
    T.briefed = w('briefed', 2.95)
    T.beam = half(Math.max(T.briefed, T.stamp + 0.8)) // light on the half-beat inside "briefed" (stamp stays readable)
    T.slide = T.beam - 0.3 // envelope leans forward, still upright (label readable)
    T.slideEnd = T.beam + 0.03 // …and is fully under the door just after the light cracks
    T.flat0 = T.beam - 0.16 // it lies down only just before it zips off
    T.flat1 = T.beam - 0.09
    T.zip0 = T.flat0 - 0.01
    T.fav = w('favorites', 3.75)
    T.favPop = Math.max(T.beam + 0.25, nb(T.fav - 0.15)) // the favourite hops out of the box
    T.favFly = T.favPop + 0.2
    T.favLand = Math.max(T.favFly + 0.34, nb(w('become', 4.31) - 0.12)) // mini lands on the cap on a beat
    T.stripLand = T.favLand - beat / 2 // Hot keys strip stands up half a beat before, where the card is heading
    T.strip = T.stripLand - 0.17
    T.press = Math.max(T.favLand + 0.45, nb(w('one-click', 4.71) - 0.02))
    return T
  }

  // ───────── background / foreground layers (parallax) ─────────
  function drawForm(ctx, t) {
    // the taped paper "form" the two slots + sticker sheet sit on
    K.at(ctx, FORM.x, FORM.y, -0.006, 1, () => {
      K.paper(ctx, K.boxPts(FORM.w, FORM.h), C.paperWhite, { torn: 5, seed: 's3-form', shadow: 0.9 })
      ctx.save()
      ctx.strokeStyle = 'rgba(134,194,227,0.35)'
      ctx.lineWidth = 2
      ctx.beginPath()
      for (let y = -140; y <= 170; y += 46) {
        ctx.moveTo(-FORM.w / 2 + 18, y)
        ctx.lineTo(FORM.w / 2 - 18, y)
      }
      ctx.stroke()
      ctx.strokeStyle = 'rgba(224,105,74,0.35)'
      ctx.beginPath()
      ctx.moveTo(-FORM.w / 2 + 64, -FORM.h / 2 + 10)
      ctx.lineTo(-FORM.w / 2 + 64, FORM.h / 2 - 10)
      ctx.stroke()
      ctx.restore()
    })
    K.tape(ctx, FORM.x - FORM.w / 2 + 16, FORM.y - FORM.h / 2 + 18, 160, -0.5, 'rgba(111,125,82,0.72)', { seed: 's3-ft1' })
    K.tape(ctx, FORM.x + FORM.w / 2 - 10, FORM.y - FORM.h / 2 + 16, 150, 0.45, 'rgba(232,169,136,0.8)', { seed: 's3-ft2', pattern: 'dots' })
  }
  function drawForeground(ctx, t) {
    // a stubby pencil lying on the desk (bottom-left) + a curl of washi (top-right corner)
    K.at(ctx, 190, 958, -0.1, 1, () => {
      const body = [[-150, -15], [110, -15], [110, 15], [-150, 15]]
      K.paper(ctx, body, C.mustard, { cut: 1, seed: 's3-pen', shadow: 1, lift: 4 })
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.fillRect(-150, -10, 260, 6)
      K.paper(ctx, [[110, -15], [160, -3], [160, 3], [110, 15]], C.kraft, { cut: 0.6, seed: 's3-pent', shadow: 0 })
      K.paper(ctx, [[148, -5], [168, 0], [148, 5]], C.ink, { cut: 0, seed: 's3-penl', shadow: 0 })
      K.paper(ctx, K.rectPts(-176, -15, 26, 30), '#c9ccd1', { cut: 0.5, seed: 's3-penf', shadow: 0 })
      K.paper(ctx, K.roundRectPts(-206, -15, 34, 30, 8), C.pink, { cut: 0.5, seed: 's3-pene', shadow: 0 })
    })
    K.tape(ctx, 1850, 40, 170, 0.62, 'rgba(228,184,90,0.8)', { seed: 's3-fgt', pattern: 'dots' })
  }

  // ───────── the sticker's frame in scene space ─────────
  function sheetStickerFrame(pp) {
    const e = E.outCubic(seg(pp, 0.6, 1))
    return { x: ST0[0] + 40 * e * SHEET.s, y: ST0[1] - 70 * e * SHEET.s, rot: -0.22 * e, s: SHEET.s * (1 + 0.08 * e), e }
  }
  const SLOT_ST = { x: S2[0], y: S2[1], rot: 0.025, s: 0.95 }
  function stickerFrame(tt, T) {
    const p1 = T.peel + 0.26
    if (tt < p1) return null
    const a = sheetStickerFrame(1)
    if (tt < T.press2 - 0.03) {
      const p = E.inOutCubic(seg(tt, p1, T.press2 - 0.03))
      const c = qarc([a.x, a.y], [SLOT_ST.x, SLOT_ST.y - 14], 60, p)
      return { x: c[0], y: c[1], rot: lerp(a.rot, SLOT_ST.rot, p) + 0.12 * Math.sin(Math.PI * p), s: lerp(a.s, SLOT_ST.s, p), sq: [1, 1] }
    }
    const land = seg(tt, T.press2 - 0.03, T.press2)
    const b = bump(tt, T.press2 - 0.02, T.press2 + 0.12)
    return { x: SLOT_ST.x, y: SLOT_ST.y - 14 * (1 - land), rot: SLOT_ST.rot, s: SLOT_ST.s, sq: [1 + 0.06 * b, 1 - 0.1 * b] }
  }
  function drawStickerAt(ctx, t, f, id) {
    K.at(ctx, f.x, f.y, f.rot, [f.s * f.sq[0], f.s * f.sq[1]], () => PROPS.sticker(ctx, 0, 0, t, { id, label: 'Feature', color: 'sage', jitter: 0.4, lift: f.lift || 0 }))
  }

  // ───────── the architect card being carried by hand A ─────────
  const P0 = [MOUTH[0], MOUTH[1] + FAN_Y * BOX.s - PINCH * AS]
  const P1 = [S1G[0], S1G[1] - PINCH * AS]
  function carryPinch(tt, T) {
    const t0 = T.grab + 0.04
    const t1 = T.drop1 - 0.03
    const tug = bump(tt, T.grab - 0.02, T.grab + 0.08)
    if (tt < t0) return [P0[0], P0[1] - 8 * tug]
    const p = E.inOutCubic(seg(tt, t0, t1))
    return qarc([P0[0], P0[1] - 8], [P1[0], P1[1] - 18], 130, p)
  }

  PROMO.scene('s3-agents', {
    draw(ctx, t, dur, info) {
      const T = beats(info)
      const tt = clamp(t, 0, dur)
      const cam = info.camShift ? info.camShift(t) : { dx: 0, dy: 0 }
      const M0 = ctx.getTransform()

      // ── background layers ──
      K.at(ctx, Math.round(-0.35 * cam.dx), 0, 0, 1, () => K.desk(ctx))
      K.at(ctx, Math.round(-0.16 * cam.dx), 0, 0, 1, () => drawForm(ctx, t))

      const sw = stickerW(ctx)
      const peelP = seg(tt, T.peel, T.peel + 0.26)
      const packP = seg(tt, T.pack, T.packEnd)

      // ── slots (+ what sits in them) ──
      const fill1 = seg(tt, T.drop1, T.drop1 + 0.12) * (1 - seg(tt, T.pack + 0.02, T.pack + 0.14))
      const fill2 = seg(tt, T.press2, T.press2 + 0.12) * (1 - seg(tt, T.pack + 0.02, T.pack + 0.14))
      PROPS.dashedSlot(ctx, S1[0], S1[1], t, { id: 's3-slot1', w: SLOT.w, h: SLOT.h, scale: SLOT.s, label: '1 · agent — who is working', filled: fill1 })
      PROPS.dashedSlot(ctx, S2[0], S2[1], t, { id: 's3-slot2', w: SLOT.w, h: SLOT.h, scale: SLOT.s, label: '2 · mission — how they work', filled: fill2 })
      // architect resting in slot 1 (dropped at T.drop1, leaves at T.pack)
      if (tt >= T.drop1 && tt < T.pack) {
        const fall = E.inQuad(seg(tt, T.drop1, T.drop1 + 0.07))
        const b = bump(tt, T.drop1 + 0.05, T.drop1 + 0.2)
        const r = wob(tt, T.drop1 + 0.05, 0.12, 20, 8)
        K.at(ctx, S1G[0], S1G[1] - 18 * (1 - fall), r, [1 + 0.08 * b, 1 - 0.12 * b], () =>
          CAST.agent(ctx, 0, 0, t, { id: 's3-arch', kind: 'architect', scale: AS, pose: 'idle', look: lookAt(S1, [PIPX, 700]) })
        )
      }
      // sticker sitting in slot 2
      const stF = stickerFrame(tt, T)
      if (stF && tt >= T.press2 - 0.03 && tt < T.pack) drawStickerAt(ctx, t, stF, 's3-st')

      // ── sticker sheet ──
      PROPS.stickerSheet(ctx, SHEET.x, SHEET.y, t, { id: 's3-sheet', scale: SHEET.s, peeled: tt >= T.peel ? 0 : -1, peel: peelP })

      // ── the Agent Library box with its fanned trading cards ──
      const antic = bump(tt, T.lid - 0.12, T.lid + 0.02)
      const stretch = bump(tt, T.lid + 0.02, T.lid + 0.2)
      const boxSq = [1 + 0.04 * antic - 0.02 * stretch, 1 - 0.06 * antic + 0.04 * stretch]
      const lidOpen = E.outBack(seg(tt, T.lid, T.lid + 0.3))
      const pressWave = tt >= T.press + 0.06
      const fanLook = tt < T.grab ? [0.25, -1] : tt < T.drop1 + 0.2 ? lookAt([BOX.x, 600], carryPinch(tt, T)) : tt < T.favPop ? lookAt([BOX.x, 600], [ENV.x, 760]) : lookAt([BOX.x, 600], [BTN.x, BTN.y])
      PROPS.cardBox(ctx, BOX.x, FLOOR - (BOX.h / 2) * BOX.s * boxSq[1], t, {
        id: 's3-box',
        scale: [BOX.s * boxSq[0], BOX.s * boxSq[1]],
        lidOpen,
        inside: (g) => {
          const fan = [
            { kind: 'devlead', x: -104, rot: -0.26, d: 0.06 },
            { kind: 'validator', x: 104, rot: 0.26, d: 0.12 },
          ]
          for (const c of fan) {
            const rp = E.outBack(seg(tt, T.fan + c.d, T.fan + c.d + 0.3))
            if (rp <= 0) continue
            const gy = lerp(HID_Y, FAN_Y, rp)
            CAST.agent(g, c.x, gy, t, { id: 's3-' + c.kind, kind: c.kind, scale: AB, rot: c.rot + wob(tt, T.fan + c.d + 0.3, 0.08), pose: pressWave ? (c.kind === 'devlead' ? 'wave' : 'hop') : 'idle', poseT: tt - T.press, look: fanLook })
          }
          // the architect (until the hand lifts it out)
          if (tt < T.grab + 0.04) {
            const rp = E.outBack(seg(tt, T.fan, T.fan + 0.3))
            if (rp > 0) {
              const tug = bump(tt, T.grab - 0.02, T.grab + 0.08)
              CAST.agent(g, 0, lerp(HID_Y, FAN_Y, rp) - (8 / BOX.s) * tug, t, { id: 's3-arch', kind: 'architect', scale: AB * (1 + 0.05 * tug), pose: 'idle', look: fanLook })
            }
          }
          // a second architect pops up: the favourite
          if (tt >= T.favPop && tt < T.favFly) {
            const r = E.outBack(seg(tt, T.favPop, T.favPop + 0.16))
            CAST.agent(g, 0, lerp(HID_Y, FAV_Y, r), t, { id: 's3-fav', kind: 'architect', scale: AB, pose: 'wave', poseT: tt - T.favPop, look: [0.8, 0.2] })
          }
        },
      })

      // ── the envelope (packing, stamp, lying down, zipping under the door) ──
      const env = envState(tt, T)
      const { envSx, envSy, envX, slideP, lean } = env
      const envOpen = 1 - E.inOutCubic(seg(tt, T.packEnd - 0.06, T.packEnd + 0.06))
      const stampP = 0.35 * E.inQuad(seg(tt, T.stamp - 0.08, T.stamp)) + 0.65 * seg(tt, T.stamp + 0.03, T.stamp + 0.16)
      const packing = tt >= T.pack && tt < T.packEnd + 0.02
      if (envX < ENV_END - 1) {
        ctx.save()
        if (slideP > 0) {
          ctx.beginPath()
          ctx.rect(-400, -400, JAMB + 400, K.H + 800)
          ctx.clip()
          const tail = envX - (ENV.w / 2) * ENV.s * envSx
          const sp = seg(tt, T.zip0, T.zip0 + 0.05) * (1 - seg(slideP, 0.85, 1))
          if (sp > 0) PROPS.speedLines(ctx, tail - 6, FLOOR - 26, t, { id: 's3-spd', dir: 0, len: 190, n: 3, spread: 44, p: sp })
        }
        const M = ctx.getTransform()
        // lean pivots about the bottom corner it tips onto (back on its heel, then forward onto its nose)
        const pivX = envX + (lean >= 0 ? 1 : -1) * (ENV.w / 2) * ENV.s * envSx
        ctx.translate(pivX, FLOOR)
        ctx.rotate(lean)
        ctx.translate(-pivX, -FLOOR)
        PROPS.envelope(ctx, envX, FLOOR - (ENV.h / 2) * ENV.s * envSy, t, {
          id: 's3-env',
          scale: [ENV.s * envSx, ENV.s * envSy],
          open: envOpen,
          stamp: stampP,
          stampSize: 40,
          jitter: slideP > 0 ? 0 : 0.6,
          contents: packing
            ? (g) => {
                g.save()
                g.setTransform(M)
                drawPacking(g, t, tt, T, packP, env)
                g.restore()
              }
            : null,
        })
        ctx.restore()
      }

      // ── the Session door (warm light spills out on "briefed") ──
      const glow = 0.35 * seg(tt, T.slideEnd - 0.1, T.slideEnd) + 0.65 * E.outCubic(seg(tt, T.beam - 0.04, T.beam + 0.1))
      const doorOpen = 0.3 * E.outBack(seg(tt, T.beam - 0.06, T.beam + 0.24))
      const gulp = bump(tt, T.slideEnd - 0.1, T.slideEnd + 0.1)
      if (glow > 0) drawDoorLight(ctx, glow, tt, T)
      PROPS.door(ctx, DOOR.x, FLOOR - (DOOR.h / 2) * DOOR.s * (1 - 0.03 * gulp), t, { id: 's3-door', scale: [DOOR.s * (1 + 0.025 * gulp), DOOR.s * (1 - 0.03 * gulp)], open: doorOpen, glow, jitter: 0.5 })
      drawClaudeBubble(ctx, t, tt, T)

      // ── Hot keys strip + clay button ──
      const standP = seg(tt, T.strip, T.stripLand)
      let btn = null
      if (standP > 0) {
        const sy = E.outBack(standP)
        const landB = bump(tt, T.favLand, T.favLand + 0.16)
        let press = 0.3 * landB
        if (tt >= T.press - 0.03) {
          press = E.outQuad(seg(tt, T.press - 0.03, T.press + 0.03)) // squashes the instant the fingertip lands
          if (tt >= T.press + 0.14) press = 1 - K.spring(tt, T.press + 0.14, { freq: 17, damp: 6.5 })
        }
        const puffP = seg(tt, T.press - 0.01, T.press + 0.75)
        if (puffP > 0 && puffP < 1) PROPS.doodlePuff(ctx, BTN.x + 10, BTN.y - 20, t, { id: 's3-puff', p: puffP, r: 170 })
        const icon = tt >= T.favLand
          ? (g, r) => {
              const b = bump(tt, T.favLand, T.favLand + 0.18)
              K.at(g, 0, -r * 0.05, 0, [1 + 0.18 * b, 1 - 0.22 * b], () => CAST.agent(g, 0, 0, t, { id: 's3-hkmini', kind: 'architect', mini: true, scale: FAV_MINI }))
            }
          : null
        const bo = { id: 's3-btn', r: BTN.r, strip: 'Hot keys', press, icon, jitter: 0.4 }
        if (sy !== 1) {
          K.at(ctx, 0, FLOOR, 0, [1, sy], () => PROPS.clayButton(ctx, BTN.x, BTN.y - FLOOR, t, Object.assign(bo, { scale: BTN.s })))
        } else {
          btn = PROPS.clayButton(ctx, BTN.x, BTN.y, t, Object.assign(bo, { scale: BTN.s }))
        }
      }

      // ── flying things ──
      // the architect, hanging from hand A's pinch
      const pinch = carryPinch(tt, T)
      if (tt >= T.grab + 0.04 && tt < T.drop1) {
        const prev = carryPinch(Math.max(0, tt - 1 / 15), T)
        const vx = (pinch[0] - prev[0]) * 15
        const rot = clamp(vx * 0.00022, -0.38, 0.38)
        K.at(ctx, pinch[0], pinch[1], rot, 1, () => airAgent(ctx, 0, PINCH * AS, AS, 0, { id: 's3-arch', kind: 'architect', pose: 'wave', poseT: tt - T.grab }, t))
      }
      // the Feature sticker in hand B
      if (stF && tt < T.press2 - 0.03) drawStickerAt(ctx, t, Object.assign({ lift: 12 }, stF), 's3-st')
      // the favourite: flies on an arc, then flips + shrinks into the mini card on the button cap
      let favPos = null
      if (tt >= T.favFly && tt < T.favLand) {
        const fv = favState(tt, T)
        const prev = favState(tt - 1 / 15, T)
        favPos = fv.pos
        const dir = Math.atan2(favPos[1] - prev.pos[1], favPos[0] - prev.pos[0])
        const rot = clamp((favPos[0] - prev.pos[0]) * 15 * 0.00012, -0.3, 0.3) * (1 - fv.u)
        if (!fv.mini) {
          // full card: turns a little (never edge-on), then squash-shrinks towards the mini's size
          K.at(ctx, favPos[0], favPos[1], rot, [fv.sq[0], fv.sq[1]], () => airAgent(ctx, 0, (110 + HOP_UP - 6) * fv.s, fv.s, HOP_UP, { id: 's3-fav', kind: 'architect', flip: fv.flip, pose: 'hop', poseT: 0.3 }, t))
        } else {
          K.at(ctx, favPos[0], favPos[1], rot, [fv.sq[0], fv.sq[1] * lerp(1, 0.8, fv.u)], () => CAST.agent(ctx, 0, 0, t, { id: 's3-hkmini', kind: 'architect', mini: true, scale: fv.s, flip: fv.flip }))
        }
        if (fv.pe > 0.05 && fv.pe < 0.9) PROPS.speedLines(ctx, favPos[0] - Math.cos(dir) * 60 * fv.k, favPos[1] - Math.sin(dir) * 60 * fv.k, t, { id: 's3-favspd', dir, len: 110, n: 3, spread: 60 * Math.max(0.6, fv.k), p: 0.75 })
      }
      drawFavHeart(ctx, t, tt, T)

      // ── Pip ──
      drawPip(ctx, t, tt, T, { pinch, stF, envX, favPos })

      // ── the human hands ──
      drawHandA(ctx, t, tt, T, pinch)
      drawHandB(ctx, t, tt, T, peelP, stF, sw)
      drawHandC(ctx, t, tt, T, btn)

      // ── foreground scraps ──
      K.at(ctx, Math.round(0.14 * cam.dx), 0, 0, 1, () => drawForeground(ctx, t))
      ctx.setTransform(M0)
    },

    sfx(dur, info) {
      const T = beats(info)
      const out = []
      const cue = (tt, type, o = {}) => {
        if (tt >= -0.05 && tt <= dur + 0.2) out.push(Object.assign({ t: Math.max(0, tt), type }, o))
      }
      cue(T.lid, 'flap', { pitch: 0.85, gain: 0.65, pan: panOf(BOX.x) })
      cue(T.fan, 'riffle', { dur: 0.45, gain: 0.9, pan: panOf(BOX.x) })
      cue(T.grab, 'paper', { dur: 0.18, gain: 0.5, pan: panOf(BOX.x) })
      cue(T.drop1, 'thup', { gain: 0.95, pitch: 0.95, pan: panOf(S1[0]) })
      cue(T.drop1 + 0.1, 'blip', { gain: 0.5, pitch: 1.2, pan: panOf(S1[0]) })
      cue(T.peel + 0.04, 'peel', { dur: 0.3, gain: 0.95, pan: panOf(SHEET.x) })
      cue(T.press2, 'thup', { gain: 0.95, pitch: 1.12, pan: panOf(S2[0]) })
      cue(T.press2 + 0.03, 'chime', { gain: 0.55, pan: panOf(S2[0]) })
      cue(T.pack, 'swish', { pitch: 1.35, gain: 0.4, pan: panOf(900) }) // both hop out of the slots
      cue(T.pack + 0.13, 'envelope', { dur: 0.26, gain: 0.8, pan: panOf(ENV.x) }) // …and sink into the pocket
      cue(T.packEnd, 'flap', { pitch: 1.15, gain: 0.5, pan: panOf(ENV.x) }) // flap shuts
      cue(T.stamp, 'stamp', { gain: 1, pan: panOf(ENV.x) })
      cue(T.flat0 - 0.02, 'boing', { pitch: 1.5, gain: 0.3, pan: panOf(PIPX) }) // Pip takes off
      cue(T.zip0, 'envelope', { dur: 0.24, gain: 0.85, pan: panOf(1250) })
      cue(T.zip0 + 0.05, 'swish', { pitch: 1.2, gain: 0.45, pan: panOf(1500) })
      cue(T.beam - 0.05, 'creak', { dur: 0.3, pitch: 1.4, gain: 0.4, pan: panOf(DOOR.x) })
      cue(T.beam, 'sparkle', { gain: 0.75, pan: panOf(DOOR.x) })
      cue(T.strip + 0.02, 'swish', { pitch: 0.9, gain: 0.45, pan: panOf(BTN.x) })
      cue(T.stripLand, 'slap', { gain: 0.75, pan: panOf(BTN.x) })
      cue(T.favPop, 'pop', { pitch: 1.2, gain: 0.7, pan: panOf(BOX.x) })
      cue(T.favPop + 0.05, 'plink', { pitch: 1.26, gain: 0.45, pan: panOf(BOX.x) })
      cue(T.favFly, 'swoosh', { dur: T.favLand - T.favFly, pitch: 1.15, gain: 0.55, pan: panOf(MOUTH[0]) })
      cue(lerp(T.favFly, T.favLand, 0.55), 'flip', { gain: 0.45, pitch: 1.2, pan: panOf(760) }) // squash-shrink
      cue(T.favLand, 'gulp', { gain: 0.75, pan: panOf(BTN.x) })
      cue(T.favLand + 0.08, 'pop', { pitch: 1.5, gain: 0.35, pan: panOf(BTN.x) }) // heart bursts into the cap
      cue(T.press, 'bloop', { gain: 1, pan: panOf(BTN.x) })
      cue(T.press + 0.02, 'kazooTada', { gain: 0.7, pan: panOf(BTN.x) })
      cue(T.press + 0.16, 'button', { pitch: 1.2, gain: 0.4, pan: panOf(BTN.x) }) // spring-back click
      // Pip's claps: a quiet tack on each actual clap hit (clap cycle 0.42 s, hands meet at poseT 0.21 + k·0.42)
      for (let k = 0; k < 3; k++) cue(T.press + 0.21 + k * 0.42, 'tack', { pitch: 1.3 + 0.06 * k, gain: 0.4 - 0.05 * k, pan: panOf(PIPX) })
      cue(T.press + 0.18, 'claps', { dur: 0.8, gain: 0.22, pan: panOf(PIPX) }) // soft bed under them, after the impact
      return out
    },
  })

  // ───────── the favourite's flight: full card → squash-shrink → mini card on the cap (never edge-on) ─────────
  const FAV_MINI = 0.95 // mini icon scale on the cap
  const CAP_AT = [BTN.x, BTN.y - 32.6 * BTN.s] // where the cap draws its icon (scene space)
  const FAV_START = [MOUTH[0], MOUTH[1] + FAV_Y * BOX.s - 110 * AS] // favourite's card centre as it leaves the box
  const SWAP = 0.36 // full-card scale at the swap to the mini…
  const MINI0 = (116 * SWAP) / 68 // …and the matching mini scale (same card width)
  function favState(tt, T) {
    const pe = E.inOutQuad(seg(tt, T.favFly, T.favLand))
    const pos = qarc(FAV_START, CAP_AT, 190, pe)
    if (pe < 0.7) {
      const sh = seg(pe, 0.4, 0.7)
      const s = lerp(AS, SWAP, E.inQuad(sh))
      const b = Math.sin(Math.PI * sh)
      return { pe, pos, mini: false, s, flip: 0.3 * E.inOutQuad(seg(pe, 0.08, 0.4)), sq: [1 + 0.2 * b, 1 - 0.24 * b], k: s / AS, u: 0 }
    }
    const u = seg(pe, 0.7, 1)
    const s = lerp(MINI0, FAV_MINI * BTN.s, E.outQuad(u))
    return { pe, pos, mini: true, s, flip: 0.3 * (1 - E.outQuad(u)), sq: [1, 1], k: (68 * s) / (116 * AS), u }
  }
  function drawFavHeart(ctx, t, tt, T) {
    const t0 = T.favPop + 0.02
    const bu = tt - T.favLand // burst clock
    if (tt < t0 || bu > 0.24) return
    const popS = E.outBack(seg(tt, t0, t0 + 0.22))
    let pos
    let sc = popS
    let alpha = 1
    const rot = 0.12 * Math.sin(tt * 8)
    if (tt < T.favFly) {
      const rise = 24 * E.outCubic(seg(tt, t0, t0 + 0.3))
      pos = [FAV_START[0] + 34 + 4 * Math.sin(tt * 9), FAV_START[1] - 112 - rise]
    } else {
      // rides along with the card, lagging a touch (follow-through), shrinking with it
      const fv = favState(Math.max(T.favFly, Math.min(tt, T.favLand) - 0.025), T)
      const ride = [fv.pos[0] + 34 * fv.k, fv.pos[1] - 136 * fv.k]
      sc *= 0.55 + 0.45 * fv.k
      pos = ride
      if (bu > 0) {
        // dives into the cap and bursts
        pos = mix2(ride, [CAP_AT[0] + 4, CAP_AT[1] - 34], E.inQuad(seg(bu, 0, 0.05)))
        sc *= 1 + 0.6 * E.outBack(seg(bu, 0.03, 0.12))
        alpha = 1 - seg(bu, 0.08, 0.2)
      }
    }
    if (sc > 0.02 && alpha > 0.01) {
      K.withAlpha(ctx, alpha, () =>
        K.at(ctx, pos[0], pos[1], rot, sc, () => {
          K.paper(ctx, heartPts(46), C.pink, { cut: 0.8, seed: 's3-heart', shadow: 0.8, stroke: C.ink })
          ctx.fillStyle = 'rgba(255,255,255,0.55)'
          ctx.beginPath()
          ctx.arc(-8, -6, 4, 0, Math.PI * 2)
          ctx.fill()
        })
      )
    }
    if (bu > 0.04 && bu < 0.24) {
      const sp = seg(bu, 0.04, 0.24)
      K.withAlpha(ctx, 1 - seg(sp, 0.55, 1), () => K.sparkle(ctx, CAP_AT[0] + 4, CAP_AT[1] - 34, 62 + 44 * E.outCubic(sp), 's3-hsp', t, { n: 4, w: 3.2 }))
    }
  }

  // ───────── the envelope's body: pack gulp, upright lean (label still readable), late flop, zip ─────────
  function envState(tt, T) {
    const packB = bump(tt, T.pack + 0.14, T.packEnd + 0.08) // a little gulp as the items sink in
    const back = bump(tt, T.slide, T.slide + 0.12) // anticipation: rocks back on its heel…
    const flat = E.inQuad(seg(tt, T.flat0, T.flat1)) // …lies down only just before it zips off
    const fwd = E.inOutCubic(seg(tt, T.slide + 0.08, T.flat0 - 0.02)) * (1 - flat) // …leans into the run
    const stretch = seg(tt, T.slide + 0.06, T.flat0) * (1 - flat)
    const envSy = (1 + 0.05 * stretch - 0.05 * packB) * lerp(1, 0.24, flat)
    const envSx = (1 - 0.03 * stretch + 0.03 * packB) * lerp(1, 1.04, flat)
    const creep = 34 * E.inOutQuad(seg(tt, T.slide + 0.08, T.zip0))
    const slideP = E.inQuad(seg(tt, T.zip0, T.slideEnd))
    const envX = lerp(ENV.x + creep, ENV_END, slideP)
    return { envSx, envSy, envX, slideP, lean: -0.045 * back + 0.08 * fwd }
  }

  // ───────── packing: card + sticker hop out of the slots, arc to the pocket lip and sink IN behind it ─────────
  // Drawn in scene space from the envelope's contents() callback, i.e. between its inside back and its front
  // pocket — so whatever is below the lip is genuinely hidden by the pocket paper.
  function drawPacking(ctx, t, tt, T, p, env) {
    const lip = FLOOR - ENV.h * ENV.s * env.envSy + 10 * ENV.s * env.envSy // pocket's top edge
    const HOP = 0.1
    const FLY = 0.56
    const hop = p < HOP ? 20 * Math.sin((p / HOP) * Math.PI * 0.5) : 20 * (1 - seg(p, HOP, HOP + 0.2))
    const fl = seg(p, HOP, FLY)
    const f = fl * (1.15 - 0.15 * fl) // arc from the slot to just inside the lip (near-linear: a readable mid-air frame)
    const k = E.inQuad(seg(p, FLY, 1)) // sink behind the pocket
    const sc = lerp(1, 0.85, seg(p, HOP, 1))
    // architect: slot 1 → pocket (left half)
    const aS = [S1G[0], S1G[1] - hop]
    const aE = [ENV.x - 92, lip + 26]
    const aH = AS * sc
    const a = f < 1 ? dropArc(aS, aE, f) : [aE[0], lerp(aE[1], lip + PINCH * aH + 16, k)]
    a[1] += HOP_UP * aH * Math.min(1, f * 1.4) // the 'hop' pose floats the card ~61 px: sink it for real
    airAgent(ctx, a[0], a[1], aH, HOP_UP, { id: 's3-arch', kind: 'architect', rot: 0.2 * Math.sin(Math.PI * f) - 0.06 * k, pose: 'hop', poseT: 0.3 }, t)
    // sticker: slot 2 → pocket (right half), turning as it falls
    const sS = [S2[0], S2[1] - hop]
    const sE = [ENV.x + 92, lip + 12]
    const ss = lerp(SLOT_ST.s, 0.72, seg(p, HOP, 1))
    const s = f < 1 ? dropArc(sS, sE, f) : [sE[0], lerp(sE[1], lip + 74 * ss * 0.5 + 16, k)]
    drawStickerAt(ctx, t, { x: s[0], y: s[1], rot: 0.025 - 0.34 * Math.sin(Math.PI * 0.5 * f) + 0.2 * k, s: ss, sq: [1, 1], lift: 8 * (1 - k) }, 's3-st')
  }

  // ───────── the lit doorway: halo on the wall + a pool of light on the floor (drawn behind the door) ─────────
  function drawDoorLight(ctx, glow, tt, T) {
    const flick = 1 + 0.04 * Math.sin(tt * 23) * seg(tt, T.beam, T.beam + 0.2)
    ctx.save()
    ctx.globalAlpha *= glow
    const hx = DOOR.x + 30
    const hy = DOOR.y - 20
    const g = ctx.createRadialGradient(hx, hy, 60, hx, hy, 380 * flick)
    g.addColorStop(0, 'rgba(247,222,138,0.55)')
    g.addColorStop(1, 'rgba(247,222,138,0)')
    ctx.fillStyle = g
    ctx.fillRect(hx - 400, hy - 400, 800, 800)
    K.at(ctx, DOOR.x - 90, FLOOR + 6, 0, [1, 0.2], () => {
      const f = ctx.createRadialGradient(0, 0, 0, 0, 0, 380 * flick)
      f.addColorStop(0, 'rgba(247,222,138,0.8)')
      f.addColorStop(0.6, 'rgba(247,222,138,0.3)')
      f.addColorStop(1, 'rgba(247,222,138,0)')
      ctx.fillStyle = f
      ctx.fillRect(-400, -400, 800, 800)
    })
    ctx.restore()
  }

  // ───────── Claude arrives: a plain cream speech bubble with typing dots pops out of the lit doorway ─────────
  function drawClaudeBubble(ctx, t, tt, T) {
    const inP = seg(tt, T.beam + 0.04, T.beam + 0.3)
    if (inP <= 0) return
    const sc = E.outBack(inP)
    if (sc <= 0.01) return
    const tip = [DOOR.x + 96, DOOR.y - (DOOR.h / 2) * DOOR.s - 18]
    const bw = 190
    const bh = 118
    const cx = -60
    const cy = -bh / 2 - 34
    K.at(ctx, tip[0], tip[1], -0.05 + 0.02 * Math.sin(tt * 2.2), sc, () => {
      const pts = []
      const n = 40
      let tailDone = false
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        if (a > 0.95 && a < 1.45) {
          if (!tailDone) pts.push([0, 0])
          tailDone = true
          continue
        }
        pts.push([cx + Math.cos(a) * (bw / 2), cy + Math.sin(a) * (bh / 2)])
      }
      K.paper(ctx, pts, C.cream, { cut: 2, seed: 's3-bub', shadow: 1, lift: 6, stroke: C.ink })
      for (let i = 0; i < 3; i++) {
        const live = 1 - seg(tt, T.beam + 1.1, T.beam + 1.4) // dots bounce, then settle so the eye moves on
        const b = live * Math.max(0, Math.sin(tt * 9 - i * 0.9))
        ctx.beginPath()
        ctx.arc(cx - 40 + i * 40, cy - 10 * b, 10, 0, Math.PI * 2)
        ctx.fillStyle = C.ink
        ctx.fill()
      }
    })
  }

  // ───────── Pip ─────────
  function drawPip(ctx, t, tt, T, st) {
    const head = [PIPX, FLOOR - 170]
    const hops = [
      PIP.hop(tt, T.lid + 0.02, { dur: 0.42, height: 44, pre: 0.1 }),
      PIP.hop(tt, T.flat0 - 0.02, { dur: 0.44, height: 100, pre: 0.1 }), // clears the flat envelope zipping under
      PIP.hop(tt, T.press + 0.05, { dur: 0.36, height: 38, pre: 0.08 }),
    ]
    let hy = 0
    let squash = 1
    for (const h of hops) {
      hy += h.y
      squash *= h.squash
    }
    const o = { id: 's3-pip', scale: PIPS, flip: true, pose: 'idle', poseT: tt, mouth: 'smile', look: lookAt(head, [BOX.x, 600]) }
    if (tt < T.grab - 0.15) {
      if (tt > T.lid - 0.1) Object.assign(o, { pose: 'cheer', poseT: tt - T.lid, mouth: 'o', eyes: 'wide' })
    } else if (tt < T.peel - 0.05) {
      Object.assign(o, { pose: 'point', poseT: tt - (T.grab - 0.15), aim: -0.62, mouth: 'grin', look: lookAt(head, st.pinch) })
    } else if (tt < T.press2 + 0.08) {
      const target = st.stF ? [st.stF.x, st.stF.y] : ST0
      Object.assign(o, { mouth: 'o', eyes: 'wide', look: lookAt(head, target) })
    } else if (tt < T.stamp - 0.1) {
      Object.assign(o, { mouth: 'grin', eyes: tt < T.pack + 0.2 ? 'wide' : 'happy', look: lookAt(head, [ENV.x, 640]) })
    } else if (tt < T.slide - 0.05) {
      const flinch = seg(tt, T.stamp - 0.02, T.stamp + 0.14) > 0 && tt < T.stamp + 0.14
      Object.assign(o, { mouth: flinch ? 'o' : 'smile', eyes: flinch ? 'shut' : null, look: lookAt(head, [ENV.x, 800]) })
      if (flinch) squash *= 1 - 0.1 * bump(tt, T.stamp - 0.02, T.stamp + 0.14)
      else squash *= 1 + wob(tt, T.stamp + 0.14, 0.06, 20, 8)
    } else if (tt < T.beam - 0.02) {
      const past = st.envX > PIPX - 60
      Object.assign(o, { mouth: 'o', eyes: 'wide', look: past ? [0.8, 0.9] : lookAt(head, [st.envX + 120, FLOOR - 60]), flip: !past })
    } else if (tt < T.strip + 0.12) {
      Object.assign(o, { flip: false, pose: 'cheer', poseT: tt - T.beam, mouth: 'open', eyes: 'happy' })
    } else if (tt < T.press - 0.02) {
      const target = st.favPos || (tt < T.favPop ? [BOX.x, 600] : [BTN.x, BTN.y - 40])
      Object.assign(o, { mouth: tt > T.favLand ? 'o' : 'smile', eyes: tt > T.favLand ? 'wide' : null, look: lookAt(head, target) })
    } else {
      Object.assign(o, { pose: 'clap', poseT: tt - T.press, mouth: 'open', eyes: 'happy' })
    }
    if (hy < 0) o.air = -hy
    o.squash = squash
    PIP.draw(ctx, PIPX, FLOOR + hy, t, o)
  }

  // ───────── hands ─────────
  function drawHandA(ctx, t, tt, T, pinch) {
    const tIn = T.grab - 0.34
    const tOut = T.drop1 + 0.45
    if (tt < tIn || tt > tOut) return
    let tip
    let pose = 'pinch'
    if (tt < T.grab + 0.04) {
      const p = E.outCubic(seg(tt, tIn, T.grab - 0.03))
      const tug = bump(tt, T.grab - 0.02, T.grab + 0.08)
      tip = mix2([P0[0] - 90, -260], P0, p)
      tip[1] -= 8 * tug
    } else if (tt < T.drop1) {
      tip = pinch
    } else {
      pose = 'drop'
      const p = E.inCubic(seg(tt, T.drop1 + 0.03, tOut))
      tip = mix2([P1[0], P1[1] - 18 - 10 * seg(tt, T.drop1, T.drop1 + 0.05)], [P1[0] - 160, -320], p)
    }
    CAST.hand(ctx, tip[0], tip[1], t, { id: 's3-handA', from: 'top', pose, scale: HAND_S, rot: -0.12, sleeve: SLEEVE })
  }

  function drawHandB(ctx, t, tt, T, peelP, stF, sw) {
    const tIn = T.peel - 0.32
    const tLift = T.press2 + 0.06 // thup held for one frame…
    const tUp = T.press2 + 0.17 // …lift straight up, clear of the slot-2 check…
    const tOut = T.press2 + 0.28 // …then away up-right before the pack starts
    if (tt < tIn || tt > tOut) return
    const corner = (f, curl) => {
      const cr = curl > 0.02 ? lerp(26, 74 * 0.66, curl) * 0.45 : 0
      const lp = rotPt([(sw / 2 - 12 - cr) * f.s, (-37 + 12 + cr) * f.s], f.rot)
      return [f.x + lp[0], f.y + lp[1]]
    }
    let tip
    let pose = 'pinch'
    if (tt < T.peel) {
      const p = E.outCubic(seg(tt, tIn, T.peel))
      tip = mix2([K.W + 240, ST0[1] - 140], corner(sheetStickerFrame(0), 0), p)
    } else if (!stF) {
      const f = sheetStickerFrame(peelP)
      tip = corner(f, clamp01(peelP / 0.6) * (1 - f.e))
    } else if (tt < tLift) {
      tip = corner(stF, 0)
      tip[1] += 6 * bump(tt, T.press2 - 0.02, T.press2 + 0.1)
    } else {
      pose = 'drop'
      const c0 = corner(SLOT_ST, 0)
      const up = [c0[0] + 8, c0[1] - 160]
      if (tt < tUp) tip = mix2(c0, up, E.outCubic(seg(tt, tLift, tUp)))
      else tip = mix2(up, [K.W + 260, -120], E.inQuad(seg(tt, tUp, tOut)))
    }
    CAST.hand(ctx, tip[0], tip[1], t, { id: 's3-handB', from: 'right', pose, scale: HAND_S, rot: -0.1, sleeve: SLEEVE })
  }

  function drawHandC(ctx, t, tt, T, btn) {
    // Enters, hovers and leaves along its OWN arm axis, so the fingertip never sweeps across the form's labels;
    // the sleeve threads the gap between slot 2 and the sticker sheet.
    const tIn = T.press - 0.5
    const tOut = T.press + 0.62
    if (tt < tIn || tt > tOut || !btn) return
    const ax = [Math.sin(HC_ROT), -Math.cos(HC_ROT)] // up the arm, towards the shoulder
    const along = (p, d) => [p[0] + ax[0] * d, p[1] + ax[1] * d]
    const cap = [btn.top[0] + BTN.r * HC_OFF * BTN.s, btn.top[1] + 4]
    const hover = along(cap, 55)
    let tip
    if (tt < T.press - 0.2) tip = along(hover, 620 * (1 - E.outCubic(seg(tt, tIn, T.press - 0.2))))
    else if (tt < T.press - 0.12) tip = along(hover, 26 * E.outQuad(seg(tt, T.press - 0.2, T.press - 0.12)))
    else if (tt < T.press - 0.03) tip = mix2(along(hover, 26), cap, E.inCubic(seg(tt, T.press - 0.12, T.press - 0.03)))
    else if (tt < T.press + 0.14) tip = cap
    else if (tt < T.press + 0.3) tip = along(cap, 40 * E.outCubic(seg(tt, T.press + 0.14, T.press + 0.3)))
    else tip = along(cap, 40 + 720 * E.inQuad(seg(tt, T.press + 0.3, tOut)))
    CAST.hand(ctx, tip[0], tip[1], t, { id: 's3-handC', from: 'top', pose: 'point', scale: HAND_S * 1.05, rot: HC_ROT, sleeve: SLEEVE })
  }
})()

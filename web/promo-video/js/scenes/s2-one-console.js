/* s2-one-console.js — "Session Manager: one console for Claude Code. A tab per project —
 * chat or terminal, same conversation."   Owner: scene s2. In: 'tape' (from s1). Out: 'pan' (to s3).
 *
 * Every beat is placed from the VO clock (info.wordAt / info.cameoAt) and snapped to the music
 * grid (info.nextBeat) — nothing is hard-coded to seconds except small in-between offsets.
 *
 *   open      the SAME desk s1 ended on (s1's terminal + sticky positions, the "big idea!" napkin, Pip
 *             right where s1 left it), revealed as the tape rips; a gentle local push-in toward Pip.
 *   thwack    Pip's glue-stick THWACK lands ~0.12 s BEFORE the cameo "Ta-da!" (action leads the voice);
 *             the whole desk jolts, three terminals + the napkin float up off the paper ("chosen").
 *   console   the kraft console slides in from the right under the floating pieces (paper-swipe speed
 *             lines, outBack overshoot) and thuds onto the first beat before "Session"; its gust sweeps
 *             every loose piece outside its footprint off the desk (a right→left wave that follows the
 *             leading edge); washi corners slap. Pip says "Ta-da!" to it, scarf flapping in the gust.
 *   plaque    the "Session Manager" plaque slaps on big during "Session Manager" (hero, held clear of the
 *             sidebar), settles into the frame corner on "one".
 *   sidebar   the peach strip unrolls, its washi slaps, six cut-out labels drop in on a stagger.
 *   tabs      from "one console": each terminal crouches, swoops on its own bezier arc with pencil speed
 *             lines, flattens onto the top edge and paper-flips into a folder tab (Home · garden-app ·
 *             recipe-bot), landing on successive beats with ascending plinks. A local camera push-in
 *             makes the tab row the hero while it is the subject; every landing / tap swaps that tab's
 *             mini session into the screen with a paper swipe (home card, chat bubble, terminal, bulb).
 *   napkin    Pip (aboard the floating napkin) surfs it into the last slot: napkin-idea (lightbulb),
 *             then hop-taps recipe-bot and garden-app on "a tab per project" — each tab dips and springs.
 *   chat⇄term the camera eases back; the index card drops in on its terracotta yarn; Pip dives onto it;
 *             it flips on "chat or terminal" while Pip hops seat-to-seat so the card rocks like a seesaw;
 *             the big pink "same session" sticky slaps onto the yarn on "conversation".
 *   hold      Pip stands up and cheers on the card; the console + plaque hold as the hero frame into the pan.
 * Parallax: the desk layer scales ~0.6x as much as the rest in the local push-ins, and moves at 0.65x
 * during the outgoing engine pan (info.camShift).
 */
(function () {
  'use strict'
  const { W, H, C } = K
  const E = K.ease
  const TAU = Math.PI * 2

  // ---------- layout (world px) ----------
  const CONS = { x: 1062, y: 540, s: 0.84, id: 's2cons' } // console rest pose (frame 431..1691 × 196..885)
  const CONS_FROM = W + 700 // console centre x before it slides in
  const CONS_HALF = 630 // half the frame width at CONS.s
  const PIP_S = 0.72
  const LEG = 40 * PIP_S // Pip's leg length: a seated Pip's feet dangle this far below the seat
  const PIP_HOME = [1405, 895] // s1 leaves Pip hugging the napkin at (1432, 830)
  const HIT = [PIP_HOME[0] + 120, PIP_HOME[1] - 13] // glue tip at the thwack hit (facing right, scale 0.72)
  const NAP = { x: 1452, y: 788, rot: -0.14, s: 0.64 } // s1's napkin, exactly where s1 left it
  const NAP_HOVER = [1425, 652] // where it floats after the ta-da (Pip rides it here): well inside the screen, clear of its right border
  const CARD = { x: 1190, s: 0.85, w: 440, h: 300, yarn: 205, seat: 130 } // chat⇄terminal card
  const SESS = [920, 470] // centre of the mini-session paper in the screen (left of term10's float station)
  const TABS = [
    { label: 'Home', icon: 'home' },
    { label: 'garden-app', icon: 'leaf' },
    { label: 'recipe-bot', icon: 'bowl' },
    { label: 'napkin-idea', icon: 'bulb', active: true },
  ]
  // s1's terminals that become tabs: s1 rest pose → float station (clear of sidebar/plaque/Pip, the napkin's
  // hover spot and the mini session at SESS) → swoop
  const HERO = [
    { x: 640, y: 485, rot: -0.38, s: 1.0, scr: 2, tape: false, id: 's1-term3', st: [868, 470], c1: [1010, 420], c2: [915, 130], side: -1 },
    { x: 1060, y: 505, rot: 0.14, s: 1.1, scr: 1, tape: true, id: 's1-term6', st: [1150, 752], c1: [1330, 600], c2: [1075, 70], side: -1 },
    { x: 1505, y: 475, rot: -0.22, s: 0.95, scr: 2, tape: false, cursor: 'block', id: 's1-term10', st: [1228, 447], c1: [1323, 232], c2: [1262, 70], side: -1 },
  ]
  // s1's pieces that lie inside the console footprint (rotated bounds ≥ 40 px inside it, incl. the
  // outBack return): the console simply covers them
  const MESS_S = [
    { x: 1180, y: 360, rot: -0.3, size: 140, color: 'lemon', text: '', id: 's1-dn3' },
    { x: 1185, y: 332, rot: -0.15, size: 160, color: 'peach', text: 'TODO!!', id: 's1-note3' },
    { x: 855, y: 690, rot: 0.12, size: 150, color: 'lemon', text: '', id: 's1-note6' },
    { x: 1282, y: 618, rot: 0.22, size: 150, color: 'pink', text: 'which tab', id: 's1-note8' },
    { x: 965, y: 440, rot: -0.22, size: 165, color: 'sage', text: '', id: 's1-note12' },
  ]
  // s1's pieces outside the footprint: the console's gust blows them off the desk
  const BLOW = [
    { k: 't', x: 175, y: 190, rot: -0.32, s: 0.95, scr: 3, tape: true, id: 's1-term0' },
    { k: 't', x: 985, y: 165, rot: -0.08, s: 1.0, scr: 4, tape: true, cursor: 'block', id: 's1-term1' },
    { k: 't', x: 1770, y: 210, rot: -0.25, s: 0.95, scr: 2, tape: 'rgba(63,153,144,0.62)', id: 's1-term2' },
    { k: 't', x: 585, y: 810, rot: 0.28, s: 1.05, scr: 4, tape: true, id: 's1-term4' },
    { k: 't', x: 1282, y: 815, rot: -0.2, s: 1.0, scr: 3, tape: true, cursor: 'block', id: 's1-term5' },
    { k: 't', x: 560, y: 150, rot: 0.2, s: 0.9, scr: 1, tape: true, id: 's1-term7' },
    { k: 't', x: 1335, y: 150, rot: 0.3, s: 0.9, scr: 3, tape: 'rgba(111,125,82,0.66)', id: 's1-term8' },
    { k: 't', x: 240, y: 525, rot: 0.22, s: 1.05, scr: 4, tape: true, id: 's1-term9' },
    { k: 't', x: 165, y: 845, rot: -0.12, s: 1.0, scr: 2, tape: 'rgba(63,153,144,0.62)', id: 's1-term11' },
    { k: 's', x: 1372, y: 902, rot: -0.34, size: 140, color: 'sage', text: 'which tab', id: 's1-dn0' },
    { k: 's', x: 905, y: 885, rot: 0.2, size: 150, color: 'pink', text: '', id: 's1-dn1' },
    { k: 's', x: 92, y: 655, rot: 0.24, size: 145, color: 'butter', text: 'fix bug??', id: 's1-dn2' },
    { k: 's', x: 770, y: 300, rot: 0.2, size: 165, color: 'butter', text: 'fix bug??', id: 's1-note0' },
    { k: 's', x: 1790, y: 525, rot: -0.2, size: 165, color: 'butter', text: 'which tab', id: 's1-note1' },
    { k: 's', x: 95, y: 395, rot: 0.3, size: 150, color: 'pink', text: '', id: 's1-note2' },
    { k: 's', x: 470, y: 900, rot: -0.1, size: 150, color: 'sage', text: 'TODO!!', id: 's1-note4' },
    { k: 's', x: 1455, y: 118, rot: 0.15, size: 150, color: 'lemon', text: 'fix bug??', id: 's1-note5' },
    { k: 's', x: 300, y: 118, rot: -0.12, size: 150, color: 'peach', text: 'which tab', id: 's1-note7' },
    { k: 's', x: 1860, y: 835, rot: -0.3, size: 150, color: 'peach', text: '', id: 's1-note9' },
    { k: 's', x: 615, y: 125, rot: -0.3, size: 150, color: 'sage', text: '', id: 's1-note10' },
    { k: 's', x: 1040, y: 900, rot: 0.18, size: 150, color: 'butter', text: 'TODO!!', id: 's1-note11' },
    { k: 's', x: 300, y: 668, rot: -0.12, size: 160, color: 'peach', text: 'TODO!!', id: 's1-handnote' },
  ]
  // each blown piece: seeded speed / spin; direction = away from the console's landing zone + the gust (−x)
  BLOW.forEach((b, i) => {
    const r = K.rng('s2blow', i)
    let dx = b.x - CONS.x
    let dy = (b.y - CONS.y) * 1.3
    const L = Math.hypot(dx, dy) || 1
    dx = dx / L - 0.62
    dy = dy / L
    const L2 = Math.hypot(dx, dy) || 1
    b.dir = [dx / L2, dy / L2]
    b.v = (b.k === 't' ? 950 : 1150) + r() * 300 + (b.x < 480 ? 350 : 0)
    b.spin = (r() < 0.5 ? -1 : 1) * (b.k === 't' ? 1.2 + r() * 1.2 : 2.5 + r() * 3)
    b.delay = r() * 0.05
  })

  // ---------- small local helpers ----------
  const lerp2 = (a, b, u) => [K.lerp(a[0], b[0], u), K.lerp(a[1], b[1], u)]
  function bez3(p0, p1, p2, p3, u) {
    const v = 1 - u
    return [
      v * v * v * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * p3[0],
      v * v * v * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * p3[1],
    ]
  }
  function bez3d(p0, p1, p2, p3, u) {
    const v = 1 - u
    return [
      3 * v * v * (p1[0] - p0[0]) + 6 * v * u * (p2[0] - p1[0]) + 3 * u * u * (p3[0] - p2[0]),
      3 * v * v * (p1[1] - p0[1]) + 6 * v * u * (p2[1] - p1[1]) + 3 * u * u * (p3[1] - p2[1]),
    ]
  }
  /** outBack with a chosen overshoot strength s (kit's is fixed at 1.70158 ≈ 10 %). */
  const back = (p, s) => {
    const q = p - 1
    return 1 + (s + 1) * q * q * q + s * q * q
  }
  /** damped ring: starts at 0, first swing toward +sign. */
  const ring = (x, f, d) => (x <= 0 ? 0 : Math.exp(-d * x) * Math.sin(f * x))
  /** damped cosine pulse starting at full amplitude at t0 (0 before). */
  const pulse = (t, t0, a, k, f) => (t >= t0 ? a * Math.exp(-k * (t - t0)) * Math.cos(f * (t - t0)) : 0)
  const panOf = (x) => K.clamp((x / W) * 1.6 - 0.8, -0.8, 0.8)
  /** Caller-driven leap A → B (lands at t1) with Pip's hop shape: crouch, stretch, squash on landing. */
  function leap(t, t0, t1, A, B, height, pre = 0.1) {
    const d = t1 - t0
    const h = PIP.hop(t, t0, { dur: d, height, pre })
    const u = K.clamp01((t - t0) / d)
    const [x, y] = lerp2(A, B, u)
    const vy = (B[1] - A[1]) / d - (height * 4 * (1 - 2 * u)) / d
    return { x, y: y + h.y, air: h.air ? -h.y + Math.max(0, (A[1] - B[1]) * (1 - u)) : 0, squash: h.squash, u, vel: h.air ? [(B[0] - A[0]) / d, vy] : [0, 0], inAir: h.air }
  }
  /** 'hop' pose with its own bounce cancelled, so it only lends the arms-up grin to a caller-driven leap. */
  function hopPose(u) {
    const pt = 0.12 + 0.46 * K.clamp01(u)
    return { pose: 'hop', poseT: pt, lift: PIP.hop(pt, 0.12, { dur: 0.46, height: 72, pre: 0.12 }).y * PIP_S }
  }
  function consoleXAtU(u) {
    return K.lerp(CONS_FROM, CONS.x, back(K.clamp01(u), 0.8))
  }

  // ---------- the plan: every event time, from the VO + the beat grid ----------
  function plan(info) {
    const nb = (x) => info.nextBeat(x)
    const w = (word, fb) => info.wordAt(word, fb)
    const half = info.beat / 2
    const P = {}
    P.tada = info.cameoAt('pip-tada', 0.58)
    const cam = info.cameos && info.cameos.find((c) => c.id === 'pip-tada')
    P.tadaEnd = cam && cam.end ? cam.end : P.tada + 0.67
    P.hit = P.tada - 0.12 // the thwack lands just before Pip says "Ta-da!"
    P.thw0 = P.hit - PIP.THWACK_HIT
    P.session = w('session', 1.4)
    P.one = w('one', 2.5)
    P.consStart = P.tada + 0.04
    // the thud lands on the last grid half-beat before "Session", in the gap after "Ta-da!" — so only the
    // plaque's slap sits on the product name
    const g = nb(P.session - 0.18)
    P.consHit = Math.max(P.tada + 0.45, g - half <= P.session - 0.18 ? g - half : g - info.beat)
    P.consDur = (P.consHit - P.consStart) / 0.7 // back() peaks at ~0.7 of its run
    // when the console's leading (left) edge passes x (bisection on the monotonic part of the slide)
    P.edgeAt = (x) => {
      let lo = 0
      let hi = 0.7
      if (consoleXAtU(hi) - CONS_HALF > x) return null
      for (let i = 0; i < 18; i++) {
        const m = (lo + hi) / 2
        if (consoleXAtU(m) - CONS_HALF > x) lo = m
        else hi = m
      }
      return P.consStart + hi * P.consDur
    }
    // blown when the leading edge is ~70 px away; the left column (never reached) goes on the gust ahead of
    // the edge, so it is gone before the plaque's hero slap
    P.blowAt = BLOW.map((b) => {
      const e = P.edgeAt(b.x > 480 ? b.x + 70 : 560)
      return (b.x > 480 ? e : e + (480 - b.x) * 0.0003) + b.delay
    })
    P.plaque = Math.max(P.consHit + 0.16, P.session + 0.14)
    P.plaqueSettle = Math.max(P.plaque + 0.6, P.one - 0.05)
    P.side0 = Math.max(P.consHit + 0.3, P.plaque + 0.2)
    P.side1 = P.side0 + 1.1
    P.cheer = P.consHit - 0.06
    P.glueDown = Math.max(P.cheer + 0.5, P.plaque + 0.3)
    P.board0 = P.glueDown + 0.1 // Pip leaps onto the floating napkin
    P.board1 = P.board0 + 0.28
    P.drift0 = P.consStart + 0.3 // floating terminals drift to their stations
    // terminals land as tabs on three successive beats from "one console"
    const l0 = nb(P.one + 0.55)
    P.land = [l0, nb(l0 + 0.3), nb(nb(l0 + 0.3) + 0.3)]
    P.launch = P.land.map((x) => x - 0.62)
    P.napFly = P.land[2] + 0.04
    P.napLand = nb(P.land[2] + 0.35)
    P.tap = [P.napLand + half, P.napLand + 2 * half] // Pip lands on recipe-bot, then garden-app
    P.cardLand = nb(w('chat', P.napLand + 1.2) - 0.15) // Pip lands on the card just before "chat"
    P.catch = P.cardLand - half // card's yarn catches
    P.drop0 = P.catch - 0.3
    P.dive0 = P.tap[1] + 0.07
    const f1 = nb(w('terminal', P.cardLand + 0.5) + 0.02)
    P.flip = [[f1 - 0.29, f1], [f1 + info.beat - 0.29, f1 + info.beat]]
    P.slap = Math.max(w('conversation', P.flip[1][1] + 0.3), P.flip[1][1] + 0.2)
    P.stand = nb(P.slap + 0.2)
    P.stand0 = P.slap + 0.03
    // mini sessions swapped into the screen: each tab landing / Pip tap; out as the card drops
    P.sess = [
      { t0: P.land[0] + 0.04, kind: 'home', tab: 0 },
      { t0: P.land[1] + 0.04, kind: 'chat', tab: 1 },
      { t0: P.land[2] + 0.04, kind: 'term', tab: 2 },
      { t0: P.napLand + 0.04, kind: 'idea', tab: 3 },
      { t0: P.tap[0] + 0.03, kind: 'term', tab: 2 },
    ]
    P.sessOut = P.drop0 + 0.1
    // local camera: push toward Pip for the thwack; push onto the tab row while it is the subject
    P.camOut0 = P.drop0 - 0.2
    return P
  }

  // ---------- local camera ----------
  /** { s, f:[x,y] pivot, ty } or null. screen = (world − f)·s + f + (0, ty). */
  function camAt(t, P) {
    const k1 = E.inOutCubic(K.seg(t, 0.08, P.hit + 0.18)) * (1 - E.inOutCubic(K.seg(t, P.consStart + 0.12, P.consHit - 0.16)))
    if (k1 > 0) return { s: 1 + 0.18 * k1, f: [PIP_HOME[0] - 20, PIP_HOME[1] - 120], ty: 0 }
    const k2 = E.inOutCubic(K.seg(t, P.land[1] - 0.1, P.land[1] + 0.5)) * (1 - E.inOutCubic(K.seg(t, P.camOut0, P.cardLand - 0.2)))
    if (k2 > 0) return { s: 1 + 0.3 * k2, f: [1090, 330], ty: 175 * k2 }
    return null
  }
  function applyCam(ctx, c, par) {
    if (!c) return
    const s = 1 + (c.s - 1) * par
    // never let a layer's top edge come down into the frame (the desk must always cover it)
    const ty = Math.min(c.ty * par, c.f[1] * (s - 1))
    ctx.translate(c.f[0], c.f[1] + ty)
    ctx.scale(s, s)
    ctx.translate(-c.f[0], -c.f[1])
  }

  // ---------- pieces ----------
  function consoleX(t, P) {
    if (t < P.consStart) return null
    return Math.round(consoleXAtU((t - P.consStart) / P.consDur))
  }
  /** the thwack jolt every desk piece shares (hop + squash + a small spin). */
  function joltOf(t, P, k) {
    const j = PIP.hop(t, P.hit + 0.012 * (k % 7), { dur: 0.3, height: 35, pre: 0.04 })
    return { y: j.y, squash: j.squash, spin: 0.09 * ring(t - P.hit, 12, 5) * (k % 2 ? 1 : -1) }
  }
  /** Floating hero terminal i before its launch (s1 rest → jolt → float up → drift to its station). */
  function heroFloat(i, t, P) {
    const h = HERO[i]
    let x = h.x
    let y = h.y
    let rot = h.rot
    let sx = h.s
    let sy = h.s
    let lift = 0
    if (t >= P.hit - 0.1) {
      const j = PIP.hop(t, P.hit + 0.02 * i, { dur: 0.36, height: 62, pre: 0.06 })
      const fl = E.outCubic(K.seg(t, P.hit + 0.12, P.hit + 0.8))
      const dr = E.inOutCubic(K.seg(t, P.drift0 + 0.14 * i, P.drift0 + 0.14 * i + 1.05))
      const fx = K.lerp(h.x, h.st[0], dr)
      const fy = K.lerp(h.y - 50 * fl, h.st[1], dr)
      x = fx
      y = fy + j.y + Math.sin((t - P.hit) * 3.3 + i * 2.1) * 6 * fl
      rot = K.lerp(h.rot, h.rot * 0.45, dr) + 0.14 * ring(t - P.hit, 10, 4) * (i % 2 ? 1 : -1)
      sy *= j.squash
      sx *= 1 + (1 - j.squash) * 0.7
      lift = Math.max(-j.y * 0.4, 24 * fl)
    }
    return { x, y, rot, sx, sy, lift }
  }
  /** Hero terminal i this frame (null once it has become a tab). */
  function heroState(i, t, P, tabs) {
    const h = HERO[i]
    const L0 = P.launch[i]
    const L1 = P.land[i]
    if (t >= L1) return null
    if (t < L0 || !tabs) {
      const f = heroFloat(i, t, P)
      if (t >= L0 - 0.16) {
        // anticipation: crouch + lean back before the swoop
        const a = Math.sin((K.seg(t, L0 - 0.16, L0) * Math.PI) / 2)
        f.sy *= 1 - 0.16 * a
        f.sx *= 1 + 0.1 * a
        f.y += 10 * a
        f.rot -= 0.14 * a * h.side
      }
      return Object.assign(f, { u: 0 })
    }
    const f0 = heroFloat(i, L0, P)
    const u = K.seg(t, L0, L1)
    const e = E.inOutCubic(u)
    const tr = tabs[i]
    const p0 = [f0.x, f0.y + 10]
    const p3 = [tr.cx, tr.cy]
    const pos = bez3(p0, h.c1, h.c2, p3, e)
    const d = bez3d(p0, h.c1, h.c2, p3, e)
    const flat = E.inQuad(K.seg(e, 0.72, 1))
    const stretch = Math.sin(Math.PI * e) * 0.1
    return {
      x: pos[0],
      y: pos[1],
      rot: K.lerp(f0.rot, 0, E.outCubic(e)) + h.side * 0.4 * Math.sin(Math.PI * e),
      sx: K.lerp(f0.sx * (1 + stretch), tr.w / 230, flat),
      sy: K.lerp(f0.sy * (1 - stretch * 0.5), tr.h / 160, flat),
      lift: 26 * (1 - flat),
      u,
      dir: Math.atan2(d[1], d[0]),
    }
  }
  /** Napkin: s1's spot → floats up at the thwack → carries Pip → surfs into the napkin-idea slot. */
  function napState(t, P, tabs) {
    let x = NAP.x
    let y = NAP.y
    let rot = NAP.rot
    const s = NAP.s
    let sy = 1
    let lift = 0
    if (t >= P.hit - 0.05) {
      const j = PIP.hop(t, P.hit + 0.04, { dur: 0.32, height: 48, pre: 0.05 })
      const fl = E.inOutCubic(K.seg(t, P.hit + 0.25, P.hit + 1.25))
      ;[x, y] = lerp2([NAP.x, NAP.y], NAP_HOVER, fl)
      y += j.y + Math.sin((t - P.hit) * 2.7) * 7 * fl
      rot = K.lerp(NAP.rot, 0.05, fl) + 0.05 * Math.sin((t - P.hit) * 1.9) * fl + 0.12 * ring(t - P.hit, 11, 5)
      lift = Math.max(-j.y * 0.4, 24 * fl)
      // Pip's weight: a dip when it lands aboard, and small dips on each of Pip's bounces
      y += 18 * ring(t - P.board1, 11, 5)
      sy = 1 - 0.06 * ring(t - P.board1, 14, 7)
      for (const l of P.land) y += 7 * ring(t - l - 0.2, 12, 6)
    }
    if (t >= P.napFly - 0.12 && t < P.napFly) y += 12 * Math.sin(K.seg(t, P.napFly - 0.12, P.napFly) * Math.PI * 0.5)
    if (t < P.napFly || !tabs) return { x, y, rot, s, sx: 1, sy, lift, u: 0 }
    const u = K.seg(t, P.napFly, P.napLand)
    const e = E.inOutCubic(u)
    const tr = tabs[3]
    const p0 = [x, y + 12]
    const p3 = [tr.cx, tr.cy]
    const c1 = [p0[0] + 150, p0[1] - 150]
    const c2 = [tr.cx + 150, 185]
    const pos = bez3(p0, c1, c2, p3, e)
    const d = bez3d(p0, c1, c2, p3, e)
    const flat = E.inQuad(K.seg(e, 0.7, 1))
    const size = 300 * s
    return {
      x: pos[0],
      y: pos[1],
      rot: K.lerp(rot, 0, e) - 0.26 * Math.sin(Math.PI * e),
      s,
      sx: K.lerp(1, tr.w / size, flat),
      sy: K.lerp(1, tr.h / size, flat),
      lift: K.lerp(22, 30, Math.sin(Math.PI * e)),
      u,
      dir: Math.atan2(d[1], d[0]),
      vel: [(d[0] / (P.napLand - P.napFly)) * 0.6, (d[1] / (P.napLand - P.napFly)) * 0.6],
    }
  }
  /** Which card seat Pip is on (−1 left, +1 right) as a continuous rock value, for the seesaw tilt. */
  function seesawSide(t, P) {
    if (t < P.cardLand) return -E.outCubic(K.seg(t, P.cardLand - 0.08, P.cardLand + 0.12))
    const a = E.inOutCubic(K.seg(t, P.flip[0][0] + 0.04, P.flip[0][1]))
    const b = E.inOutCubic(K.seg(t, P.flip[1][0] + 0.04, P.flip[1][1]))
    return -1 + 2 * a - 2 * b
  }
  /** Card (yarn-hung) geometry this frame. */
  function cardState(t, P, content) {
    if (t < P.drop0) return null
    const tapeY = content.y + 12
    const s = CARD.s
    let dy = 0
    if (t < P.catch) {
      const u = K.seg(t, P.drop0, P.catch)
      dy = -480 * (1 - u * u)
    } else dy = 30 * ring(t - P.catch, 13, 5)
    const cy = tapeY + (CARD.h / 2 + CARD.yarn) * s + dy
    const hole = [CARD.x, cy + (-CARD.h / 2 + 24) * s]
    // flips (0 → 1 → 2): Terminal face lands on "terminal", Chat again one beat later
    let flip = 0
    for (let k = 0; k < 2; k++) flip += E.inOutCubic(K.seg(t, P.flip[k][0], P.flip[k][1]))
    // seesaw: the card leans toward whichever seat Pip is on, dips on every landing
    const side = seesawSide(t, P)
    let th = 0.012 * Math.sin(t * 2.3) + 0.07 * side
    th += -0.085 * ring(t - P.cardLand, 10, 4.2)
    th += 0.085 * ring(t - P.flip[0][1], 10, 4.2)
    th += -0.085 * ring(t - P.flip[1][1], 10, 4.2)
    th += -0.06 * ring(t - P.stand, 10, 4.2)
    th += 0.04 * ring(t - P.slap, 12, 5)
    th += 0.05 * ring(t - P.catch, 8, 4)
    const sxF = Math.abs(Math.cos(flip * Math.PI))
    const seatAt = (dx, full) => {
      const lx = dx * (full ? 1 : sxF) * s
      const ly = -24 * s
      return [hole[0] + lx * Math.cos(th) - ly * Math.sin(th), hole[1] + lx * Math.sin(th) + ly * Math.cos(th)]
    }
    return { cx: CARD.x, cy, hole, tapeY, flip, th, sxF, seatAt, dy }
  }

  // ---------- local drawings ----------
  /** Pip's glue stick, set down on the desk (sage tube + white cap). */
  function glueStick(ctx, x, y, t, rot) {
    K.at(ctx, x, y, rot, PIP_S, () => {
      K.paper(ctx, K.roundRectPts(-11, -30, 22, 50, 6), C.sage, { cut: 0.8, shadow: 0.8, seed: 's2glue' })
      K.paper(ctx, K.roundRectPts(-12, -44, 24, 18, 6), C.paperWhite, { cut: 0.6, shadow: 0.5, seed: 's2gcap' })
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(-6, -24, 4, 38)
    })
  }
  /** The glossy glue splat left on the desk by the thwack. */
  function glueSplat(ctx, x, y, p) {
    if (p <= 0) return
    const e = E.outBack(p)
    K.at(ctx, x, y, -0.1, [e * 1.2, e * 1.05], () => {
      const pts = K.wobble(K.ellipsePts(0, 0, 30, 11, 20), 3, 's2splat')
      K.dropShadow(ctx, pts, 0.5, 0)
      K.pathPoly(ctx, pts)
      ctx.fillStyle = 'rgba(255,253,246,0.92)'
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.beginPath()
      ctx.ellipse(-9, -3, 7, 2.6, -0.2, 0, TAU)
      ctx.fill()
    })
  }
  /** The console's name plaque (same art as the prop's), animated here so it can land as the hero. */
  function plaque(ctx, x, y, t, sc, rot, lift) {
    if (sc <= 0) return
    const title = 'Session Manager'
    K.font(ctx, 'marker', 38)
    const pw = ctx.measureText(title).width + 78
    K.at(ctx, x, y, rot, sc, () => {
      K.paper(ctx, K.roundRectPts(-pw / 2, -31, pw, 62, 12), C.butter, { cut: 1.4, shadow: 0.95, lift: 2 + lift, seed: 's2pq' })
      K.pencil.rect(ctx, -pw / 2 + 7, -24, pw - 14, 48, 's2pqb', t, { stroke: C.terracotta, strokeWidth: 2.4, roughness: 1, bowing: 0.6 })
      for (const bx of [-pw / 2 + 21, pw / 2 - 21]) {
        ctx.fillStyle = 'rgba(58,36,14,0.25)'
        ctx.beginPath()
        ctx.arc(bx + 1, 2, 7.5, 0, TAU)
        ctx.fill()
        ctx.fillStyle = C.honey
        ctx.beginPath()
        ctx.arc(bx, 0, 7, 0, TAU)
        ctx.fill()
        ctx.fillStyle = 'rgba(255,250,230,0.8)'
        ctx.beginPath()
        ctx.arc(bx - 2, -2, 2.4, 0, TAU)
        ctx.fill()
      }
      K.hand(ctx, title, 0, 13, { family: 'marker', size: 38, color: C.ink, t, id: 's2pqt', jitter: 0.7 })
    })
  }
  /** Short crayon impact ticks radiating from (x, y) at radius r, one per angle (never a full ray burst). */
  function impactTicks(ctx, x, y, r, angles, id, t, color, p) {
    if (p <= 0) return
    const len = 16 + 14 * p
    angles.forEach((a, i) => {
      const r0 = r + (1 - p) * 14
      K.pencil.line(ctx, x + Math.cos(a) * r0, y + Math.sin(a) * r0 * 0.8, x + Math.cos(a) * (r0 + len), y + Math.sin(a) * (r0 + len) * 0.8, id + i, t, { stroke: color, strokeWidth: 4, roughness: 0.7 })
    })
  }
  /** Terracotta yarn from the washi at the top down to the card's hole, plus the knot. */
  function yarn(ctx, top, hole, t, tapeOn) {
    const sway = K.noise1(t * 1.3, 's2yarn') * 5
    const pts = []
    for (let i = 0; i <= 6; i++) {
      const u = i / 6
      pts.push([K.lerp(top[0], hole[0], u) + Math.sin(u * Math.PI) * sway, K.lerp(top[1], hole[1], u)])
    }
    K.pencil.curve(ctx, pts, 's2yn', t, { stroke: C.terracotta, strokeWidth: 5.5 * CARD.s + 1, roughness: 0.9, bowing: 0.5 })
    K.pencil.curve(ctx, pts.map(([a, b]) => [a + 1.2, b]), 's2yf', t, { stroke: '#7d3a1e', strokeWidth: 1.3, roughness: 2.2, bowing: 1 })
    // knot through the hole
    const [hx, hy] = hole
    const tail = K.noise1(t * 2, 's2tail') * 2
    K.pencil.line(ctx, hx, hy, hx - 6 + tail, hy + 18, 's2k1', t, { stroke: C.terracotta, strokeWidth: 3.2, roughness: 0.9 })
    K.pencil.line(ctx, hx, hy, hx + 5 + tail, hy + 20, 's2k2', t, { stroke: C.terracotta, strokeWidth: 3.2, roughness: 0.9 })
    ctx.fillStyle = 'rgba(58,36,14,0.25)'
    ctx.beginPath()
    ctx.arc(hx + 1.2, hy + 2, 6, 0, TAU)
    ctx.fill()
    ctx.fillStyle = C.terracotta
    ctx.beginPath()
    ctx.arc(hx, hy, 6, 0, TAU)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,235,215,0.55)'
    ctx.beginPath()
    ctx.arc(hx - 2, hy - 2, 2, 0, TAU)
    ctx.fill()
    if (tapeOn > 0) {
      const e = E.outBack(K.clamp01(tapeOn))
      K.at(ctx, top[0], top[1] + 4, 0, 1.3 - 0.3 * e, () => K.withAlpha(ctx, K.clamp01(tapeOn * 3), () => K.tape(ctx, 0, 0, 64, 0.12, 'rgba(244,193,69,0.8)', { h: 24, seed: 's2yt' })))
    }
  }
  /** Wobbly hand-drawn scribble line (a "line of text" with no words). */
  function scribble(ctx, x0, y, len, id, t, color, width) {
    K.pencil.line(ctx, x0, y, x0 + len, y + K.noise1(len * 0.01, id) * 3, id, t, { stroke: color, strokeWidth: width, roughness: 1.4, bowing: 1.2 })
  }
  /** One tab's mini session, drawn in the screen: no words, just the kind of work in it. */
  function miniSession(ctx, kind, x, y, t, rot, lift) {
    if (kind === 'term') {
      PROPS.terminalCard(ctx, x, y, t, { id: 's2mst', w: 330, h: 214, scribbles: 3, rot, lift, jitter: 0.4 })
      return
    }
    if (kind === 'idea') {
      PROPS.napkin(ctx, x, y + 8, t, { id: 's2msi', size: 250, text: '', doodle: 1, lit: 1, rot, lift, jitter: 0.4 })
      return
    }
    K.at(ctx, x, y, rot, 1, () => {
      if (kind === 'home') {
        // the project's home page: a card with a peach header, a pencil house and a checklist
        const w = 336
        const h = 222
        K.paper(ctx, K.boxPts(w, h), C.paperWhite, { cut: 1.2, shadow: 1, lift: 4 + lift, seed: 's2msh' })
        K.paper(ctx, K.rectPts(-w / 2 + 8, -h / 2 + 8, w - 16, 44), C.peach, { cut: 0.8, shadow: 0.3, seed: 's2msh2' })
        K.pencil.poly(ctx, [[-w / 2 + 26, -h / 2 + 40], [-w / 2 + 26, -h / 2 + 26], [-w / 2 + 38, -h / 2 + 16], [-w / 2 + 50, -h / 2 + 26], [-w / 2 + 50, -h / 2 + 40]], 's2mhh', t, { stroke: C.ink, strokeWidth: 3, roughness: 0.8 })
        scribble(ctx, -w / 2 + 66, -h / 2 + 30, 150, 's2mhs0', t, C.ink, 3.4)
        for (let i = 0; i < 3; i++) {
          const ry = -h / 2 + 88 + i * 42
          K.pencil.rect(ctx, -w / 2 + 26, ry - 12, 24, 24, 's2mhb' + i, t, { stroke: C.inkDim, strokeWidth: 2.4, roughness: 0.8 })
          if (i < 2) K.pencil.line(ctx, -w / 2 + 29, ry, -w / 2 + 37, ry + 9, 's2mhc' + i, t, { stroke: C.sage, strokeWidth: 4, roughness: 0.6 })
          if (i < 2) K.pencil.line(ctx, -w / 2 + 37, ry + 9, -w / 2 + 52, ry - 14, 's2mhd' + i, t, { stroke: C.sage, strokeWidth: 4, roughness: 0.6 })
          scribble(ctx, -w / 2 + 66, ry, 190 - i * 34, 's2mhl' + i, t, C.inkDim, 3)
        }
      } else {
        // chat: a cream speech-bubble window (the only way Claude is drawn) with scribbled lines
        K.paper(ctx, K.roundRectPts(-176, -118, 352, 236, 18), C.sky, { cut: 1.2, shadow: 1, lift: 4 + lift, seed: 's2msc' })
        K.bubble(ctx, 6, -8, 300, 168, [-118, 92], { color: C.cream, seed: 's2mscb' })
        scribble(ctx, -104, -44, 206, 's2mcl0', t, C.inkDim, 3.2)
        scribble(ctx, -116, -8, 232, 's2mcl1', t, C.inkDim, 3.2)
        scribble(ctx, -96, 28, 150, 's2mcl2', t, C.inkDim, 3.2)
        K.paper(ctx, K.roundRectPts(96, 64, 62, 34, 14), C.butter, { cut: 0.6, shadow: 0.5, seed: 's2mscd' })
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = C.inkDim
          ctx.beginPath()
          ctx.arc(112 + i * 15, 81 - 3 * Math.max(0, Math.sin(t * 9 - i * 0.9)), 4, 0, TAU)
          ctx.fill()
        }
      }
    })
  }
  /** The mini sessions, swiped in and out of the screen (clipped to the content area). */
  function drawSessions(ctx, t, P, A) {
    const list = P.sess
    if (t < list[0].t0 || t > P.sessOut + 0.3) return
    const r = A.content
    ctx.save()
    ctx.beginPath()
    ctx.rect(r.x, r.y, r.w, r.h)
    ctx.clip()
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      if (t < s.t0) break
      const tEnd = i + 1 < list.length ? list[i + 1].t0 : P.sessOut
      const out = K.seg(t, tEnd, tEnd + 0.22)
      if (out >= 1) continue
      // it slides down out of its own tab (from under the tab row), with an overshoot; the old one drops away
      const inn = K.seg(t, s.t0, s.t0 + 0.28)
      const eIn = back(inn, 1.2)
      const eOut = E.inCubic(out)
      const from = [A.tabs[s.tab][0], r.y - 170]
      const x = K.lerp(from[0], SESS[0], eIn) - 120 * eOut
      const y = K.lerp(from[1], SESS[1], eIn) + 520 * eOut
      const tilt = from[0] > SESS[0] ? 1 : -1
      const rot = 0.24 * tilt * (1 - eIn) + (i % 2 ? 0.025 : -0.03) - 0.2 * eOut
      miniSession(ctx, s.kind, x, y, t, rot, 16 * (1 - inn) + 10 * eOut)
      if (inn > 0.05 && inn < 0.75) PROPS.speedLines(ctx, x - (SESS[0] - from[0]) * 0.18, y - 150, t, { id: 's2ssl' + i, dir: Math.atan2(SESS[1] - from[1], SESS[0] - from[0]), len: 130, n: 3, spread: 170, p: Math.sin((Math.PI * inn) / 0.75), width: 3.2 })
    }
    ctx.restore()
  }
  /** A blown-away mess piece (s1's layout) — null when it is off the frame. */
  function drawBlown(ctx, t, P, b, i) {
    const j = joltOf(t, P, i)
    const tb = P.blowAt[i]
    const p = t - tb
    let x = b.x
    let y = b.y + j.y
    let rot = b.rot + j.spin
    let sc = 1
    let lift = -j.y * 0.3
    let flutter = K.clamp01(-j.y / 20)
    let curl = 0.12
    if (p > -0.1) {
      // anticipation: the gust arrives — the piece lifts and trembles
      const a = K.seg(p, -0.1, 0)
      lift += 8 * a
      flutter = Math.max(flutter, a)
      rot += 0.05 * a * Math.sin(t * 40 + i)
    }
    if (p > 0) {
      const d = b.v * (p + 0.9 * p * p)
      x += b.dir[0] * d
      y += b.dir[1] * d - 60 * Math.sin(Math.min(p, 0.5) * Math.PI)
      rot += b.spin * p
      sc = 1 + 0.14 * K.clamp01(p * 3)
      lift += 26 * K.clamp01(p * 4)
      flutter = 1
      curl = 0.45
      if (x < -260 || x > W + 260 || y < -260 || y > H + 260) return
    }
    if (b.k === 't') {
      PROPS.terminalCard(ctx, x, y, t, { id: b.id, rot, scale: [b.s * sc * (2 - j.squash), b.s * sc * j.squash], tape: b.tape, scribbles: b.scr, cursor: b.cursor || 'underscore', lift, jitter: 0.6 })
    } else {
      PROPS.stickyNote(ctx, x, y, t, { id: b.id, size: b.size, color: b.color, text: b.text, rot, scale: [sc * (2 - j.squash), sc * j.squash], curl, flutter, lift, jitter: 0.5 })
    }
  }

  // ---------- the frame ----------
  function draw(ctx, tRaw, dur, info) {
    const P = plan(info)
    const t = K.clamp(tRaw, 0, dur + 0.4)
    const pan = info.camShift(tRaw)
    const cam = camAt(t, P)
    const cx = consoleX(t, P)

    // ── desk layer (parallax: 0.6x of the local push-ins, 0.65x of the outgoing engine pan) ──
    ctx.save()
    ctx.translate(Math.round(-0.35 * pan.dx), Math.round(-0.35 * pan.dy))
    applyCam(ctx, cam, 0.6)
    K.desk(ctx)
    PROPS.coffeeRing(ctx, 520, 615, t, { id: 's1-ring1', r: 88 })
    PROPS.coffeeRing(ctx, 1745, 660, t, { id: 's1-ring2', r: 62, alpha: 0.8 })
    glueSplat(ctx, HIT[0], HIT[1] + 4, K.seg(t, P.hit, P.hit + 0.2))
    // the mess inside the console's footprint: covered for good once the console is down
    if (t < P.consHit) {
      MESS_S.forEach((m, k) => {
        const j = joltOf(t, P, k + 3)
        PROPS.stickyNote(ctx, m.x, m.y + j.y, t, { id: m.id, size: m.size, color: m.color, text: m.text, rot: m.rot + j.spin, scale: [2 - j.squash, j.squash], curl: 0.12, flutter: K.clamp01(-j.y / 20), lift: -j.y * 0.3, jitter: 0.5 })
      })
    }
    // everything outside it: blown off the desk by the console's gust
    if (t < P.consHit + 1.2) BLOW.forEach((b, i) => drawBlown(ctx, t, P, b, i))
    ctx.restore()
    // staging: while Pip thwacks, the mess recedes (a soft paper veil that opens around Pip)
    const veil = 0.4 * E.inOutQuad(K.seg(t, 0.12, P.hit)) * (1 - E.inOutQuad(K.seg(t, P.consStart + 0.2, P.consHit)))
    if (veil > 0) {
      ctx.save()
      applyCam(ctx, cam, 1)
      const g = ctx.createRadialGradient(PIP_HOME[0], PIP_HOME[1] - 110, 170, PIP_HOME[0], PIP_HOME[1] - 110, 1250)
      g.addColorStop(0, 'rgba(246,239,225,0)')
      g.addColorStop(0.35, 'rgba(246,239,225,' + (veil * 0.55).toFixed(3) + ')')
      g.addColorStop(1, 'rgba(246,239,225,' + veil.toFixed(3) + ')')
      ctx.fillStyle = g
      ctx.fillRect(-200, -200, W + 400, H + 400)
      ctx.restore()
    }

    // ── world layer ──
    ctx.save()
    applyCam(ctx, cam, 1)
    let A = null
    if (cx !== null) {
      const imp = ring(t - P.consHit, 16, 7)
      const tabSpec = TABS.map((tb, i) => {
        const o = Object.assign({}, tb)
        if (i < 3) {
          o.p = t >= P.land[i] ? 1 : 0
          o.morph = 1 - E.inOutCubic(K.seg(t, P.land[i] + 0.02, P.land[i] + 0.36))
          o.lift = -tabLift(t, P, i)
        } else {
          o.p = K.seg(t, P.napLand, P.napLand + 0.32)
          o.lift = -tabLift(t, P, 3)
        }
        return o
      })
      A = PROPS.consoleWindow(ctx, cx, CONS.y, t, {
        id: CONS.id,
        scale: [CONS.s * (1 - 0.018 * imp), CONS.s * (1 + 0.012 * imp)],
        tabs: tabSpec,
        sidebarReveal: K.seg(t, P.side0, P.side1),
        plaque: 0,
        pins: K.seg(t, P.consHit - 0.02, P.consHit + 0.3),
        lift: 10 * (1 - K.seg(t, P.consHit - 0.2, P.consHit + 0.1)),
      })
      // paper-swipe speed lines trailing the slide
      const u = (t - P.consStart) / P.consDur
      if (u > 0 && u < 0.62) {
        const sp = Math.sin(Math.PI * K.clamp01(u / 0.62))
        for (let k = 0; k < 3; k++) PROPS.speedLines(ctx, A.frame.x + A.frame.w + 18, A.frame.y + 110 + k * 230, t, { id: 's2cs' + k, dir: Math.PI, len: 280, n: 3, spread: 120, p: sp, width: 4 })
      }
      // one tab's mini session at a time, swiped into the screen
      if (t >= P.consHit) drawSessions(ctx, t, P, A)
      // the hero plaque: slaps on big during "Session Manager" (held above the sidebar), settles on "one"
      const pq = K.seg(t, P.plaque - 0.2, P.plaque)
      if (pq > 0) {
        const hit = t - P.plaque
        const settle = E.inOutCubic(K.seg(t, P.plaqueSettle, P.plaqueSettle + 0.32))
        let sc = pq < 1 ? K.lerp(3.2, 1.85, E.inCubic(pq)) : 1.85 - 0.14 * ring(hit, 18, 7)
        sc = K.lerp(sc, 1, settle)
        const rot = pq < 1 ? K.lerp(-0.3, -0.03, pq) : -0.03 + 0.05 * ring(hit, 14, 6)
        const px = A.plaque[0] + (1 - settle) * 110
        const py = A.plaque[1] - (1 - settle) * 58
        plaque(ctx, px, py, t, sc * CONS.s, rot, pq < 1 ? 30 * (1 - pq) : 0)
        if (hit > 0 && hit < 0.45) {
          const hw = 185 * CONS.s * sc
          impactTicks(ctx, px, py, hw + 10, [Math.PI - 0.35, Math.PI, Math.PI + 0.35, -0.35, 0, 0.35], 's2pqs', t, C.terracotta, 1 - hit / 0.45)
        }
      }
    }
    // Pip's glue stick, set down on the desk in front of the console
    if (t >= P.glueDown) {
      const g = K.seg(t, P.glueDown, P.glueDown + 0.14)
      glueStick(ctx, PIP_HOME[0] - 78, PIP_HOME[1] + 6 - 46 * (1 - E.inQuad(g)), t, K.lerp(-0.4, -1.42, E.outBack(g)))
    }

    // ── hero terminals: floating, then swooping into their tab slots (flying ones on top) ──
    const tabs = A ? A.tabRects : null
    const heroes = [0, 1, 2].map((i) => [i, heroState(i, t, P, tabs)]).filter(([, s]) => s)
    heroes.sort((a, b) => (a[1].u > 0) - (b[1].u > 0))
    for (const [i, st] of heroes) {
      if (st.u > 0.12 && st.u < 0.95) {
        const sp = Math.sin(Math.PI * st.u)
        PROPS.speedLines(ctx, st.x - Math.cos(st.dir) * 110 * st.sx, st.y - Math.sin(st.dir) * 110 * st.sx, t, { id: 's2hs' + i, dir: st.dir, len: 200, n: 4, spread: 90, p: sp, width: 3.6 })
      }
      const h = HERO[i]
      PROPS.terminalCard(ctx, st.x, st.y, t, { id: h.id, scale: [st.sx, st.sy], rot: st.rot, scribbles: h.scr, tape: h.tape || null, cursor: h.cursor || 'underscore', lift: st.lift, jitter: 0.6 })
    }
    // tab-landing ticks
    if (A) {
      for (let i = 0; i < 3; i++) {
        const q = t - P.land[i]
        if (q > 0.02 && q < 0.4) impactTicks(ctx, A.tabs[i][0], A.tabs[i][1] - 8, A.tabRects[i].w / 2 + 6, [-2.7, -1.9, -1.25, -0.45], 's2tp' + i, t, C.inkDim, 1 - q / 0.4)
      }
    }

    // ── the napkin (Pip's idea) ──
    const nap = napState(t, P, tabs)
    const napGone = t >= P.napLand
    let napTop = null
    if (!napGone) {
      if (nap.u > 0.1 && nap.u < 0.93) PROPS.speedLines(ctx, nap.x - Math.cos(nap.dir) * 90, nap.y - Math.sin(nap.dir) * 90, t, { id: 's2ns', dir: nap.dir, len: 220, n: 4, spread: 100, p: Math.sin(Math.PI * nap.u), width: 3.6 })
      PROPS.napkin(ctx, nap.x, nap.y, t, { id: 's1-napkin', size: 300, scale: [nap.s * nap.sx, nap.s * nap.sy], rot: nap.rot, lift: nap.lift, doodle: 1, lit: 1, jitter: 0.5 })
      const hh = 150 * nap.s * nap.sy - 10
      napTop = [nap.x + Math.sin(nap.rot) * hh, nap.y - Math.cos(nap.rot) * hh]
    }
    if (A && napGone) {
      // the landing puff sits ABOVE the new tab so "napkin-idea" stays readable
      const p = K.seg(t, P.napLand - 0.02, P.napLand + 0.35)
      if (p > 0 && p < 1) PROPS.doodlePuff(ctx, A.tabs[3][0] + 30, A.tabs[3][1] - 80, t, { id: 's2np', r: 44, p })
      const q = t - P.napLand
      if (q > 0.05 && q < 0.5) K.sparkle(ctx, A.tabs[3][0] - 74, A.tabs[3][1] - 62, 26, 's2bulb', t, { n: 3, color: C.honey, w: 3.5 })
    }

    // ── the chat ⇄ terminal card on its yarn + the "same session" sticky ──
    let card = null
    if (A) card = cardState(t, P, A.content)
    if (card) {
      const s = CARD.s
      const top = [CARD.x, card.tapeY]
      ctx.save()
      if (t < P.catch + 0.1) {
        const r = A.screen
        ctx.beginPath()
        ctx.rect(r.x + 2, r.y + 3, r.w - 4, r.h - 4)
        ctx.clip()
      }
      const yTop = t < P.catch ? [top[0], card.hole[1] - (CARD.yarn + 24) * s] : top
      K.at(ctx, card.hole[0], card.hole[1], card.th, 1, () => {
        PROPS.chatTermCard(ctx, 0, -(-CARD.h / 2 + 24) * s, t, { id: 's2card', scale: s, flip: card.flip, yarn: false, lift: 12 })
      })
      yarn(ctx, yTop, card.hole, t, K.seg(t, P.catch - 0.02, P.catch + 0.25))
      ctx.restore()
      // "same session": flies in spinning, slaps onto the yarn on "conversation"
      const sq = K.seg(t, P.slap - 0.34, P.slap)
      if (sq > 0) {
        const tgt = [CARD.x + 113, card.tapeY + 114]
        const e = E.inQuad(sq)
        const pos = sq < 1 ? bez3([1790, -160], [1660, 120], [tgt[0] + 190, tgt[1] - 70], tgt, e) : tgt
        const hit = t - P.slap
        const sc = sq < 1 ? K.lerp(1.3, 1, e) : 1
        const sxy = sq < 1 ? [sc, sc] : [1 + 0.14 * ring(hit + 0.02, 20, 9), 1 - 0.12 * ring(hit + 0.02, 20, 9)]
        PROPS.stickyNote(ctx, pos[0], pos[1], t, { id: 's2same', size: 212, color: 'pink', text: 'same\nsession', textSize: 50, rot: sq < 1 ? K.lerp(1.4, -0.04, e) : -0.04 + 0.03 * ring(hit, 14, 6), scale: sxy, curl: 0.3, lift: sq < 1 ? 26 : 2 })
        if (hit > 0 && hit < 0.4) impactTicks(ctx, tgt[0], tgt[1], 130, [-0.7, -0.3, 0.3, 0.7], 's2sss', t, C.terracotta, 1 - hit / 0.4)
      }
    }

    // ── Pip ──
    drawPip(ctx, t, P, A, nap, napTop, card)
    // the thwack: a paper puff + impact ticks at the glue tip
    const tp = K.seg(t, P.hit - 0.02, P.hit + 0.5)
    if (tp > 0 && tp < 1) {
      PROPS.doodlePuff(ctx, HIT[0] + 16, HIT[1] - 16, t, { id: 's2thw', r: 85, p: tp })
      if (tp < 0.5) impactTicks(ctx, HIT[0] + 6, HIT[1] - 4, 58, [-2.6, -1.95, -1.2, -0.5], 's2thws', t, C.terracotta, 1 - tp * 2)
    }
    ctx.restore()
  }

  /** Pip's world-space look toward (x, y) from its head at (hx, hy), as a -1..1 vector. */
  const lookAt = (hx, hy, x, y) => {
    const dx = x - hx
    const dy = y - hy
    const L = Math.hypot(dx, dy) || 1
    return [dx / L, dy / L]
  }

  function drawPip(ctx, t, P, A, nap, napTop, card) {
    const base = { id: 's2pip', scale: PIP_S }
    let x = PIP_HOME[0]
    let y = PIP_HOME[1]
    let o = {}
    const headY = PIP_HOME[1] - 150
    if (t < P.thw0) {
      o = { pose: 'idle', glue: true, brows: 'determined', look: [0.9, 0.3], mouth: 'grin' }
    } else if (t < P.hit + 0.14) {
      o = { pose: 'thwack', poseT: t - P.thw0, glue: true }
    } else if (t < Math.min(P.tadaEnd, P.cheer)) {
      // "Ta-da!" — arms up, presenting the console that whooshes in behind; scarf + antenna in the gust
      const cx = consoleX(t, P)
      const edge = cx === null ? W + 200 : cx - CONS_HALF
      const gust = cx !== null && Math.abs(edge - PIP_HOME[0]) < 380 ? 1 : 0
      o = { pose: 'cheer', poseT: t - P.hit - 0.14, glue: true, mouth: 'open', eyes: t < P.tada + 0.3 ? 'happy' : 'wide', look: lookAt(PIP_HOME[0], headY, Math.min(edge, W), 520), vel: [-700 * gust, -60 * gust] }
      o.squash = 1 + 0.08 * ring(t - P.hit - 0.14, 16, 8)
    } else if (t < P.cheer) {
      const cx = consoleX(t, P)
      o = { pose: 'idle', glue: true, eyes: 'wide', mouth: 'o', look: lookAt(PIP_HOME[0], headY, (cx || CONS.x) - CONS_HALF, 400), flip: true }
    } else if (t < P.glueDown) {
      // a cheer hop on the thud, facing the console's centre
      const hp = PIP.hop(t, P.cheer + 0.02, { dur: 0.36, height: 44, pre: 0.06 })
      y += hp.y
      o = { pose: 'cheer', poseT: t - P.cheer, glue: true, flip: true, squash: hp.squash, air: -hp.y, mouth: 'grin', eyes: 'happy' }
    } else if (t < P.board1) {
      // turn, crouch and leap aboard the floating napkin
      const nt = napTop || NAP_HOVER
      const L = leap(t, P.board0, P.board1, PIP_HOME, [nt[0], nt[1] + LEG], 70, 0.1)
      const hp = hopPose(L.u)
      x = L.x
      y = L.y - (t >= P.board0 ? hp.lift : 0)
      o = t >= P.board0 ? { pose: hp.pose, poseT: hp.poseT, squash: L.squash, air: L.air, vel: L.vel, look: [0.25, -0.7] } : { pose: 'idle', squash: L.squash, look: [0.2, -0.85], mouth: 'grin' }
    } else if (t < P.napFly - 0.12) {
      // riding the hovering napkin, watching the terminals fly home
      x = napTop[0]
      y = napTop[1]
      let look = [-0.6, -0.6]
      for (let i = 2; i >= 0; i--) {
        if (t > P.launch[i] - 0.2 && A) {
          const tr = A.tabRects[i]
          if (t < P.land[i]) {
            const st = heroState(i, t, P, A.tabRects)
            look = st ? lookAt(x, y - 110, st.x, st.y) : lookAt(x, y - 110, tr.cx, tr.cy)
          } else look = lookAt(x, y - 110, tr.cx, tr.cy)
          break
        }
      }
      const cheerK = P.land.some((l) => t >= l && t < l + 0.4)
      let bob = 0
      let bsq = 1 - 0.1 * ring(t - P.board1, 14, 7)
      for (const l of P.land) {
        if (t < l - 0.1 || t > l + 0.5) continue
        const h = PIP.hop(t, l - 0.02, { dur: 0.24, height: 22, pre: 0.08 })
        bob = h.y
        bsq = h.squash
      }
      y += bob
      o = { pose: 'ride', poseT: t - P.board1, rot: nap.rot, look, mouth: cheerK ? 'open' : 'grin', eyes: cheerK ? 'happy' : undefined, squash: bsq, air: -bob, flip: look[0] < -0.2 }
    } else if (t < P.napLand) {
      // surfing the napkin into its slot
      x = napTop ? napTop[0] : x
      y = napTop ? napTop[1] : y
      o = { pose: 'slide', poseT: t - P.napFly, rot: nap.rot * 0.6, vel: nap.vel || [0, 0], shadow: false, flip: true }
    } else if (t < P.cardLand) {
      // hop-tap along the tabs, then dive onto the card from garden-app's right shoulder
      const topOf = (i, dx = 0) => [A.tabRects[i].cx + dx, A.tabRects[i].y + 4 + tabLift(t, P, i) * 18 * CONS.s]
      const pts = [topOf(3, -18), topOf(2), topOf(1)]
      if (t < P.tap[0] - 0.24) {
        x = pts[0][0]
        y = pts[0][1]
        o = { pose: 'idle', squash: 1 - 0.14 * ring(t - P.napLand, 14, 7), eyes: 'happy', mouth: 'open', look: [-0.8, 0.2], shadow: false, flip: true }
      } else if (t < P.dive0) {
        const k = t < P.tap[0] ? 0 : 1
        const L = leap(t, P.tap[k] - 0.24, P.tap[k], pts[k], pts[k + 1], 26, 0.06)
        const hp = hopPose(L.u)
        x = L.x
        y = L.y - (L.air ? hp.lift : 0)
        o = L.air ? { pose: hp.pose, poseT: hp.poseT, squash: L.squash, vel: L.vel, flip: true, shadow: false } : { pose: 'idle', squash: L.squash, flip: true, mouth: 'grin', shadow: false, look: [-0.8, 0.3] }
      } else {
        const seat = card ? card.seatAt(-CARD.seat, true) : [CARD.x - 110, 470]
        const shoulder = [A.tabRects[1].x + A.tabRects[1].w - 16, A.tabRects[1].y + 4]
        const sh = K.seg(t, P.dive0, P.dive0 + 0.14)
        if (sh < 1) {
          // scoot to the tab's right shoulder, peering down at the card
          x = K.lerp(pts[2][0], shoulder[0], E.inOutQuad(sh))
          y = pts[2][1]
          o = { pose: 'idle', squash: 1 - 0.1 * Math.sin(Math.PI * sh), shadow: false, look: [0.3, 1], mouth: 'o', eyes: 'wide' }
        } else {
          const L = leap(t, P.dive0 + 0.14, P.cardLand, shoulder, [seat[0], seat[1] + LEG], 12, 0.05)
          const hp = hopPose(L.u)
          x = L.x
          y = L.y - hp.lift * 0.4
          // a light velocity trail only (scarf/antenna), so the pupils stay on the card it dives to
          o = { pose: hp.pose, poseT: hp.poseT, squash: L.squash, vel: [L.vel[0] * 0.15, L.vel[1] * 0.08], shadow: false, look: [0.3, 1], eyes: 'wide', mouth: 'open' }
        }
      }
    } else if (card) {
      const sideAt = (tt) => (tt < P.flip[0][1] ? -1 : tt < P.flip[1][1] ? 1 : -1)
      if (t < P.stand0) {
        // riding the flipping card like a seesaw: hop seat-to-seat as it turns, the card rocks each way
        let flying = null
        P.flip.forEach(([a, b], k) => {
          if (t >= a - 0.06 && t < b) flying = { a, b, k }
        })
        if (flying) {
          const from = flying.k === 0 ? -1 : 1
          const A0 = card.seatAt(from * CARD.seat, true)
          const B0 = card.seatAt(-from * CARD.seat, true)
          const L = leap(t, flying.a + 0.02, flying.b, A0, B0, 56, 0.08)
          x = L.x
          y = L.y
          const u = L.u
          o = { pose: 'ride', poseT: t - P.cardLand, rot: card.th * 0.5, squash: L.squash, air: L.air, shadow: false, flip: from > 0 ? u < 0.55 : u >= 0.55, mouth: 'open', eyes: L.inAir ? 'happy' : undefined, vel: L.vel, look: [0, 0.7] }
        } else {
          const side = sideAt(t)
          const seat = card.seatAt(side * CARD.seat)
          x = seat[0]
          y = seat[1]
          const lastLand = t < P.flip[0][1] ? P.cardLand : t < P.flip[1][1] ? P.flip[0][1] : P.flip[1][1]
          const squash = 1 - 0.14 * ring(t - lastLand, 14, 7)
          o = { pose: 'ride', poseT: t - P.cardLand, rot: card.th, squash, shadow: false, flip: side > 0, mouth: 'grin', look: [-side * 0.3, 0.6] }
          if (t > P.slap - 0.35) o.look = [0.9, -0.3]
        }
      } else {
        // pop up to stand on the card's top edge and cheer
        const seat = card.seatAt(-CARD.seat)
        const stand = card.seatAt(-CARD.seat - 10)
        if (t < P.stand) {
          const L = leap(t, P.stand0, P.stand, [seat[0], seat[1] + LEG], stand, 60, 0.06)
          const hp = hopPose(L.u)
          x = L.x
          y = L.y - hp.lift
          o = { pose: hp.pose, poseT: hp.poseT, squash: L.squash, shadow: false }
        } else {
          x = stand[0]
          y = stand[1]
          o = { pose: 'cheer', poseT: t - P.stand, rot: card.th, shadow: false }
        }
      }
    }
    PIP.draw(ctx, x, y, t, Object.assign(base, o))
  }
  /** Tab lift (0..1 units the console takes, positive = dipped) for tab i: landing spring + Pip's taps. */
  function tabLift(t, P, i) {
    let l = 0
    if (i === 3) l = 0.4 * ring(t - P.napLand - 0.05, 12, 6) + pulse(t, P.napLand, 0.6, 6, 13)
    if (i < 3) l = pulse(t, P.land[i], 0.55, 7, 15)
    if (i === 2) l += pulse(t, P.tap[0], 0.7, 6, 13)
    if (i === 1) l += pulse(t, P.tap[1], 0.7, 6, 13)
    return l
  }

  // ---------- sound ----------
  function sfx(dur, info) {
    const P = plan(info)
    const out = []
    const add = (t, type, o = {}) => out.push(Object.assign({ t: Math.max(0, t), type }, o))
    const pipPan = panOf(PIP_HOME[0])
    // the thwack leads the cameo: it lands ~0.12 s before "Ta-da!" so the voice's onset stays clear
    add(P.hit - 0.01, 'thwack', { gain: 0.8, pan: panOf(HIT[0]) })
    add(P.hit + 0.02, 'squelch', { gain: 0.2, pitch: 1.2, pan: panOf(HIT[0]) })
    add(P.hit + 0.05, 'flutter', { gain: 0.16, pitch: 1.2, pan: 0.1, dur: 0.25 })
    // console slides in (under "Ta-da!": kept low), its gust sweeps the desk, it thuds
    add(P.consStart, 'whoosh', { gain: 0.38, pan: 0.75, dur: P.consHit - P.consStart + 0.1 })
    add(P.edgeAt(1500) || P.consStart + 0.15, 'flutter', { gain: 0.2, pitch: 1.1, pan: 0.5, dur: 0.4 })
    add(P.consHit - 0.06, 'flutter', { gain: 0.2, pitch: 1.35, pan: -0.72, dur: 0.4 })
    add(P.consHit, 'thud', { gain: 0.55, pitch: 0.9, pan: 0.05 })
    ;[-0.55, 0.65, 0.65, -0.55].forEach((pn, i) => add(P.consHit + 0.03 + i * 0.055, 'thup', { gain: 0.16, pitch: 1.05 + 0.08 * i, pan: pn }))
    // the plaque (hero) + the glock ding on "one console"
    add(P.plaque, 'slap', { gain: 0.45, pitch: 1.05, pan: panOf(660) })
    add(P.one, 'ding', { gain: 0.4, note: 89, pan: 0 })
    // sidebar: unroll, tape, six labels (quiet: under "Manager")
    const sd = P.side1 - P.side0
    add(P.side0, 'rustle', { gain: 0.32, dur: 0.35, pitch: 1.3, pan: panOf(590) })
    add(P.side0 + 0.33 * sd, 'slap', { gain: 0.2, pitch: 1.35, pan: panOf(590) })
    for (let i = 0; i < 6; i++) add(P.side0 + (0.24 + (i * 0.48) / 5 + 0.2) * sd, 'thup', { gain: 0.14, pitch: 0.95 + i * 0.07, pan: panOf(560) })
    // Pip's cheer hop, then it hops aboard the napkin
    add(P.board0, 'boing', { gain: 0.28, pitch: 1.25, pan: pipPan })
    add(P.board1, 'flutter', { gain: 0.24, pitch: 1.4, pan: panOf(NAP_HOVER[0]), dur: 0.25 })
    // terminals swoop and land as tabs: three ascending plinks, then each paper-flips
    const tabX = [804, 973, 1166, 1360]
    HERO.forEach((h, i) => {
      add(P.launch[i] - 0.05, 'swoosh', { gain: 0.45, pitch: 0.95 + 0.1 * i, pan: panOf(h.st[0]), dur: 0.6 })
      add(P.land[i], 'plink', { gain: 0.8, pitch: [1, 1.26, 1.5][i], pan: panOf(tabX[i]) })
      add(P.land[i] + 0.17, 'flap', { gain: 0.24, pitch: 1.3 + 0.1 * i, pan: panOf(tabX[i]) })
    })
    // each mini session swipes into the screen (soft paper swish, rising pitch)
    P.sess.forEach((s, i) => add(s.t0 + 0.02, 'swish', { gain: 0.2, pitch: 1.3 + 0.1 * i, pan: panOf(SESS[0] + 200) }))
    add(P.sessOut, 'swish', { gain: 0.18, pitch: 1.1, pan: panOf(SESS[0] - 200) })
    // napkin surfs into napkin-idea
    add(P.napFly - 0.05, 'whoosh', { gain: 0.5, pitch: 1.25, pan: 0.55, dur: 0.6 })
    add(P.napLand, 'pop', { gain: 0.6, pitch: 1.1, pan: panOf(tabX[3]) })
    add(P.napLand + 0.02, 'chime', { gain: 0.42, pan: panOf(tabX[3]) })
    // Pip hop-taps recipe-bot, garden-app
    P.tap.forEach((tt, k) => add(tt, 'tap', { gain: 0.5, pitch: 1.3 + 0.2 * k, pan: panOf(tabX[2 - k]) }))
    // the card drops in on its yarn, Pip dives on
    add(P.drop0, 'slideDown', { gain: 0.3, pitch: 1.5, dur: 0.3, pan: panOf(CARD.x) })
    add(P.catch, 'twang', { gain: 0.7, pan: panOf(CARD.x) })
    add(P.catch + 0.04, 'slap', { gain: 0.26, pitch: 1.4, pan: panOf(CARD.x) })
    add(P.cardLand, 'boing', { gain: 0.4, pitch: 1.0, pan: panOf(CARD.x - 110) })
    // two card flips ("fwip") with Pip hopping seat to seat, typewriter clack under the Terminal face
    P.flip.forEach(([a, b], k) => {
      add((a + b) / 2 - 0.04, 'flip', { gain: 0.85, pitch: 1 + 0.12 * k, pan: panOf(CARD.x) })
      add(b, 'boing', { gain: 0.22, pitch: 1.7 + 0.15 * k, pan: panOf(CARD.x + (k ? -110 : 110)) })
      add(b + 0.02, 'creak', { gain: 0.16, pitch: 1.5 + 0.1 * k, dur: 0.3, pan: panOf(CARD.x) })
    })
    add(P.flip[0][1] + 0.03, 'typewriter', { gain: 0.5, dur: 0.3, pan: panOf(CARD.x) })
    // the sticky slap, Pip cheers
    add(P.slap - 0.3, 'swish', { gain: 0.38, pitch: 1.3, pan: 0.6 })
    add(P.slap, 'slap', { gain: 0.9, pan: panOf(CARD.x + 96) })
    add(P.stand0, 'boing', { gain: 0.3, pitch: 1.35, pan: panOf(CARD.x - 110) })
    add(P.stand, 'sparkle', { gain: 0.45, pan: panOf(CARD.x) })
    return out.filter((c) => c.t < dur)
  }

  PROMO.scene('s2-one-console', { draw, sfx })
})()

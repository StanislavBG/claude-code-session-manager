/* s4-night-scheduler.js — "Bedtime? The Scheduler runs the cards, checks each one, and pauses at your limit."
 * Owner: scene s45 (phase B; also owns s5-sunrise-done.js). Pure function of (t, info): every beat is derived from
 * info.wordAt / info.words / info.nextBeat on every frame, nothing is cached, randomness only through kit/prop seeds.
 *
 * ONE CONTINUOUS SET WITH s5. This file also defines window.S45 — the shared set (layout, the whole-set painter
 * drawSet(ctx, G, S) and nightEnd(G), the settled state at the end of the night) — which s5 reads (s4 loads first).
 * Everything in the set is drawn with the GLOBAL clock G = info.start + t (boil, blinks, tea sips, Zzz, walk cycles),
 * so s4's last frame and s5's first frame are the same picture continued: s4's state converges to nightEnd(G) once
 * its animations settle, and s5 starts from nightEnd(G) and only adds its own events.
 *
 * Set (stage px; key action above y ≈ 940):
 *   dusk paper sky → navy blind (drops) · moon on its thread (top left) · "paused" sign (top centre, folded up = ▶)
 *   · "Window used" gauge (top right) · conveyor "Scheduler" on two posts over the kraft "Slots" tray (5 bays,
 *   bulbs, a sticky-note helper per bay) · floor band (navy tint at night) · YOU asleep in a paper bed + alarm clock
 *   (bottom left) · Pip in a nightcap with its lantern (floor, right of centre) · laptop OPEN + lamp + mug + tag
 *   "app open = laptop stays awake" (bottom right). The architect hops onto the belt's left end at the start.
 * Beats (T.* in beats4(); fallbacks = the current VO). ONE focal point at a time:
 *   T.archIn   while the drop sheet clears: the architect hops in from the left edge onto the belt end (squash, boing).
 *   T.blind0   the blind falls and lands ON the beat inside "Bedtime?" — the only big motion under the word;
 *              everyone (Pip, the architect) looks up at it. On the landing Pip's lantern and the lamp pop on,
 *              then the moon drops on its thread (outBack bounce).
 *   T.tear0    right as "Bedtime?" ends: the architect RIPS the napkin into five index cards (nearest bay first,
 *              one rip every 0.18 s): hands jerk apart, the napkin jolts and shrinks, a fibre puff + a paper scrap
 *              fly off the torn edge, the new card sits on the edge for a frame, then is tossed onto the belt.
 *   T.sched    "Scheduler": the plaque pops, the belt winds back (anticipation) and runs (the last cards land on the
 *              moving belt); the architect waves and hops off the left edge.
 *   drop_k     "runs the cards": each card rides to its bay and tips off the belt into it (left → right, evenly
 *              spaced, first on "runs"); its bulb lights (plink up a scale), its helper pops up and hammer-taps it.
 *   T.check    "checks each one": helpers lift magnifiers one after another; on "one" the second helper crayons a
 *              green check (a tiny cheer, Pip claps); the fourth helper is puzzled (a "?" pops) — its card is the
 *              one that will need you in the morning. The gauge needle creeps all along and buzzes at the red tick.
 *   T.pause    "pauses": the sign flips down to "paused" (clack) and the helpers plop down with teacups, staggered.
 *   hush       Pip yawns and tiptoes toward the bed; T.snore: YOU snores (the quilt heaves, a big crayon Z puffs
 *              out and drifts up), Pip freezes mid-tiptoe, then creeps on to its spot (L.PIP_END_X).
 */
(function () {
  'use strict'
  const { C } = K
  const E = K.ease
  const seg = K.seg
  const lerp = K.lerp
  const clamp = K.clamp
  const clamp01 = K.clamp01

  // ───────────────────────── layout (shared with s5 through window.S45) ─────────────────────────
  const L = {
    FLOOR_TOP: 718, // torn top edge of the floor band
    GROUND: 905, // Pip / YOU / laptop ground line
    CONV: { x: 782, y: 380, w: 1270, h: 96 }, // belt centre
    POSTS: [404, 1318], // conveyor posts (stand on the tray top)
    TRAY: { x: 860, y: 628, s: 1 },
    SCHED_PLAQUE: [300, 474],
    SIGN: { x: 860, y: 88, s: 0.8 },
    GAUGE: { x: 1604, y: 408, s: 0.78 },
    MOON: { x: 604, y: -6, len: 96, r: 68 },
    SUN: { x: 1330, y: 158, r: 86 },
    BED: { x: 384, s: 0.8 },
    CLOCK: { x: 92, y: 846, s: 0.56 },
    LAPTOP: { x: 1668, y: 868, s: 0.64 },
    PIP_S: 0.66,
    HELPER_S: 0.85,
    HELPER_DX: -42, // helper ground x relative to its bay centre
    CARD_S: 0.46, // job cards (230 x 150 at scale 1 — same card as PROPS.doneStack)
    PILE: { x: 648, y: 890, s: 0.62, step: 52 }, // s5 done pile (bottom card centre; clear floor below the tray lip)
    TALLY: { x: 904, y: 850, s: 0.64 },
    ARCH: { x: 206, s: 0.9 },
    HELPER_COLORS: ['sage', 'teal', 'peach', 'mint', 'butter'],
  }
  L.BELT_TOP = L.CONV.y - L.CONV.h / 2
  L.BELT_CARD_Y = L.BELT_TOP - 150 * L.CARD_S * 0.5 - 1
  L.PITCH = (170 + 22) * L.TRAY.s
  L.BAYS = [0, 1, 2, 3, 4].map((i) => L.TRAY.x + (i - 2) * L.PITCH)
  L.BAY_TOP = L.TRAY.y - 75 * L.TRAY.s
  L.LIP_TOP = L.TRAY.y + 45 * L.TRAY.s
  L.FLOOR = L.TRAY.y + 59 * L.TRAY.s // helpers' ground point inside the bays
  L.TRAY_TOP = L.TRAY.y - 103 * L.TRAY.s
  L.TRAY_BOTTOM = L.TRAY.y + 103 * L.TRAY.s
  L.HX = L.BAYS.map((b) => b + L.HELPER_DX) // helper ground x per bay
  // the helper's 'check' crayons at (76, -44) × scale from its ground point: the card sits right there
  L.CARD_X = L.HX.map((h) => h + 76 * L.HELPER_S)
  L.CARD_Y = L.FLOOR - 44 * L.HELPER_S
  // belt travel: card k starts at CARD_X[k] - D[k] and tips into bay k when the belt has moved D[k]
  L.D = [0, 1, 2, 3, 4].map((k) => 180 + 72 * k)
  L.BELT_START = L.CARD_X.map((x, k) => x - L.D[k])
  L.D_TOTAL = L.D[4]
  L.NIGHT_CHECKED = 1 // this bay's card is finished during the night
  L.NEEDS_YOU = 3 // this bay's card comes back in the morning as the pink "Needs you" note
  L.PIP_END_X = 1130 // where Pip stands when the night ends (s5 catches the note here)
  L.ARCH_Y = L.BELT_TOP + 2 // the architect's feet on the belt's left end
  // napkin centre in the architect's hands (tear pose grip (0,-86) + the napkin's 26 px drop, × scale)
  L.NAPKIN = [L.ARCH.x, L.ARCH_Y - 60 * L.ARCH.s]
  L.NAPKIN_SIZE = 108

  // ───────────────────────── tiny helpers ─────────────────────────
  const bump = (t, a, b) => Math.sin(Math.PI * seg(t, a, b))
  const wob = (t, t0, amp, f = 18, d = 7) => (t < t0 ? 0 : amp * Math.exp(-d * (t - t0)) * Math.sin(f * (t - t0)))
  const qarc = (a, b, lift, p) => {
    const c = [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - lift]
    const u = 1 - p
    return [u * u * a[0] + 2 * u * p * c[0] + p * p * b[0], u * u * a[1] + 2 * u * p * c[1] + p * p * b[1]]
  }
  const panOf = (x) => clamp((x / K.W) * 1.6 - 0.8, -0.8, 0.8)
  /** End time (local) of a spoken word, from info.words; fallback when missing. */
  const wordEnd = (info, word, fb, nth = 0) => {
    const ws = (info.words || []).filter((w) => String(w.word).replace(/[^a-z']/g, '') === word)
    return ws[nth] ? ws[nth].end : fb
  }
  /** Belt travel profile: linear with 12 % slow-in / slow-out (constant speed while cards tip off). */
  function slin(u) {
    const a = 0.12
    const k = 1 / (1 - a)
    if (u <= 0) return 0
    if (u >= 1) return 1
    if (u < a) return (k * u * u) / (2 * a)
    if (u > 1 - a) return 1 - (k * (1 - u) * (1 - u)) / (2 * a)
    return k * (u - a / 2)
  }

  // ───────────────────────── art pieces owned by this set ─────────────────────────
  /** One job card: the same ruled index card as PROPS.doneStack (230 x 150 at scale 1), torn top edge.
   *  o: scale, rot, sq (squash y), checked 0..1 (green crayon check, drawn where the helper's check lands),
   *  id, lift, alpha. (x, y) = card centre. */
  function jobCard(ctx, x, y, t, o = {}) {
    const s = o.scale === undefined ? L.CARD_S : o.scale
    const sq = o.sq === undefined ? 1 : o.sq
    const id = o.id || 'job'
    const w = 230
    const h = 150
    K.at(ctx, x, y, o.rot || 0, [s * (1 + (1 - sq) * 0.6), s * sq], () => {
      const body = [[-w / 2, -h / 2 + 6], [-w / 4, -h / 2], [0, -h / 2 + 5], [w / 4, -h / 2 + 1], [w / 2, -h / 2 + 5], [w / 2, h / 2], [-w / 2, h / 2]]
      K.paper(ctx, body, C.paperWhite, { torn: 3, seed: id, shadow: 1, lift: o.lift || 2 })
      ctx.save()
      ctx.strokeStyle = 'rgba(134,194,227,0.6)'
      ctx.lineWidth = 2.4
      ctx.beginPath()
      for (let k = 1; k <= 4; k++) {
        ctx.moveTo(-w / 2 + 8, -h / 2 + 16 + k * 26)
        ctx.lineTo(w / 2 - 8, -h / 2 + 16 + k * 26)
      }
      ctx.stroke()
      ctx.strokeStyle = 'rgba(184,92,52,0.6)'
      ctx.beginPath()
      ctx.moveTo(-w / 2 + 28, -h / 2 + 8)
      ctx.lineTo(-w / 2 + 28, h / 2 - 4)
      ctx.stroke()
      // checkbox scribbles (plain canvas: cheap, boils with t)
      const b = K.boil(t)
      const r = K.rng(id, 'sc', b)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (let k = 0; k < 3; k++) {
        const ry = -h / 2 + 34 + k * 30
        ctx.strokeStyle = C.inkDim
        ctx.lineWidth = 4
        ctx.strokeRect(-w / 2 + 38 + (r() - 0.5) * 2, ry - 10, 18, 18)
        ctx.strokeStyle = C.inkFaint
        ctx.lineWidth = 4.5
        ctx.beginPath()
        const x0 = -w / 2 + 68
        const wl = 70 + ((K.hash(id, k) % 50) | 0)
        ctx.moveTo(x0, ry)
        ctx.quadraticCurveTo(x0 + wl * 0.3, ry - 7 + (r() - 0.5) * 3, x0 + wl * 0.55, ry + 1)
        ctx.quadraticCurveTo(x0 + wl * 0.8, ry + 6, x0 + wl, ry - 2 + (r() - 0.5) * 3)
        ctx.stroke()
      }
      ctx.restore()
    })
    const ck = o.checked || 0
    if (ck > 0) {
      // the helper's crayon path, mirrored into card space: C0 = card centre (card centre == helper's C0)
      const hs = L.HELPER_S * (s / L.CARD_S)
      const pth = [[-14, -2], [-4, 10], [18, -18]].map(([px, py]) => [px * hs, py * hs])
      K.at(ctx, x, y, o.rot || 0, 1, () => {
        const p = ck
        const pts = [pth[0]]
        if (p < 0.35) pts.push([lerp(pth[0][0], pth[1][0], p / 0.35), lerp(pth[0][1], pth[1][1], p / 0.35)])
        else {
          pts.push(pth[1])
          pts.push([lerp(pth[1][0], pth[2][0], (p - 0.35) / 0.65), lerp(pth[1][1], pth[2][1], (p - 0.35) / 0.65)])
        }
        K.rc(ctx).linearPath(pts, K.ro(id + 'ck', t, { stroke: C.crayonGreen, strokeWidth: 6 * (hs / 0.7), roughness: 0.9, bowing: 0.4 }))
        K.rc(ctx).linearPath(pts, K.ro(id + 'ck2', t, { stroke: '#4fae45', strokeWidth: 2.5 * (hs / 0.7), roughness: 1.2, bowing: 0.6 }))
      })
    }
  }
  /** Cream marker plaque with two washi corners (matches the props' plaques); pop = scale 0..1+. */
  function plaque(ctx, text, x, y, t, id, pop = 1, o = {}) {
    if (pop <= 0.01) return
    const size = o.size || 48
    K.font(ctx, 'marker', size)
    const w = ctx.measureText(text).width + 56
    const h = size * 1.28
    K.at(ctx, x, y, o.rot || -0.015, pop, () => {
      K.paper(ctx, K.boxPts(w, h), C.cream, { seed: id + 'pl', cut: 2, shadow: 0.95, lift: 2 })
      K.hand(ctx, text, 0, size * 0.33, { family: 'marker', size, color: C.ink, t, id: id + 'plt', jitter: 0.6 })
      K.tape(ctx, -w / 2 + 6, -h / 2 + 6, 58, -0.72, 'rgba(232,169,136,0.9)', { h: 22, seed: id + 'pt1' })
      K.tape(ctx, w / 2 - 6, -h / 2 + 6, 58, 0.72, 'rgba(232,169,136,0.9)', { h: 22, seed: id + 'pt2' })
    })
  }
  /** A kraft post from the belt down to the tray top. */
  function post(ctx, x, t, id) {
    const y0 = L.CONV.y + 20
    const y1 = L.TRAY_TOP + 6
    K.paper(ctx, [[x - 13, y0], [x + 13, y0], [x + 17, y1], [x - 17, y1]], C.kraftDark, { cut: 1, seed: id, shadow: 0.8 })
    K.paper(ctx, K.roundRectPts(x - 30, y1 - 8, 60, 14, 6), C.inkDim, { cut: 0.6, seed: id + 'f', shadow: 0.6 })
  }
  /** Morning hills (behind the floor band). */
  const HILLS = [[-60, 650], [220, 604], [520, 640], [860, 596], [1180, 634], [1500, 590], [1980, 628], [1980, 780], [-60, 780]]
  const HILL_RIM = (() => {
    const r = K.rng('s45hillrim')
    const pts = []
    const top = HILLS.slice(0, 7)
    for (let j = 0; j < top.length - 1; j++) {
      const [x0, y0] = top[j]
      const [x1, y1] = top[j + 1]
      const n = Math.ceil((x1 - x0) / 14)
      for (let i = 0; i < n; i++) {
        const f = i / n
        const e = f * f * (3 - 2 * f) // rounded hill tops
        pts.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * e, (r() - 0.5) * 5])
      }
    }
    pts.push([top[top.length - 1][0], top[top.length - 1][1], 0])
    return pts
  })()
  const HILL_FILL = HILL_RIM.map(([x, y]) => [x, y]).concat([[1980, 780], [-60, 780]])
  const CLOUDS = [[250, 150, 1], [560, 250, 0.62], [1060, 250, 0.72], [1760, 560, 0.55]]
  const CLOUD_PTS = (() => {
    const pts = []
    const bumps = [[-80, 0, 46], [-30, -26, 52], [30, -20, 46], [78, 2, 40]]
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2
      let best = 0
      for (const [bx, by, br] of bumps) {
        // furthest point of the bump union along this ray from the centre
        const dx = Math.cos(a)
        const dy = Math.sin(a)
        const b = bx * dx + by * dy
        const c = bx * bx + by * by - br * br
        const disc = b * b - c
        if (disc >= 0) best = Math.max(best, b + Math.sqrt(disc))
      }
      pts.push([Math.cos(a) * best, Math.min(22, Math.sin(a) * best)])
    }
    return pts
  })()
  const FLOOR_PTS = (() => {
    const pts = []
    for (let i = 0; i <= 16; i++) pts.push([-80 + (i / 16) * 2080, L.FLOOR_TOP + ((i * 37) % 11) - 5])
    pts.push([2000, 1160], [-80, 1160])
    return pts
  })()
  const FLOOR_RIM = (() => {
    const r = K.rng('s45rim')
    const pts = []
    for (let i = 0; i <= 150; i++) {
      const x = -60 + (i / 150) * 2040
      // follow the floor's top edge (linear between FLOOR_PTS vertices) with small torn jags
      const u = ((x + 80) / 2080) * 16
      const j = Math.min(15, Math.floor(u))
      const f = u - j
      const y = lerp(FLOOR_PTS[j][1], FLOOR_PTS[j + 1][1], f)
      pts.push([x, y - 2 + (r() - 0.5) * 5])
    }
    return pts
  })()
  /** Crayon "?" doodle (bay 3's puzzled helper). */
  function question(ctx, x, y, t, p, id) {
    if (p <= 0) return
    K.at(ctx, x, y, 0.12 * Math.sin(t * 5), E.outBack(clamp01(p)), () => {
      K.hand(ctx, '?', 0, 0, { family: 'chunky', size: 46, color: C.paperWhite, t, id: id + 'q', jitter: 0.8, weight: '600', outline: C.ink, outlineW: 7 })
    })
  }
  /** A tiny torn paper scrap (napkin fibre) — the "rip" leftover that tumbles off the torn edge. */
  const SCRAP = [[-9, -4], [-3, -6], [2, -3], [8, -5], [9, 3], [3, 5], [-4, 3], [-8, 5]]
  function scrap(ctx, x, y, rot, a, id) {
    if (a <= 0.01) return
    K.withAlpha(ctx, a, () => K.at(ctx, x, y, rot, 1, () => K.paper(ctx, SCRAP, C.paperWhite, { cut: 0.8, seed: id, shadow: 0.6, stroke: 'rgba(42,34,26,0.5)' })))
  }
  /** Big crayon "Z" (the one snore) — butter crayon with an ink outline so it reads on navy. */
  function bigZ(ctx, x, y, t, s, a, id) {
    if (a <= 0.01 || s <= 0.01) return
    const pts = [[-22, -20], [22, -20], [-22, 20], [22, 20]]
    K.withAlpha(ctx, a, () => K.at(ctx, x, y, -0.12, s, () => {
      K.rc(ctx).linearPath(pts, K.ro(id + 'o', t, { stroke: C.ink, strokeWidth: 12, roughness: 0.7, bowing: 0.3 }))
      K.rc(ctx).linearPath(pts, K.ro(id + 'z', t, { stroke: C.moon, strokeWidth: 7, roughness: 0.9, bowing: 0.3 }))
    }))
  }

  // ───────────────────────── the whole set ─────────────────────────
  /**
   * drawSet(ctx, G, S) — paint the set at global time G from the state S (see nightEnd for every field).
   * Pure: S is built fresh every frame by the scene from its own beats.
   */
  function drawSet(ctx, G, S) {
    const P = window.PROPS
    const cam = S.cam || { dx: 0, dy: 0 }
    // ── sky (moves least during a camera move) ──
    K.at(ctx, Math.round(-0.35 * cam.dx), Math.round(-0.35 * cam.dy), 0, 1, () => {
      if (S.blind.drop < 0.999 || S.sky === 'morning') {
        if (S.sky === 'morning') {
          K.backdrop(ctx, '#a9d4ea')
          if (S.sun && S.sun.rise > 0) P.paperSun(ctx, L.SUN.x, L.SUN.y, G, { r: L.SUN.r, rise: S.sun.rise, face: S.sun.face, ease: S.sun.ease || 'outBack', look: S.sun.look, dist: 600, horizon: 650, id: 's5sun' })
          CLOUDS.forEach(([cx, cy, cs], i) => K.at(ctx, cx + 14 * Math.sin(G * 0.35 + i * 2), cy, 0, cs, () => K.paper(ctx, CLOUD_PTS, C.paperWhite, { cut: 3, seed: 's45cloud' + i, shadow: 0.7 })))
          // scissor-cut hills + a hand-drawn fibre rim (a torn full-width sheet costs ~100 ms)
          K.paper(ctx, HILL_FILL, C.grass, { cut: 0, seed: 's45hill', shadow: 0 })
          ctx.save()
          ctx.beginPath()
          HILL_RIM.forEach(([hx, hy, j], i) => (i ? ctx.lineTo(hx, hy - 2 + j) : ctx.moveTo(hx, hy - 2 + j)))
          ctx.lineWidth = 5
          ctx.lineJoin = 'round'
          ctx.strokeStyle = 'rgba(255,250,240,0.8)'
          ctx.stroke()
          ctx.restore()
        } else {
          K.backdrop(ctx, '#c9b0d6')
          CLOUDS.forEach(([cx, cy, cs], i) => K.at(ctx, cx + 14 * Math.sin(G * 0.35 + i * 2), cy, 0, cs, () => K.paper(ctx, CLOUD_PTS, i % 2 ? C.peach : '#f3c7b0', { cut: 3, seed: 's45cloud' + i, shadow: 0.6 })))
        }
      }
      P.nightBlind(ctx, 0, 0, G, { drop: S.blind.drop, ease: S.blind.ease, id: 's45blind', constellations: [[150, 40], [1060, 34]], stars: 84 })
      if (S.moon.show) P.moonOnThread(ctx, L.MOON.x, L.MOON.y, G, { drop: S.moon.drop, ease: S.moon.ease, angle: S.moon.angle, len: L.MOON.len, r: L.MOON.r, id: 's45moon', swing: S.moon.swing === undefined ? 1 : S.moon.swing })
      P.hangingSign(ctx, L.SIGN.x, L.SIGN.y, G, { flip: S.sign.flip, ease: S.sign.ease || 'sign', rock: S.sign.rock, scale: L.SIGN.s, len: 44, id: 's45sign' })
      P.gauge(ctx, L.GAUGE.x, L.GAUGE.y, G, { value: S.gauge.value, scale: L.GAUGE.s, id: 's45gauge' })
    })
    // ── floor band ──
    // (a torn full-width sheet costs ~100 ms here — scissor-cut fill + a hand-drawn white fibre rim instead)
    const floorShape = K.paper(ctx, FLOOR_PTS, C.kraftLight, { cut: 2.5, seed: 's45floor', shadow: 0 })
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(FLOOR_RIM[0][0], FLOOR_RIM[0][1])
    for (let i = 1; i < FLOOR_RIM.length; i++) ctx.lineTo(FLOOR_RIM[i][0], FLOOR_RIM[i][1])
    ctx.lineWidth = 5
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(255,250,240,0.85)'
    ctx.stroke()
    ctx.translate(0, 5)
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(58,36,14,0.12)'
    ctx.stroke()
    ctx.restore()
    if (S.night > 0) {
      ctx.save()
      K.pathPoly(ctx, floorShape)
      ctx.fillStyle = `rgba(22,30,52,${0.72 * S.night})`
      ctx.fill()
      ctx.restore()
    }
    // warm light pools on the night floor: the lamp by the laptop and Pip's antenna lantern
    if (S.night > 0.02) {
      const pool = (x, y, rx, ry, a) => {
        if (a <= 0.01) return
        ctx.save()
        ctx.translate(x, y)
        ctx.scale(1, ry / rx)
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
        g.addColorStop(0, `rgba(255,214,130,${a})`)
        g.addColorStop(1, 'rgba(255,214,130,0)')
        ctx.fillStyle = g
        ctx.fillRect(-rx, -rx, rx * 2, rx * 2)
        ctx.restore()
      }
      pool(L.LAPTOP.x - 20, L.LAPTOP.y + 4, 330, 70, 0.2 * S.night * (S.laptop.lampOn || 0))
      pool(S.pip.x, L.GROUND + 2, 150, 34, 0.26 * S.night * (S.pip.o.lantern || 0))
    }
    // ── machinery ──
    for (const [i, x] of L.POSTS.entries()) post(ctx, x, G, 's45post' + i)
    P.conveyor(ctx, L.CONV.x, L.CONV.y, G, { w: L.CONV.w, h: L.CONV.h, offset: S.belt.offset, label: '', legs: false, id: 's45belt' })
    plaque(ctx, 'Scheduler', L.SCHED_PLAQUE[0], L.SCHED_PLAQUE[1], G, 's45sched', S.schedPop)
    // riders on the belt, then the architect, then cards leaving the napkin (in front of it) + the rip fibres
    S.cards.forEach((c, k) => {
      if (c.mode === 'belt') jobCard(ctx, c.x, c.y, G, { rot: c.rot, scale: c.s, sq: c.sq, id: 's45card' + k, lift: 2 })
    })
    if (S.arch) drawArchitect(ctx, G, S.arch)
    S.cards.forEach((c, k) => {
      if (c.mode === 'fly') jobCard(ctx, c.x, c.y, G, { rot: c.rot, scale: c.s, sq: c.sq, id: 's45card' + k, lift: c.lift === undefined ? 10 : c.lift })
    })
    if (S.rips) {
      for (const r of S.rips) {
        if (r.puff > 0 && r.puff < 1) P.doodlePuff(ctx, r.x, r.y, G, { p: r.puff, r: 24, id: 's45rip' + r.j })
        scrap(ctx, r.sx, r.sy, r.srot, r.sa, 's45scrap' + r.j)
        if (r.tick > 0) K.withAlpha(ctx, r.tick, () => K.sparkle(ctx, r.x, r.y, 20, 's45fib' + r.j, G, { n: 3, w: 2.6, color: C.paperWhite }))
      }
    }
    // tray: back → bay contents (falling / parked cards, helpers) → front
    P.slotBoxes(ctx, L.TRAY.x, L.TRAY.y, G, { part: 'back', lit: S.lit, scale: L.TRAY.s, label: '', id: 's45slots' })
    S.cards.forEach((c, k) => {
      if (c.mode === 'fall' || c.mode === 'bay') jobCard(ctx, c.x, c.y, G, { rot: c.rot, scale: c.s, sq: c.sq, checked: c.checked, id: 's45card' + k })
    })
    S.helpers.forEach((h, k) => drawHelper(ctx, G, h, k))
    P.slotBoxes(ctx, L.TRAY.x, L.TRAY.y, G, { part: 'front', lit: S.lit, scale: L.TRAY.s, label: '', id: 's45slots' })
    plaque(ctx, 'Slots', L.TRAY.x, L.TRAY_BOTTOM + 30, G, 's45slotsP', S.slotsPop, { size: 42, rot: 0.012 })
    S.helpers.forEach((h, k) => question(ctx, L.HX[k] + 4, L.BAY_TOP + 8, G, h.q || 0, 's45q' + k))
    // cards leaving the bays for the pile (s5) fly in front of the tray
    S.cards.forEach((c, k) => {
      if (c.mode === 'toPile') jobCard(ctx, c.x, c.y, G, { rot: c.rot, scale: c.s, sq: c.sq, checked: c.checked, id: 's45card' + k, lift: 12 })
    })
    // ── bedside, left ──
    P.alarmClock(ctx, L.CLOCK.x, L.CLOCK.y, G, { ring: S.clock.ring, scale: L.CLOCK.s, id: 's45clock', arcColor: S.night > 0.5 ? C.moon : C.ink })
    // the one snore: the whole bed heaves (a stop-motion swell anchored on the floor)
    const heave = S.heave || 0
    K.at(ctx, L.BED.x, L.GROUND, 0, heave ? [1 + 0.012 * heave, 1 + 0.045 * heave] : 1, () => {
      const ya = CAST.you(ctx, 0, 0, G, Object.assign({ inBed: true, scale: L.BED.s, id: 's45you' }, S.you))
      if (S.bigZ && ya && ya.zzz) {
        const z = S.bigZ
        bigZ(ctx, ya.zzz[0] + z.dx, ya.zzz[1] + z.dy, G, z.s, z.a, 's45bigZ') // anchors are in this K.at frame
      }
    })
    if (S.extra) S.extra(ctx, 'beforeLaptop')
    // ── bedside, right ──
    P.laptop(ctx, L.LAPTOP.x, L.LAPTOP.y, G, { scale: L.LAPTOP.s, lampOn: S.laptop.lampOn, glow: S.laptop.glow, lampSide: 'right', tagSide: 'below', tagSize: 46, id: 's45laptop' })
    // ── s5 extras ──
    if (S.pile && S.pile.n > 0) P.doneStack(ctx, L.PILE.x, L.PILE.y, G, { n: S.pile.n, stamped: S.pile.stamped, scale: L.PILE.s, step: L.PILE.step, id: 's45pile' })
    if (S.tally) {
      const tp = S.tally
      K.at(ctx, 0, 0, 0, 1, () => P.tally(ctx, L.TALLY.x, L.TALLY.y, G, { p: tp.p, count: 4, scale: L.TALLY.s * (tp.pop === undefined ? 1 : tp.pop), id: 's45tally', rot: -0.02 }))
    }
    if (S.extra) S.extra(ctx, 'beforePip')
    PIP.draw(ctx, S.pip.x, L.GROUND + (S.pip.y || 0), G, S.pip.o)
    if (S.extra) S.extra(ctx, 'afterPip')
  }

  function drawArchitect(ctx, G, A) {
    // CAST.agent always draws a floor contact shadow at its ground point: clip it away while airborne
    ctx.save()
    if (A.air) {
      ctx.beginPath()
      ctx.rect(A.x - 400, A.y - 800, 800, 800 - 6)
      ctx.clip()
    }
    const hold = A.napkin > 0.05
      ? (g) => window.PROPS.napkin(g, 0, 26, G, { size: L.NAPKIN_SIZE * A.napkin, rot: A.napRot || 0, id: 's45napkin', doodle: 1, jitter: 0.5, shadow: 0.8 })
      : null
    const sq = A.sq === undefined ? 1 : A.sq
    K.at(ctx, A.x, A.y, 0, sq === 1 ? 1 : [1 + (1 - sq) * 0.7, sq], () => {
      CAST.agent(ctx, 0, 0, G, { kind: 'architect', pose: A.pose, poseT: A.poseT, scale: L.ARCH.s * (A.s || 1), rot: A.rot || 0, mirror: !!A.mirror, look: A.look, hold, id: 's45arch' })
    })
    ctx.restore()
  }

  function drawHelper(ctx, G, h, k) {
    if (!h || h.show <= 0) return
    const bx = L.BAYS[k]
    const dy = (1 - h.show) * 90 + (h.dy || 0) + (h.pose === 'tea' || h.pose === 'sit' ? -24 : 0)
    ctx.save()
    ctx.beginPath()
    ctx.rect(bx - L.PITCH / 2 - 4, L.BAY_TOP - 140, L.PITCH + 8, L.LIP_TOP + 8 - (L.BAY_TOP - 140))
    ctx.clip()
    CAST.helper(ctx, L.HX[k], L.FLOOR + dy, G, {
      pose: h.pose,
      poseT: h.poseT,
      color: L.HELPER_COLORS[k],
      scale: L.HELPER_S,
      look: h.look,
      id: 's45helper' + k,
    })
    ctx.restore()
  }

  // ───────────────────────── the settled end-of-night state ─────────────────────────
  /** Every field drawSet reads, as it stands once the night has settled (s4's end == s5's start). */
  function nightEnd(G) {
    const cards = [0, 1, 2, 3, 4].map((k) => ({ mode: 'bay', x: L.CARD_X[k], y: L.CARD_Y, rot: (k % 2 ? 0.035 : -0.03), s: L.CARD_S, sq: 1, checked: k === L.NIGHT_CHECKED ? 1 : 0 }))
    const helpers = [0, 1, 2, 3, 4].map((k) => ({ show: 1, pose: 'tea', poseT: G + 0.53 * k, look: null, q: 0 }))
    return {
      sky: 'dusk',
      cam: { dx: 0, dy: 0 },
      blind: { drop: 1, ease: 'blind' },
      moon: { show: true, drop: 1, ease: 'outBack', angle: 0 },
      sun: null,
      sign: { flip: 1, rock: 1 },
      gauge: { value: 0.9 },
      belt: { offset: L.D_TOTAL },
      schedPop: 1,
      slotsPop: 1,
      lit: [1, 1, 1, 1, 1],
      cards,
      helpers,
      arch: null,
      rips: null,
      heave: 0,
      bigZ: null,
      you: { pose: 'sleep', poseT: G, zzz: true, bedFlat: 0 },
      clock: { ring: 0 },
      laptop: { lampOn: 1, glow: 1 },
      night: 1,
      pile: null,
      tally: null,
      pip: { x: L.PIP_END_X, y: 0, o: { scale: L.PIP_S, pose: 'idle', poseT: G, flip: true, nightcap: true, lantern: 0.92 + 0.08 * Math.sin(G * 5.3), look: [-0.6, 0.1], id: 's45pip' } },
    }
  }

  window.S45 = { L, drawSet, nightEnd, jobCard, plaque, bump, wob, qarc, panOf, wordEnd }

  // ───────────────────────── s4 clock ─────────────────────────
  function beats4(info, dur) {
    const w = (word, fb) => (info.wordAt ? info.wordAt(word, fb) : fb)
    const nb = (x) => (info.nextBeat ? info.nextBeat(x) : x)
    const T = {}
    // the architect hops in while the drop sheet clears, and has landed before the blind starts
    T.archIn = [0.0, 0.34]
    T.bed = w('bedtime', 0.6)
    T.bedEnd = wordEnd(info, 'bedtime', T.bed + 0.76)
    // the blind falls right as the drop transition clears and lands on the beat inside "Bedtime?"
    T.blindLand = nb(T.bed + 0.18)
    T.blindDur = 1.0
    T.blind0 = Math.max(0.36, T.blindLand - 0.55 * T.blindDur)
    T.blindLand = T.blind0 + 0.55 * T.blindDur
    T.lantern = T.blindLand + 0.04
    T.moon0 = T.blindLand + 0.04
    T.moonDur = 0.62
    // the tear run starts as "Bedtime?" ends (after the moon has bounced), one rip every 0.18 s, nearest bay first
    T.tearGap = 0.18
    T.tear0 = Math.max(T.moon0 + 0.3, T.bedEnd - 0.02)
    T.tears = [0, 1, 2, 3, 4].map((j) => T.tear0 + T.tearGap * j)
    T.tearHold = 0.07 // the new card sits on the napkin's torn edge for one frame
    T.cardFly = 0.34
    T.sched = w('scheduler', 1.92)
    T.beltGo = T.sched + 0.04
    T.run = w('runs', 2.44)
    // belt: first card tips off on "runs", the last one lands by "checks"
    const f0 = slin(L.D[0] / L.D_TOTAL)
    T.beltEnd = T.beltGo + (T.run + 0.05 - T.beltGo) / Math.max(0.2, f0 * 0.98)
    T.check = w('checks', 3.33)
    T.one = w('one', 3.96)
    T.pause = w('pauses', 4.48)
    T.limit = w('limit', 5.26)
    T.voEnd = info.voEnd || 5.68
    T.fall = 0.34
    // drop time of card k: invert the belt profile (bisection; pure)
    T.drops = L.D.map((d) => {
      let a = 0
      let b = 1
      for (let i = 0; i < 24; i++) {
        const m = (a + b) / 2
        if (slin(m) * L.D_TOTAL < d) a = m
        else b = m
      }
      return T.beltGo + ((a + b) / 2) * (T.beltEnd - T.beltGo)
    })
    T.lands = T.drops.map((d) => d + T.fall)
    T.pops = T.lands.map((l) => l + 0.04)
    T.nightCheck = T.one - 0.1 // bay 1's crayon starts at poseT 0.12 → lands on "one"
    // hammer strikes land at pop + 0.17 + 0.5 n; magnifiers come up across "checks each one" (2 taps where there's room)
    T.mags = T.pops.map((p, k) => (k === L.NIGHT_CHECKED ? T.nightCheck : Math.max(p + 0.4, Math.min(p + 0.78, T.one - 0.3 + 0.1 * k))))
    T.q = Math.max(T.mags[L.NEEDS_YOU] + 0.15, T.one + 0.12) // the puzzled "?" lands between "one" and "pauses"
    // the sign lands (60 % of its fall) at the start of "pauses"; the gauge hits the red tick just before
    T.signDur = 0.46
    T.sign0 = T.pause + 0.06 - 0.6 * T.signDur
    T.gaugeHit = T.sign0 - 0.08
    T.teas = [0, 1, 2, 3, 4].map((k) => T.pause + 0.16 + 0.09 * [2, 0, 3, 1, 4][k])
    T.archWave = T.tears[4] + 0.12
    T.archExit = Math.max(T.archWave + 0.26, T.sched + 0.1)
    T.archExitDur = 0.46
    T.snore = Math.max(T.voEnd + 0.12, T.limit + 0.4)
    // Pip: a patrol along the tray while the cards run, a yawn after the teacups, then the tiptoe to its spot
    T.pipWalk1 = T.tears[4] + 0.16
    T.yawn = [Math.max(...T.teas) + 0.02, Math.max(...T.teas) + 0.42]
    T.tip = [T.yawn[1] + 0.02, T.snore, T.snore + 0.34, Math.min(dur - 0.28, T.snore + 0.9)] // tiptoe · freeze · tiptoe (settled before the cut)
    T.dur = dur
    return T
  }

  function stateAt(t, dur, info) {
    const T = beats4(info, dur)
    const G = (info.start || 0) + t
    const S = nightEnd(G)
    S.cam = info.camShift ? info.camShift(t) : { dx: 0, dy: 0 }
    // ── sky ──
    S.blind = { drop: seg(t, T.blind0, T.blind0 + T.blindDur), ease: 'blind' }
    S.moon.drop = seg(t, T.moon0, T.moon0 + T.moonDur)
    S.moon.show = t > T.moon0
    S.sign = { flip: seg(t, T.sign0, T.sign0 + T.signDur), ease: 'sign', rock: 1 }
    S.night = E.inOutQuad(seg(t, T.blind0 + 0.1, T.blindLand + 0.1))
    S.laptop.lampOn = E.outBack(seg(t, T.lantern + 0.02, T.lantern + 0.24))
    S.laptop.glow = lerp(0.55, 1, seg(t, T.blind0, T.blindLand))
    // ── belt ──
    const prog = slin(seg(t, T.beltGo, T.beltEnd))
    S.belt.offset = L.D_TOTAL * prog - 9 * bump(t, T.beltGo - 0.2, T.beltGo + 0.02)
    S.schedPop = t < T.sched - 0.02 ? 1 : 1 + 0.28 * Math.sin(Math.PI * seg(t, T.sched - 0.02, T.sched + 0.22)) + wob(t, T.sched + 0.22, 0.05, 20, 9)
    S.slotsPop = E.outBack(seg(t, T.lands[0] - 0.05, T.lands[0] + 0.25))
    // gauge creeps with the work, buzzes at the tick
    const gp = E.inOutQuad(seg(t, T.beltGo, T.gaugeHit))
    const steps = T.lands.reduce((a, l) => a + 0.012 * bump(t, l, l + 0.18), 0)
    S.gauge.value = 0.07 + 0.83 * gp + steps + wob(t, T.gaugeHit, 0.035, 26, 6)
    // ── the napkin: shrinks by a fifth on every rip, jolts (alternating) as it tears ──
    const ripsDone = T.tears.filter((x) => t >= x).length
    const napRem = 1 - ripsDone / 5
    const napRot = T.tears.reduce((a, x, j) => a + wob(t, x, 0.16 * (j % 2 ? -1 : 1), 30, 11), 0)
    const napScale = napRem * (1 - 0.1 * T.tears.reduce((a, x) => a + bump(t, x - 0.05, x + 0.07), 0))
    const napC = [L.NAPKIN[0], L.NAPKIN[1]]
    const napEdge = (rem) => [napC[0] + 30 * rem + 12, napC[1] - 6]
    // ── cards ──
    const beltX = (k) => L.BELT_START[k] + S.belt.offset
    S.rips = []
    S.cards = [0, 1, 2, 3, 4].map((k) => {
      const tk = T.tears[k] // nearest bay's card is torn first; it drops first too
      const launch = tk + T.tearHold
      const land = launch + T.cardFly
      const c = { mode: 'hidden', x: 0, y: 0, rot: 0, s: L.CARD_S, sq: 1, checked: 0 }
      if (t < tk) return c
      const edge = napEdge(1 - k / 5)
      // rip fx: fibre ticks for two frames, a little puff, a scrap that tumbles off the torn edge
      const sp = seg(t, tk, tk + 0.55)
      if (sp < 1) {
        S.rips.push({
          j: k,
          x: edge[0] - 6,
          y: edge[1] + 4,
          puff: seg(t, tk, tk + 0.42),
          tick: t < tk + 0.14 ? 1 : 0,
          sx: edge[0] - 10 - 26 * sp,
          sy: edge[1] + 10 + 30 * sp + 150 * sp * sp,
          srot: 5 * sp * (k % 2 ? -1 : 1),
          sa: 1 - seg(sp, 0.65, 1),
        })
      }
      if (t < launch) return Object.assign(c, { mode: 'fly', x: edge[0] + 10, y: edge[1] - 2, rot: -0.42, s: 0.24, lift: 3 })
      if (t < land) {
        const p = seg(t, launch, land)
        const to = [beltX(k), L.BELT_CARD_Y]
        const pe = 0.45 * p + 0.55 * E.inOutQuad(p) // gentle start, no hard ease-out: it's a toss
        const at = qarc([edge[0] + 10, edge[1] - 2], to, 70 + 16 * k, pe)
        const base = k % 2 ? 0.02 : -0.015
        return Object.assign(c, { mode: 'fly', x: at[0], y: at[1], rot: lerp(-0.42, base, pe) + (k % 2 ? -1 : 1) * 0.8 * Math.sin(Math.PI * pe), s: lerp(0.24, L.CARD_S, E.outCubic(p)) })
      }
      if (t < T.drops[k]) {
        const riding = t > T.beltGo
        const bob = riding ? 1.6 * Math.sin((beltX(k) / 34) * Math.PI) : 0
        return Object.assign(c, { mode: 'belt', x: beltX(k), y: L.BELT_CARD_Y - Math.abs(bob) + 2 * bump(t, land, land + 0.12), rot: wob(t, land, 0.1, 22, 9) + (k % 2 ? 0.02 : -0.015) + wob(t, T.beltGo, 0.05, 20, 8), sq: 1 - 0.16 * bump(t, land, land + 0.14) })
      }
      const p = seg(t, T.drops[k], T.lands[k])
      if (p < 1) {
        const x = L.CARD_X[k]
        const y = lerp(L.BELT_CARD_Y, L.CARD_Y, Math.pow(p, 1.7)) - 22 * bump(p, 0, 0.4)
        return Object.assign(c, { mode: 'fall', x: x + 6 * bump(p, 0, 0.5), y, rot: -0.45 * Math.sin(Math.PI * p) + (k % 2 ? 0.035 : -0.03) * p })
      }
      return Object.assign(c, { mode: 'bay', x: L.CARD_X[k], y: L.CARD_Y, rot: (k % 2 ? 0.035 : -0.03) + wob(t, T.lands[k], 0.12, 24, 9), sq: 1 - 0.2 * bump(t, T.lands[k], T.lands[k] + 0.16), checked: k === L.NIGHT_CHECKED && t > T.nightCheck + 0.62 ? 1 : 0 })
    })
    S.lit = T.lands.map((l) => E.outCubic(seg(t, l, l + 0.14)))
    // ── helpers ──
    S.helpers = [0, 1, 2, 3, 4].map((k) => {
      const pop = T.pops[k]
      const h = { show: E.outBack(seg(t, pop, pop + 0.26)), pose: 'idle', poseT: G, look: [0.8, 0.2], q: 0 }
      if (t < pop) return Object.assign(h, { show: 0 })
      if (t >= T.teas[k]) return Object.assign(h, { pose: 'tea', poseT: G + 0.53 * k, look: null, q: k === L.NEEDS_YOU ? 1 - seg(t, T.teas[k] + 0.3, T.teas[k] + 0.55) : 0, dy: -5 * bump(t, T.teas[k], T.teas[k] + 0.12) })
      if (k === L.NIGHT_CHECKED && t >= T.nightCheck) {
        if (t < T.nightCheck + 0.62) return Object.assign(h, { pose: 'check', poseT: t - T.nightCheck, look: null })
        return Object.assign(h, { pose: 'cheer', poseT: t - T.nightCheck - 0.62, look: null })
      }
      if (t >= T.mags[k]) {
        const q = k === L.NEEDS_YOU ? E.outBack(seg(t, T.q, T.q + 0.25)) : 0
        return Object.assign(h, { pose: 'magnify', poseT: t - T.mags[k] + 0.3 * k, look: null, q })
      }
      if (t >= pop + 0.04) return Object.assign(h, { pose: 'hammer', poseT: t - pop + 0.18, look: null })
      return h
    })
    // ── architect ──
    if (t < T.archExit + T.archExitDur) {
      const A = { x: L.ARCH.x, y: L.ARCH_Y, pose: 'tear', poseT: 0, napkin: napScale, napRot, air: false, look: [0.5, 0.3], sq: 1 }
      if (t < T.archIn[1]) {
        // hops in from off the left edge, leaning into the jump, napkin held up
        const p = seg(t, T.archIn[0], T.archIn[1])
        const at = qarc([-110, L.ARCH_Y - 30], [L.ARCH.x, L.ARCH_Y], 110, p)
        Object.assign(A, { x: at[0], y: at[1], air: true, rot: 0.22 * (1 - p) - 0.08 * Math.sin(Math.PI * p), look: [1, 0.3], sq: 1 + 0.08 * bump(p, 0, 0.5) })
      } else if (t < T.tear0 - 0.25 * T.tearGap) {
        // lands with a squash + follow-through; then looks up at the falling blind with everyone, then at the moon
        A.sq = 1 - 0.2 * bump(t, T.archIn[1], T.archIn[1] + 0.12) + wob(t, T.archIn[1] + 0.12, 0.06, 22, 8)
        if (t >= T.blind0 + 0.04) A.look = t < T.moon0 ? [0.2, -1] : [0.9, -0.7]
      }
      // the rips: 'tear' is a 0.55 s jerk cycle whose peak (hands apart) sits at poseT 0.1375 — time-scale it so every
      // peak lands exactly on a rip
      const m = 0.55 / T.tearGap
      const tS = T.tear0 - 0.1375 / m
      const tE = T.tears[4] + 0.75 * T.tearGap
      if (t >= tS && t < tE) {
        A.poseT = 0.1375 + m * (t - T.tear0)
        A.look = [0.7, 0.35]
      } else if (t >= tE && t < T.archExit) {
        A.pose = 'wave'
        A.poseT = t - tE
        A.look = [0.4, 0.1]
        A.sq = 1 + 0.03 * bump(t, tE, tE + 0.2)
      } else if (t >= T.archExit) {
        // crouch (anticipation), then hop off the left edge on an arc, mirrored and spinning
        const pre = 0.1
        if (t < T.archExit + pre) {
          A.pose = 'hop'
          A.poseT = 0
          A.mirror = true
          A.sq = 1 - 0.16 * seg(t, T.archExit, T.archExit + pre)
          A.look = [-0.8, -0.2]
        } else {
          const p = seg(t, T.archExit + pre, T.archExit + T.archExitDur)
          const at = qarc([L.ARCH.x, L.ARCH_Y], [-150, 560], 150, E.inQuad(p) * 0.5 + p * 0.5)
          Object.assign(A, { pose: 'hop', poseT: 0.3, x: at[0], y: at[1], air: true, mirror: true, rot: -0.6 * p, look: [-0.8, -0.2], sq: 1 + 0.1 * bump(p, 0, 0.3) })
        }
      }
      S.arch = A
    }
    // ── YOU: asleep; Zzz from the end of "Bedtime?"; the one snore heaves the bed and puffs a big Z ──
    S.you = { pose: 'sleep', poseT: G, zzz: t > T.bedEnd - 0.1, bedFlat: 0 }
    S.heave = bump(t, T.snore - 0.12, T.snore + 0.5)
    if (t >= T.snore && t < T.snore + 0.85) {
      const p = seg(t, T.snore, T.snore + 0.85)
      S.bigZ = { dx: 4 - 44 * p, dy: -24 - 120 * E.outQuad(p), s: E.outBack(seg(p, 0, 0.22)) * (1.5 - 0.35 * p), a: 1 - seg(p, 0.6, 1) }
    }
    // ── Pip ──
    const pip = S.pip
    const po = pip.o
    const spd = PIP.WALK_SPEED * L.PIP_S // full stride
    const TIP = 0.8 // tiptoe stride
    const tipSpd = spd * TIP
    const tipLen = (T.tip[1] - T.tip[0] + T.tip[3] - T.tip[2]) * tipSpd
    const xMid = L.PIP_END_X + tipLen // where the patrol stops (the tiptoe covers the rest)
    const x0 = 1330
    const w1 = [T.pipWalk1, T.pipWalk1 + (x0 - xMid) / spd]
    if (t < w1[0]) pip.x = x0
    else if (t < w1[1]) pip.x = x0 - spd * (t - w1[0])
    else if (t < T.tip[0]) pip.x = xMid
    else if (t < T.tip[1]) pip.x = xMid - tipSpd * (t - T.tip[0])
    else if (t < T.tip[2]) pip.x = xMid - tipSpd * (T.tip[1] - T.tip[0])
    else if (t < T.tip[3]) pip.x = xMid - tipSpd * (T.tip[1] - T.tip[0] + t - T.tip[2])
    else pip.x = L.PIP_END_X
    // lantern: pops on with a flicker as the blind lands, then a steady breathing glow
    if (t < T.lantern) po.lantern = 0
    else if (t < T.lantern + 0.3) po.lantern = clamp01(seg(t, T.lantern, T.lantern + 0.12) * (0.75 + 0.25 * Math.sin(40 * (t - T.lantern))))
    po.blink = null
    if (t < T.blind0 + 0.06) {
      po.look = [0.2, -0.2]
    } else if (t < T.lantern) {
      // wide-eyed look up at the falling blind
      po.look = [-0.1, -1]
      po.mouth = 'o'
      po.eyes = 'wide'
      po.blink = 0
      po.squash = 1 + 0.04 * seg(t, T.blind0 + 0.06, T.blind0 + 0.3)
    } else if (t < T.tear0) {
      // the lantern pops on: a little startle squash, a grin up at its own light, then it watches the moon
      po.squash = 1 - 0.07 * bump(t, T.lantern, T.lantern + 0.14) + wob(t, T.lantern + 0.14, 0.03, 20, 8)
      po.mouth = t < T.lantern + 0.3 ? 'grin' : 'smile'
      po.look = t < T.lantern + 0.25 ? [0.2, -1] : [-0.5, -0.8]
    } else if (t < w1[0]) {
      po.look = [-1, -0.45] // watching the rips
    }
    if (t >= w1[0] && t < w1[1]) {
      po.pose = 'walk'
      po.poseT = t - w1[0]
      po.stride = 1
      po.flip = true
      po.look = [-0.8, -0.3]
    } else if (t >= w1[1] && t < T.tip[0]) {
      // stops to watch the machine; looks up at the bays, then up-left at the check, then at the "paused" sign
      po.look = t < T.check ? [-0.7, -0.5] : t < T.pause ? [-0.9, -0.4] : [-0.5, -0.9]
      po.flip = true
      if (t > T.nightCheck + 0.44 && t < T.pause + 0.1) {
        po.pose = 'clap'
        po.poseT = t - T.nightCheck - 0.46
      }
      if (t >= T.yawn[0]) {
        // a big sleepy yawn: stretch tall, eyes shut, mouth wide, then settle
        const y = bump(t, T.yawn[0], T.yawn[1])
        po.squash = 1 + 0.1 * y
        po.mouth = y > 0.15 ? 'open' : 'smile'
        po.eyes = y > 0.3 ? 'shut' : 'normal'
        po.look = [-0.3, -0.4]
      }
    }
    const tipping = (t >= T.tip[0] && t < T.tip[1]) || (t >= T.tip[2] && t < T.tip[3])
    if (tipping) {
      // tiptoe: short strides, a springy up-on-toes bob every step, pursed mouth
      const q = t < T.tip[1] ? t - T.tip[0] : t - T.tip[2] + (T.tip[1] - T.tip[0])
      const b = Math.abs(Math.sin((Math.PI * q) / 0.28))
      po.pose = 'walk'
      po.poseT = q
      po.stride = TIP
      po.flip = true
      po.air = 7 * b
      pip.y = -7 * b
      po.squash = 1 + 0.05 * b
      po.mouth = 'o'
      po.brows = 'raised'
      po.look = t < T.tip[1] ? [-0.9, 0.35] : [-1, 0.25]
    } else if (t >= T.tip[1] && t < T.tip[2]) {
      // the snore: Pip freezes mid-step, shrinks a little, wide-eyed glance at the bed
      po.pose = 'idle'
      po.flip = true
      po.squash = 1 - 0.08 * seg(t, T.tip[1], T.tip[1] + 0.08) + 0.04 * seg(t, T.tip[2] - 0.1, T.tip[2])
      po.eyes = 'wide'
      po.blink = 0
      po.mouth = 'wobbly'
      po.brows = 'worried'
      po.look = [-1, 0.3]
    } else if (t >= T.tip[3] && t < T.tip[3] + 0.2) {
      po.squash = 1 - 0.04 * bump(t, T.tip[3], T.tip[3] + 0.2)
    }
    return { S, T, G }
  }

  function draw(ctx, t, dur, info) {
    const tc = clamp(t, 0, dur)
    const { S, G } = stateAt(tc, dur, info)
    drawSet(ctx, G, S)
  }

  function sfx(dur, info) {
    const T = beats4(info, dur)
    const out = []
    const add = (t, type, o = {}) => {
      if (t >= 0 && t < dur + 0.2) out.push(Object.assign({ t, type }, o))
    }
    // effects are kept light while a line is spoken (they are not ducked under the voice)
    const lines = info.lines || []
    const spoken = (x) => lines.some((l) => x > l.start - 0.05 && x < l.end + 0.05)
    add(T.archIn[1] - 0.02, 'boing', { pitch: 1.35, gain: 0.3, pan: panOf(L.ARCH.x) })
    add(T.blind0 + 0.02, 'blind', { dur: 0.55, gain: 0.45, pan: 0 })
    add(T.blindLand + 0.05, 'crickets', { dur: Math.max(1, dur - T.blindLand - 0.1), gain: 0.6 })
    add(T.lantern, 'blip', { gain: 0.22, pan: panOf(1330) })
    add(Math.max(T.moon0 + 0.3, T.bedEnd + 0.03), 'plink', { note: 84, gain: 0.3, pan: panOf(L.MOON.x) })
    T.tears.forEach((x, j) => add(x - 0.02, 'tear', { dur: 0.15, pitch: [1, 1.12, 0.94, 1.2, 1.05][j], gain: spoken(x) ? 0.34 : 0.5, pan: panOf(L.NAPKIN[0]) }))
    T.tears.forEach((x, k) => add(x + T.tearHold + T.cardFly, 'thup', { pitch: 1.1 + 0.08 * k, gain: 0.2, pan: panOf(L.BELT_START[k]) }))
    add(T.sched - 0.02, 'pop', { gain: 0.4, pitch: 1.1, pan: panOf(L.SCHED_PLAQUE[0]) })
    add(T.archExit + 0.1, 'boing', { pitch: 1.3, gain: 0.22, pan: -0.7 })
    add(T.beltGo, 'conveyor', { dur: Math.max(0.6, T.beltEnd - T.beltGo + 0.05), gain: 0.7, pan: 0 })
    const notes = [72, 74, 76, 77, 79]
    T.lands.forEach((l, k) => add(l, 'plink', { note: notes[k], gain: 0.45, pan: panOf(L.BAYS[k]) }))
    T.pops.forEach((p, k) => add(p + 0.03, 'pop', { pitch: 1.3 + 0.07 * k, gain: 0.24, pan: panOf(L.BAYS[k]) }))
    // hammer taps: every strike of every helper before it switches to its magnifier
    T.pops.forEach((p, k) => {
      const end = T.mags[k]
      for (let n = 0; n < 4; n++) {
        const hit = p + (CAST.HAMMER_HIT - 0.18) + 0.5 * n
        if (hit < end - 0.02) add(hit, 'tap', { pitch: 0.9 + 0.09 * k + 0.05 * n, gain: 0.6, pan: panOf(L.BAYS[k]) })
      }
    })
    add(T.check + 0.05, 'creak', { dur: 0.7, gain: 0.4, pitch: 0.9, pan: panOf(L.GAUGE.x) })
    add(T.nightCheck + 0.12, 'pencil', { dur: 0.36, gain: 0.4, pan: panOf(L.BAYS[L.NIGHT_CHECKED]) })
    add(T.q, 'boing', { pitch: 1.7, gain: 0.22, pan: panOf(L.BAYS[L.NEEDS_YOU]) })
    add(T.gaugeHit, 'rattle', { pitch: 1.2, gain: 0.35, pan: panOf(L.GAUGE.x) })
    add(T.sign0 + 0.6 * T.signDur - 0.1, 'signFlip', { gain: 0.75, pan: panOf(L.SIGN.x) })
    add(T.teas[1] + 0.1, 'plink', { note: 91, gain: 0.2, pan: panOf(L.BAYS[1]) })
    add(T.teas[3] + 0.12, 'plink', { note: 93, gain: 0.18, pan: panOf(L.BAYS[3]) })
    add(T.snore, 'snore', { gain: 0.8, pan: panOf(L.BED.x - 70) })
    add(T.tip[0] + 0.05, 'footsteps', { dur: T.tip[1] - T.tip[0], pitch: 1.35, gain: 0.25, pan: panOf(L.PIP_END_X + 60) })
    add(T.tip[2] + 0.02, 'footsteps', { dur: T.tip[3] - T.tip[2], pitch: 1.35, gain: 0.22, pan: panOf(L.PIP_END_X + 20) })
    return out.sort((a, b) => a.t - b.t)
  }

  /** the lullaby's near-silent bar starts on "pauses" (engine → moods[].dip), not wherever the scene length puts it */
  function music(dur, info) {
    const T = beats4(info, dur)
    return { dip: [T.pause, Math.min(dur, T.pause + 4 * (info.beat || 0.58))] }
  }

  PROMO.scene('s4-night-scheduler', { draw, sfx, music })
})()

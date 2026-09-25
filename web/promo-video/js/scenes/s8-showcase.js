/* s8-showcase.js — "Then show off: a project page from your real code — like ours on bilko.run."
 * Owner: scene s8 (phase B). Contract: script/BRIEF.md §6. Pure function of (t, info): no state survives
 * between frames; every beat is timed from info.wordAt / info.cameoAt / info.nextBeat.
 *
 * STAGING — one continuous paper diorama filmed by a camera (world px = far-shot screen px):
 *   close-up (z ≈ 1.74) on the studio wall:  mitten presses "Generate Project Home" → a cream page flies out
 *     of the button onto the wall → scraps fly in from the 4 corners and glue on (the "> _" strip zips out
 *     from under Pip's feet — he hops over it, then points at it once it lands) → headings letter on →
 *     tag at "real" → kraft frame snaps at "code". Pip cheers, turns, hops, points, claps.
 *   pull-back + track (z → 1): the mitten lifts the frame, Pip leaps under it (PIP 'carry', carryW/carryH =
 *     the frame), and the pair bound down a cut-out street of little project houses. A tall foreground
 *     signpost (parallax 1.2, drawn in front of Pip and the mitten) holds "bilko.run/projects" + the pennant
 *     "Host on Bilko.run" ABOVE the carried frame, so nothing ever covers the URL while it is spoken.
 *   gallery facade "Showcase": Pip's last bound lands him past the free slot (turning mid-air); the mitten
 *     lifts the frame off his mitts and swings it up into the slot, then pushes a thumbtack in at
 *     cameoAt('visitor-ooh-1') - 0.2 (pin + bandHit) while Pip cheers clear of the frame; two strolling
 *     visitors stop, "Ooh!", clap; hearts pop in their own slots (wall gaps / between the heads).
 *
 * Parallax: every world layer has a factor f (hills + trees 0.7, houses 0.86, ground / gallery 1, signpost
 * 1.2) against the camera track; during the engine's tilt-in the backdrop wall lags (-0.25·dy) while the
 * whole diorama (floor, button, Pip…) leads (+0.12·dy) together, so Pip never leaves his floor.
 * Pip is drawn at GROUND - air (PIP's o.air only places the contact shadow).
 * The frame lives in ONE world pose at all times; while Pip carries it, it is drawn inside PIP's o.hold
 * callback (so the mitts grip over it) by mapping the grip transform back into world space; the pick-up
 * and the hand-over blend between that grip pose and the free world pose, so there is never a pop.
 * Sync points that must SHOW on the frame the sound plays (button squash, thumbtack thunk) are aligned to
 * the 15-fps frame containing the cue (frameOf), not to the next one.
 */
;(function () {
  'use strict'
  const C = K.C
  const E = K.ease
  const { seg, clamp, clamp01, lerp } = K
  const TAU = Math.PI * 2

  // ── world layout ─────────────────────────────────────────────────────────────────────────────
  const GROUND = 900
  const ZC = 1.74 // close-up zoom
  const CC = { x: 900, y: 676 } // close-up camera centre (world)
  const ANCHOR_X = 900 // parallax layers agree at this camera x
  const PIP_S = 0.75
  const PIP0_X = 820 // under the button; the "> _" strip's fly-in lane passes under his feet (he hops over it)
  const BTN = { x: 774, y: 555, s: 0.6 }
  const WALL_S = 1.1
  const POSTER_S = (344 / 888) * WALL_S // = galleryWall newSlot.scale × wall scale
  const POSTER = { x: 1095, y: 618 }
  const FW = 688 * POSTER_S // framed poster, world px
  const FH = 888 * POSTER_S
  const WALL = { x: 3072, y: 440 } // the wall centre is also the gap between garden-app and recipe-bot
  const SLOT = { x: WALL.x - 570 * WALL_S, y: WALL.y + 60 * WALL_S, pinY: WALL.y + (60 - 172 + 12) * WALL_S }
  const GAP_A = SLOT.x + 209 // clear wall between the new frame and garden-app
  const CX_END = SLOT.x + 545
  const FACADE_X = 2150
  const HAND_S = 0.72
  const ARRIVE_DX = 150 // Pip's last bound lands him here, past the slot (antenna + mitts clear of the hung frame);
  //                      the mitten lifts the frame off his grip and swings it up-left into the slot
  const CARRY_RAISE = 28 // the frame rides this much higher on his grip, so its caption tag clears the antenna
  const LEAD = 0.12 // tilt-in: the whole diorama leads…
  const WALL_LAG = -0.25 // …while the backdrop wall lags
  // hop lengths: two small wobbly starts, then long happy bounds (sums to the arrival point)
  const HOPS = (() => {
    const raw = [140, 230, 330, 350, 300]
    const k = (SLOT.x + ARRIVE_DX - POSTER.x) / raw.reduce((a, b) => a + b, 0)
    return raw.map((d) => d * k)
  })()
  const HOPC = HOPS.reduce((acc, d) => (acc.push(acc[acc.length - 1] + d), acc), [0])
  const N_HOPS = HOPS.length
  const AIR = 0.76 // fraction of each trot hop spent airborne
  const VIS_S = 0.9
  const FLOOR = '#e3cfab'
  const FACADE = '#f3e3d0'
  const WOOD = '#9a6a40'
  // foreground signpost: parallax 1.2, foot in front of Pip's ground line, board + pennant up above the frame
  const SIGN = { f: 1.2, s: 1.06, foot: GROUND + 72, boardBottom: 258, right: 492 }

  // ── timing: everything hangs off the narration + cameo clock ────────────────────────────────
  function timing(info, dur) {
    const beat = info.beat || 0.58
    const hb = beat / 2
    const nb = (x) => (info.nextBeat ? info.nextBeat(x) : Math.ceil(x / beat) * beat)
    const nhb = (x) => (nb(x) - hb >= x - 1e-6 ? nb(x) - hb : nb(x)) // next HALF-beat
    const g0 = info.start || 0
    const fps = K.ANIM_FPS || 15
    /** start of the 15-fps frame that is on screen at local time x (what the viewer sees when a cue plays) */
    const frameOf = (x) => Math.floor((g0 + x) * fps + 1e-6) / fps - g0
    const T = { beat, hb, dur }
    T.show = info.wordAt('show', 0.74)
    T.press = nb(T.show - 0.02) // mitten bottoms out on the beat under "show off"
    T.pressF = frameOf(T.press)
    T.a = info.wordAt('a', 1.63)
    T.real = info.wordAt('real', 2.97)
    T.code = info.wordAt('code', 3.23)
    T.bilko = info.wordAt('bilko', 4.68)
    T.ooh1 = info.cameoAt('visitor-ooh-1', 6.25)
    T.ooh2 = info.cameoAt('visitor-ooh-2', T.ooh1 + 0.16)
    T.pin = T.ooh1 - 0.2 // push-pin THUNK
    T.pinF = frameOf(T.pin)
    // page flies out of the button, lands on a beat
    T.pageA = T.press + 0.06
    T.pageB = nb(T.pageA + 0.42)
    // scraps: four landings on consecutive half-beats, the first on the beat after "a project…" begins
    T.land0 = nb(T.a + 0.22)
    T.scrapD = hb / 0.16
    T.scrapA = T.land0 - 0.44 * T.scrapD
    T.scrapB = T.scrapA + T.scrapD
    T.lands = [0, 1, 2, 3].map((i) => T.scrapA + (0.44 + 0.16 * i) * T.scrapD)
    // the "> _" strip (posterPage scrap 2, from the bottom-left corner) launches at scraps = 0.32 — right
    // under Pip's feet — so he hops over it; he points at it once it has glued on
    T.stripA = T.scrapA + 0.32 * T.scrapD
    T.dodge = T.stripA + 0.03
    T.dodgeDur = 0.44
    T.point = T.lands[2]
    T.headA = T.land0 - 0.12
    T.headB = Math.max(T.headA + 0.6, T.real + 0.02)
    T.tagA = T.real
    T.tagB = T.real + 0.34
    T.clapA = T.tagA + 0.02
    T.frameA = T.code + 0.02
    T.frameB = T.frameA + 0.32
    T.snap = T.frameA + 0.6 * 0.32 // outBack crosses scale 1 here
    // pick-up: Pip leaps under the frame while the mitten lifts it
    T.land = nhb(T.code + 0.62)
    T.leap0 = T.land - 0.3
    T.handDown = [T.frameB - 0.22, T.frameB - 0.02]
    T.lift = [T.frameB - 0.04, T.leap0 + 0.05]
    T.pullA = T.code + 0.12
    T.pullB = T.land + 0.3
    // trot: N hops on half-beats
    T.hop0 = nhb(T.land + 0.2)
    T.arrive = T.hop0 + (N_HOPS - 1) * hb + AIR * hb
    T.turn = T.hop0 + (N_HOPS - 1) * hb + 0.5 * AIR * hb // turns to face the slot at the top of the last hop
    T.hang = Math.max(T.pin - 0.14, T.arrive + 0.2) // the mitten has swung the frame into the slot
    T.pinA = T.pin - 0.12
    T.clap = nb(T.ooh2 + 0.12)
    const h0 = nhb(T.ooh1 + 0.05) // hearts cascade on quarter-beats from the first "Ooh!"
    T.hearts = [0, 1, 2, 3, 4].map((i) => h0 + (i * hb) / 2)
    return T
  }

  // ── small helpers ───────────────────────────────────────────────────────────────────────────
  const ring = (x, k = 8, w = 16) => (x <= 0 ? 0 : Math.exp(-k * x) * Math.cos(w * x))
  const springOut = (x, k = 8, w = 16) => (x <= 0 ? 0 : 1 - Math.exp(-k * x) * Math.cos(w * x))
  const panOf = (sx) => clamp(((sx / K.W) * 2 - 1) * 0.8, -0.8, 0.8)
  const fillPoly = (ctx, pts, col) => {
    K.pathPoly(ctx, pts)
    ctx.fillStyle = col
    ctx.fill()
  }

  // ── camera ──────────────────────────────────────────────────────────────────────────────────
  function pipScreenTarget(tt, T) {
    return lerp(640, SLOT.x + ARRIVE_DX - CX_END + 960, E.inOutCubic(seg(tt, T.hop0, T.arrive + 0.2)))
  }
  function farCam(tt, T) {
    // Pip's hop path averaged over exactly one hop period → no per-hop ripple in the camera
    let mean = 0
    for (let i = 0; i < 6; i++) mean += trot(tt - T.hb / 2 + ((i + 0.5) * T.hb) / 6, T).x
    mean /= 6
    return mean + 960 - pipScreenTarget(tt, T)
  }
  function camAt(tt, T) {
    const push = E.inOutQuad(seg(tt, T.press, T.frameB))
    const drift = E.inOutCubic(seg(tt, T.pageA - 0.12, T.land0))
    const cl = { x: lerp(CC.x - 95, CC.x + 22, drift), y: CC.y - 6 * push, z: ZC * (1 + 0.03 * push) }
    const p = E.inOutQuad(seg(tt, T.pullA, T.pullB))
    const fx = farCam(tt, T)
    const endPush = 0.04 * E.inOutCubic(seg(tt, T.pin - 0.1, T.dur + 0.3))
    return { x: lerp(cl.x, fx, p) - 180 * endPush, y: lerp(cl.y, 540, p) + 60 * endPush, z: Math.exp(lerp(Math.log(cl.z), 0, p)) * (1 + endPush), pull: p }
  }

  // ── Pip's trot + leap ─────────────────────────────────────────────────────────────────────────
  function trot(tt, T) {
    const u = (tt - T.hop0) / T.hb
    if (u < 0) return { x: POSTER.x, y: 0, sq: 1, vx: 0, k: -1 }
    const k = Math.floor(u)
    if (k >= N_HOPS) return { x: SLOT.x + ARRIVE_DX, y: 0, sq: 1, vx: 0, k: N_HOPS }
    const f = u - k
    const d = HOPS[k]
    const hh = 14 + 0.07 * d
    if (f < AIR) {
      const a = f / AIR
      return { x: POSTER.x + HOPC[k] + d * a, y: -hh * 4 * a * (1 - a), sq: 1.08 - 0.1 * a, vx: d / (AIR * T.hb), vy: (-hh * 4 * (1 - 2 * a)) / (AIR * T.hb), k }
    }
    return { x: POSTER.x + HOPC[k + 1], y: 0, sq: k === N_HOPS - 1 ? 0.84 : 0.88, vx: 0, k }
  }

  /** Pip's whole performance → PIP.draw options + world position (drawn at GROUND - air). */
  function pipState(tt, T) {
    const st = { x: PIP0_X, air: 0, pose: 'idle', poseT: tt, flip: false, look: [0.4, -0.3], mouth: null, eyes: null, brows: null, squash: null, vel: [0, 0], carry: false, release: 0 }
    if (tt < T.press + 0.02) {
      // watching the mitten come down onto the button (crouches, 'o' mouth)
      st.flip = true
      st.look = [-0.4, -0.9]
      const ant = seg(tt, T.pressF - 0.28, T.pressF)
      st.squash = 1 - 0.1 * Math.sin(ant * Math.PI * 0.5) + 0.015 * Math.sin(tt * 9)
      st.eyes = ant > 0 ? 'wide' : null
      st.mouth = ant > 0 ? 'o' : 'smile'
      return st
    }
    if (tt < T.pageB + 0.05) {
      // cheer-hop; turns toward the wall at the top of the hop
      const h = PIP.hop(tt, T.press + 0.04, { dur: 0.44, height: 50, pre: 0.04 })
      st.pose = 'cheer'
      st.poseT = tt - T.press
      st.air = -h.y
      st.squash = h.squash
      st.flip = h.p < 0.5 && tt < T.press + 0.26
      st.look = st.flip ? [-0.3, -0.6] : [0.7, -0.5]
      st.mouth = 'open'
      st.eyes = 'happy'
      st.vel = [0, h.air ? (h.p < 0.5 ? -260 : 260) : 0]
      return st
    }
    if (tt < T.dodge - 0.12) {
      // following the page and the first scraps
      const lk = seg(tt, T.pageB, T.dodge - 0.12)
      st.look = [lerp(0.8, 0.55, lk), lerp(-0.2, -0.65, lk)]
      st.eyes = 'wide'
      st.mouth = 'o'
      return st
    }
    if (tt < T.point) {
      // the "> _" strip zips out from under his feet: a stiff little surprise hop over it, eyes on the strip
      const h = PIP.hop(tt, T.dodge, { dur: T.dodgeDur, height: 80, pre: 0.08 })
      st.air = -h.y
      st.squash = h.squash
      st.vel = [0, h.air ? (h.p < 0.5 ? -420 : 420) : 0]
      const f = E.inOutQuad(seg(tt, T.dodge + 0.02, T.dodge + 0.34))
      const f2 = E.inOutQuad(seg(tt, T.dodge + T.dodgeDur, T.point))
      st.look = [lerp(lerp(-0.45, 0.9, f), 0.85, f2), lerp(lerp(0.85, -0.1, f), -0.35, f2)]
      const landed = tt >= T.dodge + T.dodgeDur
      st.eyes = landed ? null : 'wide'
      st.mouth = landed ? 'grin' : 'o'
      st.brows = landed ? null : 'raised'
      return st
    }
    if (tt < T.clapA) {
      // points at the strip that just glued on
      st.pose = 'point'
      st.poseT = tt - T.point
      st.aim = -0.36
      st.look = [0.85, -0.3]
      st.mouth = 'grin'
      return st
    }
    if (tt < T.leap0 - 0.12) {
      st.pose = 'clap'
      st.poseT = tt - T.clapA
      st.look = [0.7, -0.5]
      st.eyes = tt > T.snap - 0.05 ? 'happy' : null
      st.mouth = 'open'
      return st
    }
    if (tt < T.hang + 0.02) {
      st.carry = true
      st.pose = 'carry'
      st.poseT = (tt - T.leap0) * (0.56 / T.beat)
      st.mouth = 'grin'
      st.look = [0.35, -0.5]
      if (tt < T.land) {
        const h = PIP.hop(tt, T.leap0, { dur: T.land - T.leap0, height: 55, pre: 0.12 })
        const a = h.p
        st.x = lerp(PIP0_X, POSTER.x, h.air ? E.inOutQuad(a) : tt < T.leap0 ? 0 : 1)
        st.air = -h.y
        st.squash = h.squash
        st.vel = [h.air ? 820 : 0, h.air ? (a < 0.5 ? -300 : 300) : 0]
        st.eyes = 'wide'
        st.brows = 'determined'
        return st
      }
      const tr = trot(tt, T)
      st.x = tr.x
      st.air = -tr.y
      st.vel = [tr.vx || 0, tr.vy || 0]
      if (tt < T.hop0) st.squash = clamp(1 - 0.18 * ring(tt - T.land, 9, 17), 0.8, 1.15)
      else if (tt >= T.arrive) st.squash = clamp(1 - 0.16 * ring(tt - T.arrive, 9, 17), 0.8, 1.15)
      else st.squash = tr.sq
      if (tt >= T.turn) {
        // turned round at the top of the last bound; lets the mitten lift the frame off and watches it go up
        st.flip = true
        st.look = [lerp(-0.2, -0.75, seg(tt, T.arrive, T.hang)), -0.9]
        st.mouth = tt >= T.arrive ? 'open' : 'grin'
        st.release = seg(tt, T.arrive, T.hang)
      }
      return st
    }
    // it's up! cheer, then clap with the visitors
    st.x = SLOT.x + ARRIVE_DX
    st.flip = true
    st.look = [-0.6, -0.8]
    st.eyes = 'happy'
    st.mouth = 'open'
    st.pose = tt < T.clap ? 'cheer' : 'clap'
    st.poseT = tt < T.clap ? tt - (T.hang + 0.02) : tt - T.clap
    return st
  }

  // ── frame pose (world) when it is NOT in Pip's hands ────────────────────────────────────────
  function freePose(tt, T) {
    if (tt < T.pageA) return null
    if (tt < T.pageB) {
      const p = seg(tt, T.pageA, T.pageB)
      const e = E.outCubic(p)
      const x0 = BTN.x + 30
      const y0 = BTN.y - 10
      return {
        x: lerp(x0, POSTER.x, e),
        y: lerp(y0, POSTER.y, e) - 45 * Math.sin(Math.PI * e),
        rot: lerp(-0.95, 0, E.outBack(p)),
        s: POSTER_S * lerp(0.12, 1, E.outCubic(p)),
        sq: [1, 1],
      }
    }
    // on the wall (landing squash) → lifted by the mitten
    const land = tt - T.pageB
    const sq = 1 - 0.07 * ring(land, 7, 20)
    const lp = E.inOutCubic(seg(tt, T.lift[0], T.lift[1]))
    // lifted ABOVE Pip's leap so he can jump underneath; the carry blend then lowers it onto his mitts
    const carryY = GROUND - 504 * PIP_S - CARRY_RAISE - 50
    return {
      x: POSTER.x,
      y: lerp(POSTER.y, carryY, lp),
      rot: 0.05 * Math.sin(lp * Math.PI) * (1 - lp * 0.5),
      s: POSTER_S,
      sq: [2 - sq, sq],
    }
  }
  function slotPose(tt, T) {
    // hangs on the pin; a damped swing after the thunk
    const sw = 0.06 * ring(tt - T.pinF, 3.2, 9)
    const d = SLOT.y - SLOT.pinY
    return { x: SLOT.x + Math.sin(sw) * d, y: SLOT.pinY + Math.cos(sw) * d, rot: -sw, s: POSTER_S, sq: [1, 1] }
  }
  function blendPose(a, b, p) {
    return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), rot: lerp(a.rot, b.rot, p), s: lerp(a.s, b.s, p), sq: [lerp(a.sq[0], b.sq[0], p), lerp(a.sq[1], b.sq[1], p)] }
  }
  function posterOpts(tt, T, pose) {
    return {
      id: 's8poster',
      scale: [pose.s * pose.sq[0], pose.s * pose.sq[1]],
      rot: pose.rot,
      scraps: seg(tt, T.scrapA, T.scrapB),
      headings: seg(tt, T.headA, T.headB),
      tag: seg(tt, T.tagA, T.tagB),
      frame: seg(tt, T.frameA, T.frameB),
      nudge: 0.35,
    }
  }
  const topOf = (pose) => {
    const r = (FH / 2) * (pose.s / POSTER_S) * pose.sq[1]
    return [pose.x + Math.sin(pose.rot) * r, pose.y - Math.cos(pose.rot) * r]
  }

  // ── scenery (drawn in world space, per layer) ─────────────────────────────────────────────────
  const HOUSES = [
    { x: 1580, color: C.sage, s: 0.8, id: 'h1' },
    { x: 1810, color: C.butter, s: 0.9, id: 'h2' },
    { x: 2040, color: C.hiveTeal, s: 0.78, id: 'h3' },
    { x: 2270, color: C.terracotta, s: 0.88, id: 'h4' },
    { x: 2500, color: C.sage, s: 0.82, id: 'h5' },
  ]
  const TREES = [{ x: 1640, s: 0.95 }, { x: 2060, s: 0.8 }, { x: 2480, s: 1.05 }]

  function hills(ctx, t, xL, xR, hideX) {
    // low rolling sage hills far behind the houses (layer 0.7)
    const x0 = 1560
    const x1 = 3200
    if (xR < x0 || xL > x1) return
    const xe = Math.min(x1, hideX + 120)
    if (xe <= x0) return
    const pts = [[x0, GROUND + 40]]
    for (let x = x0; x <= xe; x += 40) {
      const u = (x - x0) / (x1 - x0)
      const y = GROUND - 70 - 60 * Math.sin(u * Math.PI * 3.2 + 0.6) * Math.sin(u * Math.PI) - 30 * Math.sin(u * 17)
      pts.push([x, y])
    }
    pts.push([xe, GROUND + 40])
    K.paper(ctx, pts, '#b9c49a', { seed: 's8hill', torn: 3, shadow: 0.5 })
    TREES.forEach((tr, i) => {
      if (tr.x < xL - 100 || tr.x > Math.min(xR, hideX) + 70) return
      K.at(ctx, tr.x, GROUND - 60, Math.sin(t * 1.3 + i) * 0.02, tr.s, () => {
        K.paper(ctx, K.rectPts(-7, -110, 14, 115), C.kraftDark, { seed: 's8tk' + i, cut: 1, shadow: 0.6 })
        const crown = K.paper(ctx, K.ellipsePts(0, -150, 58, 64, 26), i % 2 ? C.grass : '#7fa35a', { seed: 's8tc' + i, cut: 3, shadow: 0.8 })
        K.pencil.poly(ctx, crown.filter((_, j) => j % 2 === 0), 's8tco' + i, t, { stroke: 'rgba(42,34,26,0.55)', strokeWidth: 2, roughness: 1 })
      })
    })
  }

  function floor(ctx, t, xL, xR) {
    const a = Math.floor((xL - 200) / 200) * 200
    const b = xR + 200
    ctx.save()
    K.pathPoly(ctx, K.rectPts(a, GROUND - 2, b - a, 700))
    ctx.fillStyle = K.paperPattern(ctx, FLOOR)
    ctx.fill()
    // soft shade under the wall line
    ctx.fillStyle = 'rgba(90,60,30,0.10)'
    ctx.fillRect(a, GROUND - 2, b - a, 14)
    // pencil edge (cheap hand wobble, boils)
    const bo = K.boil(t)
    ctx.beginPath()
    for (let x = a; x <= b; x += 30) {
      const y = GROUND - 2 + K.noise1(x * 0.05 + bo * 0.37, 'fl') * 1.6
      if (x === a) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = 'rgba(42,34,26,0.7)'
    ctx.lineWidth = 2.4
    ctx.stroke()
    // pebbles + grass tufts every so often (world-fixed motion cues)
    for (let x = a; x <= b; x += 200) {
      const r = K.rng('s8fl', x)
      const px = x + r() * 140
      ctx.beginPath()
      ctx.ellipse(px, GROUND + 26 + r() * 40, 7 + r() * 6, 4 + r() * 3, 0, 0, TAU)
      ctx.fillStyle = 'rgba(120,90,55,0.35)'
      ctx.fill()
      if (r() < 0.6) {
        const gx = x + 60 + r() * 100
        ctx.fillStyle = r() < 0.5 ? C.grass : C.sage
        for (let k = 0; k < 3; k++) {
          const bx = gx + (k - 1) * 8
          const hh = 12 + r() * 12
          ctx.beginPath()
          ctx.moveTo(bx - 4, GROUND + 1)
          ctx.lineTo(bx + (r() - 0.5) * 10, GROUND - hh)
          ctx.lineTo(bx + 4, GROUND + 1)
          ctx.closePath()
          ctx.fill()
        }
      }
    }
    ctx.restore()
  }

  function facade(ctx, t, xL, xR) {
    if (xR < FACADE_X - 20) return
    const x0 = FACADE_X
    const x1 = Math.max(x0 + 400, xR + 200)
    const top = -700
    ctx.fillStyle = 'rgba(58,36,14,0.10)'
    ctx.fillRect(x0 - 22, top, 16, GROUND - top)
    ctx.fillStyle = 'rgba(58,36,14,0.07)'
    ctx.fillRect(x0 - 34, top, 12, GROUND - top)
    K.paper(ctx, K.rectPts(x0, top, x1 - x0, GROUND - top), FACADE, { seed: 's8fac', cut: 0, shadow: 0 })
    // honey pilaster + a terracotta stripe down the building corner
    K.paper(ctx, K.rectPts(x0 - 6, top, 46, GROUND - top), C.honey, { seed: 's8pil', cut: 1, shadow: 0.8 })
    K.paper(ctx, K.rectPts(x0 + 40, top, 12, GROUND - top), C.terracotta, { seed: 's8pil2', cut: 0.6, shadow: 0.4 })
    // baseboard
    K.paper(ctx, K.rectPts(x0 - 6, GROUND - 34, x1 - x0 + 6, 34), '#d7b995', { seed: 's8base', cut: 0.8, shadow: 0.6 })
    // striped scalloped awning along the top of the gallery building
    const ay = -8
    const ah = 46
    ctx.save()
    ctx.fillStyle = 'rgba(58,36,14,0.12)'
    ctx.fillRect(x0 - 10, ay + ah, x1 - x0 + 10, 14)
    const aw = new Path2D()
    aw.moveTo(x0 - 10, ay - 60)
    aw.lineTo(x1, ay - 60)
    aw.lineTo(x1, ay + ah - 12)
    for (let x = x1; x > x0 - 10; x -= 48) aw.arc(x - 24, ay + ah - 12, 24, 0, Math.PI)
    aw.closePath()
    ctx.fillStyle = K.paperPattern(ctx, C.cream)
    ctx.fill(aw)
    ctx.save()
    ctx.clip(aw)
    ctx.fillStyle = K.paperPattern(ctx, C.terracotta)
    for (let x = x0 - 10; x < x1; x += 96) ctx.fillRect(x, ay - 60, 48, ah + 80)
    ctx.restore()
    ctx.strokeStyle = 'rgba(42,34,26,0.6)'
    ctx.lineWidth = 2.2
    ctx.stroke(aw)
    ctx.restore()
    const bo = K.boil(t)
    ctx.save()
    ctx.beginPath()
    for (let y = top; y <= GROUND; y += 30) {
      const x = x0 - 6 + K.noise1(y * 0.05 + bo * 0.41, 'fac') * 1.4
      if (y === top) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = 'rgba(42,34,26,0.65)'
    ctx.lineWidth = 2.4
    ctx.stroke()
    ctx.restore()
  }

  // ── foreground signpost ("bilko.run/projects" + pennant "Host on Bilko.run") ─────────────────────
  /** World x of the post (sign layer): placed so the whole sign has just left the screen on the left when the
   *  track settles at the gallery — which puts it beside Pip, fully readable, while "bilko dot run" is said. */
  function signX(T) {
    const c = camAt(T.arrive + 0.12, T)
    const ex = ANCHOR_X + SIGN.f * (c.x - ANCHOR_X)
    return ex + (-30 - 960) / c.z - SIGN.right * SIGN.s
  }
  function drawSign(ctx, t, T, M, vis) {
    const s = SIGN.s
    const x = signX(T)
    if (x + SIGN.right * s < vis[0] - 10 || x - 90 > vis[1]) return null
    const baseY = SIGN.boardBottom + 286 * s // the prop's ground point, lifted so the board clears the frame
    const foot = SIGN.foot
    const top = baseY - 58
    const w0 = 13.5 * s
    const w1 = 17 * s
    ctx.save()
    ctx.setTransform(M)
    // contact shadow + a tall pole down to the kerb in front of the street
    ctx.beginPath()
    ctx.ellipse(x + 14, foot + 3, 54, 10, 0, 0, TAU)
    ctx.fillStyle = 'rgba(58,36,14,0.18)'
    ctx.fill()
    const pole = K.paper(ctx, [[x - w1, foot], [x - w0, top], [x + w0, top], [x + w1, foot]], WOOD, { seed: 's8pole', cut: 1.2, shadow: 1 })
    fillPoly(ctx, [[x + 4 * s, foot], [x + 4 * s, top], [x + w0, top], [x + w1, foot]], 'rgba(40,20,5,0.18)')
    ctx.strokeStyle = 'rgba(60,30,10,0.3)'
    ctx.lineWidth = 1.4
    ;[-6, 2].forEach((gx) => {
      ctx.beginPath()
      ctx.moveTo(x + gx * s, foot - 8)
      ctx.bezierCurveTo(x + (gx + 3) * s, foot - 150, x + (gx - 3) * s, top + 130, x + gx * s, top + 10)
      ctx.stroke()
    })
    K.pencil.poly(ctx, pole, 's8poleo', t, { stroke: 'rgba(42,34,26,0.62)', strokeWidth: 2.2, roughness: 0.7 })
    // the signpost prop sits on top of the pole (its foot + grass tufts, up to ~38 px, clipped away)
    ctx.save()
    ctx.beginPath()
    ctx.rect(x - 400, -2400, 1800, baseY - 44 + 2400)
    ctx.clip()
    const a = PROPS.signpost(ctx, x, baseY, t, { id: 's8sign', scale: s, flutter: 1 })
    ctx.restore()
    // a galvanised clamp band hides the joint
    K.at(ctx, x, baseY - 46, 0, 1, () => {
      const band = K.paper(ctx, K.roundRectPts(-w1 - 5, -10, 2 * (w1 + 5), 20, 5, 3), '#9b958a', { seed: 's8band', cut: 0.6, shadow: 0.7 })
      K.pencil.poly(ctx, band, 's8bando', t, { stroke: 'rgba(42,34,26,0.55)', strokeWidth: 1.8, roughness: 0.5 })
      ;[-w1 + 2, w1 - 2].forEach((rx) => {
        ctx.beginPath()
        ctx.arc(rx, 0, 3, 0, TAU)
        ctx.fillStyle = '#5b544b'
        ctx.fill()
      })
      fillPoly(ctx, K.rectPts(-w1 - 3, -8, 2 * (w1 + 3), 4), 'rgba(255,255,255,0.35)')
    })
    // grass tufts at the foot
    const r = K.rng('s8sgrass')
    for (let k = 0; k < 6; k++) {
      const gx = x - 40 + k * 16
      const hh = 16 + r() * 18
      fillPoly(ctx, [[gx - 6, foot + 3], [gx + (r() - 0.5) * 14, foot - hh], [gx + 6, foot + 3]], k % 2 ? C.grass : C.sage)
    }
    ctx.restore()
    return a
  }

  // ── draw ────────────────────────────────────────────────────────────────────────────────────
  function draw(ctx, t, dur, info) {
    const T = timing(info, dur)
    const tt = clamp(t, 0, dur)
    const sh = info.camShift ? info.camShift(t) : { dx: 0, dy: 0 }
    const cam = camAt(tt, T)
    const P = window.PROPS

    // backdrop: the clean paper wall (lags during the tilt-in)
    ctx.save()
    ctx.translate(0, WALL_LAG * sh.dy)
    K.backdrop(ctx, C.paper)
    ctx.restore()

    const base = ctx.getTransform()
    /** world transform for a parallax layer (f = factor); the whole diorama leads the wall in the tilt-in */
    const layerM = (f) => {
      const ex = ANCHOR_X + f * (cam.x - ANCHOR_X)
      return base.translate(960, 540 + LEAD * sh.dy).scale(cam.z, cam.z).translate(-ex, -cam.y)
    }
    const visX = (f) => {
      const ex = ANCHOR_X + f * (cam.x - ANCHOR_X)
      return [ex - 960 / cam.z, ex + 960 / cam.z]
    }
    const inLayer = (M, fn) => {
      ctx.save()
      ctx.setTransform(M)
      fn()
      ctx.restore()
    }
    const M1 = layerM(1)
    const [xL, xR] = visX(1)

    // far hills (0.7) and houses (0.86)
    // the gallery facade (factor 1) hides everything behind it: find its edge in each layer's coords
    const facadeScreen = (FACADE_X - cam.x) * cam.z + 960
    const hideIn = (f) => (facadeScreen - 960) / cam.z + ANCHOR_X + f * (cam.x - ANCHOR_X)
    const Mh = layerM(0.7)
    const vh = visX(0.7)
    inLayer(Mh, () => hills(ctx, t, vh[0], vh[1], hideIn(0.7)))
    const Mho = layerM(0.86)
    const vho = visX(0.86)
    const hideH = hideIn(0.86)
    inLayer(Mho, () => {
      HOUSES.forEach((h) => {
        if (h.x + 150 < vho[0] || h.x - 150 > vho[1] || h.x - 90 * h.s > hideH) return
        P.house(ctx, h.x, GROUND - 22, t, { color: h.color, scale: h.s, id: 's8' + h.id })
      })
    })

    // ground + gallery facade (factor 1)
    inLayer(M1, () => {
      floor(ctx, t, xL, xR)
      facade(ctx, t, xL, xR)
    })

    // studio: control strip + clay button
    const btnPress = pressCurve(tt, T)
    if (xL < BTN.x + 200) {
      inLayer(M1, () => {
        P.clayButton(ctx, BTN.x, BTN.y, t, { id: 's8btn', scale: BTN.s, r: 90, press: btnPress, strip: 'Generate Project Home', color: C.terracotta })
      })
    }

    // gallery wall
    const wallOn = xR > WALL.x - 900 * WALL_S
    const sway = 0.6 + 1.3 * Math.abs(ring(tt - T.pinF, 3, 7))
    if (wallOn) {
      inLayer(M1, () => {
        P.galleryWall(ctx, WALL.x, WALL.y, t, { id: 's8wall', scale: WALL_S, emptySlot: 0, emptyNail: false, sway, nudge: 0, hint: clamp01(seg(tt, T.arrive - 0.9, T.arrive - 0.4) - seg(tt, T.hang - 0.1, T.hang + 0.1)) })
      })
    }

    // the poster frame (world pose) — drawn here unless Pip is carrying it
    const pst = pipState(tt, T)
    let frameNow = null
    const inSlot = tt >= T.hang
    if (!pst.carry && !inSlot) {
      const fp = freePose(tt, T)
      if (fp) {
        inLayer(M1, () => P.posterPage(ctx, fp.x, fp.y, t, posterOpts(tt, T, fp)))
        frameNow = fp
      }
    }
    if (inSlot) {
      const sp = slotPose(tt, T)
      inLayer(M1, () => P.posterPage(ctx, sp.x, sp.y, t, posterOpts(tt, T, sp)))
      frameNow = sp
    }

    // visitors (behind Pip)
    drawVisitors(ctx, t, tt, T, M1, xL, xR)

    // Pip
    const MInv = M1.inverse()
    inLayer(M1, () => {
      const o = {
        id: 's8pip',
        scale: PIP_S,
        pose: pst.pose,
        poseT: pst.poseT,
        flip: pst.flip,
        look: pst.look,
        air: pst.air,
        vel: pst.vel,
      }
      if (pst.squash != null) o.squash = pst.squash
      if (pst.mouth) o.mouth = pst.mouth
      if (pst.eyes) o.eyes = pst.eyes
      if (pst.brows) o.brows = pst.brows
      if (pst.aim != null) o.aim = pst.aim
      if (pst.carry) {
        const settle = E.inOutQuad(seg(tt, T.land - 0.06, T.land + 0.12))
        // …and the mitts come in off the frame's sides as the mitten lifts it away
        o.carryW = lerp(lerp(150, FW / PIP_S, settle), 150, E.inOutQuad(pst.release || 0))
        // a taller "item" makes PIP hold its centre higher: the caption tag rides clear of the antenna
        o.carryH = lerp(150, (FH + 2 * CARRY_RAISE) / PIP_S, settle)
        o.hold = (g) => {
          const Wm = MInv.multiply(g.getTransform())
          const grot = Math.atan2(Wm.b, Wm.a)
          const inTrot = tt >= T.hop0 && tt < T.arrive + 0.12
          const wob = 0.035 * Math.sin(((tt - T.hop0) / T.hb) * TAU - 1.1) * seg(tt, T.hop0, T.hop0 + 0.2) * (1 - seg(tt, T.arrive - 0.1, T.arrive + 0.1))
          // the frame lags Pip's hop a little (drag on take-off, follow-through on landing)
          const lagY = inTrot ? 0.45 * (trot(tt - 0.07, T).y - trot(tt, T).y) : 0
          const rest = { x: Wm.e, y: Wm.f + lagY, rot: grot * 0.5 + wob, s: POSTER_S, sq: [1, 1] }
          let pose = rest
          if (tt < T.land + 0.16) pose = blendPose(freePose(tt, T), rest, E.inOutQuad(seg(tt, T.land - 0.04, T.land + 0.16)))
          else if (tt > T.arrive) {
            // the mitten swings it up and over into the slot: a lifted arc, bottom trailing (pinched at the top)
            const u = seg(tt, T.arrive, T.hang)
            const e = E.inOutCubic(u)
            const sl = slotPose(T.hang, T)
            pose = blendPose(rest, sl, e)
            pose.x = lerp(rest.x, sl.x, E.outCubic(u)) // leaves the neighbour's frame quickly
            pose.y -= 64 * Math.sin(Math.PI * Math.min(1, e * 1.25))
            pose.rot -= 0.09 * Math.sin(Math.PI * e)
          }
          g.save()
          g.setTransform(M1)
          P.posterPage(g, pose.x, pose.y, t, posterOpts(tt, T, pose))
          g.restore()
          frameNow = pose
        }
      }
      PIP.draw(ctx, pst.x, GROUND - pst.air, t, o)
    })

    // thumbtack (after the frame so it sits on it)
    if (tt >= T.pinA) {
      const pp = seg(tt, T.pinF - 0.1, T.pinF)
      inLayer(M1, () => P.thumbtack(ctx, SLOT.x, SLOT.pinY, t, { press: pp, color: C.tomato, r: 13, id: 's8tack' }))
    }

    // the mitten
    drawHand(ctx, t, tt, T, M1, frameNow, btnPress)

    // foreground signpost (in front of Pip, the frame and the mitten's sleeve)
    drawSign(ctx, t, T, layerM(SIGN.f), visX(SIGN.f))

    // hearts
    drawHearts(ctx, t, tt, T, M1)
  }

  // ── button press curve (full squash on the frame that is on screen when the clunk plays) ────────
  function pressCurve(tt, T) {
    const down = E.inCubic(seg(tt, T.pressF - 0.12, T.pressF))
    const up = tt > T.pressF + 0.1 ? springOut(tt - (T.pressF + 0.1), 7, 15) : 0
    return clamp(down - up * 1.0, -0.35, 1)
  }

  // ── the mitten (a cut-out human hand does every press) ───────────────────────────────────────
  function drawHand(ctx, t, tt, T, M1, frameNow, btnPress) {
    const btnTop = [BTN.x + 8, BTN.y - 38]
    let o = null
    let x = 0
    let y = 0
    if (tt < T.press + 0.62) {
      // 1 — press "Generate Project Home"
      const inP = E.outCubic(seg(tt, T.pressF - 0.62, T.pressF - 0.2))
      const hover = -26 * (1 - E.inCubic(seg(tt, T.pressF - 0.2, T.pressF - 0.12)))
      const out = E.inCubic(seg(tt, T.press + 0.22, T.press + 0.62))
      if (inP <= 0) return
      x = btnTop[0] + 6 * (1 - inP)
      y = lerp(btnTop[1] - 420, btnTop[1] + hover, inP) - 480 * out + 14 * Math.max(0, btnPress)
      o = { pose: 'press', press: clamp01(btnPress), from: 'top' }
    } else if (tt >= T.handDown[0] && tt < T.hang + 0.02 && frameNow) {
      // 2 — pinch the frame's top rail and carry it with Pip
      const top = topOf(frameNow)
      const inP = E.outBack(seg(tt, T.handDown[0], T.handDown[1]))
      x = top[0]
      y = lerp(top[1] - 360, top[1] + 10, inP)
      o = { pose: 'pinch', from: 'top' }
    } else if (tt >= T.hang + 0.02 && tt < T.pin + 0.8) {
      // 3 — push the thumbtack in (THUNK on the frame the sound plays), then leave
      const pinTop = [SLOT.x, SLOT.pinY - 6]
      const lift = Math.sin(Math.PI * seg(tt, T.hang + 0.02, T.pinF - 0.1)) * 22
      const push = E.inCubic(seg(tt, T.pinF - 0.1, T.pinF))
      const out = E.inOutCubic(seg(tt, T.pin + 0.22, T.pin + 0.8))
      x = pinTop[0] + 4
      y = pinTop[1] - lift - 600 * out
      o = { pose: 'press', press: push * (1 - seg(tt, T.pin + 0.1, T.pin + 0.25)), from: 'top' }
    } else return
    ctx.save()
    ctx.setTransform(M1)
    CAST.hand(ctx, x, y, t, Object.assign({ id: 's8hand', mitten: true, scale: HAND_S, sleeve: C.blue }, o))
    ctx.restore()
  }

  // ── visitors ────────────────────────────────────────────────────────────────────────────────
  // v1 stops under garden-app (clear of Pip), v2 in the wall gap between garden-app and recipe-bot
  const VIS = [
    { id: 's8v1', color: C.sky, stop: WALL.x - 222, outfit: 'dress', hair: 1 },
    { id: 's8v2', color: C.mustard, stop: WALL.x + 30, outfit: 'overalls', hair: 3 },
  ]
  function visitorX(v, tt, T) {
    const speed = CAST.VISITOR_WALK_SPEED * VIS_S
    const stopAt = T.pin + 0.04 + (v === VIS[1] ? 0.1 : 0)
    return { x: v.stop + speed * Math.max(0, stopAt - tt), stopAt }
  }
  function drawVisitors(ctx, t, tt, T, M1, xL, xR) {
    if (tt < T.hop0) return
    ctx.save()
    ctx.setTransform(M1)
    VIS.forEach((v, i) => {
      const { x, stopAt } = visitorX(v, tt, T)
      if (x + 120 < xL || x - 120 > xR) return
      const ooh = i === 0 ? T.ooh1 - 0.04 : T.ooh2 - 0.04
      let pose = 'walk'
      let poseT = tt
      if (tt >= T.clap + i * 0.08) {
        pose = 'clap'
        poseT = tt - T.clap - i * 0.08
      } else if (tt >= ooh) {
        pose = 'ooh'
        poseT = tt - ooh
      } else if (tt >= stopAt) {
        pose = 'stop'
        poseT = tt - stopAt
      }
      const look = tt >= stopAt ? [-0.9, -0.45] : [-0.6, 0.1]
      CAST.visitor(ctx, x, GROUND + 6 + i * 4, t, { id: v.id, pose, poseT, color: v.color, flip: true, scale: VIS_S, outfit: v.outfit, hair: v.hair, look })
    })
    ctx.restore()
  }

  // ── hearts: each has its own slot (clear wall gaps / between the heads), never over poster art ──
  const HEARTS = [
    { x: WALL.x - 84, y: GROUND - 100, r: 34, c: 'pink' }, // between the two visitors, at head height
    { x: WALL.x + 25, y: GROUND - 214, r: 28, c: 'coral' }, // floats up the (narrow) wall gap above visitor 2
    { x: GAP_A, y: GROUND - 306, r: 32, c: 'tomato' }, // up the gap above Pip
    { x: WALL.x + 120, y: GROUND - 100, r: 30, c: 'pink' }, // right of visitor 2
    { x: WALL.x - 150, y: GROUND - 84, r: 30, c: 'coral' }, // second one between the heads, lower-left of the first
  ]
  function drawHearts(ctx, t, tt, T, M1) {
    if (tt < T.hearts[0]) return
    ctx.save()
    ctx.setTransform(M1)
    T.hearts.forEach((h0, i) => {
      const p = seg(tt, h0, h0 + 0.95)
      if (p <= 0 || p >= 1) return
      const hd = HEARTS[i]
      PROPS.heartPop(ctx, hd.x, hd.y, t, { p, color: C[hd.c], r: hd.r, id: 's8heart' + i })
    })
    ctx.restore()
  }

  // ── sound ───────────────────────────────────────────────────────────────────────────────────
  function sfx(dur, info) {
    const T = timing(info, dur)
    // approximate screen x of the action, for pan
    const scrX = (wx, tt, f = 1) => {
      const cam = camAt(tt, T)
      const ex = ANCHOR_X + f * (cam.x - ANCHOR_X)
      return (wx - ex) * cam.z + 960
    }
    const cues = []
    const add = (t, type, o = {}) => cues.push(Object.assign({ t: Math.max(0, t), type }, o))
    const px = panOf(scrX(POSTER.x, T.lands[1]))
    add(T.press - 0.45, 'swish', { gain: 0.35, pan: panOf(scrX(BTN.x, T.press)), pitch: 1.2 })
    add(T.press, 'clunk', { gain: 1, pan: panOf(scrX(BTN.x, T.press)) })
    add(T.press + 0.06, 'boing', { gain: 0.35, pitch: 1.35, pan: panOf(scrX(PIP0_X, T.press)) })
    add(T.pageA, 'whoosh', { gain: 0.5, dur: 0.5, pitch: 1.25, pan: -0.2 })
    add(T.pageB, 'thup', { gain: 0.7, pan: panOf(scrX(POSTER.x, T.pageB)) })
    add(T.scrapA + 0.1, 'flurry', { gain: 0.85, dur: T.lands[3] - T.scrapA })
    // the strip zips out from under Pip: a quick swish + his little surprise boing, a tap on landing
    add(T.stripA + 0.02, 'swish', { gain: 0.45, pitch: 1.45, pan: panOf(scrX(PIP0_X - 60, T.stripA)) })
    add(T.dodge, 'boing', { gain: 0.3, pitch: 1.75, pan: panOf(scrX(PIP0_X, T.dodge)) })
    add(T.dodge + T.dodgeDur, 'tap', { gain: 0.35, pitch: 1.2, pan: panOf(scrX(PIP0_X, T.dodge + T.dodgeDur)) })
    ;[1, 1.14, 0.9].forEach((pi, i) => add(T.lands[i], 'squelch', { gain: 0.75, pitch: pi, pan: px + (i - 1) * 0.08 }))
    add(T.lands[3], 'thup', { gain: 0.55, pitch: 1.15, pan: px + 0.1 })
    add(T.point + 0.12, 'blip', { gain: 0.22, pitch: 1.3, pan: px - 0.15 })
    add(T.headA + 0.05, 'pencil', { gain: 0.35, dur: T.headB - T.headA, pan: px - 0.1 })
    add(T.tagA + 0.08, 'slap', { gain: 0.6, pitch: 1.1, pan: px })
    add(T.snap, 'frameSnap', { gain: 1, pan: px })
    add(T.handDown[1], 'paper', { gain: 0.4, dur: 0.25, pan: px })
    add(T.leap0, 'boing', { gain: 0.3, pitch: 1.6, pan: panOf(scrX(PIP0_X, T.leap0)) })
    add(T.land, 'thud', { gain: 0.5, pitch: 1.3, pan: panOf(scrX(POSTER.x, T.land)) })
    add(T.pullA + 0.05, 'whoosh', { gain: 0.45, dur: 0.8, pitch: 0.85, pan: 0.3 })
    add(T.hop0, 'footsteps', { gain: 0.85, dur: T.arrive - T.hop0 + 0.1, pan: -0.15 })
    const sx = signX(T)
    add(T.bilko - 0.12, 'flutter', { gain: 0.35, pitch: 0.9, pan: panOf(scrX(sx + 240 * SIGN.s, T.bilko, SIGN.f)) })
    add(T.hang - 0.02, 'thup', { gain: 0.45, pitch: 0.9, pan: panOf(scrX(SLOT.x, T.hang)) })
    add(T.arrive + 0.03, 'swish', { gain: 0.3, pitch: 0.9, pan: panOf(scrX(SLOT.x + ARRIVE_DX / 2, T.arrive + 0.1)) })
    add(T.pin, 'pin', { gain: 1.1, pan: panOf(scrX(SLOT.x, T.pin)) })
    // accent on top of the score's own full-band hit, which music() below now lands on the push-pin
    add(T.pin, 'bandHit', { gain: 0.35, pan: panOf(scrX(SLOT.x, T.pin)) * 0.5 })
    add(T.hearts[0], 'sparkle', { gain: 0.55, pan: panOf(scrX(HEARTS[0].x, T.hearts[0])) })
    T.hearts.forEach((h, i) => add(h + 0.02, 'pop', { gain: 0.3, pitch: 1.15 + 0.12 * i, pan: panOf(scrX(HEARTS[i].x, h)) }))
    add(T.clap, 'claps', { gain: 0.8, dur: Math.max(0.6, dur - T.clap), pan: 0.15 })
    return cues.filter((c) => c.t < dur)
  }

  /** the build's snare roll resolves on the push-pin thunk (engine → moods[].hit) */
  function music(dur, info) {
    return { hit: timing(info, dur).pin }
  }

  PROMO.scene('s8-showcase', { draw, sfx, music })
})()

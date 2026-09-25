/* s9-endcard.js — the end card and poster frame of the ad. Owner: scene s9.
 *
 * Every beat is resolved from `info` (wordAt / cameoAt / nextBeat): nothing is pinned to the clock.
 *   0 → hit+0.6    the camera pulls back (1.14 → 1) while every prop from the film swipes into a collage
 *                  ring on arcs with overshoot, right side first so it follows the wipe: the torn sun rises
 *                  top-right; the framed poster, the memory card and the DONE stack land on the right; the s1
 *                  terminal card + sticky notes tuck in along the top/bottom edges; the paper moon drops in
 *                  top-left with Pip standing in its cup; the binder tabs, the Chat/Terminal card (flips from
 *                  Terminal to Chat as it lands) and the three agent cards (hopping) land on the left.
 *                  Parallax: ring 1.3x the camera zoom, backdrop 0.35x (plus 0.35x info.camShift).
 *   'session'      = the music's full-band hit: "Session Manager" drops in ransom-note style, one tile per
 *                  32nd note (beat / 8) — each falls spinning, squashes on landing and springs back.
 *   title landed   "one console for Claude Code" writes itself on; Pip claps in the moon.
 *   'build'/'show' crayon "Build it." then "Show it off." write on while Pip points at them; crayon underline
 *                  on 'off' and Pip cheers.
 *   'free'         the terracotta washi strip "free & open · MIT" slaps on; a mitten pats its end down.
 *   'free'+0.14    the black label tape types "npx claude-code-session-manager@latest" (typewriter clacks).
 *   ~'open'        the luggage tag is pinned under the tape and swings (tack + creak).
 *   yay-0.6..-0.3  Pip winds the moon up like a trapeze, crouches; the carriage ding cues his leap across the
 *                  top of the frame (the moon swings back from the push-off); he lands on the "M" on the beat
 *                  before "Yay!" and the tile dips under him.
 *   cameo pip-yay  Pip's bow folds during "Yay!" and holds through the music's button ending, where paper
 *                  confetti pops behind him (ding + pop). Once he is upright his big googly eye rolls all the
 *                  way round. Everything keeps boiling through the ~1.25 s hold (tag + moon sway, agents wave,
 *                  caret blink, sun blinks).
 * Captions cover y > ~970 while the narration runs; everything that must be read sits above y = 930.
 */
;(function () {
  'use strict'
  const C = K.C
  const E = K.ease
  const P = window.PROPS
  const { seg, clamp, lerp } = K
  const W = K.W
  const CX = 960
  const CY = 520

  // ---------- layout (world px at camera zoom 1) ----------
  const TITLE = 'Session Manager'
  const TITLE_Y = 328
  const TITLE_SIZE = 104
  const TITLE_MAXW = 1130
  const SUB_Y = 426
  const CRAYON_Y = 514
  const WASHI_Y = 606
  const TAPE_Y = 702
  const TAG = { x: 988, y: 850, s: 0.72 }
  const MOON = { x: 292, y: -6, len: 82, r: 118 }
  const SUN = { x: 1752, y: 152, r: 88 }
  const PIP_MOON_S = 0.5
  const PIP_TITLE_S = 0.65
  const PIP_LETTER = 8 // Pip lands on the "M"
  const TITLE_FAM = ['chunky', 'marker', 'chunky', 'kalam', 'hand', 'chunky', 'marker', '', 'chunky', 'hand', 'marker', 'chunky', 'kalam', 'chunky', 'marker']
  const TITLE_BG = [C.terracotta, C.butter, C.sage, C.cream, C.hiveTeal, C.honey, C.terracotta, null, C.hiveTeal, C.butter, C.terracotta, C.sage, C.honey, C.cream, C.terracotta]
  const DARK_BG = [C.terracotta, C.sage, C.hiveTeal]
  const NOTES = [65, 67, 69, 72, 74, 77, 79, 72, 74, 77, 79, 81, 84, 86] // F-major pentatonic climb
  // crescent geometry of PROPS.moonOnThread (outer r, inner 0.84r offset (0.46r, -0.2r)): the upper horn tip
  // it hangs from, and the bottom of its cup where Pip stands (both relative to the outer disc centre, in r)
  const MOON_TIP = [0.1646, -0.9863]
  const MOON_CUP = [0.46, 0.64]

  const pan = (x) => clamp((x / W) * 2 - 1, -1, 1) * 0.8
  const easeIn2 = (p) => p * p

  /** Every beat time of the scene, from the narration / cameo / beat grid. Pure. */
  function plan(info, dur) {
    const beat = info.beat || 0.58
    const hit = info.wordAt('session', 0.5)
    const build = info.wordAt('build', hit + 1.43)
    const show = info.wordAt('show', build + 0.52)
    const off = info.wordAt('off', show + 0.38)
    const free = info.wordAt('free', off + 0.53)
    const open = info.wordAt('open', free + 0.56)
    const yay = info.cameoAt('pip-yay', Math.min(dur - 1.6, open + 0.8))
    const stag = beat / 8
    const lastLand = hit + 13 * stag
    const sub0 = lastLand - 0.1
    const sub1 = Math.min(build - 0.1, sub0 + 0.5)
    // the mitten pats the washi down (peak ≈ free + 0.03) and is out of frame by free + 0.26, before the tape's
    // first characters, so only one thing moves at a time
    const tape0 = free + 0.26
    const tape1 = Math.max(tape0 + 0.5, yay - 0.6) // the carriage ding is Pip's cue to leap
    const tag0 = Math.max(free + 0.35, tape1 - 0.34)
    let land = info.nextBeat ? info.nextBeat(yay - 0.3) : yay - 0.19
    if (land > yay - 0.1 || land < tape1 - 0.2) land = yay - 0.19
    const jump = land - 0.36
    const wind0 = jump - 0.5 // trapeze wind-up on the moon: back-swing, then forward swing → release
    const crouch = jump - 0.3
    // two landing frames (cheer → clap arms) before the bow; the fold (bow0 + 0.1 → + 0.4) happens during "Yay!"
    const bow0 = Math.max(land + 0.13, yay - 0.1)
    let button = info.nextBeat ? info.nextBeat(yay + 0.22) : bow0 + 0.45
    if (button > dur - 0.6) button = bow0 + 0.45
    // the googly-eye roll is secondary action on the bow's rise overshoot, and leaves the last ~0.2 s still
    // (PIP eases eyeSpin itself, so pass it linear)
    const spin1 = dur - 0.2
    const spin0 = Math.max(bow0 + 0.95, spin1 - 0.62)
    return { beat, hit, build, show, off, free, open, yay, stag, lastLand, sub0, sub1, tape0, tape1, tag0, land, jump, wind0, crouch, bow0, button, spin0, spin1, fall: 0.24, camEnd: hit + 0.6, moon0: -0.02, moon1: 0.55 }
  }

  // ---------- title (ransom note that drops in) ----------
  function titleLayout(ctx) {
    const specs = []
    let total = 0
    for (let i = 0; i < TITLE.length; i++) {
      const ch = TITLE[i]
      const r = K.rng('s9title', i)
      const fam = TITLE_FAM[i] || 'chunky'
      const sz = TITLE_SIZE * (0.9 + r() * 0.2)
      let w = TITLE_SIZE * 0.3
      if (ch !== ' ') {
        K.font(ctx, fam, sz, fam === 'chunky' ? '600' : '')
        w = ctx.measureText(ch).width + sz * 0.34
      }
      specs.push({ ch, fam, sz, w, h: sz * 1.1, rot: (r() - 0.5) * 0.21, dy: (r() - 0.5) * TITLE_SIZE * 0.1, spin: (r() - 0.5) * 1.3, fall: 0 })
      total += w
    }
    const gap = 7
    total += gap * (TITLE.length - 1)
    const fit = Math.min(1, TITLE_MAXW / total)
    let x = CX - (total * fit) / 2
    let k = 0
    for (const s of specs) {
      s.w *= fit
      s.sz *= fit
      s.h *= fit
      s.dy *= fit
      s.x = x + s.w / 2
      s.y = TITLE_Y + s.dy
      // drop from fully above the frame (even under the opening 1.14x zoom): the first frame is off-screen
      s.fall = s.y + s.h + 60 + K.rng('s9fall', s.k = s.ch === ' ' ? -1 : k++)() * 70
      x += s.w + gap * fit
    }
    return specs
  }
  /** How far Pip's bow is folded (mirrors PIP's 'bow' pose: down 0.1 → 0.4, rises 0.9 → 1.2 with overshoot < 0). */
  function bowFold(t, T) {
    const q = t - T.bow0
    if (q <= 0) return 0
    return E.inOutCubic(seg(q, 0.1, PIP.BOW.down)) * (1 - E.outBack(seg(q, 0.9, PIP.BOW.up)))
  }
  /** Extra settle of the tiles under Pip when he lands on the "M" (and the "M" dips again as he bows). */
  function landDip(i, t, T) {
    const u = t - T.land + 0.002
    if (u < 0) return 0
    const f = i === PIP_LETTER ? 1 : i === PIP_LETTER + 1 || i === PIP_LETTER - 2 ? 0.3 : 0
    return f * (15 * Math.exp(-7 * u) * Math.cos(17 * u) + 3 * (1 - Math.exp(-6 * u)) + 6 * bowFold(t, T))
  }
  function drawLetter(ctx, s, i, t, T) {
    if (s.ch === ' ') return
    const tl = T.hit + s.k * T.stag
    const u = t - tl
    if (u < -T.fall) return
    let dy = 0
    let rot = s.rot
    let sx = 1
    let sy = 1
    let lift = 0
    if (u < 0) {
      const e = easeIn2(1 + u / T.fall)
      dy = -s.fall * (1 - e)
      rot = s.rot + s.spin * (1 - e)
      // paper-swipe stretch along the fall, strongest when fastest (just before the hit)
      sy = 1.1 + 0.18 * e
      sx = 1 / Math.sqrt(sy)
      lift = 10 + 14 * (1 - e)
    } else {
      const d = Math.exp(-10 * u)
      const q = 0.3 * d * Math.cos(24 * u)
      sy = 1 - q
      sx = 1 + q * 0.7
      dy = -13 * Math.exp(-8 * u) * Math.max(0, Math.sin(19 * u - 1.2))
      rot = s.rot + 0.07 * d * Math.sin(17 * u)
    }
    const n = K.nudge('s9L' + i, t, 0.55)
    const bg = TITLE_BG[i]
    K.at(ctx, s.x + n.dx, s.y + dy + n.dy + landDip(i, t, T), rot + n.rot, 1, () => {
      ctx.translate(0, s.h / 2)
      ctx.scale(sx, sy)
      ctx.translate(0, -s.h / 2)
      K.paper(ctx, K.boxPts(s.w, s.h), bg, { seed: 's9L' + i, cut: 3, shadow: 0.9, lift })
      K.font(ctx, s.fam, s.sz, s.fam === 'chunky' ? '600' : '')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = DARK_BG.includes(bg) ? C.paperWhite : bg === C.cream ? C.terracotta : C.ink
      ctx.fillText(s.ch, 0, s.sz * 0.05)
    })
  }
  /** World point on top of the "M" tile where Pip's feet go (settled tile + boil + landing dip). */
  function letterTop(s, i, t, T) {
    const n = K.nudge('s9L' + i, t, 0.55)
    const rot = s.rot + n.rot
    return { x: s.x + n.dx + Math.sin(rot) * s.h * 0.5, y: s.y + n.dy + landDip(i, t, T) - Math.cos(rot) * s.h * 0.5, rot }
  }

  // ---------- the collage ring ----------
  /** A ring piece swiping in from off-frame along an arc, landing with overshoot + a settle wobble. */
  function swipe(t, it) {
    const p = seg(t, it.t0, it.t0 + (it.d || 0.5))
    if (p <= 0) return null
    const e = E.outBack(p)
    const k = 1 - e
    const u = t - it.t0 - (it.d || 0.5)
    const settle = u > 0 ? 0.05 * Math.exp(-7 * u) * Math.sin(16 * u) : 0
    return {
      dx: it.from[0] * 720 * k + -it.from[1] * 120 * Math.sin(p * Math.PI) * (it.arc || 1),
      dy: it.from[1] * 720 * k + it.from[0] * 120 * Math.sin(p * Math.PI) * (it.arc || 1),
      rot: it.rot + it.spin * k + settle,
      sq: p < 1 ? 1 : 1 - 0.06 * Math.exp(-9 * u) * Math.cos(20 * u),
    }
  }
  function ringAt(ctx, t, kr, it, fn) {
    const s = swipe(t, it)
    if (!s) return
    const x = CX + (it.x - CX) * kr + s.dx
    const y = CY + (it.y - CY) * kr + s.dy
    K.at(ctx, x, y, s.rot, [1 / Math.sqrt(s.sq), s.sq], () => fn(ctx, t))
  }
  const RING = [
    { id: 'poster', x: 1742, y: 398, rot: 0.075, t0: -0.14, from: [0.95, -0.3], spin: 0.7, draw: (ctx, t) => P.posterPage(ctx, 0, 0, t, { scale: 0.33, frame: 1, tag: 0, id: 's9poster' }) },
    { id: 'memo', x: 1770, y: 676, rot: -0.1, t0: -0.1, from: [1, 0.1], spin: -0.8, draw: (ctx, t) => P.memoryCard(ctx, 0, 0, t, { scale: 0.78, color: 'butter', id: 's9memo' }) },
    { id: 'done', x: 1748, y: 958, rot: 0.06, t0: -0.06, from: [0.8, 0.6], spin: 0.6, draw: (ctx, t) => P.doneStack(ctx, 0, 0, t, { n: 3, stamped: 3, scale: 0.68, id: 's9done' }) },
    {
      id: 'tabs',
      x: 168,
      y: 448,
      rot: -0.08,
      t0: 0.12,
      from: [-1, -0.15],
      arc: -1,
      spin: -0.7,
      draw: (ctx, t) => {
        P.folderTab(ctx, -12, -76, t, { label: 'Home', color: 'butter', id: 's9tab1' })
        P.folderTab(ctx, 14, 0, t, { label: 'garden-app', icon: 'leaf', color: 'sage', id: 's9tab2' })
        P.folderTab(ctx, -2, 76, t, { label: 'recipe-bot', icon: 'bowl', color: 'peach', id: 's9tab3' })
      },
    },
    { id: 'term', x: 640, y: 30, rot: -0.13, t0: -0.04, from: [0.1, -1], spin: -0.5, draw: (ctx, t) => P.terminalCard(ctx, 0, 0, t, { scale: 0.6, scribbles: 2, id: 's9term' }) },
    { id: 'stickyT', x: 1386, y: 26, rot: 0.16, t0: -0.12, from: [0.2, -1], spin: 0.6, draw: (ctx, t) => P.stickyNote(ctx, 0, 0, t, { size: 130, color: 'pink', curl: 0.5, id: 's9stT' }) },
    { id: 'stickyB', x: 1530, y: 1052, rot: -0.2, t0: -0.02, from: [0.3, 1], spin: -0.5, draw: (ctx, t) => {
        P.stickyNote(ctx, 0, 0, t, { size: 130, color: 'sage', curl: 0.4, id: 's9stB' })
        K.pencil.curve(ctx, [[-30, -22], [-12, -6], [26, -46]], 's9stBck', t, { stroke: C.paperWhite, strokeWidth: 6, roughness: 1 })
      },
    },
    { id: 'chat', x: 196, y: 700, rot: 0.06, t0: 0.26, from: [-1, 0.2], arc: -1, spin: -0.5, chat: true },
  ]
  const AGENTS = [
    { kind: 'architect', x: 92, t0: 0.22 },
    { kind: 'devlead', x: 206, t0: 0.26 },
    { kind: 'validator', x: 318, t0: 0.3 },
  ]

  // ---------- Pip ----------
  /** Pip's world position / pose for time t. `moonSeat` = { x, y, rot } of the cup in world space (now). */
  function pipState(t, T, seat, top) {
    const S0 = moonSeatAt(T)
    if (t < T.jump) {
      const st = { x: seat.x, y: seat.y, rot: seat.rot, scale: PIP_MOON_S, onMoon: true, pose: 'idle', poseT: t, look: [0.7, 0.35], mouth: null, eyes: null, brows: null, squash: null }
      if (t < T.moon1 - 0.15) {
        st.mouth = 'o'
        st.eyes = 'wide'
        st.look = [0.2, -0.6]
      } else if (t < T.hit) {
        st.mouth = 'grin'
        st.look = [0.8, 0.4]
      } else if (t < T.lastLand + 0.12) {
        st.eyes = 'wide'
        st.mouth = 'o'
        st.look = [0.9, 0.35]
      } else if (t < T.build - 0.12) {
        st.pose = 'clap'
        st.poseT = t - (T.lastLand + 0.12)
        st.look = [0.6, 0.5]
      } else if (t < T.off) {
        st.pose = 'point'
        st.aim = 0.42
        st.poseT = t >= T.show - 0.06 ? t - (T.show - 0.06) : t - (T.build - 0.12)
        st.look = [0.8, 0.6]
        st.mouth = 'grin'
      } else if (t < T.free - 0.08) {
        st.pose = 'cheer'
        st.poseT = t - T.off
      } else if (t < T.crouch - 0.15) {
        st.pose = 'clap'
        st.poseT = t - (T.free - 0.08)
        st.look = [0.8, 0.7]
      } else {
        // anticipation: eyes on the "M", determined brows, crouch
        st.look = [1, 0.25]
        st.brows = 'determined'
        st.mouth = 'flat'
        st.squash = lerp(1, 0.8, E.outQuad(seg(t, T.crouch, T.jump - 0.03)))
      }
      return st
    }
    const S1 = { x: top.x, y: top.y }
    if (t < T.land - 0.002) {
      const fd = T.land - T.jump
      const p = seg(t, T.jump, T.land)
      const hgt = 64
      const x = lerp(S0.x, S1.x, p)
      const y = lerp(S0.y, S1.y, p) - hgt * 4 * p * (1 - p)
      const vx = (S1.x - S0.x) / fd
      const vy = (S1.y - S0.y - hgt * 4 * (1 - 2 * p)) / fd
      const sq = p < 0.25 ? lerp(1.18, 1.02, p / 0.25) : p < 0.75 ? 1.02 : lerp(1.02, 1.08, (p - 0.75) / 0.25)
      return { x, y, rot: 0.16 * Math.sin(p * Math.PI) + lerp(S0.rot, top.rot, p), scale: lerp(PIP_MOON_S, PIP_TITLE_S, E.inOutQuad(p)), pose: 'cheer', poseT: t - T.jump, look: [1, 0.3], mouth: 'open', eyes: 'wide', squash: sq, vel: [vx, vy], air: true }
    }
    const st = { x: S1.x, y: S1.y, rot: top.rot * 0.8, scale: PIP_TITLE_S, pose: 'idle', poseT: t - T.land, look: [0, 0.15], mouth: 'grin', eyes: null, squash: null }
    const u = Math.max(0, t - T.land)
    if (t < T.bow0) {
      // deep landing squash (still visible on the 2nd frame); the arms follow through: up (cheer, grounded
      // phase of its hop) → out in front (clap, hands apart) → down at the sides (the bow's rise)
      st.squash = 1 - 0.28 * Math.exp(-7 * u) * Math.cos(16 * u)
      st.look = [0.1, 0.25]
      if (u < 0.05) {
        st.pose = 'cheer'
        st.poseT = 0.46
        st.mouth = 'open'
      } else {
        st.pose = 'clap'
        st.poseT = 0
      }
    } else {
      const d = bowFold(t, T)
      st.pose = 'bow'
      st.poseT = t - T.bow0
      // a slight lean into the fold toward the out-swept arm, so the bow reads as a gesture front-on
      st.rot = top.rot * 0.8 - 0.15 * d
      st.fold = d
      st.mouth = t < T.yay + 0.45 ? 'open' : 'grin'
      if (t > T.spin0 - 0.15) st.blink = 0
      st.eyeSpin = seg(t, T.spin0, T.spin1)
      if (st.eyeSpin >= 1) st.eyeSpin = 0
      st.look = [0, 0.1]
    }
    return st
  }
  /** Extra moon angle (radians, + swings left): trapeze wind-up before the leap, push-off after it. */
  function moonAngle(t, T) {
    if (t < T.wind0) return 0
    if (t < T.jump) return 0.2 * Math.sin(1.5 * Math.PI * seg(t, T.wind0, T.jump))
    const u = t - T.jump
    return Math.exp(-2.4 * u) * (-0.2 * Math.cos(5.2 * u) + 0.26 * Math.sin(5.2 * u))
  }
  /** Cup of the moon at the take-off instant (sway faded out, drop done, zoom 1) — Pip's launch point. */
  function moonSeatAt(T) {
    const r = MOON.r
    const a = moonAngle(T.jump - 1e-4, T)
    const lx = (MOON_CUP[0] - MOON_TIP[0]) * r
    const ly = MOON.len + (MOON_CUP[1] - MOON_TIP[1]) * r
    return { x: MOON.x + lx * Math.cos(a) - ly * Math.sin(a), y: MOON.y + lx * Math.sin(a) + ly * Math.cos(a), rot: a }
  }
  function drawPip(ctx, t, st) {
    return PIP.draw(ctx, st.x, st.y, t, {
      id: 'pip',
      scale: st.scale,
      rot: st.rot,
      pose: st.pose,
      poseT: Math.max(0, st.poseT),
      look: st.look,
      mouth: st.mouth || undefined,
      eyes: st.eyes || undefined,
      brows: st.brows || undefined,
      squash: st.squash,
      aim: st.aim,
      vel: st.vel,
      shadow: !st.air && !st.onMoon,
      eyeSpin: st.eyeSpin || 0,
      blink: st.blink === undefined ? null : st.blink,
    })
  }

  /** Cartoon motion marks for the bow: crayon "( )" brackets beside the head tracing its drop as the card folds
   *  (anchored to where the head WAS, in Pip's ground frame), then a 3-tick sparkle at the out-swept hand when
   *  the bow bottoms out — they make the fold read as a gesture front-on. */
  function bowMarks(ctx, t, T, st, a) {
    const q = t - T.bow0
    if (q < 0.1 || q > 0.85) return
    const fa = seg(q, 0.12, 0.2) * (1 - seg(q, 0.44, 0.58))
    if (fa > 0.02) {
      K.withAlpha(ctx, fa, () =>
        K.at(ctx, st.x, st.y, st.rot, st.scale, () => {
          const grow = E.outCubic(seg(q, 0.12, 0.36))
          for (const sgn of [-1, 1]) {
            const pts = []
            for (let k = 0; k <= 5; k++) {
              const v = (k / 5) * grow
              pts.push([sgn * (104 + 22 * Math.sin(Math.PI * v)), -262 + 74 * v])
            }
            if (grow > 0.08) K.pencil.curve(ctx, pts, 's9bowarc' + sgn, t, { stroke: C.inkDim, strokeWidth: 4.5, roughness: 0.9, bowing: 0.3 })
            const tk = [sgn * 70, -284]
            if (grow > 0.4) K.pencil.line(ctx, tk[0], tk[1], tk[0] + sgn * 14, tk[1] - 20, 's9bowtk' + sgn, t, { stroke: C.inkDim, strokeWidth: 4, roughness: 0.8 })
          }
        })
      )
    }
    const fs = seg(q, 0.34, 0.42) * (1 - seg(q, 0.7, 0.85))
    if (fs > 0.02 && a && a.hands && a.hands[0]) {
      const [x, y] = a.hands[0]
      K.withAlpha(ctx, fs, () => K.sparkle(ctx, x - 20, y - 18, 17 + 4 * fs, 's9bowsp', t, { n: 3, color: C.terracotta, w: 3.2 }))
    }
  }

  // ---------- small local pieces ----------
  function drawCrayon(ctx, t, T) {
    const size = 80
    const a = 'Build it.'
    const b = 'Show it off.'
    K.font(ctx, 'marker', size)
    const wa = ctx.measureText(a).width
    const wb = ctx.measureText(b).width
    const gap = 34
    const x0 = CX - (wa + gap + wb) / 2
    const ink = K.paperPattern(ctx, '#b3552e')
    const ra = seg(t, T.build - 0.05, T.build + 0.3)
    const rb = seg(t, T.show - 0.05, T.off + 0.18)
    if (ra > 0) K.hand(ctx, a, x0, CRAYON_Y, { family: 'marker', size, color: ink, align: 'left', t, id: 's9cra', jitter: 0.8, reveal: ra })
    if (rb > 0) K.hand(ctx, b, x0 + wa + gap, CRAYON_Y, { family: 'marker', size, color: ink, align: 'left', t, id: 's9crb', jitter: 0.8, reveal: rb })
    // waxy crayon underline under "Show it off." on 'off'
    const up = E.outQuad(seg(t, T.off + 0.06, T.off + 0.3))
    if (up > 0) {
      const xs = x0 + wa + gap - 6
      const xe = xs + Math.min((wb + 16) * up, wb * rb + 16)
      const pts = []
      const n = Math.max(2, Math.round(10 * up))
      for (let i = 0; i <= n; i++) {
        const x = lerp(xs, xe, i / n)
        pts.push([x, CRAYON_Y + 20 + Math.sin((x - xs) * 0.03) * 5])
      }
      K.pencil.curve(ctx, pts, 's9ul', t, { stroke: C.terracotta, strokeWidth: 6, roughness: 1.4, bowing: 0.6 })
      K.pencil.curve(ctx, pts.map(([x, y]) => [x + 3, y + 4]), 's9ul2', t, { stroke: 'rgba(232,169,136,0.8)', strokeWidth: 3, roughness: 1.8, bowing: 0.6 })
    }
  }
  function washiWidth(ctx) {
    K.font(ctx, 'chunky', 42, '600')
    return ctx.measureText('free & open · MIT').width + 42 * 2.2
  }
  function drawMitten(ctx, t, T, ww) {
    const tip = [CX + ww / 2 + 2, WASHI_Y - 14] // pats the torn right end down, clear of the lettering
    const a0 = T.free - 0.3
    const a1 = T.free - 0.04
    const l0 = T.free + 0.08
    const l1 = T.free + 0.28
    if (t < a0 || t > l1) return
    const inP = E.outCubic(seg(t, a0, a1))
    const outP = E.inQuad(seg(t, l0, l1))
    const off = 820 * (1 - inP) + 900 * outP
    const press = Math.sin(Math.PI * seg(t, T.free - 0.04, T.free + 0.1))
    CAST.hand(ctx, tip[0] + off, tip[1] - 30 * (1 - inP) - 90 * outP, t, { from: 'right', pose: 'press', press, mitten: true, id: 's9mitt' })
  }
  function tagHook(ctx) {
    K.font(ctx, 'hand', 48)
    const tw = Math.max(ctx.measureText('bilko.run/products/').width, ctx.measureText('session-manager').width + 24)
    const w = tw + 200
    return [TAG.x + (-w / 2 + 52 - 46) * TAG.s, TAG.y - 124 * TAG.s]
  }
  function drawTag(ctx, t, T) {
    const u = t - T.tag0
    if (u < 0) return
    const hk = tagHook(ctx)
    const pop = lerp(0.4, 1, E.outBack(seg(u, 0, 0.2)))
    // pinned, then it swings: first downward (clockwise), never far enough back up to touch the tape
    const ang = 0.24 * Math.exp(-3.6 * u) * Math.cos(7.4 * u)
    K.at(ctx, hk[0], hk[1], ang, pop, () => {
      ctx.translate(-hk[0], -hk[1])
      P.luggageTag(ctx, TAG.x, TAG.y, t, { scale: TAG.s, id: 's9tag', swing: 1 })
    })
  }
  function drawTape(ctx, t, T) {
    if (t < T.tape0 - 0.1) return
    const pop = E.outBack(seg(t, T.tape0 - 0.1, T.tape0 + 0.04))
    const reveal = seg(t, T.tape0, T.tape1)
    K.at(ctx, CX, TAPE_Y, 0.006, [lerp(0.7, 1, pop), pop], () => P.tapeTyper(ctx, 0, 0, t, { reveal, size: 40, id: 's9tape' }))
  }
  const CONF_COLORS = [C.terracotta, C.butter, C.sage, C.hiveTeal, C.peach, C.honey, C.sky, C.pink, C.mint, C.lemon]
  const CONF_N = 16 // chips per burst (two bursts)
  /** Paper confetti: two bursts on the music's button (button, button + beat/2) behind Pip and the type, cut chips
   *  and dots with a white cut edge that tumble (scaleY flip) and drift down, plus crayon-curled paper streamers.
   *  A doodle puff sells the "pop" at the origin. */
  function drawConfetti(ctx, t, T, org, dur) {
    const b0 = T.button
    if (t < b0 || t > dur + 0.05) return
    const bursts = [b0, b0 + T.beat / 2]
    const ga = ctx.globalAlpha
    // the pop itself
    P.doodlePuff(ctx, org.x, org.y + 10, t, { p: seg(t, b0 - 0.01, b0 + 0.36), r: 64, id: 's9puff', color: C.inkDim })
    bursts.forEach((bt, bi) => {
      const u = t - bt
      if (u < 0) return
      const life = Math.min(1.12, dur - 0.04 - bt)
      if (u > life) return
      // pieces drift off into depth at the end (shrink + fade together), so the poster frame ends clean
      const a = 1 - E.inQuad(seg(u, life * 0.6, life))
      const dep = 0.45 + 0.55 * a
      const g = 300 // low gravity: paper floats
      for (let i = 0; i < CONF_N; i++) {
        const r = K.rng('s9conf', bi, i)
        const ang = -Math.PI / 2 + (r() - 0.5) * (bi ? 3.3 : 2.7)
        const sp = 580 + r() * 480
        const k = 2.15
        const f = (1 - Math.exp(-k * u)) / k
        const x = org.x + Math.cos(ang) * sp * f + Math.sin(u * 7 + i) * 14 * Math.min(1, u * 3)
        const y = org.y + Math.sin(ang) * sp * f + g * u * u * (0.7 + r() * 0.6)
        const spin = r() * 6 + u * (r() - 0.5) * 14
        const tumble = Math.cos(u * (8 + r() * 8) + r() * 6)
        const s = Math.min(1, 0.35 + u * 8) * dep
        const round = (i + bi) % 3 === 0
        const col = CONF_COLORS[(i * 3 + bi * 5) % CONF_COLORS.length]
        const w = 22 + r() * 8
        const h = 13 + r() * 5
        ctx.globalAlpha = ga * a
        K.at(ctx, x, y, spin, [s, s * (0.25 + 0.75 * Math.abs(tumble))], () => {
          ctx.fillStyle = 'rgba(58,36,14,0.2)'
          ctx.beginPath()
          if (round) ctx.arc(2, 3, 10, 0, Math.PI * 2)
          else ctx.rect(-w / 2 + 2, -h / 2 + 3, w, h)
          ctx.fill()
          // the white core showing at the cut edge
          ctx.fillStyle = 'rgba(255,252,242,0.95)'
          ctx.beginPath()
          if (round) ctx.arc(-1.2, -1.2, 10, 0, Math.PI * 2)
          else ctx.rect(-w / 2 - 1.5, -h / 2 - 1.5, w, h)
          ctx.fill()
          ctx.fillStyle = col
          ctx.beginPath()
          if (round) ctx.arc(0, 0, 10, 0, Math.PI * 2)
          else ctx.rect(-w / 2, -h / 2, w, h)
          ctx.fill()
          if (tumble < 0) {
            // the back of the paper is a shade darker
            ctx.fillStyle = 'rgba(40,24,8,0.16)'
            ctx.fill()
          }
        })
      }
      ctx.globalAlpha = ga
      // curled paper streamers (heavier drag, they unfurl as they fly)
      const NS = bi ? 2 : 3
      for (let j = 0; j < NS; j++) {
        const r = K.rng('s9str', bi, j)
        const ang = -Math.PI / 2 + (j - (NS - 1) / 2) * (bi ? 1.9 : 1.1) + (r() - 0.5) * 0.4
        const sp = 520 + r() * 300
        const k = 2.8
        const f = (1 - Math.exp(-k * u)) / k
        const x = org.x + Math.cos(ang) * sp * f
        const y = org.y + Math.sin(ang) * sp * f + 180 * u * u
        const unf = seg(u, 0, 0.5)
        const col = (j + bi) % 2 ? C.hiveTeal : C.terracotta
        const len = 70 + 40 * unf
        const pts = []
        for (let m = 0; m <= 7; m++) {
          const v = m / 7
          const curl = (1 - unf) * 2.4 + 0.9
          pts.push([(v - 0.5) * len, Math.sin(v * Math.PI * curl + u * 9 + j) * (14 - 5 * unf)])
        }
        K.withAlpha(ctx, a, () =>
          K.at(ctx, x, y, ang + Math.PI / 2 + Math.sin(u * 5 + j) * 0.5, Math.min(1, 0.4 + u * 7) * dep, () => {
            K.pencil.curve(ctx, pts.map(([px, py]) => [px + 2, py + 3]), 's9strs' + bi + j, t, { stroke: 'rgba(58,36,14,0.2)', strokeWidth: 8, roughness: 0.5, bowing: 0.3 })
            K.pencil.curve(ctx, pts, 's9str' + bi + j, t, { stroke: col, strokeWidth: 8, roughness: 0.6, bowing: 0.3 })
          })
        )
      }
    })
  }

  PROMO.scene('s9-endcard', {
    draw(ctx, tRaw, dur, info) {
      const t = clamp(tRaw, 0, dur)
      const T = plan(info, dur)
      const cs = info.camShift ? info.camShift(tRaw) : { dx: 0, dy: 0 }
      const z = 1 + 0.14 * (1 - E.outCubic(seg(t, 0, T.camEnd)))
      const kr = 1 + (z - 1) * 1.3

      // far layer: clean paper, moves least during the pull-back
      const zb = 1 + (z - 1) * 0.35
      K.at(ctx, CX - cs.dx * 0.35, CY - cs.dy * 0.35, 0, zb, () => {
        ctx.translate(-CX, -CY)
        K.backdrop(ctx, C.paper)
        P.coffeeRing(ctx, 548, 912, t, { r: 62, alpha: 0.45, id: 's9ring' }) // an old friend from the desk in s1
      })

      ctx.save()
      ctx.translate(CX, CY)
      ctx.scale(z, z)
      ctx.translate(-CX, -CY)
      const specs = titleLayout(ctx)
      const mTop = letterTop(specs[PIP_LETTER], PIP_LETTER, t, T)

      // who everyone is looking at
      let focus = [CX, 330]
      if (t >= T.sub0) focus = [CX, SUB_Y]
      if (t >= T.build - 0.1) focus = [CX, CRAYON_Y]
      if (t >= T.free - 0.1) focus = [CX, WASHI_Y]
      if (t >= T.tape0) focus = [CX + 200, TAPE_Y]
      if (t >= T.crouch) focus = [mTop.x, mTop.y - 60]

      // sun (top-right) rises behind the ring and watches the action
      {
        const sx = CX + (SUN.x - CX) * kr
        const sy = CY + (SUN.y - CY) * kr
        const dx = focus[0] - SUN.x
        const dy = focus[1] - SUN.y
        const dl = Math.hypot(dx, dy) || 1
        P.paperSun(ctx, sx, sy, t, { r: SUN.r, rise: seg(t, -0.15, 0.6), dist: 330, face: t >= T.button ? 'happy' : 'awake', look: [(dx / dl) * 0.9, (dy / dl) * 0.9], id: 's9sun' })
      }

      // right side of the ring (lands first, following the wipe)
      for (const it of RING) {
        if (it.chat) continue
        ringAt(ctx, t, kr, it, it.draw)
      }

      // Pip's leap trail: drawn before the moon so the crescent covers the lines at take-off
      if (t >= T.jump && t < T.land - 0.002) {
        const st = pipState(t, T, null, mTop)
        const hd = Math.atan2(st.vel[1], st.vel[0])
        P.speedLines(ctx, st.x - Math.cos(hd) * 60, st.y - 70 - Math.sin(hd) * 60, t, { dir: hd, len: 110, n: 3, spread: 70, p: seg(t, T.jump + 0.03, T.jump + 0.14) })
      }

      // moon (top-left) drops in on its thread with Pip standing in its cup
      let seat = null
      {
        const mx = CX + (MOON.x - CX) * kr
        const my = CY + (MOON.y - CY) * kr
        const drop = seg(t, T.moon0, T.moon1)
        // idle sway fades out, Pip swings the moon like a trapeze and lets go on the forward swing;
        // the push-off swings it back (+ = left), then the sway returns
        const sw = 1 - seg(t, T.wind0 - 0.3, T.wind0) + seg(t, T.land + 0.3, T.land + 1.2)
        K.at(ctx, mx, my, 0, 1, () => {
          const m = P.moonOnThread(ctx, 0, 0, t, { r: MOON.r, len: MOON.len, drop, swing: sw, angle: moonAngle(t, T), id: 's9moon' })
          if (t < T.jump && drop > 0 && m && m.moon && m.hook) {
            const v = [m.moon[0] - m.hook[0], m.moon[1] - m.hook[1]]
            const th = Math.atan2(v[1], v[0]) - Math.atan2(-MOON_TIP[1], -MOON_TIP[0])
            const c = Math.cos(th)
            const s = Math.sin(th)
            const ox = MOON_CUP[0] * MOON.r
            const oy = MOON_CUP[1] * MOON.r
            seat = { x: m.moon[0] + c * ox - s * oy, y: m.moon[1] + s * ox + c * oy, rot: th }
            drawPip(ctx, t, pipState(t, T, seat, mTop))
          }
        })
      }

      // left side of the ring
      for (const it of RING) {
        if (!it.chat) continue
        ringAt(ctx, t, kr, it, (g, tt) => {
          const s = swipe(tt, it)
          const p = seg(tt, it.t0 + 0.2, it.t0 + 0.52)
          // it spins in showing Terminal, flips round (once the wipe has uncovered it) and lands on Chat
          P.chatTermCard(g, 0, 0, tt, { scale: 0.5, flip: lerp(1, 2, E.inOutCubic(p)), yarnLen: 120, id: 's9chat', swing: s ? (s.rot - it.rot) * 0.4 : 0 })
        })
      }
      for (const a of AGENTS) {
        const it = { x: a.x, y: 1040, rot: 0, t0: a.t0, from: [-0.9, 0.45], arc: 0.25, spin: -0.4, d: 0.45 }
        ringAt(ctx, t, kr, it, (g, tt) => {
          let pose = 'idle'
          let poseT = tt
          if (tt < a.t0 + 0.75) pose = 'hop'
          else if (tt >= T.button) {
            pose = 'wave'
            poseT = tt - T.button
          }
          const lx = (focus[0] - a.x) / 900
          CAST.agent(g, 0, 0, tt, { kind: a.kind, scale: 0.5, pose, poseT, look: [clamp(lx, -1, 1), -0.35], id: 's9ag' + a.kind })
        })
      }

      // paper confetti pops out behind Pip on the button ending (behind the type as well)
      drawConfetti(ctx, t, T, { x: mTop.x, y: mTop.y - 118 }, dur)

      // centre: clean paper, the type, the install line, the tag
      specs.forEach((s, i) => drawLetter(ctx, s, i, t, T))
      if (t >= T.sub0) K.hand(ctx, 'one console for Claude Code', CX, SUB_Y, { family: 'hand', size: 54, color: C.inkDim, t, id: 's9sub', jitter: 0.6, reveal: seg(t, T.sub0, T.sub1) })
      drawCrayon(ctx, t, T)
      const ww = washiWidth(ctx)
      P.washiLabel(ctx, CX, WASHI_Y, t, { slap: seg(t, T.free - 0.22, T.free + 0.18), rot: -0.022, id: 's9washi' })
      drawTag(ctx, t, T) // hangs from its pin just under the tape (tape layered over it if they touch)
      drawTape(ctx, t, T)
      drawMitten(ctx, t, T, ww)

      // Pip off the moon: the leap, the landing on the "M", the bow; confetti pops behind him
      if (t >= T.jump) {
        const st = pipState(t, T, seat, mTop)
        const anchors = drawPip(ctx, t, st)
        if (t >= T.bow0) bowMarks(ctx, t, T, st, anchors)
      }
      ctx.restore()
    },

    sfx(dur, info) {
      const T = plan(info, dur)
      const out = []
      const add = (t, type, o = {}) => {
        if (t >= 0 && t < dur) out.push(Object.assign({ t: +t.toFixed(3), type }, o))
      }
      // collage whoosh cascade (right → left, behind the wipe)
      add(0.02, 'whoosh', { gain: 0.65, pan: 0.6, pitch: 1.06 })
      add(0.13, 'whoosh', { gain: 0.55, pan: 0.05, pitch: 0.94 })
      add(0.3, 'whoosh', { gain: 0.6, pan: -0.55, pitch: 1.16 })
      add(T.moon0 + 0.42, 'boing', { gain: 0.35, pitch: 1.45, pan: pan(MOON.x) })
      add(0.62, 'flip', { gain: 0.35, pitch: 1.15, pan: pan(196) }) // the Chat/Terminal card turns over to Chat
      // letter-drop pops, one per tile, climbing the scale (first one rides the band hit)
      let k = 0
      for (let i = 0; i < TITLE.length; i++) {
        if (TITLE[i] === ' ') continue
        add(T.hit + k * T.stag, 'letterPop', { note: NOTES[k], gain: k === 0 ? 0.7 : 0.48 + 0.02 * (k % 3), pan: pan(CX + (i - 7) * 76) })
        k++
      }
      add(T.sub0, 'pencil', { dur: Math.max(0.3, T.sub1 - T.sub0), gain: 0.3, pan: 0 })
      add(T.build - 0.04, 'pencil', { dur: 0.32, gain: 0.4, pan: -0.15 })
      add(T.build - 0.1, 'blip', { gain: 0.3, pitch: 1.2, pan: pan(MOON.x + 60) })
      add(T.show - 0.04, 'pencil', { dur: 0.5, gain: 0.4, pan: 0.15 })
      add(T.off + 0.06, 'scratch', { gain: 0.45, pitch: 1.1, pan: 0.2 })
      // washi slap + mitten pat
      add(T.free, 'slap', { gain: 0.9, pan: 0 })
      add(T.free + 0.03, 'thup', { gain: 0.55, pitch: 1.1, pan: pan(CX + 250) })
      add(T.free + 0.12, 'swish', { gain: 0.25, pitch: 1.2, pan: 0.6 }) // the mitten whisks off up-right
      // label tape typing + carriage ding
      add(T.tape0, 'typewriter', { dur: Math.max(0.3, T.tape1 - T.tape0), gain: 0.55, pan: 0 })
      add(T.tape1 + 0.02, 'carriage', { gain: 0.55, pitch: 1.05, pan: 0.45 })
      // luggage tag: pin tick + swing creak
      add(T.tag0, 'tack', { gain: 0.6, pan: pan(TAG.x - 220) })
      add(T.tag0 + 0.06, 'creak', { pitch: 1.3, dur: 0.5, gain: 0.5, pan: pan(TAG.x) })
      // Pip's leap: spring off the moon, slide-whistle arc, soft landing on the "M"
      add(T.jump - 0.02, 'boing', { gain: 0.55, pitch: 1.25, pan: pan(MOON.x + 60) })
      add(T.jump + 0.02, 'slideUp', { dur: 0.3, gain: 0.45, pitch: 1.1, pan: -0.2 })
      add(T.land, 'thup', { gain: 0.7, pitch: 0.95, pan: pan(1000) })
      // bow (card fold) + the final bright ding and paper pop on the music's button
      add(T.bow0 + 0.12, 'flip', { gain: 0.45, pitch: 0.9, pan: pan(1000) })
      add(T.button, 'ding', { note: 89, gain: 0.6, pan: 0.05 })
      add(T.button, 'pop', { gain: 0.8, pitch: 1.1, pan: pan(1000) })
      add(T.button + T.beat / 2, 'pop', { gain: 0.5, pitch: 1.35, pan: pan(1060) }) // second, smaller burst
      add(T.button + 0.08, 'flurry', { dur: 0.9, gain: 0.28 }) // the paper confetti fluttering down
      // the googly eye rolls all the way round
      add(T.spin0 + 0.05, 'rattle', { gain: 0.55, pitch: 1.15, pan: pan(1000) })
      return out
    },
  })
})()

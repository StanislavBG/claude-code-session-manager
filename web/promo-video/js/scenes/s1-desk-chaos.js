/* s1-desk-chaos.js — scene 1, "Desk chaos" (the hook). Owner: scene s1. Style: js/kit.js.
 *
 * 0–5.5 s · mood chaos · in: none (first scene) · out: 'tape' into s2.
 * Frazzled-dev VO (af_jessica): "Twelve terminals." / "Forty sticky notes." / "What was I doing again?"
 * Every narrated beat is keyed off info.wordAt / info.nextBeat (FB below are fallbacks only).
 *
 *   open        top-down kraft desk, already a mess: 7 black-paper terminals jittering out of sync
 *               (keyboard-clatter bursts), coffee rings, the "big idea!" napkin half-buried between a
 *               terminal and the butter sticky Pip is hiding under.
 *   "Twelve"    five more terminals are tossed onto the desk on the quarter-beat grid; hand-cut paper
 *               digits "12" pop with squash/stretch + wobble; the "terminals" tag pops on "terminals".
 *   "Forty"     "40" pops the same way; 13 sticky notes flutter in on sine paths ('fix bug??' /
 *               'which tab' / 'TODO!!'); on "notes" the frazzled dev's flat cut-out hand slaps one more down.
 *   Pip         the paperclip antenna pokes up behind the butter sticky on the next beat, then the
 *               googly eyes peek over the edge, darting.
 *   "What …"    a torn notepad page slams onto the desk on the beat (dust puffs, the desk jolts, the
 *               "12"/"40" tags are blown back and shrink to secondary), a paper veil dims the rest, the
 *               giant pencil "?" draws itself; Pip's eyes follow the pencil, the pupils spin on "was";
 *               the dot lands on the beat and two smaller graphite "?" scribble on, rising → "? ? ?".
 *   boing       Pip spots the napkin (a wide-eyed take), crouches deep (the sticky 'blanket' squashes),
 *               boings out with its eyes on the napkin (the sticky is flung off-frame), lands on the beat
 *               after "again", grows into the hero framing, scoops the napkin up and hugs it with a
 *               squeeze; the bulb doodle lights up (plink) and a paper heart pops over Pip's head.
 *               The veil now sits over everything but Pip + napkin: one focal point for the payoff.
 *   out         the hug is the last thing the tape's middle strip covers.
 *
 * Layering (back → front): desk · coffee rings · napkin · terminals · stickies · "12"/"40" tags ·
 * veil A · page + "?" · veil B (payoff only) · Pip (+ napkin) · Pip's sticky · the hand.
 * Pure function of t (clamped to [0, dur]).
 * Brand safety: the lit bulb keeps ONLY the napkin prop's own 3 glow ticks; nothing radial is added
 * near it (the heart's 3-tick sparkle sits ~250 px away, over Pip's head).
 */
PROMO.scene(
  's1-desk-chaos',
  (function () {
    'use strict'
    const C = K.C
    const E = K.ease
    const { clamp, clamp01, lerp, seg } = K
    const TAU = Math.PI * 2
    const W = K.W

    // fallback word times (timeline 2026-09-24) — only used if info.wordAt misses a word
    const FB = { twelve: 0.5, terminals: 0.93, forty: 1.91, sticky: 2.3, notes: 2.76, what: 3.58, was: 3.87, doing: 4.23, again: 4.58 }
    const GRAPHITE = '#4a4540'
    const PEEK_SINK = 162 // mascot.js: Pip sinks this far (local px) at peek = 1

    // ───────────── layout ─────────────
    // terminals: d = -1 on the desk from the first frame (7), else index of its toss landing (5)
    const TERMS = [
      { x: 175, y: 190, r: -0.32, s: 0.95, d: -1, tape: true, sc: 2 },
      { x: 985, y: 165, r: -0.08, s: 1.0, d: -1, tape: true, sc: 3, cursor: 'block' },
      { x: 1770, y: 210, r: -0.25, s: 0.95, d: -1, tape: 'rgba(63,153,144,0.62)', sc: 1 },
      { x: 640, y: 485, r: -0.38, s: 1.0, d: -1, tape: false, sc: 2 },
      { x: 585, y: 810, r: 0.28, s: 1.05, d: -1, tape: true, sc: 3 },
      { x: 1262, y: 818, r: -0.2, s: 1.0, d: -1, tape: true, sc: 2, cursor: 'block' },
      { x: 1060, y: 505, r: 0.14, s: 1.1, d: -1, tape: true, sc: 1 },
      { x: 560, y: 150, r: 0.2, s: 0.9, d: 0, tape: true, sc: 1 },
      { x: 1335, y: 150, r: 0.3, s: 0.9, d: 1, tape: 'rgba(111,125,82,0.66)', sc: 2 },
      { x: 240, y: 525, r: 0.22, s: 1.05, d: 2, tape: true, sc: 3 },
      { x: 1505, y: 475, r: -0.22, s: 0.95, d: 3, tape: false, sc: 2, cursor: 'block' },
      { x: 165, y: 845, r: -0.12, s: 1.0, d: 4, tape: 'rgba(63,153,144,0.62)', sc: 2 },
    ]
    // sticky notes that flutter in on "Forty sticky notes" (listed in landing order)
    const NOTES = [
      { x: 770, y: 300, r: 0.2, s: 165, c: 'butter', tx: 'fix bug??', f: 't' },
      { x: 1790, y: 525, r: -0.2, s: 165, c: 'butter', tx: 'which tab', f: 'r' },
      { x: 95, y: 395, r: 0.3, s: 150, c: 'pink', tx: '', f: 'l' },
      { x: 1185, y: 330, r: -0.15, s: 160, c: 'peach', tx: 'TODO!!', f: 't' },
      { x: 470, y: 900, r: -0.1, s: 150, c: 'sage', tx: 'TODO!!', f: 'l' },
      { x: 1455, y: 118, r: 0.15, s: 150, c: 'lemon', tx: 'fix bug??', f: 't' },
      { x: 855, y: 690, r: 0.12, s: 150, c: 'lemon', tx: '', f: 't' },
      { x: 300, y: 118, r: -0.12, s: 150, c: 'peach', tx: 'which tab', f: 't' },
      { x: 1282, y: 618, r: 0.22, s: 150, c: 'pink', tx: 'which tab', f: 'r' },
      { x: 1860, y: 835, r: -0.3, s: 150, c: 'peach', tx: '', f: 'r' },
      { x: 615, y: 125, r: -0.3, s: 150, c: 'sage', tx: '', f: 't' },
      { x: 1040, y: 900, r: 0.18, s: 150, c: 'butter', tx: 'TODO!!', f: 'l' },
      { x: 965, y: 440, r: -0.22, s: 165, c: 'sage', tx: '', f: 't' },
    ]
    // desk stickies present from the first frame
    const DESK_NOTES = [
      { x: 1352, y: 918, r: -0.34, s: 140, c: 'sage', tx: 'which tab', id: 's1-dn0' },
      { x: 905, y: 885, r: 0.2, s: 150, c: 'pink', tx: '', id: 's1-dn1' },
      { x: 92, y: 655, r: 0.24, s: 145, c: 'butter', tx: 'fix bug??', id: 's1-dn2' },
      { x: 1180, y: 360, r: -0.3, s: 140, c: 'lemon', tx: '', id: 's1-dn3' },
    ]
    const HAND_NOTE = { x: 300, y: 668, r: -0.12, s: 160, c: 'peach', tx: 'TODO!!' }
    const HAND_DX = 56 // the flat hand's anchor (fingertips) relative to the note centre
    const HAND_DY = 6
    const NAP = { x: 1478, y: 772, r: -0.1, scale: 0.58 } // the "big idea!" napkin (size 300 → 174 px)
    const SN = { x: 1640, y: 800, r: 0.03, s: 190 } // Pip's hiding sticky
    const CLIP_Y = SN.y - SN.s / 2 + 4 // Pip is clipped just below the sticky's top edge
    const PEEK_X = 1648
    const LAND_X = 1478
    const GROUND = 846
    const PIP_S = 1.1 // peek + hop
    const PIP_HERO = 1.3 // after the landing: Pip grows into the hero framing
    const HOP_H = 108
    // hug: 'clap' frozen at poseT 0 puts the hole-punch hands at the card's sides (±60, -50 body frame), elbows
    // bowed out — a paper-doll hug. The napkin (a hair foreshortened, tipped back in Pip's arms) sits under
    // the scarf with its side edges in the hands.
    const HUG_SIZE = 118 // napkin size in Pip-local px while hugged
    const HUG_SY = 0.8 // napkin foreshortening while hugged
    const HUG_OFF = 40 // napkin centre below Pip's grip point (Pip-local px): top edge tucks under the scarf
    const PAGE = { x: 958, y: 455, w: 470, h: 560 }
    const Q_BIG = [-38, -18] // page-local centre of the giant "?"
    const TAG12 = { x: 395, y: 292 }
    const TAG40 = { x: 1556, y: 286 }

    // ───────────── timing (pure function of info) ─────────────
    function plan(info) {
      const w = (k) => (info && info.wordAt ? info.wordAt(k, FB[k]) : FB[k])
      const beat = (info && info.beat) || 0.58035
      const start = (info && info.start) || 0
      const nb = (x) => (info && info.nextBeat ? info.nextBeat(x) : Math.ceil((start + x) / beat - 1e-6) * beat - start)
      const q = beat / 4
      const snapQ = (x) => Math.round((start + x) / q) * q - start
      const P = { beat }
      for (const k of Object.keys(FB)) P[k] = w(k)
      // five terminal tosses on the quarter-beat grid, from the first frames to after "terminals"
      const a = Math.min(0.15, P.twelve - 0.3)
      const b = Math.max(a + 1, P.terminals + 0.5)
      P.drops = []
      for (let k = 0; k < 5; k++) {
        let d = Math.max(0.12, snapQ(lerp(a, b, k / 4)))
        if (k && d <= P.drops[k - 1] + 0.05) d = P.drops[k - 1] + q
        P.drops.push(d)
      }
      P.pop12 = P.twelve - 0.05
      P.lab12 = P.terminals
      P.pop40 = P.forty - 0.05
      P.lab40 = P.sticky
      P.note0 = P.forty + 0.42
      P.note1 = Math.max(P.note0 + 0.4, P.notes + 0.36)
      P.slap = P.notes
      P.antenna = nb(P.notes + 0.05)
      P.eyes = P.antenna + beat / 2
      P.pageLand = nb(P.what - 0.14)
      P.draw0 = Math.max(P.what, P.pageLand + 0.06)
      P.dot = Math.max(nb(P.was + 0.1), P.draw0 + 0.3)
      P.q2 = P.dot + 0.05
      P.q3 = P.dot + 0.12
      P.spin0 = P.was - 0.02
      P.spin1 = Math.min(P.spin0 + 0.3, P.dot + 0.06) // pupils stop spinning just after the dot lands
      P.spot = P.spin1 // Pip spots the napkin: one wide-eyed frame, then determined
      P.hopDur = 0.38
      P.crouchDur = 0.2
      P.land = Math.max(nb(P.again - 0.02), P.dot + P.crouchDur + P.hopDur)
      P.takeoff = P.land - P.hopDur
      P.crouch = P.takeoff - P.crouchDur // the anticipation starts as the dot lands (3 frames)
      P.scoop = 0.1
      P.grow = 0.22
      P.lit = snapQ(P.land + 0.15) // hug squeeze → the idea lights up (quarter-beat after the landing)
      // clatter bursts: [terminal index, start]
      P.bursts = [
        [1, 0.04],
        [0, P.terminals - 0.12],
        [2, P.terminals + 0.4],
        [4, P.forty - 0.28],
        [9, P.sticky + 0.12],
        [5, P.notes + 0.26],
        [8, P.what - 0.42],
      ]
      // flutter-in schedule for the sticky notes (seeded, not random)
      const r = K.rng('s1-notes')
      P.notesAt = NOTES.map((n, k) => {
        const land = lerp(P.note0, P.note1, k / (NOTES.length - 1)) + (r() - 0.5) * 0.05
        const fly = 0.5 + r() * 0.2
        return { land, fly, ph: r() * TAU, sway: 55 + r() * 40 }
      })
      return P
    }

    // ───────────── small helpers ─────────────
    const panOf = (x) => clamp((x / W) * 1.6 - 0.8, -0.8, 0.8)
    const unit = (dx, dy) => {
      const L = Math.hypot(dx, dy) || 1
      return [dx / L, dy / L]
    }
    /** damped jolt (px) after an impact at t0 */
    function jolt(t, t0, amp, k = 9, w = 30) {
      const x = t - t0
      if (x < 0 || x > 0.7) return 0
      return amp * Math.exp(-k * x) * Math.cos(w * x)
    }
    /** damped landing ring 1 → 0 */
    const ringAt = (z, k = 10, w = 26) => (z < 0 ? 0 : Math.exp(-k * z) * Math.cos(w * z))
    /** pop-in with squash & stretch + a wobble; null before t0 */
    function popSS(t, t0, dur = 0.4) {
      const x = t - t0
      if (x <= 0) return null
      const u = clamp01(x / dur)
      const g = E.outBack(u)
      const st = u < 1 ? 0.2 * Math.sin(Math.PI * u) : 0
      const y = x - dur * 0.6
      const ring = y > 0 ? Math.exp(-7 * y) * Math.sin(20 * y) : 0
      return { sx: g * (1 - st * 0.45 + 0.09 * ring), sy: g * (1 + st - 0.12 * ring), rot: 0.2 * Math.exp(-5 * x) * Math.sin(13 * x) }
    }
    function toScene(ctx, base, p) {
      const d = ctx.getTransform().transformPoint(new DOMPoint(p[0], p[1]))
      const s = base.inverse().transformPoint(d)
      return [s.x, s.y]
    }
    function veil(ctx, a) {
      if (a <= 0.002) return
      ctx.fillStyle = `rgba(246,239,225,${a})`
      ctx.fillRect(-100, -100, W + 200, K.H + 200)
    }

    // ───────────── pieces ─────────────
    function termJitter(i, t, P) {
      const f1 = 1.3 + 0.37 * i
      const f2 = 1.1 + 0.29 * i
      let dx = 1.6 * Math.sin(TAU * f1 * t + i * 1.7)
      let dy = 1.3 * Math.sin(TAU * f2 * t + i)
      let rot = 0.012 * Math.sin(TAU * (0.9 + 0.23 * i) * t + 2 * i)
      let typed = 0
      for (const [bi, bt] of P.bursts) {
        if (bi !== i) continue
        if (t >= bt) typed = 1
        if (t < bt || t > bt + 0.4) continue
        const env = Math.sin((Math.PI * (t - bt)) / 0.4)
        const r = K.rng('clat', i, Math.round(t * 15))
        dx += (r() - 0.5) * 11 * env
        dy += (r() - 0.5) * 8 * env
        rot += (r() - 0.5) * 0.06 * env
      }
      return { dx, dy, rot, typed }
    }

    function drawTerminal(ctx, i, T, t, P) {
      let x = T.x
      let y = T.y
      let rot = T.r
      let sc = T.s
      let lift = 0
      let sx = 1
      let sy = 1
      if (T.d >= 0) {
        const tl = P.drops[T.d]
        const t0 = tl - 0.3
        if (t < t0) return
        const dx = T.x - 960
        const dy = T.y - 520
        const L = Math.hypot(dx, dy) || 1
        if (t < tl) {
          const u = seg(t, t0, tl)
          const e = E.outCubic(u)
          const k = 1 - E.inQuad(u) // height above the desk
          x = lerp(T.x + (dx / L) * 700, T.x, e)
          y = lerp(T.y + (dy / L) * 520, T.y, e)
          rot = T.r + (i % 2 ? 0.8 : -0.8) * (1 - e)
          sc *= 1 + 0.55 * k
          lift = 50 * k
        } else {
          const ring = ringAt(t - tl)
          sx = 1 + 0.07 * ring
          sy = 1 - 0.08 * ring
        }
      }
      const j = termJitter(i, t, P)
      PROPS.terminalCard(ctx, x + j.dx, y + j.dy, t, {
        id: 's1-term' + i,
        rot: rot + j.rot,
        scale: [sc * sx, sc * sy],
        tape: T.tape,
        scribbles: Math.min(4, T.sc + j.typed),
        cursor: T.cursor || 'underscore',
        lift,
        jitter: 0.6,
      })
    }

    function drawFlutterNote(ctx, k, t, P) {
      const n = NOTES[k]
      const a = P.notesAt[k]
      const t0 = a.land - a.fly
      if (t < t0) return
      let x = n.x
      let y = n.y
      let rot = n.r
      let sc = 1
      let lift = 0
      let flutter = 0.18
      let curl = 0.12
      let sx = 1
      let sy = 1
      if (t < a.land) {
        const u = (t - t0) / a.fly
        const e = E.outQuad(u)
        const s0 = n.f === 't' ? [n.x + (k % 2 ? 180 : -180), -140] : n.f === 'l' ? [-140, n.y - 170] : [W + 140, n.y - 170]
        const dx = n.x - s0[0]
        const dy = n.y - s0[1]
        const L = Math.hypot(dx, dy) || 1
        const sway = a.sway * Math.sin(TAU * 1.25 * u + a.ph) * (1 - e)
        x = lerp(s0[0], n.x, e) + (-dy / L) * sway
        y = lerp(s0[1], n.y, e) + (dx / L) * sway
        rot = n.r + 0.75 * Math.sin(TAU * 1.05 * u + a.ph) * (1 - e)
        sc = 1 + 0.22 * (1 - e)
        lift = 26 * (1 - e)
        flutter = 1
        curl = 0.3 + 0.3 * Math.sin(TAU * 2 * u + a.ph)
      } else {
        const ring = ringAt(t - a.land, 11, 24)
        sx = 1 - 0.05 * ring
        sy = 1 + 0.05 * ring
      }
      PROPS.stickyNote(ctx, x, y, t, { id: 's1-note' + k, size: n.s, color: n.c, text: n.tx, rot, scale: [sc * sx, sc * sy], lift, flutter, curl: clamp01(curl), jitter: 0.5 })
    }

    /** The frazzled dev's flat hand ('drop' pose, palm down) carries one more sticky in under its fingers,
     *  lifts for the wind-up and SLAPS it down on "notes", then slides out. (hx, hy) = the hand's fingertip
     *  anchor, which sits over the note's left edge; hs = the hand's height above the desk (scale). */
    function handState(t, P) {
      const tIn = P.slap - 0.34
      const tUp = P.slap - 0.1
      const tHit = P.slap - 0.02
      const tOut = P.slap + 0.14
      const tGone = tOut + 0.3
      const F = [HAND_NOTE.x + HAND_DX, HAND_NOTE.y + HAND_DY] // palm over the note's left half, fingers splayed on the right
      if (t < tIn) return null
      if (t < tUp) {
        const e = E.outCubic(seg(t, tIn, tUp))
        return { hx: lerp(-120, F[0] - 16, e), hy: lerp(F[1] - 90, F[1] - 26, e) - 30 * Math.sin(Math.PI * e), hs: 1.14, carry: true }
      }
      if (t < tHit) {
        // anticipation: the hand rises (grows toward the camera) before the slap
        const u = seg(t, tUp, tHit)
        return { hx: F[0] - 16 - 6 * u, hy: F[1] - 26 - 16 * E.outQuad(u), hs: 1.14 + 0.13 * E.outQuad(u), carry: true }
      }
      if (t < P.slap) return { hx: F[0] - 6, hy: F[1] - 10, hs: 1.08, carry: true } // smear frame on the way down
      if (t < tOut) {
        const z = t - P.slap
        return { hx: F[0], hy: F[1], hs: 1 - 0.035 * ringAt(z, 14, 30), carry: false }
      }
      if (t < tGone) {
        const e = E.inCubic(seg(t, tOut, tGone))
        return { hx: lerp(F[0], -260, e), hy: lerp(F[1], F[1] + 40, e), hs: 1 + 0.08 * Math.sin(Math.PI * Math.min(1, e * 2)), carry: false }
      }
      return { gone: true }
    }
    function drawHandNote(ctx, t, P, hs, top) {
      // on the desk after the slap (sticky layer); carried under the hand before it (top layer)
      if (!hs) return
      if (top !== !!hs.carry) return
      let x = HAND_NOTE.x
      let y = HAND_NOTE.y
      let lift = 0
      let sx = 1
      let sy = 1
      let rot = HAND_NOTE.r
      if (hs.carry) {
        x = hs.hx - HAND_DX * hs.hs
        y = hs.hy - HAND_DY
        lift = 130 * (hs.hs - 1)
        sx = sy = 1 + 0.6 * (hs.hs - 1)
        rot += 0.08
      } else {
        const ring = ringAt(t - P.slap, 11, 28)
        sx = 1 + 0.06 * ring
        sy = 1 - 0.07 * ring
      }
      PROPS.stickyNote(ctx, x, y, t, { id: 's1-handnote', size: HAND_NOTE.s, color: HAND_NOTE.c, text: HAND_NOTE.tx, rot, scale: [sx, sy], lift, jitter: 0.5 })
      if (!hs.carry) {
        // a tiny dust puff squeezes out from under the free corners
        const dp = seg(t, P.slap - 0.01, P.slap + 0.42)
        if (dp > 0 && dp < 1) {
          PROPS.doodlePuff(ctx, HAND_NOTE.x + 94, HAND_NOTE.y - 76, t, { id: 's1-hpuff1', p: dp, r: 22 })
          PROPS.doodlePuff(ctx, HAND_NOTE.x + 84, HAND_NOTE.y + 92, t, { id: 's1-hpuff2', p: dp, r: 18 })
          PROPS.doodlePuff(ctx, HAND_NOTE.x - 96, HAND_NOTE.y + 84, t, { id: 's1-hpuff3', p: dp, r: 16 })
        }
      }
    }

    function drawGlyph(ctx, ch, size, color) {
      K.font(ctx, 'chunky', size, '700')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineJoin = 'round'
      // cast shadow (lifted cut paper)
      ctx.save()
      ctx.translate(7, 10)
      ctx.fillStyle = 'rgba(58,36,14,0.2)'
      ctx.strokeStyle = 'rgba(58,36,14,0.2)'
      ctx.lineWidth = size * 0.13
      ctx.strokeText(ch, 0, 0)
      ctx.fillText(ch, 0, 0)
      ctx.restore()
      // lumpy scissor-cut white margin: three slightly offset passes
      ctx.strokeStyle = K.paperPattern(ctx, C.paperWhite)
      ctx.lineWidth = size * 0.12
      for (const [ox, oy] of [[-2, 1], [2, -1.5], [0.5, 2]]) ctx.strokeText(ch, ox, oy)
      // pencil edge under the colour (half of it shows), so the font's overlapping contours never do
      ctx.lineWidth = 4.4
      ctx.strokeStyle = 'rgba(42,34,26,0.55)'
      ctx.strokeText(ch, 0, 0)
      ctx.fillStyle = K.paperPattern(ctx, color)
      ctx.fillText(ch, 0, 0)
    }
    /** a hand-cut number ("12" / "40") + its torn word tag. When the page slams (the "?" takes focus) the
     *  whole tag is blown back: it eases ~65 px up/outward and shrinks to 0.85 (secondary). */
    function drawTag(ctx, t, P, x, y, digits, colors, t0, label, tl, id, dir) {
      const k = E.outBack(seg(t, P.pageLand - 0.02, P.pageLand + 0.28))
      K.at(ctx, x + dir * 40 * k, y - 52 * k, dir * 0.03 * k, 1 - 0.15 * k, () => {
        const size = 196
        const gap = 124
        digits.split('').forEach((ch, i) => {
          const p = popSS(t, t0 + i * 0.07, 0.42)
          if (!p) return
          const cx = (i - (digits.length - 1) / 2) * gap
          const idle = 0.035 * Math.sin(TAU * 0.9 * t + i * 2.1 + x)
          const n = K.nudge(id + i, t, 0.8)
          K.at(ctx, cx + n.dx, n.dy + (i ? 8 : -6), (i ? 0.1 : -0.08) + p.rot + idle, [p.sx, p.sy], () => drawGlyph(ctx, ch, size, colors[i]))
        })
        const pl = popSS(t, tl, 0.34)
        if (pl) {
          K.at(ctx, 6, 138, 0, [pl.sx, pl.sy], () => {
            K.label(ctx, label, 0, 0, { size: 46, t, id: id + 'lb', rot: (id === 's1-12' ? -0.05 : 0.05) + pl.rot * 0.5, bg: C.paperWhite, torn: 3, tapeColor: id === 's1-12' ? 'rgba(111,125,82,0.6)' : 'rgba(184,92,52,0.55)' })
          })
        }
      })
    }

    /** torn notepad page that slams down, with the giant pencil "?" (+ two smaller "?") drawn on it */
    function drawPage(ctx, t, P, base, out) {
      const t0 = P.pageLand - 0.24
      if (t < t0) return
      const u = seg(t, t0, P.pageLand)
      const k = 1 - E.inQuad(u) // height above the desk
      let sx = 1
      let sy = 1
      if (t >= P.pageLand) {
        const ring = ringAt(t - P.pageLand, 12, 28)
        sx = 1 + 0.035 * ring
        sy = 1 - 0.04 * ring
      }
      const x = PAGE.x - 70 * k
      const y = PAGE.y - 300 * k
      const rot = -0.035 - 0.32 * k
      const s = 1 + 0.45 * k
      K.at(ctx, x, y, rot, [s * sx, s * sy], () => {
        const hw = PAGE.w / 2
        const hh = PAGE.h / 2
        K.paper(ctx, K.boxPts(PAGE.w, PAGE.h), C.paperWhite, { torn: 4, seed: 's1-page', lift: 46 * k, shadow: 1 })
        // faint blue rules + a red margin
        ctx.save()
        ctx.strokeStyle = 'rgba(90,130,196,0.22)'
        ctx.lineWidth = 2
        ctx.beginPath()
        for (let ry = -hh + 70; ry < hh - 16; ry += 36) {
          ctx.moveTo(-hw + 14, ry)
          ctx.lineTo(hw - 14, ry)
        }
        ctx.stroke()
        ctx.strokeStyle = 'rgba(224,105,74,0.4)'
        ctx.beginPath()
        ctx.moveTo(-hw + 58, -hh + 10)
        ctx.lineTo(-hw + 58, hh - 10)
        ctx.stroke()
        ctx.restore()
        // washi corners slap on just after the landing
        const tp = popSS(t, P.pageLand + 0.05, 0.25)
        if (tp) {
          K.at(ctx, -hw + 34, -hh + 10, 0, [tp.sx, tp.sy], () => K.tape(ctx, 0, 0, 130, -0.62, 'rgba(242,169,192,0.82)', { seed: 's1-pt1', pattern: 'dots' }))
          K.at(ctx, hw - 34, -hh + 10, 0, [tp.sx, tp.sy], () => K.tape(ctx, 0, 0, 130, 0.58, 'rgba(63,153,144,0.6)', { seed: 's1-pt2' }))
        }
        // the giant pencil "?"
        let qp = 0
        if (t >= P.draw0) qp = 0.8 * E.inOutQuad(seg(t, P.draw0, P.dot - 0.06))
        if (t >= P.dot - 0.06) qp = 0.8 + 0.04 * seg(t, P.dot - 0.06, P.dot - 0.03) + 0.16 * seg(t, P.dot - 0.03, P.dot + 0.06)
        if (qp > 0) {
          const an = PROPS.pencilQuestion(ctx, Q_BIG[0], Q_BIG[1], t, { id: 's1-q', size: 380, p: qp, jitter: 0.5 })
          out.tip = toScene(ctx, base, an.tip)
        }
        // two smaller graphite "?" scribble on, rising to the upper right → "? ? ?" (same boiling pencil)
        const smalls = [[128, 34, 0.1, 150, P.q2], [192, -96, 0.2, 116, P.q3]]
        smalls.forEach(([qx, qy, qr, qs, q0], i) => {
          const p = popSS(t, q0, 0.3)
          if (!p) return
          K.at(ctx, qx, qy, qr + p.rot * 0.6, [p.sx, p.sy], () => PROPS.pencilQuestion(ctx, 0, 0, t, { id: 's1-sq' + i, size: qs, p: seg(t, q0, q0 + 0.13), tool: false, jitter: 0.5 }))
        })
      })
      // dust puffs under the bottom corners
      const dp = seg(t, P.pageLand - 0.02, P.pageLand + 0.5)
      if (dp > 0 && dp < 1) {
        PROPS.doodlePuff(ctx, PAGE.x - PAGE.w / 2 - 10, PAGE.y + PAGE.h / 2 - 10, t, { id: 's1-puffL', p: dp, r: 40 })
        PROPS.doodlePuff(ctx, PAGE.x + PAGE.w / 2 + 16, PAGE.y + PAGE.h / 2 - 24, t, { id: 's1-puffR', p: dp, r: 34 })
      }
    }

    function napkinDesk(ctx, t) {
      PROPS.napkin(ctx, NAP.x, NAP.y, t, { id: 's1-napkin', size: 300, scale: NAP.scale, rot: NAP.r, doodle: 1, lit: 0, jitter: 0.5 })
    }

    /** Pip: hidden under the butter sticky → antenna → eyes → pupils spin → spots the napkin → crouch →
     *  boing → lands, grows, scoops + hugs the napkin → the idea lights up. Returns Pip's anchors (or null). */
    function drawPip(ctx, t, P, base, look, out) {
      const s = PIP_S
      const full = 300 * s
      const antSink = 208 * s
      const eyeSink = 0.8 * PEEK_SINK * s
      const crouchSink = 22 * s
      const hop = PIP.hop(t, P.takeoff, { dur: P.hopDur, height: HOP_H, pre: P.crouchDur })
      const eyesAt = (x, gy, sc) => [x, gy - 190 * sc]
      if (t < P.takeoff) {
        let sink = full
        if (t >= P.antenna) sink = lerp(full, antSink, E.outBack(seg(t, P.antenna, P.antenna + 0.26)))
        if (t >= P.eyes) sink = lerp(antSink, eyeSink, E.outBack(seg(t, P.eyes, P.eyes + 0.28)))
        if (t >= P.crouch) sink += crouchSink * Math.sin((seg(t, P.crouch, P.takeoff) * Math.PI) / 2)
        if (sink >= full - 1) return null
        const pk = Math.min(1, sink / (PEEK_SINK * s))
        const yy = CLIP_Y + Math.max(0, sink - PEEK_SINK * s)
        const spin = seg(t, P.spin0, P.spin1)
        const spinning = spin > 0 && spin < 1
        const spotted = t >= P.spot
        const take = spotted && t < P.spot + 1 / 15 // one wide-eyed "there it is!" frame
        let lk = look
        if (spinning) {
          const a = Math.PI / 2 - E.inOutCubic(spin) * TAU * 1.25 // the small eye counter-spins
          lk = [Math.cos(a), Math.sin(a)]
        } else if (spotted) {
          // eyes lead: straight at the half-buried napkin
          lk = unit(NAP.x - PEEK_X, NAP.y - (CLIP_Y - 24))
        }
        const o = {
          id: 's1-pip',
          scale: s,
          pose: 'peek',
          poseT: t - P.antenna,
          peek: pk,
          eyeSpin: spin,
          mouth: spinning ? 'wobbly' : take ? 'o' : spotted ? 'flat' : 'o',
          blink: t >= P.draw0 ? 0 : null,
        }
        if (take) {
          o.eyes = 'wide'
          o.brows = 'raised'
        } else if (spotted) o.brows = 'determined'
        if (lk) o.look = lk
        if (t >= P.crouch) o.squash = hop.squash
        ctx.save()
        ctx.beginPath()
        ctx.rect(-200, -200, W + 400, CLIP_Y + 200)
        ctx.clip()
        const an = PIP.draw(ctx, PEEK_X, yy, t, o)
        ctx.restore()
        return an
      }
      const sinkT = eyeSink + crouchSink
      if (t < P.land) {
        const u = clamp01((t - P.takeoff) / P.hopDur)
        const g0 = CLIP_Y + sinkT
        const ground = lerp(g0, GROUND, u)
        const x = lerp(PEEK_X, LAND_X, u)
        const vx = (LAND_X - PEEK_X) / P.hopDur
        const vy = (-HOP_H * 4 * (1 - 2 * u)) / P.hopDur + (GROUND - g0) / P.hopDur
        const e = eyesAt(x, ground + hop.y, s)
        return PIP.draw(ctx, x, ground + hop.y, t, {
          id: 's1-pip',
          scale: s,
          pose: 'cheer',
          poseT: t - P.takeoff,
          flip: true,
          air: -hop.y,
          squash: hop.squash,
          vel: [vx * 0.12, vy * 0.12], // a light trail for scarf/antenna; the pupils stay on the target
          mouth: 'open',
          eyes: 'normal',
          brows: 'determined',
          look: unit(NAP.x - e[0], NAP.y - e[1]),
          blink: 0,
        })
      }
      // landed: grow into the hero framing, scoop the napkin up and hug it
      const z = t - P.land
      const sc = lerp(PIP_S, PIP_HERO, E.outBack(seg(t, P.land, P.land + P.grow)))
      const lit = E.outBack(seg(t, P.lit, P.lit + 0.16))
      const happy = t >= P.lit
      const scoop = seg(t, P.land, P.land + P.scoop)
      const deskP = base.transformPoint(new DOMPoint(NAP.x, NAP.y + (out.jy || 0)))
      const bScale = Math.hypot(base.a, base.b)
      const bRot = Math.atan2(base.b, base.a)
      const pop = t >= P.lit ? 1 + 0.12 * ringAt(t - P.lit, 7, 20) : 1 // the idea "pops" as it lights
      let squash = z < 0.4 ? hop.squash : 1
      if (t >= P.lit) squash *= 1 - 0.075 * Math.sin(Math.PI * seg(t, P.lit, P.lit + 0.32)) // the hug squeeze
      const o = {
        id: 's1-pip',
        scale: sc,
        pose: 'clap',
        poseT: 0, // frozen: hands at the card's sides, elbows bowed out → a hug
        rot: 0.045 * Math.sin((TAU * z) / 1.1) * seg(t, P.land + 0.08, P.land + 0.3), // cuddly rock
        squash,
        look: [0.05, 0.9],
        eyes: happy ? 'happy' : 'normal',
        mouth: happy ? 'grin' : 'o',
        blush: 1,
        blink: 0,
        hold: (g) => {
          const m = g.getTransform()
          const hx = m.c * HUG_OFF + m.e
          const hy = m.d * HUG_OFF + m.f
          const hsc = Math.hypot(m.a, m.b) * (HUG_SIZE / 300)
          const hr = Math.atan2(m.b, m.a)
          const e = E.outCubic(scoop)
          const cx = lerp(deskP.x, hx, e)
          const cy = lerp(deskP.y, hy, e) - 26 * bScale * Math.sin(Math.PI * scoop)
          const k = lerp(bScale * NAP.scale, hsc, e) * pop
          g.save()
          g.setTransform(1, 0, 0, 1, 0, 0)
          PROPS.napkin(g, cx, cy, t, { id: 's1-napkin', size: 300, scale: [k, k * lerp(1, HUG_SY, e)], rot: lerp(bRot + NAP.r, hr, e), doodle: 1, lit: clamp01(lit), lift: 14 * Math.sin(Math.PI * scoop) + 5, jitter: 0 })
          g.restore()
        },
      }
      return PIP.draw(ctx, LAND_X, GROUND, t, o)
    }

    function drawPipSticky(ctx, t, P) {
      if (t < P.takeoff) {
        // the "blanket" lifts a touch while Pip peeks under it, then squashes down with the crouch
        const peek = seg(t, P.eyes, P.eyes + 0.3)
        const crouch = E.outQuad(seg(t, P.crouch, P.takeoff))
        const wig = t >= P.eyes ? 0.012 * Math.sin(TAU * 1.7 * t) : 0
        PROPS.stickyNote(ctx, SN.x, SN.y + 5 * crouch, t, { id: 's1-pipnote', size: SN.s, color: 'butter', text: 'fix bug??', rot: SN.r + wig * (1 - crouch) - 0.03 * crouch, scale: [1 + 0.03 * crouch, 1 - 0.06 * crouch], curl: 0.15 + 0.25 * peek * (1 - 0.6 * crouch), lift: 4 * peek * (1 - crouch), jitter: 0.5 })
        return
      }
      const z = t - P.takeoff
      const x = SN.x + 1500 * z
      if (x > W + 220) return
      const y = SN.y - 1250 * z + 1300 * z * z
      PROPS.stickyNote(ctx, x, y, t, { id: 's1-pipnote', size: SN.s, color: 'butter', text: 'fix bug??', rot: SN.r + 7.5 * z, scale: 1 + 0.5 * z, lift: 36, flutter: 1, curl: 0.5, jitter: 0 })
    }

    // ───────────── the scene ─────────────
    function draw(ctx, tRaw, dur, info) {
      const t = clamp(tRaw, 0, dur)
      const P = plan(info)
      const cam = info && info.camShift ? info.camShift(tRaw) : { dx: 0, dy: 0 }
      const base = ctx.getTransform()
      const out = {}

      // desk (background parallax: moves less than the foreground during an engine pan/tilt)
      K.at(ctx, Math.round(-0.3 * cam.dx), Math.round(-0.3 * cam.dy), 0, 1, () => K.desk(ctx))

      // the desk jumps when the page slams and when Pip lands
      const jy = Math.round(-jolt(t, P.pageLand, 7) - jolt(t, P.land, 3))
      out.jy = jy
      const hs = handState(t, P)
      ctx.save()
      ctx.translate(0, jy)
      PROPS.coffeeRing(ctx, 520, 615, t, { id: 's1-ring1', r: 88 })
      PROPS.coffeeRing(ctx, 1745, 660, t, { id: 's1-ring2', r: 62, alpha: 0.8 })
      if (t < P.land) napkinDesk(ctx, t)
      for (const n of DESK_NOTES) PROPS.stickyNote(ctx, n.x, n.y, t, { id: n.id, size: n.s, color: n.c, text: n.tx, rot: n.r, curl: 0.2, flutter: 0.15, jitter: 0.5 })
      // terminals: the ones on the desk first, then the tossed ones in landing order
      TERMS.forEach((T, i) => T.d < 0 && drawTerminal(ctx, i, T, t, P))
      TERMS.forEach((T, i) => T.d >= 0 && drawTerminal(ctx, i, T, t, P))
      drawHandNote(ctx, t, P, hs, false)
      for (let k = 0; k < NOTES.length; k++) drawFlutterNote(ctx, k, t, P)
      drawTag(ctx, t, P, TAG12.x, TAG12.y, '12', [C.terracotta, C.butter], P.pop12, 'terminals', P.lab12, 's1-12', -1)
      drawTag(ctx, t, P, TAG40.x, TAG40.y, '40', [C.sage, C.peach], P.pop40, 'sticky notes', P.lab40, 's1-40', 1)
      ctx.restore()

      // staging. Veil A (under the page) dims the desk while the "?" is the one focal point; for the payoff
      // veil B also dims the page, so only Pip + the napkin stay at full contrast.
      const vA = 0.2 * seg(t, P.pageLand - 0.1, P.pageLand + 0.1) * (1 - 0.5 * seg(t, P.takeoff, P.land))
      const vB = 0.2 * E.inOutQuad(seg(t, P.takeoff, P.land + 0.12))
      veil(ctx, vA)
      drawPage(ctx, t, P, base, out)
      veil(ctx, vB)

      // Pip looks where the action is: the pencil tip while the "?" draws
      let look = null
      if (out.tip && t < P.dot + 0.05) look = unit(out.tip[0] - PEEK_X, (out.tip[1] - (CLIP_Y - 20)) * 0.9)
      const pip = drawPip(ctx, t, P, base, look, out)
      drawPipSticky(ctx, t, P)

      // the idea lights → a paper heart pops over Pip's head (well away from the bulb; no rays near it)
      if (pip && t >= P.lit) {
        const hp = seg(t, P.lit + 0.02, P.lit + 0.8)
        if (hp > 0 && hp < 1) PROPS.heartPop(ctx, pip.head[0] + 78, pip.head[1] - 10, t, { id: 's1-heart', p: hp, r: 26, color: C.pink })
      }

      // the frazzled dev's hand (top layer)
      if (hs && !hs.gone) {
        drawHandNote(ctx, t, P, hs, true)
        CAST.hand(ctx, hs.hx, hs.hy, t, { id: 's1-hand', from: 'left', pose: 'drop', scale: 0.86 * hs.hs, rot: 0.12, sleeve: C.blue })
      }
    }

    function sfx(dur, info) {
      const P = plan(info)
      const cues = []
      const add = (t, type, o = {}) => t >= 0 && t < dur && cues.push(Object.assign({ t, type }, o))
      add(0, 'rustle', { dur: Math.min(5, dur), gain: 0.8 })
      // keyboard clatter bursts, panned to the terminal that shakes
      P.bursts.forEach(([i, bt], k) => add(bt, 'clatter', { dur: 0.42, gain: 0.5 + 0.05 * (k % 3), pitch: 0.9 + 0.06 * (k % 4), pan: panOf(TERMS[i].x) }))
      // terminals tossed onto the desk (soft paper landings, every other one)
      P.drops.forEach((d, k) => {
        if (k % 2 === 0) {
          const T = TERMS.find((x) => x.d === k)
          add(d, 'thup', { gain: 0.38, pitch: 0.85 + 0.1 * k, pan: panOf(T.x) })
        }
      })
      // hand-cut numbers pop (tonal), their word tags press on
      add(P.pop12 + 0.02, 'letterPop', { note: 72, gain: 0.6, pan: panOf(TAG12.x - 60) })
      add(P.pop12 + 0.09, 'letterPop', { note: 76, gain: 0.6, pan: panOf(TAG12.x + 60) })
      add(P.lab12 + 0.03, 'thup', { gain: 0.45, pitch: 1.2, pan: panOf(TAG12.x) })
      add(P.pop40 + 0.02, 'letterPop', { note: 74, gain: 0.6, pan: panOf(TAG40.x - 60) })
      add(P.pop40 + 0.09, 'letterPop', { note: 79, gain: 0.6, pan: panOf(TAG40.x + 60) })
      add(P.lab40 + 0.03, 'thup', { gain: 0.45, pitch: 1.3, pan: panOf(TAG40.x) })
      // sticky-note flutters (every other note, pitch varied; kept a touch under the VO in this busy window)
      P.notesAt.forEach((a, k) => {
        if (k % 2) return
        add(a.land - a.fly + 0.08, 'flutter', { dur: Math.min(0.45, a.fly), gain: 0.44 + 0.06 * (k % 3), pitch: 0.85 + 0.09 * (k % 5), pan: panOf(NOTES[k].x) })
      })
      // the dev's flat hand swings in and slaps one more sticky down
      add(P.slap - 0.34, 'swish', { gain: 0.35, pitch: 1.2, pan: -0.7 })
      add(P.slap, 'slap', { gain: 0.9, pan: panOf(HAND_NOTE.x) })
      // Pip: antenna pokes up, eyes peek
      add(P.antenna, 'blip', { gain: 0.45, pan: panOf(PEEK_X) })
      add(P.eyes + 0.02, 'rattle', { gain: 0.4, pitch: 1.25, pan: panOf(PEEK_X) })
      // the page slams down, the pencil scribbles the "?", the dot + two smaller "?"
      add(P.pageLand - 0.22, 'swoosh', { dur: 0.24, gain: 0.35, pitch: 0.8, pan: -0.2 })
      add(P.pageLand, 'slap', { gain: 0.9, pitch: 0.75, pan: panOf(PAGE.x) })
      add(P.draw0, 'pencil', { dur: Math.max(0.2, P.dot - 0.06 - P.draw0), gain: 0.85, pan: panOf(PAGE.x) })
      add(P.dot - 0.03, 'scratch', { dur: 0.12, gain: 0.6, pitch: 1.2, pan: panOf(PAGE.x) })
      add(P.q2, 'scratch', { dur: 0.1, gain: 0.4, pitch: 1.45, pan: panOf(PAGE.x + 128) })
      add(P.q3, 'scratch', { dur: 0.09, gain: 0.36, pitch: 1.7, pan: panOf(PAGE.x + 192) })
      // googly-eye rattle, the "spotted it" blip, the boing
      add(P.spin0, 'rattle', { gain: 0.8, pan: panOf(PEEK_X) })
      add(P.spot, 'blip', { gain: 0.35, pan: panOf(PEEK_X) })
      add(P.takeoff, 'boing', { gain: 0.9, pan: panOf(PEEK_X) })
      add(P.takeoff + 0.02, 'flutter', { dur: 0.35, gain: 0.45, pitch: 1.3, pan: 0.8 })
      // lands, scoops the napkin, squeezes → the idea lights up, a heart pops
      add(P.land, 'thup', { gain: 0.6, pitch: 0.9, pan: panOf(LAND_X) })
      add(P.land + 0.04, 'crinkle', { gain: 0.5, pan: panOf(LAND_X) })
      add(P.lit, 'plink', { gain: 0.6, pitch: 1.26, pan: panOf(LAND_X) })
      add(P.lit + 0.03, 'pop', { gain: 0.35, pitch: 1.6, pan: panOf(LAND_X + 80) })
      return cues.sort((a, b) => a.t - b.t)
    }

    return { draw, sfx }
  })()
)

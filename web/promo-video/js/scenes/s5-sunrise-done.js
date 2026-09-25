/* s5-sunrise-done.js — cameos "Check!" x3, then "Morning: a pile of done, and one note that needs you."
 * Owner: scene s45 (phase B; also owns s4-night-scheduler.js). Transition in: 'none' — this scene CONTINUES s4's
 * set: it starts from window.S45.nightEnd(G) (the settled end-of-night state, defined in s4's file, which loads
 * first) and paints with the same S45.drawSet, on the same global clock G = info.start + t, so the first frame is
 * s4's last frame continued. Pure function of (t, info): beats from info.cameoAt / info.wordAt / info.nextBeat.
 *
 * Beats (T.* in beats5(); fallbacks = the current timeline):
 *   T.alarm     on the cut: the "reset" alarm clock rings and hops; the Window-used needle eases back to empty
 *               (outCubic: outBack's 4.7x initial slope read as a one-frame pop at 15 fps), the "paused" sign flips
 *               back up to ▶ and the belt rolls again; YOU wakes up; Pip jumps.
 *   cameos      "Check!" x3 (bot-check-1/2/3): the teacup helpers of bays 0, 2, 4 spring up, each crayons a
 *               green check exactly as its "Check!" starts, then a tiny cheer (left → centre → right, like the pans).
 *   T.blindUp   after the third check: the navy blind snaps up (slow → fast), the moon swings off on its thread,
 *               the torn paper sun pops up with an outBack overshoot that peaks on "Morning!"; night tint lifts,
 *               the lamp dims, Pip cheers and its nightcap poofs off; bay 1's helper cheers too.
 *   T.stretch   "Morning!": YOU stretches and the bed flattens away.
 *   T.fly       "a pile of done": the four checked cards hop out of their bays and arc into a pile on the floor;
 *               a DONE stamp cascade (x4, 16ths from the beat) while "Done today ||||" writes itself mark by mark.
 *   T.notePop   "and one note": bay 3's helper (the puzzled one) pops a pink sticky "Needs you" up out of its bay;
 *               it flutters down on a zig-zag; Pip catches it (PIP catch) between "one" and "note", squints at it,
 *               then holds it out ('give'); a cut-out human hand slides in from the right, palm up, takes it on
 *               "you" and carries it off (the human still has a say); Pip cheers as the wipe comes.
 */
(function () {
  'use strict'
  const { C } = K
  const E = K.ease
  const seg = K.seg
  const lerp = K.lerp
  const clamp = K.clamp
  const clamp01 = K.clamp01

  const CHECKERS = [0, 2, 4] // bays whose helpers finish on the three "Check!" cameos
  const PILE_ORDER = [1, 0, 2, 4] // checked cards, in the order they leave for the pile

  function beats5(info, dur) {
    const w = (word, fb) => (info.wordAt ? info.wordAt(word, fb) : fb)
    const c = (id, fb) => (info.cameoAt ? info.cameoAt(id, fb) : fb)
    const nb = (x) => (info.nextBeat ? info.nextBeat(x) : x)
    const beat = info.beat || 0.58
    const T = {}
    T.alarm = 0.02
    T.checks = [c('bot-check-1', 0.2), c('bot-check-2', 0.58), c('bot-check-3', 0.96)]
    T.morning = w('morning', 1.69)
    T.pile = w('pile', 2.74)
    T.done = w('done', 3.15)
    T.and = w('and', 3.51)
    T.one = w('one', 3.71)
    T.note = w('note', 3.92)
    T.needs = w('needs', 4.43)
    T.you = w('you', 4.73)
    T.signUp = [0.1, 0.5]
    T.gaugeReset = [0.08, 0.62]
    T.beltRoll = [0.3, 1.3]
    // helpers spring up ~0.3 s before their "Check!", the crayon lands as the word starts (check poseT 0.12)
    T.stands = T.checks.map((x) => Math.max(0.03, x - 0.3))
    T.checkPose = T.checks.map((x) => x - 0.12)
    // night leaves after the third check; the sun's outBack overshoot peaks on "Morning!"
    T.blindUp = Math.max(T.checks[2] + 0.1, T.morning - 0.62)
    T.blindDur = 0.36
    T.sunDur = 0.62
    T.sun0 = T.morning - 0.55 * T.sunDur
    T.cheer1 = T.morning - 0.12
    T.capOff = T.morning + 0.08
    T.stretch = T.morning + 0.02
    // the bed flattens fast (the see-through phase lasts ~2 frames) and ends in a paper puff
    T.bedFlat = [T.morning + 0.3, T.morning + 0.7]
    T.bedPuff = T.bedFlat[0] + 0.12
    // the pile: four cards leave their bays, land before the beat; then 4 stamps on 16ths from that beat
    T.stampBeat = nb(T.pile + 0.02)
    T.flyDur = 0.3
    T.flys = PILE_ORDER.map((_, i) => T.stampBeat - 0.1 - T.flyDur - 0.12 * (3 - i))
    T.stamps = [0, 1, 2, 3].map((i) => T.stampBeat + (beat / 4) * i)
    T.tally0 = T.flys[1]
    // the note: pops from bay 3 after the last stamp, flutters, Pip catches it between "one" and "note"
    T.catchAt = (T.one + T.note) / 2 + 0.02
    T.notePop = Math.max(T.stamps[3] + 0.08, T.catchAt - 0.52)
    T.flutter0 = T.notePop + 0.12
    T.catchPose = T.catchAt - PIP.CATCH_AT
    T.squint = T.catchAt + 0.1
    T.give = Math.max(T.squint + 0.34, T.needs - 0.02)
    T.handIn = [T.give - 0.22, T.give + 0.2]
    T.take = Math.max(T.give + 0.18, T.you)
    T.dur = dur
    return T
  }

  function stateAt(t, dur, info) {
    const S45 = window.S45
    const { L, bump, wob, qarc } = S45
    const T = beats5(info, dur)
    const G = (info.start || 0) + t
    const S = S45.nightEnd(G)
    S.cam = info.camShift ? info.camShift(t) : { dx: 0, dy: 0 }
    // ── reset: alarm, gauge, sign, belt ──
    // a short ring (it must not compete with the helpers' "Check!"s)
    S.clock.ring = t < T.alarm ? 0 : 1 - seg(t, T.alarm + 0.34, T.alarm + 0.5)
    S.gauge.value = t < T.gaugeReset[0] ? 0.9 : lerp(0.9, 0.04, E.outCubic(seg(t, T.gaugeReset[0], T.gaugeReset[1])))
    S.sign = { flip: 1 - seg(t, T.signUp[0], T.signUp[1]), ease: 'inOutCubic', rock: t < T.signUp[0] ? 1 : false }
    S.belt.offset = L.D_TOTAL + 150 * E.inOutCubic(seg(t, T.beltRoll[0], T.beltRoll[1]))
    // ── sky ──
    // the blind's lower part hangs behind the floor band, so the visible travel starts with its fringe at the floor
    // line (eased drop ≈ 0.66): a small tug down (anticipation), then it accelerates up and snaps out of frame
    const up = seg(t, T.blindUp, T.blindUp + T.blindDur)
    const D0 = (L.FLOOR_TOP + 110) / (K.H + 62 + 110)
    S.blind = { drop: t < T.blindUp ? 1 : D0 * (1 - E.inQuad(up)) + 0.025 * bump(up, 0, 0.3), ease: false }
    S.sky = t >= T.blindUp - 0.1 ? 'morning' : 'dusk'
    const moonOff = seg(t, T.blindUp - 0.12, T.blindUp + 0.42)
    S.moon = { show: moonOff < 1, drop: 1 - E.inCubic(moonOff), ease: false, angle: 1.3 * E.inOutCubic(moonOff), swing: 1 - moonOff }
    const sunP = seg(t, T.sun0, T.sun0 + T.sunDur)
    S.sun = { rise: sunP, ease: 'outBack', face: t < T.morning + 0.08 ? 'sleepy' : 'happy' }
    S.night = 1 - E.inOutQuad(seg(t, T.blindUp, T.blindUp + T.blindDur + 0.2))
    S.laptop = { lampOn: lerp(1, 0.28, seg(t, T.blindUp, T.blindUp + 0.6)), glow: lerp(1, 0.8, seg(t, T.blindUp, T.blindUp + 0.6)) }
    // ── YOU: wakes on the alarm, stretches on "Morning!", the bed flattens away ──
    // YOU sleeps through three rings of the bell, then bolts upright
    if (t >= T.alarm + 0.18) S.you = { pose: 'wake', poseT: t - T.alarm - 0.18, zzz: false, bedFlat: 0 }
    if (t >= T.stretch) S.you = { pose: 'stretch', poseT: t - T.stretch, zzz: false, bedFlat: E.inOutQuad(seg(t, T.bedFlat[0], T.bedFlat[1])) }
    if (t >= T.bedFlat[1] + 0.25) S.you = { pose: 'wake', poseT: t - T.bedFlat[1] - 0.25 + 0.4, zzz: false, bedFlat: 1, look: [0.8, 0] }
    // ── helpers ──
    const pileCard = (i) => {
      const r = K.rng('s45pile', 'card', i)
      const cx = (r() - 0.5) * 22
      const rot = (r() - 0.5) * 0.09
      return { x: L.PILE.x + cx * L.PILE.s, y: L.PILE.y - i * L.PILE.step * L.PILE.s, rot }
    }
    S.helpers = S.helpers.map((h, k) => {
      const ci = CHECKERS.indexOf(k)
      if (ci >= 0) {
        const st = T.stands[ci]
        if (t < st) return h
        const cp = T.checkPose[ci]
        const pop = { dy: -16 * bump(t, st, st + 0.18) }
        if (t < T.checks[ci] + 0.5) return Object.assign(h, pop, { pose: 'check', poseT: Math.max(0, t - cp), look: null })
        if (t < T.checks[ci] + 1.4) return Object.assign(h, { pose: 'cheer', poseT: t - T.checks[ci] - 0.5, look: null, dy: 0 })
        return Object.assign(h, { pose: 'idle', poseT: G, look: [-0.45, 0.35], dy: 0 })
      }
      if (k === L.NIGHT_CHECKED) {
        if (t < T.cheer1) return h
        if (t < T.cheer1 + 0.9) return Object.assign(h, { pose: 'cheer', poseT: t - T.cheer1, look: null, dy: -10 * bump(t, T.cheer1, T.cheer1 + 0.15) })
        return Object.assign(h, { pose: 'idle', poseT: G, look: [-0.45, 0.35] })
      }
      // bay 3: the puzzled one — gets up, peers at its card, pops the pink note up for the human
      const s0 = T.notePop - 0.55
      if (t < s0) return h
      if (t < T.notePop - 0.1) return Object.assign(h, { pose: 'magnify', poseT: t - s0, look: null, dy: -10 * bump(t, s0, s0 + 0.15), q: E.outBack(seg(t, s0 + 0.05, s0 + 0.3)) })
      if (t < T.notePop + 0.3) return Object.assign(h, { pose: 'hop', poseT: 0.1 + (t - T.notePop + 0.1) * 0.8, look: [0.2, -1], q: 1 - seg(t, T.notePop - 0.1, T.notePop + 0.05) })
      return Object.assign(h, { pose: 'idle', poseT: G, look: [0.5, 0.5] })
    })
    // ── cards: checks land in the bays, then the four done cards arc onto the pile ──
    S.cards = S.cards.map((c, k) => {
      const ci = CHECKERS.indexOf(k)
      if (ci >= 0) c.checked = t >= T.checks[ci] + 0.5 ? 1 : 0
      const pi = PILE_ORDER.indexOf(k)
      if (pi >= 0 && t >= T.flys[pi]) {
        const p = seg(t, T.flys[pi], T.flys[pi] + T.flyDur)
        if (p >= 1) return Object.assign(c, { mode: 'gone' })
        const to = pileCard(pi)
        const at = qarc([c.x, c.y], [to.x, to.y], 120 - 18 * pi, E.inOutQuad(p))
        return Object.assign(c, { mode: 'toPile', x: at[0], y: at[1], rot: lerp(c.rot, to.rot, p) - 0.9 * Math.sin(Math.PI * p) * (pi % 2 ? -1 : 1), s: lerp(L.CARD_S, L.PILE.s, E.outCubic(p)), sq: 1 })
      }
      if (k === L.NEEDS_YOU && t >= T.notePop - 0.1) c.rot += wob(t, T.notePop - 0.05, 0.12, 26, 9)
      return c
    })
    S.lit = S.lit.map((v, k) => {
      const pi = PILE_ORDER.indexOf(k)
      if (pi >= 0) return 1 - seg(t, T.flys[pi], T.flys[pi] + 0.15)
      return 1 - seg(t, T.notePop, T.notePop + 0.15)
    })
    const landed = T.flys.filter((f) => t >= f + T.flyDur).length
    if (landed > 0) {
      S.pile = { n: landed, stamped: 4 * seg(t, T.stamps[0], T.stamps[0] + (info.beat || 0.58)) }
    }
    if (t >= T.tally0) S.tally = { p: t < T.stampBeat ? 0.4 * seg(t, T.tally0, T.stampBeat) : 0.4 + 0.6 * seg(t, T.stampBeat, T.stampBeat + (info.beat || 0.58) * 0.95), pop: E.outBack(seg(t, T.tally0 - 0.05, T.tally0 + 0.2)) }
    // ── Pip ──
    const po = S.pip.o
    po.flip = true
    const hop = PIP.hop(t, 0.09, { dur: 0.44, height: 70, pre: 0.06 })
    if (t < 0.7) {
      S.pip.y = hop.y
      po.air = -hop.y
      po.squash = hop.squash
      po.eyes = 'wide'
      po.blink = 0
      po.mouth = 'o'
      po.flip = t < 0.3
      po.look = [-0.2, -0.6]
      po.vel = [0, hop.air ? (hop.p < 0.5 ? -300 : 300) : 0]
    } else {
      po.flip = false
      po.look = t < T.blindUp ? [-0.6, -0.55] : [0.3, -0.7]
    }
    po.lantern *= 1 - seg(t, T.blindUp, T.blindUp + 0.4)
    po.nightcap = t < T.capOff
    if (t >= T.cheer1 && t < T.cheer1 + 0.8) {
      po.pose = 'cheer'
      po.poseT = t - T.cheer1
    } else if (t >= T.stamps[0] - 0.05 && t < T.stamps[3] + 0.3) {
      po.pose = 'clap'
      po.poseT = t - T.stamps[0] + 0.05
      po.look = [-0.9, 0.2]
    } else if (t >= T.flys[0] && t < T.stamps[0]) {
      po.look = [-0.9, 0.1]
    }
    // the pink note: pops out of bay 3, flutters down on a zig-zag, Pip catches → squints → gives → the hand
    const cardAt = [L.CARD_X[L.NEEDS_YOU], L.CARD_Y]
    const popTop = [cardAt[0] - 40, L.TRAY_TOP - 120]
    const catchPt = [L.PIP_END_X, L.GROUND - 254 * L.PIP_S]
    const NOTE = 116 // note size on stage (px)
    const noteDraw = (g, size, rot, flutter, curl, dx = 0, dy = 0) => window.PROPS.stickyNote(g, dx * size, dy * size, G, { size, color: 'pink', text: 'Needs\nyou', rot, flutter, curl, id: 's45note', family: 'marker' })
    let noteFree = null
    if (t >= T.notePop && t < T.catchAt) {
      if (t < T.flutter0) {
        const p = E.outBack(seg(t, T.notePop, T.flutter0))
        noteFree = { x: lerp(cardAt[0], popTop[0], p), y: lerp(cardAt[1], popTop[1], p), s: lerp(0.45, 1, p), rot: -0.3 * (1 - p) }
      } else {
        const p = seg(t, T.flutter0, T.catchAt)
        const zig = Math.sin(p * Math.PI * 2.5)
        noteFree = { x: lerp(popTop[0], catchPt[0], E.inOutQuad(p)) + 70 * zig * (1 - p), y: lerp(popTop[1], catchPt[1], E.inQuad(p) * 0.6 + p * 0.4), s: 1, rot: 0.45 * zig * (1 - 0.6 * p), flutter: 1 }
      }
    }
    if (t >= T.catchPose && t < T.squint) {
      po.pose = 'catch'
      po.poseT = t - T.catchPose
      po.look = t < T.catchAt ? [0, -1] : [0.1, 0.4]
    } else if (t >= T.squint && t < T.give) {
      po.pose = 'squint'
      po.poseT = t - T.squint
    } else if (t >= T.give) {
      po.pose = t < T.take + 0.12 ? 'give' : 'cheer'
      po.poseT = t < T.take + 0.12 ? t - T.give : t - T.take - 0.12
    }
    const held = t >= T.catchAt && t < T.take
    if (held) po.hold = po.pose === 'catch' ? (g) => noteDraw(g, NOTE / L.PIP_S, 0, 0, 0.2) : (g) => noteDraw(g, NOTE / L.PIP_S, 0.04, 0, 0.2, 0.34, -0.12)
    // the cut-out human hand slides in from the right, palm up; takes the note on "you" and carries it away
    // it comes in on a diagonal from the lower right (the sleeve passes below the laptop and its tag, clear of the
    // captions), takes the note on "you", and leaves down and to the right the way it came
    const HS = 0.62
    const HA = 0.5 // arm angle: the sleeve runs down-right from the palm
    const hdir = [Math.cos(HA), Math.sin(HA)]
    const palm = [L.PIP_END_X + 142, 846]
    let hand = null
    if (t >= T.handIn[0]) {
      const pin = E.outBack(seg(t, T.handIn[0], T.handIn[1]))
      const out = E.inOutCubic(seg(t, T.take + 0.2, T.take + 0.62))
      const d = 760 * (1 - pin) + 640 * out
      hand = { x: palm[0] + hdir[0] * d, y: palm[1] + hdir[1] * d + 8 * bump(t, T.take, T.take + 0.14), has: t >= T.take }
    }
    S.extra = (ctx, layer) => {
      if (layer === 'afterPip') {
        if (noteFree) K.at(ctx, noteFree.x, noteFree.y, 0, noteFree.s, () => noteDraw(ctx, NOTE, noteFree.rot, noteFree.flutter || 0, 0.3))
        if (t >= T.bedPuff && t < T.bedPuff + 0.55) window.PROPS.doodlePuff(ctx, L.BED.x - 10, L.GROUND - 70, G, { p: seg(t, T.bedPuff, T.bedPuff + 0.55), r: 120, id: 's45bedPuff' })
        if (t >= T.capOff && t < T.capOff + 0.5) window.PROPS.doodlePuff(ctx, L.PIP_END_X, L.GROUND - 250 * L.PIP_S, G, { p: seg(t, T.capOff, T.capOff + 0.5), r: 34, id: 's45capPuff' })
        if (hand) {
          K.at(ctx, hand.x, hand.y, HA, 1, (g) =>
            CAST.hand(g, 0, 0, G, {
              from: 'right',
              pose: 'open',
              scale: HS,
              reach: 1100,
              id: 's45hand',
              hold: hand.has ? (c) => K.at(c, 0, 0, -HA * 0.85, 1, () => noteDraw(c, NOTE / HS, 0.06, 0, 0.2, 0, -0.18)) : null,
            }),
          )
        }
        if (t >= T.take && t < T.take + 0.35) K.withAlpha(ctx, 1 - seg(t, T.take, T.take + 0.35), () => K.sparkle(ctx, hand.x, hand.y - 30, 70 + 40 * seg(t, T.take, T.take + 0.35), 's45takeSpark', G, { n: 4, color: C.terracotta }))
      }
    }
    return { S, T, G }
  }

  function draw(ctx, t, dur, info) {
    const S45 = window.S45
    if (!S45) {
      K.desk(ctx)
      return
    }
    const tc = clamp(t, 0, dur)
    const { S, G } = stateAt(tc, dur, info)
    S45.drawSet(ctx, G, S)
  }

  function sfx(dur, info) {
    const S45 = window.S45
    const panOf = S45 ? S45.panOf : () => 0
    const L = S45 ? S45.L : null
    const T = beats5(info, dur)
    const out = []
    const add = (t, type, o = {}) => {
      if (t >= 0 && t < dur + 0.1) out.push(Object.assign({ t, type }, o))
    }
    const bx = (k) => (L ? L.BAYS[k] : 960)
    // the three "Check!"s, "Morning!" and the narration sit on top of these cues (SFX are not ducked under voices),
    // so everything under a voice stays light: the alarm is a short ring, the reset noises are tiny
    add(T.alarm, 'alarm', { dur: 0.3, gain: 0.5, pan: -0.8 })
    add(T.signUp[0] + 0.05, 'signFlip', { gain: 0.24, pitch: 1.15, pan: 0 })
    add(T.gaugeReset[0], 'slideDown', { dur: 0.4, gain: 0.16, pitch: 1.3, pan: 0.55 })
    add(0.12, 'boing', { pitch: 1.2, gain: 0.15, pan: 0.2 })
    add(T.beltRoll[0], 'conveyor', { dur: 0.9, gain: 0.22 })
    T.stands.forEach((s, i) => add(s, 'pop', { pitch: 1.25 + 0.12 * i, gain: 0.22, pan: panOf(bx(CHECKERS[i])) }))
    T.checks.forEach((c, i) => add(c + 0.02, 'pencil', { dur: 0.32, gain: 0.26, pan: panOf(bx(CHECKERS[i])) }))
    add(T.blindUp, 'blindUp', { gain: 0.55 })
    add(T.blindUp + 0.05, 'swish', { gain: 0.22, pitch: 0.9, pan: -0.2 })
    add(T.sun0 + 0.15, 'rooster', { gain: 0.26, pitch: 1.05, pan: 0.5 })
    add(T.morning - 0.02, 'sparkle', { gain: 0.3, pan: 0.6 })
    add(T.capOff, 'pop', { pitch: 1.6, gain: 0.22, pan: 0.2 })
    add(T.bedPuff, 'crumple', { dur: 0.4, gain: 0.22, pan: -0.55 })
    T.flys.forEach((f, i) => add(f, 'flip', { pitch: 1 + 0.08 * i, gain: 0.25, pan: panOf(bx(PILE_ORDER[i])) }))
    T.flys.forEach((f, i) => add(f + T.flyDur, 'thup', { pitch: 1 + 0.06 * i, gain: 0.22, pan: -0.25 }))
    T.stamps.forEach((s, i) => add(s + 0.04, 'stamp', { pitch: [1, 1.06, 0.96, 1.12][i], gain: [0.46, 0.4, 0.4, 0.44][i], pan: -0.25 }))
    add(T.stampBeat, 'pencil', { dur: 0.5, gain: 0.2, pan: 0 })
    add(T.notePop, 'pop', { pitch: 1.4, gain: 0.35, pan: panOf(bx(3)) })
    add(T.flutter0, 'flutter', { dur: 0.45, gain: 0.45, pan: 0.2 })
    add(T.catchAt, 'thup', { pitch: 1.3, gain: 0.4, pan: 0.2 })
    add(T.squint + 0.02, 'rattle', { pitch: 1.3, gain: 0.25, pan: 0.2 })
    add(T.handIn[0], 'swish', { gain: 0.3, pitch: 1.1, pan: 0.45 })
    add(T.take, 'plink', { note: 84, gain: 0.35, pan: 0.35 })
    return out.sort((a, b) => a.t - b.t)
  }

  PROMO.scene('s5-sunrise-done', { draw, sfx })
})()

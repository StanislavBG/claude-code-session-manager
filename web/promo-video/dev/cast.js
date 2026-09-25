/* dev/cast.js — labelled model sheet for js/mascot.js (PIP + CAST).
 *
 *   node dev/sheet.mjs cast           → contact sheet of every page at every time
 *   node dev/sheet.mjs cast --full    → one 1920x1080 PNG per time
 *
 * SHEET.times encodes pages: page = floor(T / 10), local t = T - page * 10.
 *   page 0  PIP — all 20 poses at scale 0.6 + hero at scale 1.1 + navy night patch (nightcap + lantern)
 *   page 1  PIP — options: mouths, eyes/brows, eyeSpin, peek, blush, flip/look, hold, glue, scale ladder
 *   page 2  CAST.helper (9 poses) + CAST.agent (3 kinds x 5 poses, flip, mini)
 *   page 3  CAST.you (bed + poses + bedFlat + zzz) + CAST.hand (6 poses, mitten, from) + CAST.visitor
 *   page 4  performance: PIP.draw x20 and every CAST fn x20 on an offscreen canvas (mean / max ms)
 *   page 5  PIP one-shot filmstrips at fixed poseT: throw (+ flying ball) · catch · bow
 *   page 6  PIP filmstrips: thwack · point · carry-overhead; walk onion-skins at the exported WALK_SPEEDs
 *           (ticks mark planted feet — they must stack, i.e. no foot-slide)
 *   page 7  close-ups: lid texture + squint at scale 2, nightcap on navy, agent flip strip + mirror,
 *           minis at 1x / 1.6x, YOU bedFlat strip, open hands, visitor outfits
 * Dev-only file: performance.now() is used for measuring, never inside the art.
 */
(function () {
  const { C } = K
  const cyc = [0, 0.27, 0.53, 0.8, 1.07, 1.33]
  const times = [
    ...cyc,
    10, 10.53,
    ...cyc.map((v) => 20 + v),
    ...cyc.map((v) => 30 + v),
    40,
    50,
    60,
    60.53,
    70,
  ]

  function label(ctx, str, x, y, t, o = {}) {
    K.hand(ctx, str, x, y, { size: o.size || 22, family: o.family || 'hand', color: o.color || C.inkDim, t, id: 'lbl' + str + x, jitter: 0.35, align: o.align || 'center' })
  }
  function title(ctx, str, sub, t) {
    K.hand(ctx, str, 36, 62, { size: 46, family: 'marker', color: C.ink, t, id: 'ttl', align: 'left', jitter: 0.5 })
    K.hand(ctx, sub, 38, 96, { size: 22, family: 'hand', color: C.inkDim, t, id: 'sub', align: 'left', jitter: 0.3 })
  }
  function baseline(ctx, x0, x1, y) {
    ctx.save()
    ctx.strokeStyle = 'rgba(90,70,40,0.18)'
    ctx.setLineDash([6, 8])
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.stroke()
    ctx.restore()
  }
  // small held props for the hold() demos
  const napkin = (c) => {
    const pts = K.ellipsePts(0, 0, 50, 36, 22).map(([x, y], i) => [x * (1 + (i % 2) * 0.06), y * (1 + (i % 2) * 0.06)])
    K.paper(c, pts, C.paperWhite, { cut: 1, shadow: 0.7, seed: 'napk' })
    K.pencil.circle(c, 0, -4, 22, 'bulb', 0, { strokeWidth: 2.4, roughness: 1 })
    K.pencil.line(c, -5, 8, 5, 8, 'bulbb', 0, { strokeWidth: 2.4 })
  }
  const note = (color) => (c) => {
    K.paper(c, K.boxPts(62, 62), color, { cut: 1, shadow: 0.8, seed: 'nt' + color })
    K.pencil.line(c, -20, -6, 18, -8, 'ntl1', 0, { strokeWidth: 2, stroke: C.inkDim })
    K.pencil.line(c, -20, 8, 10, 7, 'ntl2', 0, { strokeWidth: 2, stroke: C.inkDim })
  }
  const frame = (c) => {
    K.paper(c, K.boxPts(170, 120), C.kraft, { cut: 1, shadow: 1, seed: 'frm', lift: 3 })
    K.paper(c, K.boxPts(134, 86), C.cream, { cut: 0.6, shadow: 0.4, seed: 'frmi' })
  }
  const page = (c) => {
    K.paper(c, K.boxPts(80, 58), C.paperWhite, { cut: 0.6, shadow: 0.6, seed: 'pg' })
    c.strokeStyle = 'rgba(90,130,196,0.5)'
    c.lineWidth = 1.5
    c.beginPath()
    for (const y of [-14, -2, 10]) {
      c.moveTo(-32, y)
      c.lineTo(32, y)
    }
    c.stroke()
  }
  const ball = (c) => K.paper(c, K.ellipsePts(0, 0, 16, 15, 12), C.paperWhite, { cut: 2.5, shadow: 0.7, seed: 'ball' })

  const POSE_DEMO = {
    carry: { hold: frame },
    hug: { hold: napkin },
    catch: { hold: note(C.pink) },
    squint: { hold: note(C.pink) },
    give: { hold: note(C.pink) },
    throw: { hold: ball },
    fold: { hold: page },
    thwack: {},
    point: { aim: -0.35 },
    peek: { peek: 0 },
  }

  // ─────────── page 0: PIP poses ───────────
  function page0(ctx, t) {
    K.desk(ctx)
    title(ctx, 'PIP — model sheet', 'all 20 poses at scale 0.6 (poseT = t, cycles loop)  ·  hero at 1.1  ·  night patch: nightcap + lantern', t)
    // hero
    PIP.draw(ctx, 190, 640, t, { scale: 1.1, pose: 'idle', glue: true, id: 'hero', look: [0.35, 0] })
    label(ctx, 'scale 1.1 · idle + glue', 190, 690, t)
    // night patch
    const nx = 22
    const ny = 730
    K.at(ctx, nx + 170, ny + 165, -0.015, 1, () => {
      K.paper(ctx, K.boxPts(340, 330), C.night, { torn: 3, shadow: 1, seed: 'navy' })
      // (the lantern halo may spill past the patch — it is drawn behind Pip, not clipped)
      ctx.fillStyle = 'rgba(245,227,163,0.8)'
      for (let i = 0; i < 18; i++) {
        const r = K.rng('star', i)
        ctx.beginPath()
        ctx.arc(-160 + r() * 320, -155 + r() * 150, 1.2 + r() * 1.8, 0, Math.PI * 2)
        ctx.fill()
      }
    })
    PIP.draw(ctx, nx + 120, ny + 292, t, { scale: 0.66, pose: 'walk', nightcap: true, lantern: 1, id: 'night', vel: [120, 0] })
    PIP.draw(ctx, nx + 270, ny + 290, t, { scale: 0.5, pose: 'idle', nightcap: true, lantern: 0.5, id: 'night2', look: [-0.6, 0] })
    K.hand(ctx, 'nightcap + lantern 1 / 0.5', nx + 170, ny + 322, { size: 20, color: C.moon, t, id: 'nl', align: 'center', jitter: 0.3 })

    const poses = PIP.POSES
    const x0 = 470
    const cw = 206
    const rows = [360, 620, 880]
    rows.forEach((ry) => baseline(ctx, 420, 1900, ry))
    poses.forEach((pose, i) => {
      const col = i % 7
      const row = Math.floor(i / 7)
      const cx = x0 + col * cw
      const gy = rows[row]
      const demo = POSE_DEMO[pose] || {}
      const seated = pose === 'sit' || pose === 'ride'
      if (seated) {
        // a little paper ledge to sit on
        K.at(ctx, cx, gy - 30, 0, 1, () => K.paper(ctx, K.boxPts(170, 24), C.kraft, { cut: 1.2, shadow: 0.9, seed: 'ledge' + pose }))
      }
      const a = PIP.draw(ctx, cx, seated ? gy - 42 : gy, t, Object.assign({ scale: 0.6, pose, poseT: t, id: 'p' + pose }, demo))
      if (pose === 'throw' && a.released) {
        const fly = (t - PIP.THROW_RELEASE) * 260
        K.at(ctx, a.hands[1][0] + fly, a.hands[1][1] - fly * 0.35, 0, 0.6, ball)
      }
      label(ctx, pose, cx, gy + 30, t)
    })
    // 21st cell: caller-driven hop via PIP.hop + squash + air
    {
      const cx = x0 + 6 * cw
      const gy = rows[2]
      // PIP.hop's y is WORLD px: move Pip by h.y and pass air = -h.y so the contact shadow stays on the ground
      const h = PIP.hop(t % 0.9, 0.15, { dur: 0.5, height: 60 })
      PIP.draw(ctx, cx, gy + h.y, t, { scale: 0.6, pose: 'idle', squash: h.squash, air: -h.y, id: 'ph', mouth: h.air ? 'open' : 'grin' })
      label(ctx, 'PIP.hop → squash', cx, gy + 30, t)
    }
  }

  // ─────────── page 1: PIP options ───────────
  function page1(ctx, t) {
    K.desk(ctx)
    title(ctx, 'PIP — options', 'mouths · eyes & brows · eyeSpin · peek · blush · flip/look · hold · glue · scale ladder (idle unless noted)', t)
    const row = (y) => baseline(ctx, 40, 1880, y)
    // row 1: mouths
    row(330)
    PIP.MOUTHS.forEach((m, i) => {
      const x = 110 + i * 175
      PIP.draw(ctx, x, 330, t, { scale: 0.55, mouth: m, id: 'mo' + m, look: [0.1, 0] })
      label(ctx, 'mouth ' + m, x, 358, t)
    })
    // eyes on the same row (right side)
    ;['happy', 'squint', 'wide', 'shut'].forEach((e, i) => {
      const x = 1360 + i * 150
      PIP.draw(ctx, x, 330, t, { scale: 0.55, eyes: e, id: 'ey' + e, mouth: e === 'shut' ? 'grin' : undefined })
      label(ctx, 'eyes ' + e, x, 358, t)
    })
    // row 2: eyeSpin + brows
    row(620)
    ;[0, 0.2, 0.4, 0.6, 0.8, 1].forEach((v, i) => {
      const x = 110 + i * 150
      PIP.draw(ctx, x, 620, t, { scale: 0.55, eyeSpin: v, id: 'sp' + i, mouth: 'o' })
      label(ctx, 'eyeSpin ' + v, x, 648, t)
    })
    ;['determined', 'worried', 'focus', 'raised'].forEach((b, i) => {
      const x = 1030 + i * 150
      PIP.draw(ctx, x, 620, t, { scale: 0.55, brows: b, id: 'br' + b, mouth: b === 'worried' ? 'wobbly' : 'flat' })
      label(ctx, 'brows ' + b, x, 648, t)
    })
    ;[0, 1].forEach((b, i) => {
      const x = 1650 + i * 150
      PIP.draw(ctx, x, 620, t, { scale: 0.55, blush: b, id: 'bl' + b })
      label(ctx, 'blush ' + b, x, 648, t)
    })
    // row 3: peek behind a sticky note, flip + look, glue, hold, scale ladder
    row(930)
    ;[0.3, 0.7, 1].forEach((p, i) => {
      const x = 110 + i * 170
      const ey = 900
      PIP.draw(ctx, x, ey, t, { scale: 0.6, pose: 'peek', peek: p, id: 'pk' + i })
      K.at(ctx, x, ey + 32, -0.03, 1, () => K.paper(ctx, K.boxPts(150, 64), C.lemon, { cut: 1.4, shadow: 1, seed: 'pkn' + i }))
      label(ctx, 'peek ' + p, x, 958, t)
    })
    PIP.draw(ctx, 640, 930, t, { scale: 0.55, flip: true, look: [-0.9, 0], id: 'fl' })
    label(ctx, 'flip, look ←', 640, 958, t)
    PIP.draw(ctx, 790, 930, t, { scale: 0.55, look: [0, -1], id: 'lu' })
    label(ctx, 'look ↑', 790, 958, t)
    PIP.draw(ctx, 940, 930, t, { scale: 0.55, pose: 'walk', vel: [260, 0], id: 'vel' })
    label(ctx, 'walk + vel', 940, 958, t)
    PIP.draw(ctx, 1090, 930, t, { scale: 0.55, pose: 'carry', carryLow: true, hold: napkin, id: 'cl' })
    label(ctx, 'carry low', 1090, 958, t)
    PIP.draw(ctx, 1240, 930, t, { scale: 0.55, pose: 'point', glue: true, aim: 0.3, id: 'pg' })
    label(ctx, 'point + glue', 1240, 958, t)
    ;[0.35, 0.6, 1].forEach((sc, i) => {
      const x = 1420 + i * 150 + (i === 2 ? 40 : 0)
      PIP.draw(ctx, x, 930, t, { scale: sc, pose: 'wave', id: 'sc' + i })
      label(ctx, 'scale ' + sc, x, 958, t)
    })
  }

  // ─────────── page 2: helpers + agents ───────────
  function page2(ctx, t) {
    K.desk(ctx)
    title(ctx, 'CAST.helper + CAST.agent', 'sticky-note helpers: 9 poses (sage / teal / peach)  ·  trading cards: 3 kinds x 5 poses, flip, mini', t)
    const colors = ['sage', 'teal', 'peach']
    baseline(ctx, 40, 1880, 330)
    CAST.HELPER_POSES.forEach((pose, i) => {
      const x = 110 + i * 205
      const seated = pose === 'tea' || pose === 'sit'
      const a = CAST.helper(ctx, x, 330, t, { pose, color: colors[i % 3], id: 'h' + pose })
      if (pose === 'hammer' || pose === 'check') {
        // the card being worked on
        K.at(ctx, x + (pose === 'check' ? 76 : 92), pose === 'check' ? 290 : 318, 0.04, pose === 'check' ? 0.8 : 0.5, () => K.paper(ctx, K.boxPts(70, 40), C.cream, { cut: 1, shadow: 0.8, seed: 'hc' + pose }))
      }
      label(ctx, pose + (seated ? ' (seat)' : ''), x, 360, t)
      if (a.tool && pose === 'hammer') {
        ctx.fillStyle = 'rgba(224,105,74,0.8)'
        ctx.beginPath()
        ctx.arc(a.tool[0], a.tool[1], 3, 0, Math.PI * 2)
        ctx.fill()
      }
    })
    // agents
    const kinds = CAST.AGENT_KINDS
    const poses = CAST.AGENT_POSES
    baseline(ctx, 40, 1880, 650)
    baseline(ctx, 40, 1880, 1010)
    let k = 0
    kinds.forEach((kind) => {
      poses.forEach((pose) => {
        const i = k++
        const row = i < 8 ? 0 : 1
        const col = row ? i - 8 : i
        const x = 100 + col * (row ? 214 : 205)
        const gy = row ? 1010 : 650
        CAST.agent(ctx, x, gy, t, {
          kind,
          pose,
          scale: 0.82,
          id: 'a' + kind + pose,
          hold: pose === 'tear' ? (c) => {
            const d = 10 + 8 * Math.sin(t * 11)
            K.paper(c, [[-d - 34, -26], [-d, -24], [-d + 4, 26], [-d - 34, 24]], C.paperWhite, { torn: 2, shadow: 0.7, seed: 'tl' })
            K.paper(c, [[d, -24], [d + 34, -26], [d + 34, 24], [d - 4, 26]], C.paperWhite, { torn: 2, shadow: 0.7, seed: 'tr' })
          } : null,
        })
        label(ctx, kind + ' · ' + pose, x, gy + 28, t, { size: 19 })
      })
    })
    // flip demo + minis in the remaining slots of row 2
    const flip = (Math.sin(t * 2.4) * 0.5 + 0.5)
    CAST.agent(ctx, 110 + 7 * 214, 1010, t, { kind: 'devlead', flip, scale: 0.82, id: 'aflip' })
    label(ctx, 'flip ' + flip.toFixed(2), 110 + 7 * 214, 1038, t, { size: 19 })
    CAST.agent(ctx, 110 + 8 * 214 - 20, 1010, t, { kind: 'validator', flip: 1, scale: 0.6, id: 'aback' })
    label(ctx, 'back', 110 + 8 * 214 - 20, 1038, t, { size: 19 })
    // minis on a clay button strip
    kinds.forEach((kind, i) => {
      const x = 1790 + (i % 2) * 90 - (i === 2 ? 45 : 0)
      const y = i < 2 ? 470 : 600
      CAST.agent(ctx, x, y, t, { kind, mini: true, id: 'mini' + kind })
    })
    CAST.agent(ctx, 1880, 600, t, { kind: 'architect', mini: true, scale: 0.5, id: 'mini-s' })
    label(ctx, 'minis (+ @0.5)', 1812, 672, t, { size: 19 })
  }

  // ─────────── page 3: you, hand, visitor ───────────
  function page3(ctx, t) {
    K.desk(ctx)
    title(ctx, 'CAST.you + CAST.hand + CAST.visitor', 'YOU in a paper bed (sleep / wake / stretch, bedFlat, Zzz)  ·  cut-out hand (6 poses, mitten, from)  ·  gallery visitors', t)
    // night strip behind the sleeper
    K.at(ctx, 250, 268, -0.01, 1, () => K.paper(ctx, K.boxPts(470, 270), C.night, { torn: 3, shadow: 1, seed: 'ynav' }))
    CAST.you(ctx, 260, 370, t, { pose: 'sleep', zzz: true, id: 'y1' })
    label(ctx, 'sleep · zzz', 250, 412, t, { color: C.inkDim })
    CAST.you(ctx, 720, 370, t, { pose: 'wake', poseT: t, id: 'y2' })
    label(ctx, 'wake', 720, 412, t)
    CAST.you(ctx, 1150, 370, t, { pose: 'stretch', poseT: t, id: 'y3' })
    label(ctx, 'stretch', 1150, 412, t)
    const bf = Math.min(1, (t % 1.6) / 1.2)
    CAST.you(ctx, 1560, 370, t, { pose: 'stretch', poseT: 1 + t, bedFlat: bf, id: 'y4' })
    label(ctx, 'stretch · bedFlat ' + bf.toFixed(2), 1560, 412, t)
    CAST.you(ctx, 1840, 370, t, { pose: 'wake', inBed: false, poseT: t, id: 'y5', scale: 0.8 })
    label(ctx, 'no bed', 1840, 412, t)

    // hands (from right) — row
    const hy = 560
    const press = 0.5 + 0.5 * Math.sin(t * 7)
    const hands = [
      ['point', {}],
      ['press', { press }],
      ['pinch', { hold: (c) => K.paper(c, [[-30, -8], [-4, -30], [26, 4], [0, 26]], C.sage, { cut: 0.8, shadow: 0.6, seed: 'stk' }) }],
      ['hold', { hold: (c) => { K.at(c, -20, 0, -0.1, 1, () => { K.paper(c, K.boxPts(60, 84), C.honey, { cut: 1, shadow: 0.8, seed: 'crd' }) }) } }],
      ['drop', {}],
      ['open', { hold: note(C.pink) }],
    ]
    hands.forEach(([pose, extra], i) => {
      const x = 80 + i * 300
      const btn = pose === 'press' || pose === 'point'
      if (btn) {
        const sq = pose === 'press' ? press : 0
        K.at(ctx, x - 20, hy + 12, 0, [1, 1 - 0.25 * sq], () => K.paper(ctx, K.ellipsePts(0, 0, 26, 18, 18), C.terracotta, { cut: 0.8, shadow: 1, seed: 'btn' + i }))
      }
      CAST.hand(ctx, x, hy, t, Object.assign({ pose, id: 'hd' + pose, scale: 0.6, reach: 150 }, extra))
      label(ctx, pose + (pose === 'press' ? ' ' + press.toFixed(2) : ''), x + 60, hy + 76, t)
    })
    // mitten + from variants
    const my = 790
    CAST.hand(ctx, 70, my, t, { pose: 'point', mitten: true, id: 'm1', scale: 0.6, reach: 150 })
    label(ctx, 'mitten point', 130, my + 76, t)
    K.at(ctx, 340, my + 12, 0, [1, 1 - 0.25 * press], () => K.paper(ctx, K.ellipsePts(0, 0, 26, 18, 18), C.terracotta, { cut: 0.8, shadow: 1, seed: 'btnm' }))
    CAST.hand(ctx, 370, my, t, { pose: 'press', mitten: true, press, id: 'm2', scale: 0.6, reach: 150 })
    label(ctx, 'mitten press', 430, my + 76, t)
    CAST.hand(ctx, 700, my, t, { pose: 'open', mitten: true, id: 'm3', scale: 0.6, reach: 120, hold: note(C.pink) })
    label(ctx, 'mitten open', 720, my + 76, t)
    CAST.hand(ctx, 930, my - 30, t, { pose: 'pinch', mitten: true, id: 'm4', scale: 0.6, reach: 120 })
    label(ctx, 'mitten pinch', 990, my + 76, t)
    CAST.hand(ctx, 1140, my + 20, t, { pose: 'point', from: 'top', id: 'ft', scale: 0.55, reach: 90 })
    label(ctx, 'from top', 1140, my + 76, t)
    CAST.hand(ctx, 1210, 1000, t, { pose: 'point', from: 'left', id: 'fl', scale: 0.55, reach: 120 })
    label(ctx, 'from left', 1170, 1050, t)
    CAST.hand(ctx, 1240, my + 10, t, { pose: 'pinch', from: 'bottom', id: 'fb', scale: 0.5, reach: 80 })
    label(ctx, 'from bottom', 1330, my + 110, t)

    // visitors
    const vy = 1040
    baseline(ctx, 1280, 1900, vy)
    ;[['walk', C.sky, 'tee', 0], ['stop', C.coral, 'dress', 1], ['clap', C.mint, 'overalls', 2], ['ooh', C.lilac, 'skirt', 3]].forEach(([pose, color, outfit, hair], i) => {
      const x = 1340 + i * 150
      CAST.visitor(ctx, x, vy, t, { pose, color, outfit, hair, id: 'v' + i, scale: 0.72 })
      label(ctx, pose, x, vy + 26, t)
    })
  }

  // ─────────── page 4: performance ───────────
  function page4(ctx, t) {
    K.desk(ctx)
    title(ctx, 'performance', 'ms per call on an offscreen 1920x1080 canvas, CPU raster (budget: PIP ≤ 12 ms, each CAST ≤ 8 ms)', t)
    const off = document.createElement('canvas')
    off.width = 1920
    off.height = 1080
    const g = off.getContext('2d', { willReadFrequently: true })
    K.desk(g)
    const runs = {
      'PIP.draw (all poses, s0.6–1)': (i) => PIP.draw(g, 150 + (i % 10) * 170, 400 + Math.floor(i / 10) * 400, 0.37 + i * 0.13, { pose: PIP.POSES[i % PIP.POSES.length], scale: i % 2 ? 1 : 0.6, glue: i % 3 === 0, nightcap: i % 5 === 0, lantern: i % 5 === 0 ? 1 : 0, id: 'perf' + i, hold: i % 4 === 0 ? note(C.pink) : null }),
      'CAST.helper': (i) => CAST.helper(g, 100 + i * 85, 500, 0.3 + i * 0.11, { pose: CAST.HELPER_POSES[i % 9], color: ['sage', 'teal', 'peach'][i % 3], id: 'ph' + i }),
      'CAST.agent': (i) => CAST.agent(g, 100 + i * 85, 700, 0.3 + i * 0.11, { kind: CAST.AGENT_KINDS[i % 3], pose: CAST.AGENT_POSES[i % 5], id: 'pa' + i, mini: i % 7 === 6, flip: i % 9 === 8 ? 0.7 : 0 }),
      'CAST.you': (i) => CAST.you(g, 300 + (i % 5) * 330, 400, 0.3 + i * 0.11, { pose: ['sleep', 'wake', 'stretch'][i % 3], zzz: true, bedFlat: (i % 4) / 3, id: 'py' + i }),
      'CAST.hand': (i) => CAST.hand(g, 300 + (i % 6) * 250, 900, 0.3 + i * 0.11, { pose: ['point', 'press', 'pinch', 'hold', 'drop', 'open'][i % 6], mitten: i % 2 === 1, id: 'pd' + i }),
      'CAST.visitor': (i) => CAST.visitor(g, 100 + i * 85, 1000, 0.3 + i * 0.11, { pose: ['walk', 'stop', 'clap', 'ooh'][i % 4], id: 'pv' + i }),
    }
    // Chromium records canvas calls and rasterizes lazily, so every timed call is followed by a 1-px
    // getImageData that forces the raster to happen inside the timed window (its own overhead with an
    // empty queue is measured and subtracted). The machine is shared with other renders, so each of the
    // 20 inputs runs 5 times after a warm pass and keeps its fastest run; we report the mean of those
    // minima, the overall median and the worst minimum.
    const flush = () => g.getImageData(0, 0, 1, 1)
    flush()
    let base = Infinity
    for (let i = 0; i < 30; i++) {
      const a = performance.now()
      flush()
      base = Math.min(base, performance.now() - a)
    }
    const res = {}
    for (const [name, fn] of Object.entries(runs)) {
      for (let i = 0; i < 20; i++) fn(i) // warm pass: each colour's paper texture is created once (kit.js caches it)
      flush()
      const best = new Array(20).fill(Infinity)
      const all = []
      for (let pass = 0; pass < 5; pass++) {
        for (let i = 0; i < 20; i++) {
          const a = performance.now()
          fn(i)
          flush()
          const d = Math.max(0, performance.now() - a - base)
          all.push(d)
          if (d < best[i]) best[i] = d
        }
      }
      all.sort((a, b) => a - b)
      res[name] = { mean: +(best.reduce((a, b) => a + b, 0) / 20).toFixed(2), max: +Math.max(...best).toFixed(2), median: +all[all.length >> 1].toFixed(2) }
    }
    res.flushOverheadMs = +base.toFixed(3)
    window.__CAST_PERF = res
    ctx.drawImage(off, 980, 160, 900, 506)
    K.at(ctx, 480, 520, -0.01, 1, () => K.paper(ctx, K.boxPts(860, 620), C.paperWhite, { cut: 2, shadow: 1, seed: 'perfp' }))
    let y = 280
    for (const [name, r] of Object.entries(res)) {
      if (typeof r !== 'object') continue
      const budget = name.startsWith('PIP') ? 12 : 8
      const ok = r.mean <= budget
      K.hand(ctx, name, 90, y, { size: 30, align: 'left', t: 0, id: 'pn' + name, jitter: 0 })
      K.hand(ctx, `${r.mean.toFixed(2)} ms  (median ${r.median.toFixed(1)}, worst ${r.max.toFixed(1)})`, 480, y, { size: 30, align: 'left', t: 0, id: 'pv' + name, jitter: 0, color: ok ? '#3f7d3a' : C.tomato })
      y += 70
    }
    K.hand(ctx, '20 inputs x 5 passes after a warm pass; mean of per-input best · shared, loaded machine', 90, y + 10, { size: 22, align: 'left', t: 0, id: 'pnote', color: C.inkFaint, jitter: 0 })
  }

  // ─────────── filmstrip helper ───────────
  // Anchors are needed from a pose at another poseT (e.g. the throw's release point) without drawing it on the
  // sheet: draw into a scratch canvas under the same transform.
  let scratch = null
  function probe(ctx, x, y, t, o) {
    if (!scratch) {
      scratch = document.createElement('canvas')
      scratch.width = 1920
      scratch.height = 1080
    }
    const g = scratch.getContext('2d')
    g.setTransform(ctx.getTransform())
    return PIP.draw(g, x, y, t, o)
  }
  function strip(ctx, t, name, gy, x0, dx, times, extra, sc = 0.6, after) {
    baseline(ctx, 30, 1890, gy)
    K.hand(ctx, name, 36, gy - 250, { size: 34, family: 'marker', color: C.terracotta, t, id: 'st' + name, align: 'left', jitter: 0.4 })
    times.forEach((pt, i) => {
      const x = x0 + i * dx
      const o = Object.assign({ scale: sc, pose: name, poseT: pt, id: 'fs' + name }, extra || {})
      const a = PIP.draw(ctx, x, gy, t + pt, o)
      if (after) after(ctx, x, gy, pt, a, o)
      label(ctx, pt.toFixed(2), x, gy + 28, t, { size: 20 })
    })
  }

  // ─────────── page 5: throw · catch · bow ───────────
  function page5(ctx, t) {
    K.desk(ctx)
    title(ctx, 'PIP — one-shot filmstrips (1)', 'labels = poseT · throw: wind-up behind the head, release at PIP.THROW_RELEASE with the hand forward · catch: reach outside the card · bow: fold at the scarf', t)
    // throw: ball leaves from the release-frame hand position
    strip(ctx, t, 'throw', 400, 150, 170, [0, 0.1, 0.2, 0.27, 0.33, 0.38, 0.4, 0.47, 0.6, 0.9, 1.2], { hold: ball }, 0.6, (c, x, gy, pt, a, o) => {
      if (!a.released) return
      const r = probe(c, x, gy, t, Object.assign({}, o, { poseT: PIP.THROW_RELEASE }))
      const dt = pt - PIP.THROW_RELEASE
      K.at(c, r.hands[1][0] + 420 * dt, r.hands[1][1] - 300 * dt + 700 * dt * dt, dt * 9, 0.6, ball)
    })
    strip(ctx, t, 'catch', 720, 150, 170, [0, 0.07, 0.13, 0.2, 0.25, 0.33, 0.4, 0.47, 0.53, 0.62, 0.9], { hold: note(C.pink) })
    strip(ctx, t, 'bow', 1010, 150, 170, [0, 0.07, 0.2, 0.33, 0.6, 0.93, 1.0, 1.07, 1.13, 1.2, 1.5], {})
  }

  // ─────────── page 6: thwack · point · carry · walk onion-skins ───────────
  function onion(ctx, t, name, gy, x0, speed, n, draw) {
    // n frames at 15 fps while the caller moves the character at `speed` px/s; planted feet get a tick
    baseline(ctx, x0 - 60, x0 + speed * (n / 15) + 120, gy)
    const ticks = []
    for (let i = 0; i < n; i++) {
      const tau = i / 15
      const x = x0 + speed * tau
      const last = i === n - 1
      let anc
      K.withAlpha(ctx, last ? 1 : i % 3 === 0 ? 0.22 : 0, () => {
        anc = draw(ctx, x, gy, tau)
      })
      anc.feet.forEach((f, k) => {
        if (Math.abs(f[1] - gy) < 0.6) ticks.push([f[0], k])
      })
    }
    ticks.forEach(([fx, k]) => {
      ctx.fillStyle = k ? 'rgba(63,153,144,0.9)' : 'rgba(224,105,74,0.9)'
      ctx.fillRect(fx - 1.5, gy + 6, 3, 14)
    })
    label(ctx, name, x0 + speed * (n / 30), gy + 46, t, { size: 21 })
  }
  function page6(ctx, t) {
    K.desk(ctx)
    title(ctx, 'PIP — one-shot filmstrips (2) + walk speeds', 'thwack (hit at PIP.THWACK_HIT) · point (mitt + finger, jab ticks) · carry overhead (carryW/H, stride) · onion-skins: ticks = planted feet, must stack', t)
    strip(ctx, t, 'thwack', 360, 150, 170, [0, 0.13, 0.2, 0.27, 0.33, 0.4, 0.42, 0.47, 0.6, 0.9, 1.3], {})
    strip(ctx, t, 'point', 640, 150, 196, [0, 0.07, 0.13, 0.2, 0.27, 0.33, 0.8], {})
    // carry overhead with a big frame, walking (stride 1)
    const frame2 = (c) => {
      K.paper(c, K.boxPts(220, 150), C.kraft, { cut: 1, shadow: 1, seed: 'frm2', lift: 3 })
      K.paper(c, K.boxPts(180, 112), C.cream, { cut: 0.6, shadow: 0.4, seed: 'frm2i' })
    }
    ;[0, 0.14, 0.28].forEach((pt, i) => {
      const x = 1540 + i * 130
      PIP.draw(ctx, x, 640, t, { scale: 0.5, pose: 'carry', poseT: pt, hold: frame2, carryW: 220, carryH: 150, stride: 1, id: 'cw' + i })
      label(ctx, 'carry ' + pt.toFixed(2), x, 668, t, { size: 19 })
    })
    // onion-skins
    onion(ctx, t, 'PIP walk · WALK_SPEED ' + PIP.WALK_SPEED.toFixed(0) + ' px/s × scale', 900, 190, PIP.WALK_SPEED * 0.55, 16, (c, x, gy, tau) => PIP.draw(c, x, gy, tau, { scale: 0.55, pose: 'walk', poseT: tau, id: 'ow' }))
    onion(ctx, t, 'carry + stride 1', 900, 640, PIP.WALK_SPEED * 0.45, 16, (c, x, gy, tau) => PIP.draw(c, x, gy, tau, { scale: 0.45, pose: 'carry', poseT: tau, stride: 1, hold: frame, id: 'oc' }))
    onion(ctx, t, 'helper · HELPER_WALK_SPEED ' + CAST.HELPER_WALK_SPEED.toFixed(0), 1030, 1080, CAST.HELPER_WALK_SPEED * 0.8, 16, (c, x, gy, tau) => CAST.helper(c, x, gy, tau, { scale: 0.8, pose: 'walk', poseT: tau, color: 'teal', id: 'oh' }))
    onion(ctx, t, 'visitor · VISITOR_WALK_SPEED ' + CAST.VISITOR_WALK_SPEED.toFixed(0), 1030, 1520, CAST.VISITOR_WALK_SPEED * 0.7, 16, (c, x, gy, tau) => CAST.visitor(c, x, gy, tau, { scale: 0.7, pose: 'walk', poseT: tau, outfit: 'overalls', id: 'ov' }))
  }

  // ─────────── page 7: close-ups ───────────
  function page7(ctx, t) {
    K.desk(ctx)
    title(ctx, 'close-ups', 'half-blink lid (o.blink 0.5) + squint at scale 1.5 · nightcap on navy · agent flip strip + mirror · minis · bedFlat strip · open hands · visitor outfits', t)
    PIP.draw(ctx, 170, 640, t, { scale: 1.5, blink: 0.5, id: 'cu1', look: [0.3, 0] })
    label(ctx, 'blink 0.5 (lid hachure)', 170, 668, t)
    PIP.draw(ctx, 470, 640, t, { scale: 1.5, pose: 'squint', poseT: 0.4, id: 'cu2', hold: note(C.pink) })
    label(ctx, 'squint', 450, 668, t)
    // night patch
    K.at(ctx, 890, 390, -0.012, 1, () => {
      K.paper(ctx, K.boxPts(330, 400), C.night, { torn: 3, shadow: 1, seed: 'navy7' })
      ctx.fillStyle = 'rgba(245,227,163,0.8)'
      for (let i = 0; i < 16; i++) {
        const r = K.rng('st7', i)
        ctx.beginPath()
        ctx.arc(-150 + r() * 300, -180 + r() * 160, 1.2 + r() * 1.8, 0, Math.PI * 2)
        ctx.fill()
      }
    })
    PIP.draw(ctx, 880, 560, t, { scale: 1.05, pose: 'walk', nightcap: true, lantern: 1, id: 'cun', vel: [100, 0] })
    label(ctx, 'nightcap + lantern', 890, 580, t, { color: C.moon })
    // agent flip strip
    const flips = [0, 0.2, 0.3, 0.4, 0.48, 0.52, 0.6, 0.75, 1]
    baseline(ctx, 1080, 1900, 400)
    flips.forEach((f, i) => {
      const x = 1130 + i * 92
      CAST.agent(ctx, x, 400, t, { kind: i % 2 ? 'architect' : 'validator', flip: f, scale: 0.5, id: 'af' + i })
      label(ctx, 'flip ' + f, x, 424, t, { size: 17 })
    })
    CAST.agent(ctx, 1800, 580, t, { kind: 'devlead', pose: 'wave', flip: true, scale: 0.6, id: 'amir' })
    label(ctx, 'flip: true = mirror', 1790, 604, t, { size: 18 })
    // minis
    CAST.AGENT_KINDS.forEach((kind, i) => {
      CAST.agent(ctx, 1150 + i * 84, 520, t, { kind, mini: true, id: 'm7' + kind })
      CAST.agent(ctx, 1150 + i * 130, 700, t, { kind, mini: true, scale: 1.6, id: 'm7b' + kind })
    })
    label(ctx, 'minis 1x / 1.6x', 1260, 800, t, { size: 19 })
    // bedFlat strip
    ;[0.4, 0.55, 0.67, 0.8, 0.95].forEach((bf, i) => {
      const x = 150 + i * 250
      CAST.you(ctx, x, 1000, t, { pose: 'stretch', poseT: 1, bedFlat: bf, id: 'bf' + i, scale: 0.55 })
      label(ctx, 'bedFlat ' + bf, x - 30, 1030, t, { size: 19 })
    })
    // open hands
    CAST.hand(ctx, 1330, 900, t, { pose: 'open', id: 'oh1', scale: 0.8, reach: 200, hold: note(C.pink) })
    label(ctx, 'open', 1360, 960, t, { size: 19 })
    CAST.hand(ctx, 1330, 1010, t, { pose: 'open', mitten: true, id: 'oh2', scale: 0.7, reach: 200 })
    label(ctx, 'mitten open', 1380, 1060, t, { size: 19 })
    // visitor outfits
    ;[['tee', C.sky, 0], ['dress', C.coral, 1], ['overalls', C.mint, 2], ['skirt', C.lilac, 3]].forEach(([outfit, color, hair], i) => {
      const x = 1650 + (i % 2) * 150
      const gy = i < 2 ? 870 : 1060
      CAST.visitor(ctx, x, gy, t, { pose: i === 2 ? 'clap' : i === 3 ? 'ooh' : 'stop', outfit, color, hair, id: 'vo' + i, scale: 0.75 })
      label(ctx, outfit, x + 60, gy - 10, t, { size: 18 })
    })
  }

  window.SHEET = {
    times,
    draw(ctx, T) {
      const p = Math.floor(T / 10 + 1e-9)
      const t = T - p * 10
      if (p === 0) page0(ctx, t)
      else if (p === 1) page1(ctx, t)
      else if (p === 2) page2(ctx, t)
      else if (p === 3) page3(ctx, t)
      else if (p === 4) page4(ctx, t)
      else if (p === 5) page5(ctx, t)
      else if (p === 6) page6(ctx, t)
      else page7(ctx, t)
    },
  }
})()

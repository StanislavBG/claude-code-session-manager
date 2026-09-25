/* dev/props-show.js — catalogue sheet for js/props/show.js (s6–s9 props).
 *   timeout 120 node dev/sheet.mjs props-show            → out/preview/dev-props-show.png
 *   timeout 120 node dev/sheet.mjs props-show --full     → one 1920x1080 PNG per time
 * Each catalogue PAGE is encoded in the time: page = floor(t / 10), local time = t % 10.
 * Every page is drawn at two local times so boil / blink / sway differences are visible.
 * Composite pages put PIP / CAST next to the props at the scales the scenes will likely use.
 */
;(function () {
  const C = K.C
  const P = window.PROPS

  function tag(ctx, str, x, y) {
    ctx.save()
    ctx.font = '600 22px "Fredoka", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const w = ctx.measureText(str).width + 18
    ctx.fillStyle = 'rgba(42,34,26,0.82)'
    ctx.fillRect(x - w / 2, y - 15, w, 30)
    ctx.fillStyle = '#fbf4e4'
    ctx.fillText(str, x, y + 1)
    ctx.restore()
  }
  function title(ctx, str) {
    ctx.save()
    ctx.font = '600 30px "Fredoka", sans-serif'
    ctx.fillStyle = 'rgba(42,34,26,0.85)'
    ctx.fillText(str, 24, 44)
    ctx.restore()
  }
  function dot(ctx, p, col = '#e0694a', r = 6) {
    ctx.beginPath()
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2)
    ctx.fillStyle = col
    ctx.fill()
  }
  const hasPip = () => window.PIP && typeof window.PIP.draw === 'function'
  const hasCast = () => window.CAST && typeof window.CAST.hand === 'function'

  const pages = [
    // 0 — fileTree grow
    (ctx, t) => {
      title(ctx, 'fileTree  grow 0.35 / 0.6 / 1   ·   fileLeaf')
      ;[0.35, 0.6, 1].forEach((g, i) => {
        const x = 330 + i * 630
        const a = P.fileTree(ctx, x, 470, t, { grow: g, scale: 0.5, id: 'tr' })
        tag(ctx, 'grow ' + g, x, 720)
        if (g === 1) a.leaves.forEach((l) => dot(ctx, [l.x, l.y], 'rgba(63,153,144,0.6)', 5))
      })
      P.fileLeaf(ctx, 520, 910, t, { kind: 'file', scale: 1.4 })
      P.fileLeaf(ctx, 800, 910, t, { kind: 'folder', scale: 1.4, id: 'lf2' })
      P.fileLeaf(ctx, 1080, 910, t, { kind: 'file', m: true, scale: 1.4, id: 'lf3', rot: 0.1 })
      P.fileLeaf(ctx, 1360, 910, t, { kind: 'folder', color: '#bfe0c8', scale: 1.4, id: 'lf4', rot: -0.1 })
      tag(ctx, 'fileLeaf  file / folder / m:true / color', 940, 1040)
    },
    // 1 — fileTree pluck + anchors
    (ctx, t) => {
      title(ctx, 'fileTree  pluck 0.5 / pluck 1 + pluckT 0.12  ·  anchors: slide (blue, join = teal), mLeaf (red)')
      const a = P.fileTree(ctx, 480, 590, t, { pluck: 0.5, scale: 0.82, id: 'tr' })
      tag(ctx, 'pluck 0.5', 480, 1045)
      const b = P.fileTree(ctx, 1440, 590, t, { pluck: 1, pluckT: 0.12, scale: 0.82, id: 'tr' })
      tag(ctx, 'pluck 1 (leaf hidden → draw it in the hand with fileLeaf)', 1440, 1045)
      b.slide.forEach((p, i) => i % 2 === 0 && dot(ctx, p, 'rgba(90,130,196,0.9)', 4))
      dot(ctx, b.slide[b.slideJoin], '#3f9990', 8)
      dot(ctx, b.mLeaf, '#e0694a', 9)
      P.fileLeaf(ctx, b.mLeaf[0] + 70, b.mLeaf[1] - 70, t, { m: true, scale: b.mLeafScale, rot: 0.4 })
      dot(ctx, a.trunkTop, '#3f9990', 7)
      dot(ctx, a.potTop, '#3f9990', 7)
    },
    // 2 — s6 composite: Pip slides down the branch, the hand plucks the M leaf
    (ctx, t) => {
      title(ctx, 's6 composite: tree scale 0.74, PIP scale 0.5 sliding on slide[], hand plucking (pluck 0.6)')
      const tr = P.fileTree(ctx, 820, 560, t, { scale: 0.74, pluck: 0.6, id: 'tr' })
      if (hasPip()) {
        const k = Math.floor(tr.slide.length * (0.25 + 0.05 * (t % 2)))
        const p = tr.slide[k]
        const q = tr.slide[Math.min(tr.slide.length - 1, k + 2)]
        const ang = Math.atan2(q[1] - p[1], q[0] - p[0])
        PIP.draw(ctx, p[0], p[1], t, { pose: 'slide', scale: 0.5, rot: ang, id: 'pip' })
      }
      if (hasCast()) CAST.hand(ctx, tr.mLeaf[0] + 60, tr.mLeaf[1] - 20, t, { pose: 'pinch', from: 'right', id: 'hand' })
      P.notebookPage(ctx, 1610, 500, t, { scale: 0.42, unfold: 0.55, id: 'nbc' })
      tag(ctx, 'notebookPage unfold 0.55 (s6 beat 2)', 1610, 900)
    },
    // 3 — notebookPage states
    (ctx, t) => {
      title(ctx, 'notebookPage  unfold / strike / rewrite / saved')
      const S = [
        ['unfold 0', { unfold: 0 }],
        ['unfold 0.3', { unfold: 0.3 }],
        ['unfold 0.75', { unfold: 0.75 }],
        ['strike 0.5', { strike: 0.5 }],
        ['rewrite 0.5, saved .15', { strike: 1, rewrite: 0.5, saved: 0.15 }],
        ['saved 0.45', { strike: 1, rewrite: 1, saved: 0.45 }],
      ]
      S.forEach(([lbl, o], i) => {
        const x = 175 + i * 314
        const a = P.notebookPage(ctx, x, 520, t, Object.assign({ scale: 0.4, id: 'nb' }, o))
        tag(ctx, lbl, x, 830)
        if (a.pen) dot(ctx, a.pen, '#3f9990', 5)
      })
    },
    // 4 — notebook detail
    (ctx, t) => {
      title(ctx, 'notebookPage detail: strike 1, rewrite 1, saved 1 (scale 1)  ·  strike 0.7')
      const a = P.notebookPage(ctx, 620, 580, t, { strike: 1, rewrite: 1, saved: 1, id: 'nb' })
      P.notebookPage(ctx, 1400, 580, t, { strike: 0.7, rewrite: 0, saved: 0, id: 'nb2', scale: 0.8 })
      dot(ctx, a.stamp, '#3f9990', 6)
      a.tabs.forEach((p) => dot(ctx, p, '#3f9990', 6))
      tag(ctx, 'strike 0.7 (pencil at the tip)', 1400, 1010)
    },
    // 5 — paperAirplane folds, fine sampling
    (ctx, t) => {
      title(ctx, 'paperAirplane  fold 0 → 1 (nose teal, tail blue)')
      const S = [0, 0.08, 0.15, 0.22, 0.3, 0.45, 0.6, 0.62, 0.66, 0.7, 0.8, 1]
      S.forEach((f, i) => {
        const x = 190 + (i % 6) * 308
        const y = 290 + Math.floor(i / 6) * 450
        const a = P.paperAirplane(ctx, x, y, t, { fold: f, scale: 0.6, id: 'pl', stamp: f === 1 ? 1 : 0 })
        tag(ctx, 'fold ' + f, x, y + 190)
        dot(ctx, a.nose, '#3f9990', 5)
        dot(ctx, a.tail, '#5a82c4', 5)
      })
    },
    // 6 — dottedTrail + trailAt + banking + flip + stamp thunk
    (ctx, t) => {
      title(ctx, 'dottedTrail (loop) + trailAt, planes bank upright (bank default)  ·  flip, stamp 0.35 / 0.5, close-up')
      const pts = [[140, 760], [520, 560], [780, 300], [620, 170], [470, 330], [720, 470], [1100, 420], [1400, 260]]
      P.dottedTrail(ctx, 0, 0, t, { pts, p: 1, from: 0, alpha: 0.18 })
      const p = 0.35 + 0.3 * ((t % 10) / 2)
      P.dottedTrail(ctx, 0, 0, t, { pts, p, from: 0.05 })
      ;[0.12, 0.3, 0.42, 0.52, 0.62, 0.85].forEach((q, i) => {
        const at = P.trailAt(pts, q)
        P.paperAirplane(ctx, at[0], at[1], t, { fold: 1, scale: 0.3, rot: at[2], flutter: 1, stamp: 1, id: 'fly' + i })
      })
      P.paperAirplane(ctx, 1600, 560, t, { fold: 1, scale: 0.9, stamp: 1, id: 'pc' })
      tag(ctx, 'close-up scale 0.9 (stamp + M)', 1600, 690)
      P.paperAirplane(ctx, 1380, 900, t, { fold: 1, scale: 0.45, stamp: 0.35, id: 'ps', flip: true })
      P.paperAirplane(ctx, 1720, 900, t, { fold: 1, scale: 0.45, stamp: 0.5, id: 'ps2' })
      tag(ctx, 'flip + stamp 0.35 / stamp 0.5', 1550, 1030)
      P.dottedTrail(ctx, 0, 0, t, { pts: [[100, 960], [400, 900], [700, 980], [1000, 930]], style: 'dot', color: C.terracotta })
      tag(ctx, "style 'dot'", 550, 1030)
    },
    // 7 — corkboard with cards
    (ctx, t) => {
      title(ctx, 'corkboard + memoryCard (cream / butter / sage / stale / staleStamp / lift .55)')
      const b = P.corkboard(ctx, 960, 560, t, { scale: 1.1, titleIn: 1 })
      const sl = b.slots
      P.memoryCard(ctx, sl[0][0], sl[0][1], t, { text: 'tests: npm test', color: 'cream', id: 'm1', rot: -0.05 })
      P.memoryCard(ctx, sl[1][0], sl[1][1], t, { text: 'likes small commits', color: 'butter', id: 'm2', rot: 0.04 })
      P.memoryCard(ctx, sl[2][0], sl[2][1], t, { color: 'sage', id: 'm3', rot: -0.02 })
      P.memoryCard(ctx, sl[3][0], sl[3][1], t, { stale: true, id: 'm4', rot: 0.05 })
      P.memoryCard(ctx, sl[4][0], sl[4][1], t, { stale: true, staleStamp: 1, id: 'm5', rot: -0.03 })
      P.memoryCard(ctx, sl[5][0], sl[5][1], t, { text: 'likes small commits', color: 'cream', lift: 0.55, id: 'm6', rot: 0.02 })
    },
    // 8 — memoryCard lift / part layering, stale stamp, thumbtack, yarn
    (ctx, t) => {
      title(ctx, "memoryCard lift 0 / .35 / .7 / 1 (grip = teal) · part 'under' → PIP → 'flap' · pinPop · tacks · yarn")
      ;[0, 0.35, 0.7, 1].forEach((l, i) => {
        const x = 180 + i * 300
        const a = P.memoryCard(ctx, x, 230, t, { text: 'tests: npm test', lift: l, id: 'lc' + i })
        if (l > 0) a.grip.forEach((g) => dot(ctx, g, '#3f9990', 5))
        tag(ctx, 'lift ' + l, x, 370)
      })
      // layering: the board spot, Pip peeking out, then the flap over Pip
      ctx.save()
      ctx.translate(390, 640)
      K.paper(ctx, K.boxPts(420, 330), '#c99558', { seed: 'corkbit', cut: 0, shadow: 0.6 })
      ctx.restore()
      const cx = 390
      const cy = 640
      P.memoryCard(ctx, cx, cy, t, { part: 'under', lift: 1, text: 'likes small commits', color: 'butter', id: 'lay' })
      if (hasPip()) PIP.draw(ctx, cx, cy + 128, t, { pose: 'peek', scale: 0.5, id: 'pip2', eyes: 'wide', look: [0, -0.6], shadow: false })
      const f = P.memoryCard(ctx, cx, cy, t, { part: 'flap', lift: 1, text: 'likes small commits', color: 'butter', id: 'lay' })
      f.grip.forEach((g) => dot(ctx, g, '#3f9990', 5))
      tag(ctx, "under → PIP (peek) → flap", cx, 830)
      ;[0, 0.35, 0.6, 0.85].forEach((pp, i) => {
        const x = 790 + i * 150
        P.memoryCard(ctx, x, 620, t, { stale: i === 3, staleStamp: i === 3 ? 1 : 0, pinPop: pp, id: 'pp' + i, scale: 0.52, color: 'mint' })
        tag(ctx, i === 3 ? 'stamp 1, pop .85' : 'pinPop ' + pp, x, 700)
      })
      ;[0, 0.4, 0.7, 1].forEach((p, i) => {
        const x = 1390 + i * 130
        P.thumbtack(ctx, x, 230, t, { press: p, id: 'tk' + i, color: [C.tomato, C.hiveTeal, C.mustard, C.blue][i] })
        tag(ctx, '' + p, x, 300)
      })
      tag(ctx, 'thumbtack press', 1585, 350)
      ;[0, 0.08, 0.2, 0.5].forEach((tw, i) => {
        const y = 460 + i * 105
        P.yarn(ctx, 0, 0, t, { from: [1350, y], to: [1830, y], twang: tw, id: 'y' + i })
        P.thumbtack(ctx, 1350, y, t, { id: 'yt' + i, r: 12 })
        P.thumbtack(ctx, 1830, y, t, { id: 'yu' + i, r: 12 })
        tag(ctx, 'twang ' + tw, 1590, y + 42)
      })
      P.yarn(ctx, 0, 0, t, { from: [700, 960], to: [1500, 940], p: 0.6, id: 'yp' })
      tag(ctx, 'yarn p 0.6', 900, 1010)
    },
    // 9 — clipBundle gather sequence
    (ctx, t) => {
      title(ctx, 'clipBundle gather 0 / .2 / .3 / .4 / .6 / .7 / .85 / 1 (clip + tag after .85)')
      const G = [0, 0.2, 0.3, 0.4, 0.6, 0.7, 0.85, 1]
      G.forEach((g, i) => {
        const x = 250 + (i % 4) * 470
        const y = 270 + Math.floor(i / 4) * 440
        P.clipBundle(ctx, x, y, t, { gather: g, clip: g >= 0.85 ? (g - 0.85) / 0.15 : 0, tagIn: g >= 1 ? 1 : 0, scale: g < 0.5 ? 0.42 : 0.62, id: 'cb' })
        tag(ctx, 'gather ' + g, x, y + 170)
      })
    },
    // 10 — crumple + basket
    (ctx, t) => {
      title(ctx, 'crumple p 0 / .2 / .4 / .6 / .8 / 1   ·   basket (stakes + over/under weavers)')
      ;[0, 0.2, 0.4, 0.6, 0.8, 1].forEach((p, i) => {
        const x = 170 + i * 250
        P.crumple(ctx, x, 280, t, { p, id: 'cr', scale: 0.8, rot: p * 1.5 })
        tag(ctx, 'crumple ' + p, x, 420)
      })
      const bk = P.basket(ctx, 520, 800, t, { part: 'back', id: 'bk' })
      P.crumple(ctx, bk.mouth[0] + 10, bk.mouth[1] - 10, t, { p: 1, scale: 0.8, id: 'crb', rot: 1 })
      P.basket(ctx, 520, 800, t, { part: 'front', id: 'bk' })
      tag(ctx, 'back → ball → front', 520, 950)
      P.basket(ctx, 1000, 800, t, { contents: 3, id: 'bk2', scale: 0.8, bounce: 0.2 })
      tag(ctx, 'contents 3, bounce .2', 1000, 950)
      P.basket(ctx, 1500, 780, t, { id: 'bk3', scale: 1.5 })
      tag(ctx, 'scale 1.5', 1500, 1000)
    },
    // 11 — posterPage states
    (ctx, t) => {
      title(ctx, 'posterPage  scraps .25 / .6 / 1   headings   frame .4 / 1')
      const S = [
        ['scraps .25', { scraps: 0.25, headings: 0, tag: 0 }],
        ['scraps .6, headings .5', { scraps: 0.6, headings: 0.5, tag: 0 }],
        ['all in, frame .4', { frame: 0.4 }],
        ['frame 1', { frame: 1 }],
      ]
      S.forEach(([lbl, o], i) => {
        const x = 250 + i * 470
        P.posterPage(ctx, x, 520, t, Object.assign({ scale: 0.52, id: 'pp' }, o))
        tag(ctx, lbl, x, 1000)
      })
    },
    // 12 — posterPage detail
    (ctx, t) => {
      title(ctx, 'posterPage detail (frame 1; top + grips) + title option')
      const a = P.posterPage(ctx, 560, 520, t, { frame: 1, scale: 0.98, id: 'pp' })
      dot(ctx, a.top, '#3f9990', 7)
      a.grips.forEach((g) => dot(ctx, g, '#3f9990', 7))
      P.posterPage(ctx, 1380, 520, t, { frame: 1, scale: 0.7, id: 'pp2', title: 'napkin-idea' })
    },
    // 13 — house, signpost, heartPop
    (ctx, t) => {
      title(ctx, 'house (sage / butter / teal / terracotta, lit, gable label)  ·  signpost  ·  heartPop p .1 / .25 / .5 / .8')
      ;[[C.sage, 0], [C.butter, 0.8], [C.hiveTeal, 0], [C.terracotta, 0.5]].forEach(([col, lit], i) => {
        const x = 170 + i * 250
        P.house(ctx, x, 560, t, { color: col, lit, id: 'h' + i, scale: 0.9 + (i % 2) * 0.15 })
      })
      tag(ctx, 'house (x,y = ground)', 540, 620)
      P.signpost(ctx, 1240, 640, t, { id: 'sp' })
      tag(ctx, 'signpost', 1240, 690)
      ;[0.1, 0.25, 0.5, 0.8].forEach((p, i) => {
        const x = 200 + i * 220
        P.heartPop(ctx, x, 920, t, { p, id: 'hp' + i, color: i % 2 ? C.tomato : C.pink })
        tag(ctx, 'p ' + p, x, 1010)
      })
      P.house(ctx, 1380, 1000, t, { color: C.lilac, id: 'hl', label: 'garden-app', scale: 0.8 })
      P.house(ctx, 1640, 1000, t, { color: C.sky, id: 'hl2', label: 'recipe-bot', scale: 0.8 })
    },
    // 14 — gallery wall
    (ctx, t) => {
      title(ctx, 'galleryWall  (hint 1, newWire 1 → posterPage({frame:1, scale:newSlot.scale}))  ·  tiny: reveal .5, emptyNail false')
      const g = P.galleryWall(ctx, 960, 560, t, { hint: 1, newWire: 1 })
      P.posterPage(ctx, g.newSlot.x, g.newSlot.y, t, { frame: 1, scale: g.newSlot.scale, id: 'newp' })
      g.newSlot.wire.forEach((p) => dot(ctx, p, '#3f9990', 4))
      P.galleryWall(ctx, 960, 1000, t, { reveal: 0.5, scale: 0.28, id: 'g2', emptyNail: false })
      tag(ctx, 'reveal 0.5 (tiny)', 1400, 1000)
    },
    // 15 — end card pieces
    (ctx, t) => {
      title(ctx, 'tapeTyper reveal .3 / .7 / 1   ·   washiLabel slap .3 / .6 / .8 / 1   ·   luggageTag (wrapped)')
      ;[0.3, 0.7, 1].forEach((r, i) => {
        P.tapeTyper(ctx, 960, 150 + i * 120, t, { reveal: r, scale: 0.9, id: 'tt' })
      })
      ;[0.3, 0.6, 0.8, 1].forEach((s, i) => {
        const x = 260 + i * 470
        P.washiLabel(ctx, x, 540, t, { slap: s, id: 'wl' })
        tag(ctx, 'slap ' + s, x, 620)
      })
      const lt = P.luggageTag(ctx, 760, 850, t, { scale: 0.95 })
      dot(ctx, lt.hook, '#3f9990', 5)
      P.luggageTag(ctx, 1500, 850, t, { scale: 0.5, id: 'lt2', swing: 1 })
    },
    // 16 — end-card mock composition at true size
    (ctx, t) => {
      title(ctx, 'end-card mock (props at the size s9 will likely use)')
      K.ransom(ctx, 'Session Manager', 960, 250, { size: 110, t, t0: -1 })
      K.hand(ctx, 'one console for Claude Code', 960, 370, { family: 'hand', size: 52, color: C.inkDim, t })
      P.washiLabel(ctx, 960, 470, t, { rot: -0.03 })
      P.tapeTyper(ctx, 960, 590, t, { reveal: 1 })
      P.luggageTag(ctx, 960, 790, t, { scale: 0.82, rot: 0.02 })
    },
    // 17 — s7 composite at scene scale
    (ctx, t) => {
      title(ctx, 's7 composite: corkboard 0.92, PIP peeks under a lifted flap, bundle gathered, stale card pin pops')
      const b = P.corkboard(ctx, 960, 540, t, { scale: 0.92 })
      const sl = b.slots
      P.memoryCard(ctx, sl[0][0], sl[0][1], t, { text: 'tests: npm test', id: 'm1', rot: -0.04, part: 'under', lift: 0.9 })
      if (hasPip()) PIP.draw(ctx, sl[0][0], sl[0][1] + 128, t, { pose: 'peek', scale: 0.5, id: 'pp', eyes: 'wide', look: [0.2, -0.5], shadow: false })
      P.memoryCard(ctx, sl[0][0], sl[0][1], t, { text: 'tests: npm test', id: 'm1', rot: -0.04, part: 'flap', lift: 0.9 })
      P.clipBundle(ctx, sl[1][0] + 60, sl[1][1] + 70, t, { gather: 1, scale: 0.7, id: 'cbz' })
      P.memoryCard(ctx, sl[5][0], sl[5][1], t, { stale: true, staleStamp: 1, pinPop: 0.5, id: 'm5', rot: 0.04 })
      P.memoryCard(ctx, sl[3][0], sl[3][1], t, { text: '+ New memory', color: 'mint', id: 'm7', rot: 0.03 })
    },
  ]

  const times = []
  pages.forEach((_, i) => times.push(i * 10 + 0.2, i * 10 + 1.13))

  window.SHEET = {
    times,
    draw(ctx, t) {
      K.desk(ctx)
      const page = Math.floor(t / 10 + 1e-6)
      const lt = t - page * 10
      ;(pages[page] || pages[0])(ctx, lt)
    },
  }
})()

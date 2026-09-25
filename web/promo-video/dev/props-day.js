/* dev/props-day.js — catalogue sheet for js/props/day.js (owner: props-day).
 *   node dev/sheet.mjs props-day          → contact sheet of every page
 *   node dev/sheet.mjs props-day --full   → one 1920x1080 PNG per time
 * Each time t encodes a page (floor(t / 10)) and a local time (t mod 10), so every page is
 * rendered at two local times to show boil / blink / bounce.
 * Pages: 0 hero console · 1 console reveal states + folder tabs · 2 s1 desk props ·
 *        3 chat/terminal flip, clay button, puffs, speed lines · 4 card box, stickers, slots ·
 *        5 envelope, stamp, door, index cards · 6 s1 load test · 7 s2+s3 load test ·
 *        8 1x details (pencil ?, clay button + mitten, envelope stamp) · 9 console 1x mid-transition
 */
;(function () {
  const P = window.PROPS
  const C = K.C
  function lab(ctx, str, x, y, t, o = {}) {
    K.hand(ctx, str, x, y, { family: 'hand', size: o.size || 25, color: o.color || C.inkDim, t, id: 'lab' + str + x + y, jitter: 0.4 })
  }
  function title(ctx, str, t) {
    K.label(ctx, str, 960, 52, { size: 38, family: 'marker', bg: C.paperWhite, t, id: 'ttl' + str, rot: -0.01 })
  }
  const agentStub = (ctx, x, y, t, rot, color, id) =>
    K.at(ctx, x, y, rot, 1, () => {
      P.indexCard(ctx, 0, 0, t, { id, w: 150, h: 200, lines: 2, color: C.paperWhite })
      K.paper(ctx, K.rectPts(-75, -100, 150, 20), color, { cut: 0.6, shadow: 0, seed: id + 'bd' })
      K.googly(ctx, -22, -10, 16, t, id + 'e1', [0.3, 0])
      K.googly(ctx, 20, -12, 13, t, id + 'e2', [0.3, 0])
    })

  const pages = [
    // 0 — HERO
    (ctx, t) => {
      K.desk(ctx)
      const a = P.consoleWindow(ctx, 960, 520, t, {
        id: 'hero',
        content: (c, r) => {
          P.chatTermCard(c, r.x + r.w * 0.5, r.y + r.h * 0.6, t, { id: 'heroCT', flip: 0, yarnLen: 130, scale: 0.95 })
        },
      })
      // tiny anchor markers so we can see the returned points are right
      ctx.save()
      ctx.strokeStyle = 'rgba(224,105,74,0.9)'
      ctx.lineWidth = 2
      a.tabs.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.stroke() })
      a.sidebarItems.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.stroke() })
      const r = a.content
      ctx.setLineDash([6, 6])
      ctx.strokeRect(r.x, r.y, r.w, r.h)
      ctx.restore()
      lab(ctx, 'consoleWindow (defaults) — red rings/dashes = returned anchors (tabs, sidebarItems, content)', 960, 1062, t)
    },
    // 1 — console reveal states + folder tabs
    (ctx, t) => {
      K.desk(ctx)
      title(ctx, 'consoleWindow reveal states  ·  folderTab', t)
      const S = 0.37
      const cfg = [
        { tabsReveal: 0, sidebarReveal: 0.15, pins: 0.35, plaque: 0.6, l: 'tabs 0 · sidebar .15 · pins .35 · plaque .6' },
        { tabsReveal: 0.5, sidebarReveal: 0.6, pins: 1, l: 'tabs .5 · sidebar .6' },
        { sidebarActive: 1, tabs: [{ label: 'Home' }, { label: 'garden-app', lift: 1 }, { label: 'recipe-bot' }, { label: 'napkin-idea', icon: 'bulb', active: true }], l: 'sidebarActive 1 · garden-app lift 1' },
      ]
      cfg.forEach((c, i) => {
        const x = 330 + i * 630
        if (i === 1) {
          // drawn inside a rotated+scaled CALLER frame: the returned anchors must still land on the art
          K.at(ctx, x, 330, -0.05, 0.9, () => {
            const a = P.consoleWindow(ctx, 0, 0, t, Object.assign({ id: 'cw' + i, scale: S / 0.9 }, c))
            ctx.save()
            ctx.strokeStyle = 'rgba(224,105,74,0.95)'
            ctx.lineWidth = 3
            a.tabs.concat(a.sidebarItems).forEach(([ax, ay]) => { ctx.beginPath(); ctx.arc(ax, ay, 5, 0, 7); ctx.stroke() })
            ctx.restore()
          })
          lab(ctx, c.l + ' · caller rot/scale + anchors', x, 520, t)
          return
        }
        P.consoleWindow(ctx, x, 330, t, Object.assign({ id: 'cw' + i, scale: S }, c))
        lab(ctx, c.l, x, 520, t)
      })
      P.consoleWindow(ctx, 330, 770, t, {
        id: 'cwm', scale: S, dim: 0,
        tabs: [{ label: 'Home', morph: 1 }, { label: 'garden-app', icon: 'leaf', morph: 0.72 }, { label: 'recipe-bot', icon: 'bowl', morph: 0.5 }, { label: 'napkin-idea', icon: 'bulb', active: true, morph: 0.3 }],
      })
      lab(ctx, 'tab.morph 1 · .72 · .5 (edge) · .3 (active, still turning)', 330, 960, t)
      const tabs = [
        { label: 'Home', l: 'Home (auto icon)' },
        { label: 'garden-app', icon: 'leaf', color: 'sage', lift: 1, l: 'sage + leaf · lift 1' },
        { label: 'napkin-idea', icon: 'bulb', active: true, l: 'active' },
        { label: 'recipe-bot', icon: 'bowl', color: 'sky', p: 0.35, l: 'p .35 (popping)' },
      ]
      tabs.forEach((tb, i) => {
        const x = 800 + i * 300
        P.folderTab(ctx, x, 680, t, Object.assign({ id: 'ft' + i }, tb))
        lab(ctx, tb.l, x, 752, t)
      })
      ;[1, 0.82, 0.62, 0.5, 0.38, 0.18, 0].forEach((m, i) => {
        const x = 740 + i * 172
        P.folderTab(ctx, x, 880, t, { id: 'fm' + i, label: 'Home', color: 'butter', morph: m, scale: 0.9 })
        lab(ctx, 'morph ' + m, x, 950, t)
      })
      lab(ctx, 'folderTab.morph = paper flip about the bottom edge (terminal face → edge-on sliver → coloured face)', 1200, 1010, t)
    },
    // 2 — s1 desk props
    (ctx, t) => {
      K.desk(ctx)
      title(ctx, 's1 desk chaos: terminalCard · stickyNote · napkin · coffeeRing · pencilQuestion', t)
      P.coffeeRing(ctx, 1640, 250, t, { id: 'cr1' })
      lab(ctx, 'coffeeRing', 1640, 380, t)
      P.terminalCard(ctx, 170, 220, t, { id: 'tc1' })
      lab(ctx, 'default', 170, 330, t)
      P.terminalCard(ctx, 440, 220, t, { id: 'tc2', label: '~/garden-app', typed: 'npm test', scribbles: 3, rot: 0.08 })
      lab(ctx, 'label + typed + 3 scribbles', 440, 330, t)
      P.terminalCard(ctx, 710, 220, t, { id: 'tc3', cursor: 'block', scribbles: 1, rot: -0.2, blink: false })
      lab(ctx, "cursor 'block', no blink", 710, 330, t)
      P.terminalCard(ctx, 980, 220, t, { id: 'tc4', tape: true, rot: 0.14, scale: 0.8 })
      lab(ctx, 'tape: true, scale .8', 980, 330, t)
      P.terminalCard(ctx, 1260, 220, t, { id: 'tc5', tape: 'rgba(63,153,144,0.62)', rot: -0.36, scale: 0.7, scribbles: 0 })
      lab(ctx, 'teal tape, rot -.36', 1260, 330, t)
      const notes = [
        { color: 'butter', text: 'fix bug??', curl: 0, l: 'butter · curl 0' },
        { color: 'sage', text: 'which tab', curl: 0.5, l: 'sage · curl .5' },
        { color: 'peach', text: 'TODO!!', curl: 1, underline: true, l: 'peach · curl 1 · underline' },
        { color: 'pink', text: 'same\nsession', flutter: 1, l: 'pink · 2 lines · flutter' },
        { color: 'lemon', text: 'fix bug??', reveal: 0.5, rot: 0.2, size: 150, l: 'reveal .5 · size 150' },
      ]
      notes.forEach((n, i) => {
        const x = 150 + i * 240
        P.stickyNote(ctx, x, 500, t, Object.assign({ id: 'sn' + i, size: 180 }, n))
        lab(ctx, n.l, x, 625, t)
      })
      ;[0.25, 0.6, 1].forEach((d, i) => {
        const x = 170 + i * 330
        P.napkin(ctx, x, 830, t, { id: 'np' + i, doodle: d, size: 270, rot: (i - 1) * 0.06 })
        lab(ctx, 'napkin doodle ' + d, x, 1000, t)
      })
      ;[0.35, 0.7, 1].forEach((p, i) => {
        const x = 1260 + i * 230
        P.pencilQuestion(ctx, x, 770, t, { id: 'pq' + i, p, size: 330 })
        lab(ctx, 'pencilQuestion p ' + p, x, 1000, t)
      })
    },
    // 3 — chatTermCard flip, clay button, puffs, speed lines
    (ctx, t) => {
      K.desk(ctx)
      title(ctx, 'chatTermCard flip · clayButton press · doodlePuff · speedLines', t)
      ;[0, 0.3, 0.47, 0.7, 1].forEach((f, i) => {
        const x = 200 + i * 380
        const a = P.chatTermCard(ctx, x, 350, t, { id: 'ct' + i, flip: f, scale: 0.72, yarnLen: 170 })
        lab(ctx, 'flip ' + f + ' → ' + a.face, x, 510, t)
      })
      ;[0, 0.5, 1].forEach((p, i) => {
        const x = 170 + i * 250
        P.clayButton(ctx, x, 700, t, { id: 'cb' + i, press: p, label: i === 0 ? 'go' : '' })
        lab(ctx, 'press ' + p, x, 820, t)
      })
      const hk = P.clayButton(ctx, 1080, 720, t, { id: 'cbs', strip: 'Hot keys', press: 0.55, icon: (g, r) => CAST.agent(g, 0, -r * 0.05, t, { id: 'hkmini', kind: 'architect', mini: true, scale: 0.8 }), scale: 0.9 })
      CAST.hand(ctx, hk.top[0], hk.top[1], t, { id: 'hkhand', from: 'top', pose: 'press', mitten: true, press: 0.55, reach: 420 })
      lab(ctx, "strip 'Hot keys' + CAST.agent mini icon + mitten at .top", 980, 860, t)
      ;[0.15, 0.4, 0.75].forEach((p, i) => {
        const x = 1440 + i * 170
        P.doodlePuff(ctx, x, 700, t, { id: 'pf' + i, p })
        lab(ctx, 'puff ' + p, x, 820, t)
      })
      P.terminalCard(ctx, 600, 960, t, { id: 'sltc', scale: 0.55, rot: -0.1 })
      P.speedLines(ctx, 520, 960, t, { id: 'sl1', dir: 0 })
      lab(ctx, 'speedLines dir 0 (moving right)', 380, 1050, t)
      P.speedLines(ctx, 1150, 940, t, { id: 'sl2', dir: -2.4, p: 0.6, n: 5 })
      lab(ctx, 'dir -2.4 · p .6 · n 5', 1150, 1050, t)
    },
    // 4 — card box, stickers, slots
    (ctx, t) => {
      K.desk(ctx)
      title(ctx, 'cardBox lidOpen · stickerSheet peel · sticker · dashedSlot', t)
      ;[0, 0.45, 1].forEach((lo, i) => {
        const x = 250 + i * 470
        P.cardBox(ctx, x, 380, t, {
          id: 'bx' + i,
          lidOpen: lo,
          scale: 0.8,
          inside: lo > 0.5 ? (c) => {
            ;[-1, 0, 1].forEach((k) => agentStub(c, k * 120, -110 + Math.abs(k) * 30, t, k * 0.3, [C.terracotta, C.honey, C.hiveTeal][k + 1], 'ag' + i + k))
          } : null,
        })
        lab(ctx, 'lidOpen ' + lo + (lo > 0.5 ? ' + inside()' : ''), x, 530, t)
      })
      P.stickerSheet(ctx, 1570, 330, t, { id: 'ss0', scale: 0.62 })
      lab(ctx, 'sheet', 1570, 510, t)
      P.stickerSheet(ctx, 1790, 330, t, { id: 'ss1', peeled: 0, peel: 0.45, scale: 0.62 })
      lab(ctx, 'peel .45', 1790, 510, t)
      P.stickerSheet(ctx, 1570, 760, t, { id: 'ss2', peeled: 0, peel: 0.85, scale: 0.62 })
      lab(ctx, 'peel .85', 1570, 940, t)
      P.stickerSheet(ctx, 1790, 760, t, { id: 'ss3', peeled: 0, peel: 1, scale: 0.62 })
      lab(ctx, 'peel 1 (gone)', 1790, 940, t)
      P.sticker(ctx, 160, 700, t, { id: 'st0', label: 'Feature' })
      lab(ctx, 'sticker', 160, 770, t)
      P.sticker(ctx, 160, 860, t, { id: 'st1', label: 'Feature', curl: 0.6, lift: 10, rot: -0.15 })
      lab(ctx, 'curl .6 · lift', 160, 950, t)
      P.dashedSlot(ctx, 520, 740, t, { id: 'ds0' })
      P.dashedSlot(ctx, 900, 740, t, { id: 'ds1', label: '2 · mission — how they work', filled: 1 })
      P.sticker(ctx, 900, 740, t, { id: 'st2', label: 'Feature', rot: 0.04 })
      lab(ctx, 'dashedSlot filled 0', 520, 1010, t)
      lab(ctx, 'filled 1 + sticker in it', 900, 1010, t)
      P.dashedSlot(ctx, 1230, 780, t, { id: 'ds2', label: 'Bug', labelPos: 'top', w: 200, h: 130 })
      lab(ctx, "labelPos 'top'", 1230, 900, t)
    },
    // 5 — envelope, stamp, door, index cards
    (ctx, t) => {
      K.desk(ctx)
      title(ctx, 'envelope · stampMark · door · indexCard', t)
      P.envelope(ctx, 230, 280, t, { id: 'ev0', scale: 0.8 })
      lab(ctx, 'closed', 230, 420, t)
      P.envelope(ctx, 640, 330, t, {
        id: 'ev1', scale: 0.8, open: 1,
        contents: (c) => agentStub(c, 0, -40, t, 0.05, C.terracotta, 'evag'),
      })
      lab(ctx, 'open 1 + contents()', 640, 468, t)
      ;[0.2, 0.42, 1].forEach((p, i) => {
        const x = 230 + i * 410
        P.envelope(ctx, x, 620, t, { id: 'ev' + (i + 2), scale: 0.8, stamp: p })
        lab(ctx, 'stamp ' + p, x, 760, t)
      })
      P.stampMark(ctx, 1500, 640, t, { id: 'smt', text: 'DONE', p: 0.4 })
      lab(ctx, 'stampMark p .4 (tool down)', 1500, 760, t)
      P.stampMark(ctx, 1080, 260, t, { id: 'sm0', text: 'DONE', shape: 'round', size: 44, rot: -0.2 })
      lab(ctx, "stampMark round 'DONE'", 1080, 400, t)
      P.stampMark(ctx, 380, 900, t, { id: 'sm1', text: 'Actor → Input → Mission → Goal', color: C.hiveTeal })
      lab(ctx, 'stampMark (teal) — arrows are drawn', 380, 980, t)
      ;[[0, 0, 'closed'], [0.14, 1, 'open .14 · glow 1'], [0.75, 1, 'open .75 · glow 1']].forEach(([op, gl, l], i) => {
        const x = 1330 + i * 250
        P.door(ctx, x, 360, t, { id: 'dr' + i, open: op, glow: gl, scale: 0.62 })
        lab(ctx, l, x, 540, t)
      })
      P.indexCard(ctx, 1000, 900, t, { id: 'ic0', title: 'napkin-idea', lines: ['plant tomatoes', 'water daily', 'ship it'], checkboxes: [true, true, false], h: 200 })
      lab(ctx, 'indexCard title + lines + checkboxes', 1000, 1030, t)
      P.indexCard(ctx, 1560, 900, t, { id: 'ic1', torn: true, color: C.lemon, lines: 4, rot: 0.05, h: 190 })
      lab(ctx, 'torn: true, lemon', 1560, 1030, t)
    },
    // 6 — s1 load test (roughly what the s1 scene will draw)
    (ctx, t) => {
      K.desk(ctx)
      const r = K.rng('s1load')
      for (let i = 0; i < 12; i++) {
        P.terminalCard(ctx, 160 + (i % 4) * 520 + r() * 80, 170 + Math.floor(i / 4) * 330 + r() * 60, t, { id: 'l' + i, rot: (r() - 0.5) * 0.8, tape: r() < 0.7, scale: 0.9 + r() * 0.3 })
      }
      P.coffeeRing(ctx, 1500, 600, t, { id: 'lcr' })
      P.napkin(ctx, 900, 560, t, { id: 'lnp', rot: -0.1 })
      const colors = ['butter', 'sage', 'peach', 'pink', 'lemon']
      const texts = ['fix bug??', 'which tab', 'TODO!!', '', 'fix bug??', '', 'which tab', 'TODO!!']
      for (let i = 0; i < 8; i++) P.stickyNote(ctx, 250 + r() * 1400, 200 + r() * 700, t, { id: 'ls' + i, color: colors[i % 5], text: texts[i], rot: (r() - 0.5) * 0.6, flutter: 0.5, curl: r() * 0.5, size: 150 })
      P.pencilQuestion(ctx, 1000, 470, t, { id: 'lq', p: 0.75, size: 480 })
      lab(ctx, 's1 load test: 12 terminals + 8 stickies + napkin + ring + pencil ?', 960, 1062, t, { color: C.ink })
    },
    // 7 — s2 + s3 load test
    (ctx, t) => {
      K.desk(ctx)
      P.consoleWindow(ctx, 700, 460, t, {
        id: 'lcw', scale: 0.8, tabsReveal: 1, sidebarReveal: 1,
        content: (c, rr) => P.chatTermCard(c, rr.x + rr.w / 2, rr.y + rr.h * 0.62, t, { id: 'lct', flip: 0.8, yarnLen: 120 }),
      })
      P.cardBox(ctx, 1640, 250, t, { id: 'lbx', lidOpen: 1, scale: 0.55 })
      P.stickerSheet(ctx, 1700, 640, t, { id: 'lss', peeled: 0, peel: 0.4, scale: 0.5 })
      P.envelope(ctx, 1450, 880, t, { id: 'lev', stamp: 0.5, scale: 0.55 })
      P.door(ctx, 1750, 900, t, { id: 'ldr', open: 0.2, glow: 1, scale: 0.4 })
      P.clayButton(ctx, 400, 960, t, { id: 'lcb', strip: 'Hot keys', press: 0.6, scale: 0.6 })
      P.dashedSlot(ctx, 1000, 930, t, { id: 'lds', scale: 0.5 })
      lab(ctx, 's2+s3 load test: console + flip card + box + sheet + envelope(stamp) + door + button + slot', 960, 1062, t, { color: C.ink })
    },
    // 8 — 1x details: the pieces the review called out, at the size they are shown in the film
    (ctx, t) => {
      K.desk(ctx)
      title(ctx, '1x: pencilQuestion · clayButton + mitten · envelope stamp (1x / 0.6x) · stamp tool', t)
      P.pencilQuestion(ctx, 230, 330, t, { id: 'q1x', p: 1 })
      lab(ctx, 'pencilQuestion p 1 (size 420)', 230, 590, t)
      P.pencilQuestion(ctx, 640, 330, t, { id: 'q1h', p: 0.55 })
      lab(ctx, 'p .55', 640, 590, t)
      const b = P.clayButton(ctx, 1480, 360, t, { id: 'cb1x', strip: 'Hot keys', press: 0.35, icon: (g, r) => CAST.agent(g, 0, -r * 0.05, t, { id: 'mini1x', kind: 'architect', mini: true, scale: 0.8 }) })
      CAST.hand(ctx, b.top[0], b.top[1], t, { id: 'hand1x', from: 'top', pose: 'press', mitten: true, press: 0.35, reach: 300 })
      lab(ctx, 'clayButton 1x · press .35 · mitten fingertip at .top', 1400, 520, t)
      P.clayButton(ctx, 1000, 380, t, { id: 'cbp', press: 1, color: 'sage', label: 'go' })
      lab(ctx, 'press 1 · sage', 1000, 520, t)
      P.envelope(ctx, 300, 820, t, { id: 'e1x', stamp: 1 })
      lab(ctx, 'envelope 1x · stamp 1', 300, 1010, t)
      P.envelope(ctx, 700, 840, t, { id: 'e06', stamp: 1, scale: 0.6 })
      lab(ctx, 'scale .6 (s3 size)', 700, 1010, t)
      P.envelope(ctx, 1130, 850, t, { id: 'eth', stamp: 0.42, scale: 0.8 })
      lab(ctx, 'stamp .42 (THUNK)', 1130, 1010, t)
      P.stampMark(ctx, 1640, 860, t, { id: 'smd', text: 'DONE', p: 0.45, size: 40 })
      lab(ctx, "stampMark 'DONE' p .45", 1640, 1010, t)
    },
    // 9 — console at 1x mid-transition (tabs flipping in, sidebar unrolling / tape slapping)
    (ctx, t) => {
      K.desk(ctx)
      const A = t < 0.2
      P.consoleWindow(ctx, 960, 560, t, {
        id: 'c1x',
        tabs: A
          ? [{ label: 'Home', morph: 1 }, { label: 'garden-app', icon: 'leaf', morph: 0.78 }, { label: 'recipe-bot', icon: 'bowl', morph: 0.5 }, { label: 'napkin-idea', icon: 'bulb', active: true, morph: 0.3 }]
          : [{ label: 'Home', morph: 0.62 }, { label: 'garden-app', icon: 'leaf', morph: 0.4 }, { label: 'recipe-bot', icon: 'bowl', morph: 0.14 }, { label: 'napkin-idea', icon: 'bulb', active: true, morph: 0 }],
        sidebarReveal: A ? 0.17 : 0.34,
        content: (c, r) => P.chatTermCard(c, r.x + r.w * 0.5, r.y + r.h * 0.6, t, { id: 'c1xct', flip: A ? 0 : 0.85, yarnLen: 130, scale: 0.95 }),
      })
      lab(ctx, A ? 'tabs morph 1 · .78 · .5 · .3 (active) · sidebarReveal .17 (rolling)' : 'tabs morph .62 · .4 · .14 · 0 (active merged) · sidebarReveal .34 (tape slap)', 960, 1062, t, { color: C.ink })
    },
  ]

  window.SHEET = {
    times: [0, 0.53, 10, 10.4, 20, 20.47, 30, 30.6, 40, 41.2, 50, 50.33, 60, 70, 80, 80.4, 90, 90.4],
    draw(ctx, t) {
      const page = Math.min(pages.length - 1, Math.floor(t / 10 + 1e-6))
      pages[page](ctx, t - page * 10)
    },
  }
})()

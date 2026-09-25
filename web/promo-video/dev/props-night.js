/* dev/props-night.js — catalogue sheet for js/props/night.js (owner: props-night).
 *
 *   timeout 120 node dev/sheet.mjs props-night          (contact sheet)
 *   timeout 120 node dev/sheet.mjs props-night --full   (one 1920x1080 PNG per time)
 *
 * SHEET.times encode page + local time: t = page * 10 + localT.
 *   1 night sky states      2 sunrise states       3 machinery (conveyor, slots)
 *   4 gauge / sign / clock  5 bedside (laptop, teacups, done stack, tally)
 *   6 composed mini NIGHT set (animated over localT 0..7)
 *   7 composed mini MORNING set (animated over localT 0..5)
 *   8 laptop tag regressions (tag:false on the mug side must not throw) + tag sides
 *   9 small-scale readability (sun r 60/90/130, moon r 40/60 tape, sign flip 0 @ .5, bulbs)
 *  10 blind: default 'blind' ease filmstrip + bounded window blind (o.w/o.h)
 */
;(function () {
  const { C } = K
  const P = window.PROPS
  const seg = K.seg

  function cap(ctx, text, x, y) {
    ctx.save()
    ctx.font = '600 22px monospace'
    const w = ctx.measureText(text).width + 16
    ctx.fillStyle = 'rgba(20,20,28,0.78)'
    ctx.fillRect(x - w / 2, y - 18, w, 28)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.fillText(text, x, y + 3)
    ctx.restore()
  }
  /** Draw a full 1920x1080 stage scaled into a panel at (px, py) with scale s. */
  function mini(ctx, px, py, s, title, fn) {
    ctx.save()
    ctx.translate(px, py)
    ctx.scale(s, s)
    ctx.beginPath()
    ctx.rect(0, 0, K.W, K.H)
    ctx.clip()
    fn(ctx)
    ctx.restore()
    ctx.save()
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 4
    ctx.strokeRect(px, py, K.W * s, K.H * s)
    ctx.restore()
    cap(ctx, title, px + (K.W * s) / 2, py + K.H * s - 22)
  }
  /** Other agents' characters, if they exist yet (never fatal to this sheet). */
  function tryDraw(ctx, fn) {
    ctx.save()
    try {
      fn()
    } catch (e) {
      /* character not ready yet */
    }
    ctx.restore()
  }
  function morningSky(ctx) {
    K.backdrop(ctx, '#a9d4ea')
  }
  function morningHills(ctx) {
    K.at(ctx, 0, 0, 0, 1, () => {
      K.paper(ctx, [[-40, 640], [300, 590], [700, 628], [1100, 580], [1500, 622], [1960, 585], [1960, 1120], [-40, 1120]], C.grass, { torn: 5, seed: 'hill', shadow: 1 })
      K.paper(ctx, K.rectPts(-40, 720, 2000, 420), C.kraftLight, { torn: 4, seed: 'deskm', shadow: 1.2, lift: 6 })
    })
  }
  function jobCard(ctx, x, y, t, id, rot = 0, s = 1) {
    K.at(ctx, x, y, rot, s, () => {
      K.paper(ctx, K.boxPts(92, 64), C.paperWhite, { torn: 2.5, seed: id, shadow: 0.9, lift: 3 })
      for (let k = 0; k < 2; k++) {
        K.pencil.line(ctx, -30, -12 + k * 20, 34, -12 + k * 20, id + k, t, { strokeWidth: 2, stroke: C.inkFaint, roughness: 1 })
        ctx.strokeStyle = C.inkDim
        ctx.lineWidth = 2
        ctx.strokeRect(-40, -18 + k * 20, 9, 9)
      }
    })
  }

  // ---------------- pages ----------------
  const pages = {
    // 1 — night sky states
    1(ctx, t) {
      K.backdrop(ctx, '#2b2b33', { vignette: false })
      const s = 0.49
      const g = 12
      const cells = [
        ['nightBlind drop .30', (c) => { K.desk(c); P.nightBlind(c, 0, 0, t, { drop: 0.3 }) }],
        ['drop .80 (settling bounce)', (c) => { K.desk(c); P.nightBlind(c, 0, 0, t, { drop: 0.8 }) }],
        ['drop 1 + moon drop .45', (c) => { P.nightBlind(c, 0, 0, t); P.moonOnThread(c, 520, -4, t, { drop: 0.45 }) }],
        ['moon drop 1, swinging', (c) => { P.nightBlind(c, 0, 0, t); P.moonOnThread(c, 520, -4, t, { drop: 1, len: 260 }); P.moonOnThread(c, 1400, -4, t, { drop: 1, len: 140, r: 70, id: 'moon2', angle: 0.5 }) }],
      ]
      cells.forEach(([title, fn], i) => mini(ctx, g + (i % 2) * (K.W * s + g), g + Math.floor(i / 2) * (K.H * s + g), s, title, fn))
    },
    // 2 — sunrise states
    2(ctx, t) {
      K.backdrop(ctx, '#2b2b33', { vignette: false })
      const s = 0.49
      const g = 12
      const cells = [
        ['paperSun rise .25 sleepy', { rise: 0.25, face: 'sleepy' }],
        ['rise .55 awake (stretch)', { rise: 0.55, face: 'awake' }],
        ['rise .80 happy (overshoot)', { rise: 0.8, face: 'happy' }],
        ['rise 1 face none', { rise: 1, face: 'none' }],
      ]
      cells.forEach(([title, so], i) =>
        mini(ctx, g + (i % 2) * (K.W * s + g), g + Math.floor(i / 2) * (K.H * s + g), s, title, (c) => {
          morningSky(c)
          P.paperSun(c, 960, 380, t, Object.assign({ r: 150 }, so))
          morningHills(c)
        })
      )
    },
    // 3 — machinery
    3(ctx, t) {
      K.backdrop(ctx, C.night, { dots: true })
      P.conveyor(ctx, 700, 250, t, { offset: t * 140 })
      cap(ctx, 'conveyor offset=t*140', 700, 60)
      const lit = (t % 10) * 2.2
      const sl = P.slotBoxes(ctx, 700, 700, t, { part: 'back', lit })
      sl.floor.forEach(([fx, fy], i) => { if (i < Math.floor(lit)) jobCard(ctx, fx, fy - 40, t, 'sc' + i, (i % 2 ? 0.06 : -0.05)) })
      P.slotBoxes(ctx, 700, 700, t, { part: 'front', lit })
      cap(ctx, 'slotBoxes back+cards+front lit=' + lit.toFixed(1), 700, 520)
      P.slotBoxes(ctx, 1640, 330, t, { n: 2, slotW: 120, slotH: 110, lit: [0, 1], id: 'slots2', label: 'Slots' })
      cap(ctx, 'n=2 lit=[0,1]', 1640, 160)
      P.teacup(ctx, 1560, 760, t, {})
      P.teacup(ctx, 1720, 770, t, { color: C.mint, id: 'tc2', r: 26 })
      P.teacup(ctx, 1820, 770, t, { color: C.lilac, id: 'tc3', r: 18, tilt: -0.2 })
      cap(ctx, 'teacup r=34/26/18', 1680, 860)
    },
    // 4 — gauge / sign / clock
    4(ctx, t) {
      K.backdrop(ctx, C.night, { dots: true })
      ;[0.25, 0.7, 0.9].forEach((v, i) => {
        P.gauge(ctx, 260 + i * 420, 260, t, { value: v, id: 'g' + i })
        cap(ctx, 'gauge ' + v, 260 + i * 420, 400)
      })
      ;[0, 0.3, 0.55, 0.8, 1].forEach((f, i) => {
        P.hangingSign(ctx, 150 + i * 262, 520, t, { flip: f, id: 's' + i, scale: 0.8 })
        cap(ctx, 'sign flip ' + f, 150 + i * 262, 740)
      })
      P.alarmClock(ctx, 1500, 810, t, { ring: 0 })
      cap(ctx, 'alarmClock ring 0', 1500, 1010)
      P.alarmClock(ctx, 1500, 330, t, { ring: 1, id: 'clk2', time: 6.5 })
      cap(ctx, 'ring 1', 1500, 520)
      P.alarmClock(ctx, 1810, 330, t + 0.0667, { ring: 1, id: 'clk3', r: 60, tag: false })
      cap(ctx, 'next frame', 1810, 520)
    },
    // 5 — bedside
    5(ctx, t) {
      K.desk(ctx)
      K.at(ctx, 0, 0, 0, 1, () => K.paper(ctx, K.rectPts(0, 0, 1060, 1080), C.night, { cut: 0, shadow: 0, seed: 'half' }))
      P.laptop(ctx, 470, 560, t, {})
      cap(ctx, 'laptop (lamp right, tag below)', 470, 90)
      P.laptop(ctx, 330, 960, t, { scale: 0.5, lampSide: 'left', tagSide: 'right', id: 'lap2', lampOn: 0.4 })
      cap(ctx, 'scale .5 lampSide left tagSide right', 400, 1040)
      ;[0, 1.5, 4].forEach((st, i) => {
        P.doneStack(ctx, 1210 + i * 260, 520, t, { stamped: st, id: 'd' + i, scale: 0.9 })
        cap(ctx, 'stamped ' + st, 1210 + i * 260, 640)
      })
      ;[0.3, 0.7, 1].forEach((p, i) => {
        P.tally(ctx, 1480, 740 + i * 120, t, { p, id: 'ty' + i, scale: 0.85 })
        cap(ctx, 'tally p ' + p, 1180, 740 + i * 120)
      })
    },
    // 6 — composed night set, local time 0..7
    6(ctx, t) {
      K.desk(ctx)
      P.nightBlind(ctx, 0, 0, t, { drop: seg(t, 0, 1.2) })
      P.moonOnThread(ctx, 250, -6, t, { drop: seg(t, 0.4, 1.6), len: 190, r: 92 })
      P.gauge(ctx, 1010, 250, t, { value: K.lerp(0.15, 0.9, K.ease.inOutCubic(seg(t, 1.5, 5))), scale: 0.72 })
      P.hangingSign(ctx, 1500, 70, t, { flip: seg(t, 5, 5.7), scale: 0.9 })
      const bel = P.conveyor(ctx, 700, 520, t, { w: 1000, offset: t * 110, scale: 0.9 })
      const sl = P.slotBoxes(ctx, 720, 790, t, { part: 'back', lit: K.clamp((t - 2.4) / 0.5, 0, 5), scale: 0.72 })
      for (let i = 0; i < 5; i++) {
        const t0 = 1.2 + i * 0.5
        const u = (t - t0) / 1.2
        if (u < 0) continue
        if (u <= 1) {
          const bx = K.lerp(bel.left[0], bel.right[0], u)
          jobCard(ctx, bx, bel.top[1] - 26, t, 'cj' + i, 0.03 * Math.sin(i + t * 3), 0.9)
        } else {
          const [fx, fy] = sl.floor[i]
          jobCard(ctx, fx, fy - 32, t, 'cj' + i, i % 2 ? 0.05 : -0.05, 0.7)
          if (t > 5.2) P.teacup(ctx, fx + 40, fy - 70, t, { r: 16, id: 'tcs' + i, color: [C.pink, C.mint, C.lilac, C.peach, C.sky][i] })
        }
      }
      P.slotBoxes(ctx, 720, 790, t, { part: 'front', scale: 0.72 })
      P.laptop(ctx, 1580, 760, t, { scale: 0.72 })
      tryDraw(ctx, () => window.CAST && CAST.you && CAST.you(ctx, 170, 900, t, { pose: 'sleep', inBed: true, zzz: true, scale: 0.8 }))
      tryDraw(ctx, () => window.PIP && PIP.draw && PIP.draw(ctx, 1260, 930, t, { nightcap: true, lantern: 1, pose: 'idle', scale: 0.6 }))
    },
    // 7 — composed morning set, local time 0..5
    7(ctx, t) {
      morningSky(ctx)
      P.paperSun(ctx, 1480, 300, t, { rise: seg(t, 0.9, 1.9), face: t < 1.5 ? 'sleepy' : 'happy', r: 120 })
      morningHills(ctx)
      P.alarmClock(ctx, 300, 640, t, { ring: t < 1.6 ? 1 : 0, scale: 0.9 })
      P.doneStack(ctx, 820, 900, t, { stamped: seg(t, 2, 3.2) * 4, scale: 0.8 })
      P.tally(ctx, 1170, 840, t, { p: seg(t, 2.2, 3.6), scale: 0.8 })
      P.laptop(ctx, 1620, 900, t, { scale: 0.62, lampOn: 0.25 })
      P.hangingSign(ctx, 900, 60, t, { flip: 1 - seg(t, 0.2, 0.7), scale: 0.8, rock: false })
      // night leaving: blind snaps up, moon swings off
      P.nightBlind(ctx, 0, 0, t, { drop: 1 - seg(t, 0.5, 1.0), ease: 'inOutCubic' })
      P.moonOnThread(ctx, 250, -6, t, { drop: 1 - seg(t, 0.8, 1.3), ease: 'inCubic', angle: 1.25 * K.ease.inOutCubic(seg(t, 0.3, 1.0)), len: 190, r: 92 })
    },
    // 8 — laptop tag regressions + sides (every call here used to be able to throw / unbalance ctx)
    8(ctx, t) {
      K.backdrop(ctx, C.night, { dots: true })
      P.laptop(ctx, 330, 420, t, { tag: false, tagSide: 'left', scale: 0.62, id: 'lt1' })
      cap(ctx, 'tag:false tagSide:left', 330, 470)
      P.laptop(ctx, 1000, 420, t, { tag: false, tagSide: 'right', lampSide: 'left', scale: 0.62, id: 'lt2' })
      cap(ctx, 'tag:false tagSide:right lampSide:left', 1000, 470)
      P.laptop(ctx, 1650, 420, t, { tag: '', tagSide: 'below', scale: 0.62, id: 'lt3', mug: false })
      cap(ctx, "tag:'' mug:false", 1650, 470)
      P.laptop(ctx, 560, 900, t, { tagSide: 'left', scale: 0.72, id: 'lt4' })
      cap(ctx, 'tagSide left (lamp right) @ .72', 560, 1060)
      P.laptop(ctx, 1500, 900, t, { tagSide: 'right', lampSide: 'left', scale: 0.72, id: 'lt5', lampOn: 0.5 })
      cap(ctx, 'tagSide right (lamp left) @ .72', 1500, 1060)
      // ctx must still be balanced: this marker must sit exactly at the top-left corner
      ctx.fillStyle = '#ff00ff'
      ctx.fillRect(0, 0, 14, 14)
    },
    // 9 — small-scale readability
    9(ctx, t) {
      morningSky(ctx)
      ;[[60, 150], [90, 400], [130, 760]].forEach(([r, x], i) => {
        P.paperSun(ctx, x, 190, t, { r, id: 'ss' + i, face: ['happy', 'awake', 'sleepy'][i] })
        cap(ctx, 'sun r ' + r, x, 370)
      })
      K.at(ctx, 0, 0, 0, 1, () => K.paper(ctx, K.rectPts(1000, 0, 920, 520), C.night, { cut: 0, shadow: 0, seed: 'n9' }))
      P.moonOnThread(ctx, 1120, 0, t, { r: 40, len: 70, id: 'mn1' })
      P.moonOnThread(ctx, 1300, 0, t, { r: 60, len: 110, id: 'mn2' })
      cap(ctx, 'moon r40 / r60 (tape scales)', 1220, 300)
      P.hangingSign(ctx, 1560, 30, t, { flip: 0, scale: 0.5, id: 'sg0' })
      P.hangingSign(ctx, 1780, 30, t, { flip: 0.15, scale: 0.5, id: 'sg1' })
      cap(ctx, 'sign flip 0 / .15 @ .5', 1670, 190)
      P.hangingSign(ctx, 1560, 250, t, { flip: 0.45, scale: 0.5, id: 'sg2' })
      P.hangingSign(ctx, 1780, 250, t, { flip: 1, scale: 0.5, id: 'sg3' })
      cap(ctx, 'flip .45 / 1 @ .5', 1670, 440)
      // bulbs: a 5-bay tray at .72 with lit 0 / .4 / .7 / 1 / 1, and at 1.0
      K.at(ctx, 0, 520, 0, 1, () => K.paper(ctx, K.rectPts(0, 0, 1920, 560), C.night, { cut: 0, shadow: 0, seed: 'n9b' }))
      P.slotBoxes(ctx, 520, 760, t, { lit: [0, 0.4, 0.7, 1, 1], scale: 0.72, id: 'sb1' })
      cap(ctx, 'bulbs lit 0 / .4 / .7 / 1 / 1 @ .72', 520, 1040)
      P.slotBoxes(ctx, 1480, 770, t, { n: 3, lit: [0, 0.5, 1], id: 'sb2' })
      cap(ctx, 'bulbs lit 0 / .5 / 1 @ 1', 1480, 1040)
    },
    // 10 — blind ease filmstrip + bounded window blind
    10(ctx, t) {
      K.backdrop(ctx, '#2b2b33', { vignette: false })
      const s = 0.24
      const g = 8
      const drops = [0.3, 0.45, 0.55, 0.62, 0.7, 0.78, 0.9, 1]
      drops.forEach((dp, i) =>
        mini(ctx, g + (i % 4) * (K.W * s + g), g + Math.floor(i / 4) * (K.H * s + 30), s, 'drop ' + dp, (c) => {
          K.desk(c)
          P.nightBlind(c, 0, 0, t, { drop: dp })
        })
      )
      // a window with a bounded blind (w 600, h 420): must not overhang the frame
      const wx = 560
      const wy = 600
      K.at(ctx, 0, 0, 0, 1, () => {
        K.paper(ctx, K.rectPts(wx - 30, wy - 30, 660, 480), C.kraft, { cut: 1, seed: 'win', shadow: 1 })
        K.flat(ctx, K.rectPts(wx, wy, 600, 420), '#a9d4ea')
      })
      P.nightBlind(ctx, wx, wy, t, { w: 600, h: 420, drop: 0.7, id: 'wb', stars: 40 })
      cap(ctx, 'bounded blind w600 h420 drop .7', wx + 300, wy + 450)
      P.nightBlind(ctx, 1300, 600, t, { w: 520, h: 420, drop: 1, id: 'wb2', stars: 40, constellations: [[60, 60], [300, 90]] })
      cap(ctx, 'bounded w520 drop 1', 1560, 1050)
    },
  }

  window.SHEET = {
    times: [10.4, 20.6, 30.5, 40.5, 40.9, 50.5, 60.7, 62.2, 65.9, 70.7, 71.3, 72.6, 74.2, 80.5, 90.5, 100.5],
    draw(ctx, T) {
      const page = Math.floor(T / 10 + 1e-6)
      const t = +(T - page * 10).toFixed(4)
      ;(pages[page] || pages[1])(ctx, t)
    },
  }
})()

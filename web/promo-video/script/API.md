# Phase-A API reference (generated from the builders final reports)

Authoritative for phase B. Where this and a file header disagree, the file header wins — read it.


## js/mascot.js — PIP + CAST

mascot.js exposes window.PIP and window.CAST. Every draw function has the form fn(ctx, x, y, t, o = {}) and is pure. Randomness comes only from K.rng / K.ro, seeded by o.id. Lines boil via K.boil, and each piece gets a K.nudge micro-jitter. The file uses no shadowBlur, no filter, no Math.random and no Date.

Common options (every draw function):
- id: seed string
- scale: default 1
- rot: default 0, in world radians
- flip: false faces right; true faces left. look is compensated for flip.
- look: [lx, ly], -1..1, in world space
- pose
- poseT: defaults to t. It drives the cycles and one-shots. It is clamped to ≥ 0, so a t slightly outside [0, dur] is safe.

Anchors are always returned in the caller's coordinate space, mapped through ctx.getTransform() at call time. A probe checked this under a translated, rotated and scaled caller context for PIP, agent (flipped and mini), visitor and hand.

WALKING WITHOUT FOOT-SLIDE: every walk cycle has a linear stance phase. Move the character at WALK_SPEED × scale × stride px/s in the direction it faces; any other speed makes the feet slide. The speeds are PIP.WALK_SPEED ≈ 128.6, CAST.HELPER_WALK_SPEED ≈ 118.2 and CAST.VISITOR_WALK_SPEED ≈ 90.3 (px/s at scale 1). With flip:true the character walks toward −x.

═══ PIP ═══
PIP.draw(ctx, x, y, t, o) returns { hands:[[x,y],[x,y]], head, antenna, feet:[[x,y],[x,y]], eyes:[[x,y],[x,y]], holdAt, center, tool, tip, released }.
- (x, y) is the ground point between the feet.
- For 'sit' and 'ride' it is the seat point under Pip's bottom edge.
- With peek > 0 it is the hiding edge.

o.pose: the brief's 18 poses (idle | hop | cheer | clap | point | carry | thwack | peek | squint | bow | sit | hug | wave | slide | ride | catch | throw | fold) plus two extras:
- 'walk': 0.56 s stride cycle
- 'give': holds an item out to the right with both mitts

Loops: idle, hop, cheer, clap, carry, peek, squint, sit, hug, wave, slide, ride, fold, walk and give.

One-shots hold their last frame:
- point: outBack jab over 0.32 s. Three short "boop" ticks appear at the fingertip from about 0.13 to 0.47. Reach is capped at about 100 px, so the arm keeps a gentle bow. The hand is a sage mitt with an index finger.
- thwack: wind-up from 0 to 0.32 swings outside the card, with the arm behind the card and the hand and glue stick visible over the head. The hit is at PIP.THWACK_HIT = 0.42, and it settles by 0.9.
- bow: 0.1 s rise/stretch. The card then folds forward at the scarf line (hinge y = -86); the upper flap foreshortens to 0.55, gets 10% wider, is shaded, casts a shadow and shows a pencil crease. It is fully down by PIP.BOW.down = 0.4 and holds. It rises from 0.9 with an outBack overshoot and is upright by PIP.BOW.up = 1.2. One hand goes to the tummy and the other sweeps out wide. rot stays ≤ 0.03. The antenna bulb stays round and slightly bigger.
- catch: both hands sweep up outside the card with the arms behind it, catching at PIP.CATCH_AT = 0.25 over the head. The item reaches the chest by 0.62. The arms come back in front once the hands are below the eyes.
- throw: the wind-up arcs up over the head; hand, arm and held item are drawn behind the card while they are over it. Forward snap from 0.30 to 0.40 (inOutQuad). Release is at PIP.THROW_RELEASE = 0.38, with the hand already forward-up; anchors.hands[1] on that frame is the launch point. o.hold is not drawn once released is true.

Options:
- o.stride: default 1 for 'walk' and 0 for 'carry'. It scales foot travel from 0 to 1. 'carry' with stride 1 walks at PIP.WALK_SPEED.
- o.squash = null: overrides scaleY. scaleX compensates, and the knees bend below 1.
- o.air = 0: WORLD px Pip is above the ground. Draw at groundY + hop.y and pass air: -hop.y; the contact shadow stays on the ground. (Fixed: this used to be in local units.)
- o.vel = [vx, vy]: caller velocity in px/s. Pupils, scarf, antenna and cowlick trail it.
- o.mouth: smile | grin | o | open | flat | wobbly | tongue. The default depends on the pose.
- o.eyes: normal | happy | squint | wide | shut.
- o.brows: null | determined | worried | squint | focus | raised.
- o.blink = null (NEW): 0..1 forces the eyelids. null means automatic blinks, which snap shut, carry the body's hachure and are suppressed while the brows are 'determined'.
- o.eyeSpin = 0.
- o.blush = 1.
- o.nightcap = false: the cap is now navy #3b5286 with cream stripes, moon dots and a moonlit rim facing the lantern.
- o.lantern = 0.
- o.glue = false: tip goes to anchors.tool.
- o.hold = fn(ctx): draws the item centred on the grip origin, in Pip's scale, never mirrored. It is layered between the body and the arms/hands. In 'throw', while the hand is behind the card, the item is drawn behind the card too.
- o.carryLow = false.
- o.carryW = 170 and o.carryH = 120 (NEW, carry overhead): the hands grip the item's sides at ±(carryW/2+4). holdAt is the item CENTRE, placed so the item's bottom edge rides about 10 px above the card top and never covers the face. The antenna squashes flat and peeks out at the left.
- o.aim = -0.3: keep within ±90° of forward and use flip to point the other way.
- o.peek = 0.
- o.shadow = true.

Anchors:
- hands[0] is the margin-side (left) hand; hands[1] is the glue/point/throw/wave hand.
- tool is the glue tip, or null.
- tip (NEW) is the pointing fingertip in 'point', or null.
- released is true once a throw has let go.

PIP.hop(t, t0, { dur = 0.5, height = 90, pre = 0.1 }) returns { y, p, squash, air }.
- y ≤ 0 is up, in caller px.
- squash goes 0.84 (crouch) → 1.15 (take-off) → 0.8 (landing) → springs back to 1.

Other PIP exports:
- PIP.size = { w: 150, h: 200 }
- PIP.POSES (20), PIP.MOUTHS
- PIP.THROW_RELEASE 0.38, PIP.THWACK_HIT 0.42, PIP.CATCH_AT 0.25
- PIP.BOW { down: 0.4, up: 1.2 }
- PIP.WALK_SPEED ≈ 128.6

═══ CAST ═══
CAST.helper(ctx, x, y, t, o) returns { hands, head, tool, feet, center }.
- (x, y) is the ground point; for 'sit' and 'tea' it is the seat point on the floor.
- o.color: sage | teal | peach | butter | pink | mint | lemon | hex. Default sage.
- o.pose:
  - idle, sit, hop, cheer
  - walk: 0.44 s cycle at CAST.HELPER_WALK_SPEED ≈ 118
  - hammer: 0.5 s cycle, strikes at poseT ≡ CAST.HAMMER_HIT = 0.35 mod 0.5; tool = strike face
  - magnify
  - check: crayon writes over poseT 0.12→0.5; tool = check centre
  - tea: sips every 2.6 s
- Also takes poseT, look, flip.

CAST.agent(ctx, x, y, t, o) returns { hands, head, feet, center, holdAt }, or { center, head } for mini.
- (x, y) is the ground point; with o.mini it is the card centre. The mini center anchor is now correct (≈ (x, y)).
- o.kind: architect | devlead | validator.
- o.pose: idle | wave | hop | tear | fan. In 'tear' the prop is put away and o.hold draws the napkin at holdAt.
- o.flip:
  - A NUMBER 0..1 is the card flip. The WHOLE doll foreshortens (card, arms, props); arms and props fade out below |cos| 0.3, and the legs converge to pencil lines. ≥ 0.5 shows the patterned back.
  - o.flip === true now means face left, the same as o.mirror.
- o.mirror = false.
- o.mini: 68×92 icon card. It has a face panel and a white name plate carrying the kind's emblem (hard hat | wrench | lens); the architect also keeps its hat. Minis have no limbs.
- o.hold.

CAST.you(ctx, x, y, t, o) returns { head, hands, feet, zzz }.
- (x, y) is the floor point under the bed centre when inBed, with the figure at x − 70. Otherwise it is the ground point.
- o.pose: sleep | stretch | wake.
- o.inBed = true.
- o.bedFlat = 0: the bed squashes and fades 0.35→0.75 and is gone by 0.75; the legs arrive 0.5→0.9 and YOU stands.
- o.zzz = false; o.zzzColor defaults to C.moon.

CAST.hand(ctx, x, y, t, o) returns { tip, palm, wrist, holdAt }.
- (x, y) is the fingertip for point/press, the pinch point for pinch, the grip for hold, and the palm centre for drop/open.
- o.from: right | left | top | bottom.
- o.pose: point | press | pinch | hold | drop | open. 'open' is now palm-up with four separated, slightly fanned and curled fingers plus the thumb on top, with the item at holdAt = (0, −20). The mitten 'open' is a short knit mitt with a thumb bump.
- o.press = 0 for point and 1 for press; o.push = 16.
- o.mitten, o.sleeve = C.blue, o.reach = 1600, o.hold, o.mirror.

CAST.visitor(ctx, x, y, t, o) returns { head, hands, feet }.
- About 215 px tall at scale 1: head radius 34, legs 62. (x, y) is the ground point.
- o.pose:
  - walk: 0.62 s cycle at CAST.VISITOR_WALK_SPEED ≈ 90.3
  - stop
  - clap
  - ooh: hands to cheeks
- o.color: shirt or dress colour, default C.sky.
- o.outfit (NEW): 'tee' (with trousers) | 'dress' | 'overalls' | 'skirt'. Default comes from o.id; see CAST.OUTFITS.
- o.hair (NEW): 0 bun | 1 bob | 2 curls | 3 beret. Default comes from o.id.
- o.bottoms (NEW): trouser, skirt or overall colour.
- Sleeve stubs are drawn. Skin tone varies by o.id.
- Also takes poseT, look, flip.

CAST exports: HELPER_POSES, AGENT_POSES, AGENT_KINDS, STICKY, HAMMER_HIT 0.35, HELPER_WALK_SPEED, VISITOR_WALK_SPEED, OUTFITS.

No API name or option was removed or renamed.

### Builder notes / open issues

- Bow is a flat foreshortening (upper flap scaled to 0.55, 10% wider, shaded, creased, with a cast shadow) rather than true perspective, because canvas 2D has no keystone transform. It reads as a smiling bow with a hand on the tummy. If the director wants it bigger, the next step would be a deeper fold (0.45) or adding a quick head-nod.
- Carry overhead needs the scene to pass o.carryW / o.carryH, the carried item's width and height in Pip-local px at scale 1. Otherwise the hands grip a 170×120 box. holdAt stays the item CENTRE, consistent with every other hold.
- For 1–2 frames, a held item or hand is fully hidden behind the card: the throw wind-up around poseT 0.13, and the catch around 0.47 where the hands hold the note in front of the face with the arms hidden. This follows from the behind-the-card rule and was judged acceptable at 15 fps.
- Automatic blinks follow the global t, not poseT, so a still frame can land on a closed-eye blink. Use o.blink: 0 to pin the eyes open for a hero hold, or o.blink: 0..1 for a deliberate slow blink.
- Walking only avoids foot-slide when the scene moves the character at the exported *_WALK_SPEED × scale × stride, toward the side it faces (−x when flip:true). The 'carry' pose steps in place unless o.stride is set.
- The 'give' pose's left arm still crosses the scarf to hold the note with both mitts. The review didn't flag it, but it could become a one-hand give if it reads busy in s5.
- Poses, options and exports added this round (all additive; nothing removed or renamed): options o.carryW, o.carryH, o.stride, o.blink and anchors.tip on PIP; o.outfit, o.hair and o.bottoms on visitor; exports PIP.CATCH_AT, PIP.BOW, PIP.WALK_SPEED, CAST.HELPER_WALK_SPEED, CAST.VISITOR_WALK_SPEED and CAST.OUTFITS. The 'walk' and 'give' poses from the previous round remain. Timing docs changed: the bow is now down by 0.4 and up by 1.2, where it was 0.35 / 1.25.
- The architect's hat is still a ridged rounded dome, not a literal triangle. This is unchanged from the builder's version.
- Perf numbers come from a shared machine whose load average swung between 16 and 50 during this session. PIP measured 3.0 ms mean at load 16 and about 2.5x higher under heavy load.


## js/props/day.js

window.PROPS additions from js/props/day.js. They merge Object.assign-style and don't collide with night.js or show.js. The header comment of js/props/day.js is the authoritative copy. Every name and option from the previous build still works; options were only added, none removed or renamed.

COMMON TO EVERY PROP
- Signature: PROPS.name(ctx, x, y, t, o = {}). (x, y) is the visual centre unless noted.
- o.id: seed for all randomness (default: the prop name). Give each instance its own id.
- o.scale: 1, or [sx, sy] to squash.
- o.rot: 0 (radians).
- o.jitter: 1 (stop-motion nudge; 0 = still). Pieces 500 px and larger nudge by position only, never rotation.
- o.shadow: 1. o.lift: 0 (extra shadow offset in px).
- Colours accept a K.C key ('sage') or any CSS colour.
- Anchors come back in the CALLER's coordinate space (the transform current at the call), so they work inside K.at or a camera transform. Rects are {x, y, w, h, cx, cy}, axis-aligned.
- Pure: no state between calls. Every prop is wrapped in ctx.save()/ctx.restore(), so font, alpha, composite op, styles, line dash and transform are exactly as the caller left them (verified by a probe).

S1 — DESK CHAOS
- terminalCard(ctx,x,y,t,o): black paper terminal with a rough cream border, 3 title dots, cream crayon output scribbles, and a green crayon `> _` with a blinking cursor.
  o: w 230, h 160, scribbles 2 (0..4), label null (tiny cream title), typed '' (green text after `>`), typedReveal 1, cursor 'underscore'|'block', blink true, blinkPhase (auto from id), torn 2.2, tape null (true or a colour: crooked washi across the top edge), color termBlack.
  Returns { center, prompt, top }.
- stickyNote(ctx,x,y,t,o): square sticky note with adhesive sheen and a bottom-right curl.
  o: size 190, color 'butter', text '' ('\n' = new line), textColor auto, textSize auto (auto-fits), family 'marker', reveal 0..1 (1), underline false, curl 0..1, flutter 0..1.
  Returns { center, top, bottom, corner }.
- napkin(ctx,x,y,t,o): scalloped napkin with a 3-stroke pencil lightbulb and "big idea!".
  o: size 300, text 'big idea!', color paperWhite.
  o.doodle 0..1 (1) sets the draw-on order: bulb 0–0.3 → base → filament → 3 glow ticks → text 0.64–1.
  o.lit 0..1 (default follows doodle) is the butter crayon fill.
  Returns { center, bulb, top }.
- coffeeRing(ctx,x,y,t,o): static coffee stain.
  o: r 90, alpha 1 (jitter defaults to 0).
  Returns { center }.
- pencilQuestion(ctx,x,y,t,o): giant sketchy graphite "?" that draws itself.
  Look: 5 thin rough passes side by side (tapered, with paper showing between them), a hooked flick where the pencil lands, and a scribbled cross-hatched dot drawn in 2 passes. A yellow pencil rides the tip of the leading pass.
  o: size 420 (height), color '#4a4540'.
  o.p 0..1: the stroke draws over 0–0.8 and the dot pops over 0.84–1.
  o.tool true: the pencil is visible while 0 < p < 0.985.
  Returns { center, tip }.

S2 — CONSOLE
- consoleWindow(ctx,x,y,t,o): hero shot, about 1500x820. Layers: torn terracotta border, torn kraft frame, cream screen with a dot grid. Recipe-binder folder tabs sit on the screen's top edge. A torn peach sidebar strip carries cut-out word labels with pencil icons. Washi corners; "Session Manager" plaque top-left; 3 paper dots top-right.
  o:
  - w 1500, h 820
  - tabs [{label, active, lift 0..1, icon, color, p, morph, insert}]. Default: Home(home) · garden-app(leaf) · recipe-bot(bowl) · napkin-idea(bulb, active).
  - icon ∈ home|bulb|leaf|bowl|chat|folder|clock|pin|flag|dot|null ('Home' gets home automatically).
  - tab.p overrides tabsReveal for that tab (0 hidden → 1 landed, outBack pop).
  - tab.morph 1→0 is a PAPER FLIP about the screen's top edge: black `> _` terminal face → kraft sliver lying on the edge at 0.5 → coloured face. It is never a crossfade.
  - An ACTIVE tab stays behind the screen with a cream face while morph > 0. At morph === 0 it merges into the screen and gets its terracotta "you are here" sticker dot.
  - tabsReveal 0..1 (1)
  - sidebar [labels]. Default: Project Home · Sessions · File Explorer · Scheduler · Memory · Host on Bilko.run.
  - sidebarReveal 0..1 (1): over 0–0.3 the strip unrolls like a scroll (full-size paper is revealed down to a peach roll that travels ahead of it). Its washi tape slaps on over 0.3–0.4 (scale 1.3→1 plus alpha). Labels then drop in on a stagger with ±4° tilt. Long labels shrink to fit inside the strip.
  - sidebarActive -1 (index → terracotta label)
  - title 'Session Manager'; plaque 0..1 (1); pins 0..1 (1) washi corners slap on
  - dim 0..1 (0) staging veil
  - content(ctx, rect) callback in window-local coords
  - screenColor cream, sidebarColor peach
  Returns { center, frame, screen, content, sidebar (rects), sidebarItems [[x,y]], tabs [[x,y]] (tab centres), tabRects [rect], plaque [x,y] }. Tab and sidebar anchors exist before those items are revealed (they are the landing spots). Keep o.rot = 0.
- folderTab(ctx,x,y,t,o): one binder tab, the same art the console uses.
  o: label 'Home', icon auto, color butter, active false (cream, no insert), lift 0..1, p 0..1 (1) pop, insert true, textSize 30, w auto, h 66.
  o.morph 0..1 (0) flips with scaleY = |cos(morph·π)| about the line y = pivot:
  - morph > 0.5: terminal face (termBlack, rough cream inner border, 3 title dots, green `> _`).
  - scaleY < 0.08: kraftDark edge sliver on the pivot line.
  - morph < 0.5: coloured face with its insert and label.
  Faces are always drawn at full strength; a turning shade darkens the face as it tips.
  o.pivot (NEW) = h/2: the tab-local y of the fold line. The default is the bottom edge, so the tab flattens down.
  Returns { center, bottom, w, h }.
- chatTermCard(ctx,x,y,t,o): index card on one terracotta yarn strand. It flips about the yarn with scaleX = |cos(flip·π)|:
  - flip 0: Chat face (cream speech bubble "Chat" + 3 bouncing dots, on a pale sky ruled card).
  - flip 1: Terminal face (black, "Terminal", blinking green `> _`).
  - flip 2: Chat again.
  Only one face is ever drawn; edge-on shows a kraft sliver. The yarn and its knot never flip.
  o: w 440, h 300, flip 0, yarn true, yarnLen 240, tapeTop true, swing 0 (radians, pivot = yarn top), chatText 'Chat', termText 'Terminal', cardColor (NEW, chat face card, default mix(paperWhite, sky, 0.3)), lift 10 (was 6).
  Returns { center, face:'chat'|'terminal', top (card top edge — Pip rides here), hole, yarnTop, yarnMid (slap the 'same session' sticky here), rect }.

S3 — AGENTS & MISSIONS
- clayButton(ctx,x,y,t,o): chunky clay arcade button, 3/4 view. Layers: cream washer → dark housing collar and socket → clay cylinder (side shade -0.18, left-to-right shading) → domed cap. The cap has a lighter crown (+0.12), faint thumbprint arcs and a paperWhite rim highlight. The dome squashes flat as it is pressed and bulges on negative overshoot.
  o: r 90, depth r*0.44, bezel cream, stripColor cream.
  o.color terracotta; the cap is drawn slightly more saturated.
  o.label '' is drawn on the cap.
  o.press is clamped to -0.35..1.25 for spring overshoot.
  o.icon(ctx, r) callback draws on the cap (origin = cap centre, y squashed 0.8). Recommended: (g, r) => CAST.agent(g, 0, -r*0.05, t, { kind: 'architect', mini: true, scale: 0.8 }).
  o.strip null|'Hot keys': a torn cream strip about ry*1.55 (≈84 px) tall behind the washer, which overhangs it. Lettered at the left, with a sage washi tab.
  Returns { center, top (dome apex = press point for the mitten fingertip), stripLabel }.
- cardBox(ctx,x,y,t,o): kraft recipe box with corner guards, terracotta lid hinged at the back, brass label holder "Agent Library", and coloured divider cards visible when open. (x, y) = front-face centre.
  o: w 420, h 250, label 'Agent Library', color kraft, lidColor terracotta.
  o.lidOpen 0..1 (to ~1.15 overshoot; underside lining shows past ~0.32).
  o.inside(ctx) callback is drawn between back and front (origin = mouth centre).
  Returns { center, mouth, fan [[x,y]×3], fanRot [-0.32, 0, 0.32] }.
- stickerSheet(ctx,x,y,t,o):
  o: labels ['Feature','Bug','Discussion'], colors [sage, tomato, sky], peeled -1, w 330.
  o.peel 0..1: 0–0.6 the corner curls, 0.6–1 the sticker lifts off; at ≥1 it is gone and a die-cut ghost remains.
  Returns { center, stickers [[x,y]], size [w,h] }.
- sticker(ctx,x,y,t,o):
  o: label 'Feature', color sage, curl 0..1, corner 'tr'|'tl'|'br'|'bl', w auto, h 74, textSize 34.
  Returns { center, w, h }.
- dashedSlot(ctx,x,y,t,o):
  o: w 300, h 200, labelPos 'bottom'|'top'.
  o.label '1 · agent — who is working' is split at ' — ': a big first line with the number in terracotta, then '— rest' smaller.
  o.filled 0..1: sage outline and a check pops.
  Returns { center, rect, label }.
- envelope(ctx,x,y,t,o): kraft envelope, flap side. A torn paperWhite address label (w*0.86 x ≤88, centred at y = h*0.325, below the flap tip) carries the stamp.
  o: w 440, h 270, color kraft, stampColor terracotta, stampTool true, seal true (heart).
  o.open 0..1: the flap flips up.
  o.stamp 0..1: the stampMark p.
  o.stampText 'Actor → Input → Mission → Goal': broken before the middle arrow into 'Actor → Input' / '→ Mission → Goal' when it doesn't fit; '\n' forces a break.
  NEW: o.stampSize 30, o.stampDarken 0.2, o.addressLabel true.
  o.contents(ctx) callback is drawn behind the pocket (origin = mouth centre).
  Returns { center, mouth, stamp (label centre), addressLabel (rect, NEW) }.
- stampMark(ctx,x,y,t,o): rubber-stamp ink impression (speckled, uneven, multiply blend) with an optional wooden stamp tool. The tool has a block with a visible red rubber layer and foam, wood grain, an index label, and a turned-wood handle with a tomato cap (two handles when the tool is wider than 300 px). The block is max(44, bw*0.22) tall.
  o: color terracotta, tool true, size 30, shape 'rect'|'round', family 'chunky'.
  o.text 'Actor → Input → Mission → Goal': '→' is drawn as a hand arrow; '\n' = new line (NEW).
  o.darken 0 (NEW): 0..1 ink darkening.
  o.fade 0.2 (NEW): dry-side strength; it was 0.42.
  o.p 0..1: 0–0.35 the tool drops, 0.35 THUNK and impression, 0.6–0.9 it lifts and fades.
  Returns { center, w, h }.
- door(ctx,x,y,t,o): hiveTeal paper door in a torn kraft frame, "Session" plate, hinge on the left.
  o: w 250, h 400, label 'Session', color hiveTeal, frameColor kraft.
  o.open 0..1: the face narrows linearly; 0.1 shows a crack; 1 ≈ 83°.
  o.glow 0..1: lemon under-door light and floor pool, plus a crayon hachure beam wedge when open > 0.
  Returns { center, gap, crack, knob, top }.

GENERIC
- indexCard(ctx,x,y,t,o):
  o: w 360, h 220, color paperWhite, title null, textSize 28, reveal 1, torn false.
  o.lines 3: a count or an array of strings.
  o.checkboxes 0: a count or an array of bools.
  Returns { center, rows [[x,y]], boxes [[x,y]] }.
- speedLines(ctx,x,y,t,o): (x, y) = the point just behind the mover.
  o: dir 0 (direction of motion), len 160, n 4, spread 80, p 1, color inkDim, width 3.2, gap 10.
  Returns null.
- doodlePuff(ctx,x,y,t,o): three lumpy 5–6-bump paper clouds (sizes 1 / 0.8 / 0.65), born overlapping as one cloud, then bursting apart with specks.
  o: r 70, n 3, color ink, fill paperWhite.
  o.p 0..1: 0 and 1 draw nothing; pops out by 0.35, fades by 1.
  Returns null.

### Builder notes / open issues

- For cast/s3: CAST.hand's mitten is fixed to terracotta knit in mascot.js and has no colour option, and the brief's Hot keys button is terracotta. The dome's paperWhite rim, lighter crown and dark collar now separate the fingertip from the cap reasonably well (see dev-props-day-80.00.png), but a contrasting mitten (sky or blue knit) or a mitten-colour option on CAST.hand would read better. That change is cast's, not mine.
- For s3: clayButton.top is the dome apex, so a fingertip placed exactly there covers the centre of the CAST.agent mini icon. Press slightly off-centre (for example top + [r*0.3, r*0.1]) or drop the icon in just before the press if the icon must stay visible during it.
- Draw times on this shared machine vary about 3x with load (load average 17–34 during the session). Steady-state figures: load tests 36–131 ms, worst sheet page 148 ms, all under 250 ms. Re-check with `node dev/sheet.mjs props-day` once the machine is quiet.
- When an active tab's morph reaches exactly 0, it jumps in one frame from behind the screen (bottom 11 px tucked, screen outline crossing it) to merged with the screen. This is intentional and reads as the tab 'landing', but s2 may want its sfx on that frame.
- Carried over: tabsReveal uses an outBack pop, so s2 should drive each tab's `p` and `morph` itself for beat-synced landings. A flip from morph 1→0 over about 0.4 s looks right.
- Carried over: keep consoleWindow at rot 0 (a rotated 1500 px fill is about 2x the cost). The door's light beam reaches about 150 px right of the frame and 120 px below it; leave room for it in s3's layout. stampMark allocates one small offscreen canvas per call (about 1 ms), so don't draw dozens of stamps per frame.
- Dev-sheet only: CAST.hand from 'top' ignored `reach: 300/420`, so the sleeve still runs to the top edge and crosses the sheet title. This is cosmetic in my sheet, but cast may want to check whether `reach` is honoured for from:'top'.
- FYI for props-show (carried over): PROPS.trailAt in show.js throws when called without its points list. I only hit this with a generic probe, not in real use.


## js/props/night.js

js/props/night.js adds 12 functions to window.PROPS (Object.assign), each with the signature PROPS.name(ctx, x, y, t, o = {}).
- They are pure functions of (t, o).
- Every function accepts o.scale (default 1), o.rot (default 0, radians) and o.id (the seed; defaults to the prop name).
- Returned anchors are in the CALLER's coordinate space, mapped through getTransform at call time.
- An `ease` option takes any of:
  - a K.ease key;
  - this file's own curves by name: 'blind' (accelerating fall, lands at 55 %, then two damped bounces of 4 % or less) or 'sign' (hinged fall, lands at 60 %, then one 10 % rebound);
  - a function p => p;
  - false, for linear.

SKY

nightBlind(ctx, x=0, y=0, t, o) → { bottom:[x,y] }
- A navy construction-paper blind that drops from the top.
- (x, y) is the TOP-LEFT of the area it covers; pass 0,0 for the full frame.
- Contents:
  - pinprick stars punched into the sheet; they travel with it, twinkle, and the big ones show + glints;
  - 7 butter/lemon paper 4-point stars with glows;
  - 2 dotted-pencil constellations;
  - soft broken fold creases;
  - a kraft dowel and a torn fringe;
  - a pull cord with a mustard ring and a terracotta tassel.
- o.drop 0..1 (default 1). For a full frame, the dowel parks just off-frame at 1. The travel is rounded to whole pixels.
- o.ease (default 'blind'). For the morning snap-up, animate drop 1→0 with 'inCubic' or 'inOutCubic'. 'outBounce' still works.
- o.stars (120): at drop 1 they span frame y 10..h-10.
- Other options: o.twinkle 0..1 (1), o.color (K.C.night), o.cord (true), o.creases (true).
- o.constellations: true | false | [[x,y],[x,y]] frame positions.
  - Default [[0.22w, 0.06h], [0.52w, 0.05h]].
  - Group 1 spans about 212x58 px right and down of its point; group 2 about 128x56.
  - Pass positions clear of your props.
- o.w / o.h:
  - Default K.W/K.H: full bleed, overhanging 80 px on each side.
  - Passing either makes a WINDOW blind: the sheet is clipped to [0,w] and to below y; the dowel overhangs 12 px; the paper stars shrink; at drop 1 the dowel rests inside the window bottom with the fringe 20 px below it.
- Returns the centre of the fringe.

moonOnThread(ctx, x, y, t, o) → { pivot, hook, moon }
- A butter-paper crescent hanging from its upper horn on a cream thread:
  - moon-paper highlight layer, torn white rim, craters;
  - sleepy closed eye with lashes, blush and smile;
  - glow.
- (x, y) is the washi-taped pivot.
- o.drop 0..1 (1) unspools the thread, eased by o.ease ('outBack'), so it bounces on the string. Below 0 thread length the moon is hauled straight up past the pivot.
- o.len thread length (300); o.r radius (110).
- o.swing sway (1 = about ±4°). The moon lags the swing.
- o.angle is an extra angle in radians: POSITIVE swings LEFT, negative swings right. For "swings off", animate it to about ±1.3 while drop goes 1→0 with 'inCubic'.
- Other options: o.face (true), o.glow 0..1 (1), o.charm (true; a lemon star on the lower horn).
- o.tape (true): the washi now scales with r, to max(40, 0.8r) x max(18, 0.27r). It stays at the pivot when the moon swings off.
- Colours: o.tapeColor ('rgba(184,92,52,0.9)'), o.color (K.C.butter), o.light (K.C.moon).
- `moon` = the centre of the crescent's outer disc.

paperSun(ctx, x, y, t, o) → { centre }
- NO RAYS. Layers:
  - a warm radial glow;
  - 2 translucent torn tissue rings, flat colour (pale gold inside, cream outside);
  - a tangerine torn rim and a scissor-cut mustard disc;
  - a lemon light sliver hugging the upper-left rim and a honey shade sliver lower-right.
- The face sits on flat mustard, with blush and cream cheek catch-lights.
- The rim and disc slowly turn; the face and the light stay upright.
- (x, y) is the centre when fully risen.
- o.rise 0..1 (1), eased by o.ease ('outBack').
  - Squash and stretch come from the rise velocity.
  - A ±3 px bob fades in over the last 20 % of the rise, so nothing pops when rise reaches 1.
- o.dist (420); o.r (130; reads down to r 60).
- o.face: 'happy' | 'sleepy' | 'awake' (googly eyes; uses o.look, default [0.15,-0.1]) | 'none'.
- o.glow 0..1 (1; also fades the tissue rings).
- o.horizon: caller-space y; everything below it is clipped. Otherwise draw your hills after the sun.
- Colours: o.color (K.C.mustard), o.rim ('#f2934f'), o.light (K.C.lemon), o.shade (K.C.honey), o.halo ('#ffd98f'), o.haloOuter ('#fff0cc').

SCHEDULER MACHINERY

conveyor(ctx, x, y, t, o) → { left, right, top, label }
- A dark belt loop with travelling cream slat ticks, a terracotta panel, hatched butter rollers that spin with offset, kraft legs, and a taped cream plaque.
- (x, y) is the belt centre.
- Options: o.w (1100), o.h (100), o.offset (px of travel; + moves the top run right), o.label ('Scheduler'; '' hides it), o.labelSize (50), o.rollers (6), o.legs (true), o.band (15).
- Colours: o.belt ('#4a3a2c'), o.panel (K.C.terracotta), o.rollerColor (K.C.butter).
- Anchors are the top-run surface. Place riders at lerp(left, right, u) with their bottom on top[1].
- It draws no cards.

slotBoxes(ctx, x, y, t, o) → { slots:[[x,y]×n], floor:[[x,y]×n], label }
- A kraft tray of n recessed bays with dashed cream crayon lines and a taped plaque.
- Each bay has a marquee bulb: socket, threaded neck, glass and a coil filament.
  - Off: clear bluish glass with a grey coil.
  - Lit: warm lemon glass, a honey coil, and a glow; above lit 0.5 a white-hot core appears.
- (x, y) is the tray centre.
- Options: o.n (5), o.slotW (170), o.slotH (150), o.gap (22), o.label ('Slots'; '' hides it).
- o.lit: a number (the first ⌊lit⌋ bulbs on; the fraction warms the next one) or an array of 0..1 per bay.
- o.part: 'all' | 'back' | 'front'. Draw 'back', then your cards/helpers standing on floor[i], then 'front' (lip + plaque).
- Colours: o.color (K.C.kraft), o.inside ('#9a7650').

gauge(ctx, x, y, t, o) → { pivot, tip, tick }
- A kraft plate, cream face, sage/mustard/peach bands, pencil ticks, a RED crayon tick at o.tick, and a black paper needle on a butter brad, with the label underneath.
- (x, y) is the needle pivot.
- o.value 0..1 (0.5; clamped at 1.04; tiny jiggle).
- Other options: o.tick (0.9), o.r (150), o.label ('Window used'), o.jiggle (1).
- Red buzz marks appear when value reaches the tick.

hangingSign(ctx, x, y, t, o) → { pin, sign }
- A cream sign with a terracotta border, pause bars and the text, hinged on a kraft dowel that hangs by 2-ply twine from a mustard pin.
- (x, y) is the pin.
- o.flip 0..1:
  - 0 = folded UP over the dowel, leaning back at 80 % height. It shows a kraft back with a dashed stitch border and a sage ▶. The ▶ sits near the hinge, between the twine legs; the twine and pin are drawn IN FRONT of the board.
  - 1 = hanging down, readable.
- o.ease (default 'sign').
- o.rock 0..1 | bool (1): the damped rock while flip is in 0.6..1. Pass rock:false on the flip-back-up path.
- Other options: o.text ('paused'), o.w (300), o.h (116), o.len (56), o.swing (1), o.icon (true).
- Colours: o.color (K.C.cream), o.border (K.C.terracotta), o.back (K.C.kraft).
- `sign` = the current centre of the face.

BEDSIDE

laptop(ctx, x, y, t, o) → { screen, tag, mug, lamp, deck }
- ALWAYS OPEN and lit. A silver-blue paper laptop whose cream screen shows:
  - a terracotta bar, tabs, sidebar and ticked rows;
  - the SAME black terminal card as s1–s2 (PROPS.terminalCard scaled in; a matching local stand-in if day.js is absent) with a green "> _" and a blinking cursor.
- A breathing green LED sits on the deck.
- A honey anglepoise lamp with a light cone (screen blend), and a steaming mug.
- A twine-tied kraft tag, lettered in marker.
- (x, y) is the centre of the bottom edge on the desk.
- Options: o.w LID width (420), o.lamp (true), o.lampOn 0..1 (1), o.lampSide 'right' | 'left', o.mug (true; on the side opposite the lamp), o.glow 0..1 (1), o.body ('#aebdcb').
- o.tag: the text ('app open = laptop stays awake', split into 2 lines at " = "). false or '' hides it, and that is safe with any tagSide.
- o.tagSize (40; renders at 29 px at scale 0.72).
- o.tagSide:
  - 'below' (default): hangs in front of the desk edge.
  - 'left' | 'right': looped round the lid corner. Use the side OPPOSITE the lamp. The mug steps out further when the tag is on its side.
- Keys are missing from the result when that part is hidden.

alarmClock(ctx, x, y, t, o) → { centre, top, tag }
- A terracotta twin-bell clock:
  - mustard bells, hammer, cream dial and hands;
  - dot eyes, blush and smile;
  - a turning butter key and stubby feet;
  - a kraft "reset" tag hanging from the key.
- (x, y) is the body centre.
- o.ring 0..1 (0): per-frame shake and hop, hammer flicks, vibration ARCS, > < eyes and an open mouth.
- Other options: o.r (84), o.time hours (7), o.tag ('reset'; false hides it), o.tagSize (40), o.color (K.C.terracotta), o.bell (K.C.mustard).
- o.arcColor (K.C.ink; pass a light colour on navy).

teacup(ctx, x, y, t, o) → { rim }
- A polka-dot cup on a saucer, with a teabag tag and steam.
- (x, y) is the cup centre.
- Options: o.r (34; about 16 for held cups), o.color (K.C.pink), o.steam 0..1 (1), o.saucer (true), o.tilt (0).

doneStack(ctx, x, y, t, o) → { cards:[[x,y]×n], top }
- A shingled pile of ruled index cards with checkbox scribbles, each getting a terracotta "DONE" rubber stamp on its visible lower strip. Stamped cards get green checks.
- (x, y) is the BOTTOM card's centre.
- o.stamped 0..n: whole cards are stamped. The fraction animates the thunk: overshoot, ink fade-in, squash and 4 corner flicks. Drive it as seg(t,a,b)*n for a cascade.
- Other options: o.n (4), o.w (230), o.h (150), o.step (60), o.color (K.C.paperWhite), o.stampColor (K.C.terracotta).

tally(ctx, x, y, t, o) → { end }
- A torn cream scrap with "Done today" and terracotta crayon tallies (4 bars + a slash per group of 5).
- (x, y) is the scrap centre.
- o.p 0..1 draw-on: the label writes itself over the first 40 %, then each mark draws.
- Other options: o.count (4), o.label ('Done today'), o.paper (true), o.color (K.C.terracotta).
- `end` = the right end drawn so far.

### Builder notes / open issues

- PERF, not in my files (pipeline owns js/engine.js): the camera nudge `ctx.translate(cam.dx, cam.dy)` uses sub-pixel offsets from K.nudge. That pushes every grain fill and cached background draw off Skia's fast path. Measured: a full-frame paper-grain fill goes 8 → 17 ms; a K.desk/K.backdrop draw goes 0.9 → 5.7 ms; nightBlind at drop 1 goes 9 → 21 ms. This happens in every scene. Rounding cam.dx and cam.dy (Math.round) keeps the stop-motion bump and roughly halves background cost. nightBlind already rounds its own travel, so it benefits once the engine does.
- The laptop's terminal card now calls PROPS.terminalCard from day.js, with jitter:0, shadow, torn:1.6, scribbles:2 and scale. Future day.js changes to that card will show up on the laptop, which is the intent. A local look-alike is used if day.js isn't loaded.
- paperSun defaults changed: the rim is now '#f2934f' (tangerine) instead of K.C.coral, the halo is '#ffd98f', and there are new options o.haloOuter and o.shade. Scenes that pass o.rim or o.halo explicitly are unaffected.
- moonOnThread's washi tape stays at the pivot when the moon swings off, which is physically right. Scenes should pass tape:false or stop drawing once the moon has left.
- laptop does not avoid the lamp automatically: tagSide on the SAME side as the lamp overlaps the lamp stand. The header says to use the opposite side. A side-hung tag is about 340 px wide at scale 1, and the mug moves out past it.
- The conveyor and slotBoxes draw no job cards. Scenes should use PROPS.indexCard (day.js) or their own; the dev sheet uses a local stand-in card.
- slotBoxes defaults to n=5, per the storyboard's 'five parking-spot boxes'. No number is printed on screen, so pass o.n if a scene wants a different count.
- The draw-time figures were measured on a heavily shared machine (load average 18–64 on 14 cores), so absolute numbers are inflated about 3x. The relative costs are reliable.


## js/props/show.js

All functions are on window.PROPS (merged with Object.assign). Every draw fn is fn(ctx, x, y, t, o = {}) and is pure. COMMON options: o.id (seed; each prop has its own fixed default, so give two copies different ids), o.scale (1), o.rot (0 rad), o.nudge (0.5 = stop-motion hand jitter; 0 = rock steady). (x, y) is the visual centre unless noted. Anchors come back in the CALLER's coordinate space (mapped through the transform current at call time). Hero silhouettes get a bold boiling pencil outline. Every stroke respects an outer K.withAlpha fade (inkLine, codeLine, scribble and stamps now multiply globalAlpha instead of overwriting it).

── s6 files ──
fileTree(ctx,x,y,t,o): a potted picture-book tree with the pot lettered "File Explorer". About 960x950 at scale 1: the pot bottom is at local y +432 and the canopy top is at about -515. A round torn-paper cloud crown (4 overlapping scalloped blobs, lumpy, with white torn rims) sits behind thick crayon branches hung with file and folder leaves, plus clusters of green leaves at every tip.
  Options:
  • o.grow 0..1 (1): the trunk, then the branches, draw on. The canopy blobs pop in over 0.44–0.86, and the green and file/folder leaves pop in with overshoot.
  • o.leafScale (1.3): NEW. Size of every file/folder leaf; the greens grow 60% as much.
  • o.pluck 0..1 (0): the "M" leaf pulls off its twig. At 1 it is NOT drawn; draw it in the hand with fileLeaf at scale anchors.mLeafScale.
  • o.pluckT (-1): seconds since the leaf detached; drives the twig spring-back.
  • o.sway 0..1 (1): leaf flutter and canopy bob. Also o.label ('File Explorer') and o.pot (true).
  Returns { leaves:[{x,y,kind,m}], mLeaf:[x,y] (rest position), mLeafScale (NEW: tree scale × leafScale × 1.15), branches:[[[x,y]…]x5], slide:[[x,y]…] (51 pts), slideJoin (NEW: index), trunkTop:[x,y], potTop:[x,y] }.
  • slide is Pip's FEET path. It runs along the TOP edge of the left-high branch 2 (now 40→20 px thick, a gentle playground-slide S, flat at the tip (-258,-180) and steeper toward the trunk) to slide[slideJoin] at the trunk (-3,-58), then down the trunk centreline to the soil (0,246).
  • The top edge of branch 2 is kept clear of leaves.
fileLeaf(ctx,x,y,t,o): o.kind 'file'|'folder' ('file'), o.m (false) terracotta "M" sticker, o.color. Size is ~70x90 (file) or 96x72 (folder). Returns { center, top }.
notebookPage(ctx,x,y,t,o): a 560x720 ruled page with punched holes, a terracotta margin, code-token lines and sticky-note tabs. The first tab now carries a tiny terracotta sticker with a white "M". (x, y) = centre of the FULLY unfolded page; the top edge stays fixed while it unfolds.
  Options:
  • o.unfold 0..1 (1): 3-panel accordion with fold shading. A crease drawn at full outline weight acts as the page's bottom edge while the lower panels are tucked.
  • o.strike 0..1 (0): an angry tomato pencil scribble-out of line 5. It is an irregular zig-zag (step 9–14 px, amplitude 6–11 px, slight upward slant) plus a looser second pass at 60% alpha.
  • o.rewrite 0..1 (0): a teal line writes on below it, with a ^ caret.
  • o.saved 0..1 (0): a perforated peach postage stamp reading "All changes / saved" plus a check. Impact at 0.3; postmark lines at 0.45–0.7.
  • o.tabs (3), o.pencil (true).
  Returns { top, bottom, corners:{tl,tr,bl,br}, tabs:[[x,y]…], stamp:[x,y], pen:[x,y]|null, strikeLine:[[x,y],[x,y]] }.
paperAirplane(ctx,x,y,t,o): o.fold 0..1 goes through these stages:
  • 0: a flat 260x340 notebook page with rules, terracotta margin, holes, 6 code-token lines and an M sticker at the lower right.
  • 0–0.3: the top corners fold in. Each flap swings up out of the page (never thinner than 8 px from the crease) and shows its back past halfway.
  • 0.3–0.6: the left half folds over; the flaps end up hidden inside the fold.
  • 0.6–0.63: anticipation squash.
  • 0.63–0.72: the wedge snaps nose-right (outBack) with 3 speed-tick arcs.
  • 0.72–1: the wings open (outCubic).
  • 1: a side-view plane ~410 long flying RIGHT; heading = o.rot.
  Options:
  • o.flip (false): the nose points along o.rot + π. The stamp and M stay readable.
  • o.bank (true): NEW. The plane always flies upright. When its nose (o.rot, or o.rot + π when flipped) points left, it is drawn mirrored instead of upside down, so rot = trailAt()[2] works on any trail. This is backward compatible with flip:true + rot = heading − π. Pass bank:false for an upside-down loop top.
  • o.stamp 0..1: terracotta "Send to chat" rubber stamp on the near wing. It only appears once fold ≥ 0.95 and is legible at scale ≥ ~0.7. A small M sticker sits beside it.
  • o.flutter 0..1 (0).
  • o.page ({margin:true, code:true, m:true} | false): NEW. What is printed on the page.
  Returns { nose, tail (now computed from the folded geometry, always on the paper), center, stamp|null }.
dottedTrail(ctx,x,y,t,o): a dashed pencil Catmull-Rom trail through o.pts, RELATIVE to (x, y); call with x = y = 0 for stage coordinates.
  Options: o.p 0..1 (1) head, o.from 0..1 (0) erases the tail, o.gap (24), o.dash (11), o.w (4), o.color (ink), o.alpha (0.8), o.style 'dash'|'dot'. nudge defaults to 0.
  Returns { x, y, angle, len }.
trailAt(pts, p) → [x, y, angle]: the same curve without drawing.

── s7 memory ──
corkboard(ctx,x,y,t,o): 1200x720 wood frame with speckled cork. A butter header strip lettered "Memory" is pinned on with two teal tacks, and a sage "Workspace" tab sits behind the top-left.
  Options: o.w, o.h, o.title ('Memory'), o.tab ('Workspace'), o.titleIn 0..1 (1).
  Returns { slots:[[x,y]x6], title, tab, corners:{tl,tr,bl,br} }.
memoryCard(ctx,x,y,t,o): a 260x180 torn-top index card with a red header rule, blue rules and a bold pencil outline. Hand text o.text wraps to 3 lines; with no text it draws varied cursive scribbles.
  Options:
  • o.color 'cream'|'butter'|'sage'|'peach'|'mint'|hex ('cream').
  • o.pin (true): the thumbtack now sits at the top edge (card-local y -h/2+10). Also o.pinColor (tomato), o.pinR (NEW, 12) and o.pinPress 0..1 (1).
  • o.pinPop 0..1 (0): NEW. The pin pops out: anticipation grow (inBack), then it shrinks away with a 16 px hop. It is gone at 1.
  • o.stale (false): faded card, inkFaint text, coffee ring, dog-ear.
  • o.staleStamp 0..1 (0): "STALE" rubber-stamp thunk; impact at 0.25.
  • o.lift 0..1 (0): the flap is hinged at the top.
    ◦ Its angle is clamped to 0.33π, so the face never drops below ~50% height and the text (shifted 8 px down) stays clear of the pin.
    ◦ It is keystoned: the free edge is up to 14% wider than the hinge.
    ◦ It gets brighter, grows an underside curl lip (18 px of the darker card back) below the free edge, and casts a shadow pushed down by up to 34 px.
    ◦ The board under it gets a shade that is darkest at the hinge and fades to 0 at the bottom.
  • o.part 'both'|'under'|'flap' ('both'): NEW. Draw part:'under', then Pip, then part:'flap'.
  • o.under: text on the board under the flap.
  • o.w, o.h, o.textSize (30).
  Returns { pin, center (of the visible face; the same as before at lift 0), bottom (free edge), grip:[[x,y],[x,y]] (NEW: free-edge hand holds), under (NEW: the spot under the flap) }.
thumbtack(ctx,x,y,t,o): o.color (tomato), o.r (15), o.press 0..1 (1). nudge defaults to 0. Returns { center }.
yarn(ctx,x,y,t,o): red plied yarn from o.from to o.to (both RELATIVE to x, y). o.sag (16), o.twang 0..1 (0), o.p 0..1 (1), o.color, o.w (5). nudge defaults to 0. Returns { mid, end }.
clipBundle(ctx,x,y,t,o): three memory cards.
  Options:
  • o.cards [{text,color}]x3. Default: 'tests: npm test' (cream), 'likes small commits' (butter), a sage scribble card.
  • o.spread ([[-300,-50],[0,30],[300,-40]]).
  • o.gather 0..1 (1) follows a NEW timeline:
    ◦ 0–0.3: the pin-to-pin yarn twangs and the cards tug outward a hair.
    ◦ 0.18–0.3: the pins pop off.
    ◦ By 0.44: the yarn has faded out, before any overlap.
    ◦ 0.3–0.82: the cards slide together (inOutCubic plus a small overshoot).
    ◦ 0.62–0.86: two crossing strands draw across the stack and tuck behind its edges.
    ◦ 0.84–0.96: the bow pops (outBack).
    ◦ The draw order is fixed as [0,2,1].
  • o.clip 0..1 (1): a hive-teal paperclip at scale 0.72 and card-local [92,-112] slides onto the top edge, staying above the front card's header rule.
  • o.tagIn 0..1 (1): a kraft "Clusters" tag swings in on twine tied to the clip's lower loop (outElastic). o.tag overrides the text.
  Returns { tag, clip, center, cards:[[x,y]x3] }.
crumple(ctx,x,y,t,o): o.p 0..1 turns a card (260x180) into a lumpy, creased, faceted ball (r≈58). The card's radial profile melts round progressively, the noise is low-frequency and each radius is clamped to ±18% of its neighbours' mean, so it is never spiky. The squish goes in stop-motion steps.
  Options: o.stale (NEW, true) gives the same outline and face as memoryCard({stale:true}); pass the card's id for a seamless swap at p 0. Also o.text, o.color, o.w, o.h, o.r.
  Returns { center, r }.
basket(ctx,x,y,t,o): 300 at the rim, 200 tall, with 9 upright stakes, over/under weavers in alternating light and dark, a rope rim and a pencil outline.
  Options: o.part 'both'|'back'|'front' ('both'); o.bounce 0..1 (0); o.contents (0).
  To drop something IN: draw part:'back', then the ball, then part:'front'.
  Returns { mouth, rimL, rimR, bottom }.

── s8 showcase ──
posterPage(ctx,x,y,t,o): a 600x800 cream page with an outline. The butter header now has a lightbulb plus three paper dots over a wavy crayon line; the fake cursive title is gone. o.title ('') replaces the dots with a title.
  Options:
  • o.scraps 0..1 (1): the README scrap, folder-tree doodle, "> _" strip and mini console window with a card friend fly in from the 4 corners, landing with a squash and a glue smear.
  • o.headings 0..1 (1): "What it is" / "Who it's for" / "How to run it".
  • o.tag 0..1 (1): the taped caption "one page, written from real code".
  • o.frame 0..1 (0): a kraft frame snaps on.
  Returns { top, grips:[[x,y],[x,y]], tag, corners:{tl,tr,bl,br} }.
house(ctx,x,y,t,o): (x, y) = GROUND centre, with pencil outlines.
  Options: o.color (sage), o.roof (auto contrast), o.w (180), o.h (150), o.lit 0..1 (0), o.label (a tiny sign now on the GABLE at y -h-34, shrunk to fit inside the roof triangle).
  Returns { door, roofTop, windows:[[x,y],[x,y]] }.
signpost(ctx,x,y,t,o): (x, y) = GROUND point, now with outlines. The kraft arrow board reads "bilko.run/projects" and the fluttering pennant "Host on Bilko.run".
  Options: o.flutter 0..1 (1), o.text, o.pennant.
  Returns { board, pennant, top }.
galleryWall(ctx,x,y,t,o): ~1600x720. A "Showcase" banner at local y -300 above framed mini posters on nails with picture wire.
  Options:
  • o.posters (['garden-app','recipe-bot','Session Manager']), o.emptySlot (3; -1 = none), o.reveal 0..1 (1), o.sway (0.6), o.hint 0..1 (0).
  • o.emptyNail (NEW, true): the free slot's nail. Set false to hang the new frame with a thumbtack at newSlot.pin.
  • o.newWire 0..1 (0): NEW. Draws the picture wire on from the nail to the new frame's top corners. Draw the wall first, then the poster over it.
  Returns { slots:[{x,y,w,h}], newSlot:{x,y,nail,pin,wire:[left,nail,right] (NEW),scale}, banner }. Draw posterPage(ctx,newSlot.x,newSlot.y,t,{frame:1,scale:newSlot.scale}).
heartPop(ctx,x,y,t,o): o.p 0..1 (drawn only while 0<p<1), o.color (pink), o.r (34). Returns { center }.

── s9 end card ──
luggageTag(ctx,x,y,t,o): a kraft tag at ~2.7:1 (542x204 at size 48) with an outline, stitched border, stripes and a butter sticker dot.
  Options:
  • o.text ('bilko.run/products/session-manager'): now wrapped after the last '/' into 'bilko.run/products/' and an indented 'session-manager'. o.wrap (NEW, true); false gives one line.
  • o.sub ('Linux & macOS'): the third, smaller line.
  • o.swing (1), o.string ([-46,-124]) (the doc is corrected to match the code), o.nail (true), o.size (48). nudge defaults to 0.35.
  Returns { hook, eyelet, center, w, h }.
tapeTyper(ctx,x,y,t,o): black label-maker tape with a V-notch on the left end, an angled cut on the right, embossed ridge lines 4 px inside both edges, and a droop of ≤0.012 rad that grows with the extrude, pivoted at the left end.
  Options: o.text ('npx claude-code-session-manager@latest'), o.reveal 0..1 (1), o.caret (true), o.grow (true), o.prompt ('>'), o.size (46).
  Returns { w, h, caret, left, right }.
washiLabel(ctx,x,y,t,o): o.text ('free & open · MIT'), o.color (terracotta), o.textColor (paperWhite), o.size (42), o.slap 0..1 (1). Returns { w, h }.

### Builder notes / open issues

- tapeTyper's mono font (Fira Mono, then Ubuntu Mono, then DejaVu Sans Mono) is still a system font, not vendored. It renders correctly on the render machine but falls back to the generic monospace elsewhere.
- posterPage has no title by default, because s8's onScreenText has none. The header shows a lightbulb, three paper dots and a wavy line instead. o.title is available if the pipeline owner allows one.
- clipBundle's gather timeline was retimed: the twang runs 0–0.3, the yarn is gone by 0.44, the cards slide over 0.3–0.82, and the tie and bow land at 0.62–0.96. s7 should run gather 0→1 over about 1.2–1.8 s and put its twang SFX near gather 0.1 and its bow SFX near 0.9.
- paperAirplane now banks by default, so a leftward heading with flip false is drawn upright and mirrored instead of upside down. The turn (fold 0.63–0.72) is very short, so if fold is animated over less than about 1 s, the snap lasts only 1–2 frames. That is intended.
- fileTree.slide ends by running straight down the trunk centreline (a fireman's-pole drop). s6 may prefer to stop at slide[slideJoin] and hop down instead.
- The PIP layering beats are checked only in dev composites with PIP.draw pose 'peek' and 'slide' at scale 0.5. Scene authors may still need small tweaks to Pip's offset, such as putting Pip's feet about 128 px below the card centre for the flap peek.
- memoryCard.center now tracks the visible, foreshortened face while the card is lifted; it is identical at lift 0. The pin moved up 6 px, and the default pin radius changed from 15 to 12 (it can be overridden with o.pinR).
- notebookPage redraws its content once per panel during an unfold (about 22–25 ms), so it costs roughly 3× while unfolding and 1× otherwise.
- All timings were taken at load average 25–39 while other agents were running, so absolute ms are pessimistic and noisy. The contact-sheet max of 556 ms was a one-off first-use spike.
- scribble's varied glyphs can occasionally form letter-like fragments such as 'la' or 'ta'. They are neutral doodle writing, not words or claims.


## Timeline, voices, engine info + transitions

FINAL TIMELINE (timeline.json; total 56.99 s, bpm 103.3855 so 22 bars land exactly on logoTime 51.07; beat 0.58035 s, grid anchored at global t=0). All times are global seconds.
s1-desk-chaos 0.00-5.50 (5.50) chaos, in:none (first scene)
  VO 0.50-1.66 "Twelve terminals." | 1.91-3.28 "Forty sticky notes." | 3.58-5.05 "What was I doing again?"  [af_jessica @1.1]
s2-one-console 5.50-14.35 (8.85) full, in:tape
  cameo pip-tada 6.08-6.75 "Ta-da!" [am_puck @1.0, rubberband pitch 1.18 formant preserved, gain .95, pan -.1] (after the tape clears, half-beat snapped)
  VO 6.91-9.86 "Session Manager: one console for Claude Code." | 10.11-11.43 "A tab per project —" (spoken "A tab per project,") | 11.64-13.95 "chat or terminal, same conversation."  [af_heart @1.0]
s3-agents 14.35-20.54 (6.19) full, in:pan
  VO 14.80-16.34 "Pick an agent and a mission —" | 16.56-17.80 "Claude arrives briefed." | 18.10-20.14 "Favorites become one-click buttons."  [af_heart]
s4-night-scheduler 20.54-27.34 (6.80) night, in:drop
  VO 21.14-21.90 "Bedtime?" | 22.25-26.22 "The Scheduler runs the cards, checks each one, and pauses at your limit."  [af_heart]
s5-sunrise-done 27.34-32.78 (5.44) sunrise, in:none (continues s4's set)
  cameos bot-check-1 27.54-28.02 [af_aoede], bot-check-2 27.92-28.34 [am_adam], bot-check-3 28.30-28.88 [bf_emma]  "Check!" @1.0, pitch 1.26 formant shifted, gain .8, pan -.45/0/+.45
  VO 29.03-29.68 "Morning:" (spoken "Morning!") | 29.98-32.38 "a pile of done, and one note that needs you."  [af_heart]
s6-files 32.78-38.28 (5.50) full, in:wipe
  VO 33.23-35.01 "Files sit right beside Claude:" [af_heart @0.95] | 35.30-37.30 "edit one, or toss it into chat." [af_heart]
s7-memory 38.28-43.28 (5.00) full, in:pan
  VO 38.73-41.76 "Peek at what Claude remembers — plain notes you can tidy." [af_heart, one clip]
s8-showcase 43.28-50.57 (7.29) build, in:tilt
  VO 43.73-44.66 "Then show off:" | 44.91-46.88 "a project page from your real code —" | 47.13-48.98 "like ours on bilko.run." (spoken "like ours on bilko dot run.")  [af_heart]
  cameos visitor-ooh-1 49.53-49.91 [af_bella, gain .6, pan -.35], visitor-ooh-2 49.69-50.22 [am_michael, gain .55, pan .35]  "Ooh!" @1.0 pitch 1.12 preserved (push-pin moment ~ cameoAt('visitor-ooh-1') - 0.2)
s9-endcard 50.57-56.99 (6.42) finale, in:wipe, logoAt:'vo' → logoTime 51.07 = "Session Manager." start
  VO 51.07-52.15 "Session Manager." | 52.50-53.69 "Build it, show it off —" | 53.94-54.94 "free and open."  [af_heart]
  cameo pip-yay 55.32-55.74 "Yay!" [am_puck @1.08 pitch 1.18 preserved, gain .95, pan .1] then 1.25 s hold

SCENE CONTRACT (js/engine.js): PROMO.scene(id, { draw(ctx, t, dur, info), sfx(dur, info) → [{t (local), type, gain?, pitch?, pan?, dur?}] }). t is local, quantized to 15 fps. During pan/tilt the engine also calls draw with t in [-0.3, 0) (incoming) or (dur, dur+0.3] (outgoing): clamp internally.
info = { id, index, start, end, dur, mood, voStart, voEnd (local narration start/end), lines [{text,start,end}] local (caption text), words [{word,start,end}] local (lower-case, estimated from the SPOKEN text, so wordAt('bilko') works), wordAt(word, fallback=0, nth=0), cameos [{id,text,start,duration,end}] local, cameoAt(id, fallback=0), beat (60/bpm), nextBeat(localT) → local time of first grid beat ≥ localT, transIn / transOut (kind into this scene / into the next, or null), camShift(localT) → {dx,dy}: the engine's pan/tilt offset applied to this scene at localT (0,0 otherwise). Use it for parallax, e.g. draw the background shifted by -0.35*dx so it moves less than the foreground }.
Captions: narration only, from vo[].text, balanced chunks ≤ ~46 chars (no orphan words), torn label centred at y≈1010. Cameos are never captioned.

TRANSITIONS (kind set on the incoming scene, centred on the cut; half-lengths in PROMO.TRANSITIONS):
- wipe ±0.36: torn coloured sheet sweeps right→left (unchanged). sfx 'swoosh'.
- drop ±0.36: sheet falls top→bottom (unchanged). sfx 'slideDown'.
- tape ±0.42: three wide washi strips (terracotta stripes / butter dots / peach stripes, paper grain, zig-zag torn ends, crinkles, drop shadow) slap on along a -0.26 rad diagonal, one after another, fully covering the frame from p≈0.44 to 0.56 around the cut, then rip off up-right with curl + lift. Only one scene is drawn at a time. sfx: 'tape' at cut-0.42 (slap) and 'tape' at cut+0.04 (rip, pitch 1.15).
- pan ±0.30 (inOutCubic): outgoing drawn at local t≥dur-0.3 translated -W*e; incoming drawn at local t<0.3 translated +W*(1-e), clipped to a torn leading edge with a white fibre rim and a 3-layer shadow cast onto the outgoing scene. sfx 'whoosh'.
- tilt ±0.30: same on the vertical axis. Incoming slides down from the top (torn bottom edge, shadow falls downward) and outgoing slides down and out. sfx 'slideUp'.
- none: hard cut, no sfx.
Transition sfx carry {transition: kind} and fall back to 'swoosh' if a type is missing from AUDIO.SFX_TYPES. Each scene draw (and each sfx()) is wrapped in try/catch.

AUDIO PLAN: plan.vo = [{start, buffer, kind:'narration'} | {start, buffer, kind:'cameo', gain, pan}]. PROMO.setVoice(false) drops both. moods from timeline scene.mood.

script/script.json schema (build-timeline.mjs): top level {voice, speed, lineGap, voLead, tail, cameoTail, bpm, loudness(-20 dBFS mean per clip), trim{threshold,lead,tail,fadeIn,fadeOut}, snapCuts?}. Scene {id, file, mood, transition, minDur, voLead, tail, lineGap, cameoTail, voice, speed, lines: ["text" | {text, say?, voice?, speed?, gap?}], cameos: [{id, text, say?, voice, speed, pitch, formant, at: number | {after:'vo', offset} | {word, nth, offset} | {with: cameoId, offset} | {after: cameoId, offset}, snap?: 'beat'|'half'|'bar', gain, pan, fadeIn?}], logoAt: number|'vo'}. Rules: a cameo before the narration pushes the narration later, a cameo that collides with narration is moved past it (with a warning), the scene end is max(minDur, voEnd+tail, lastCameo+cameoTail), and the build fails if the total is over 60 s (--allow-long overrides). Snapped cameos iterate to a fixed point with the logo-locked bpm.
Pipeline: Kokoro batch (uv run tts/kokoro_say.py) into a temp dir → vo/raw/<id>.wav (cache key = say/voice/speed) → ffmpeg -nostdin [rubberband=pitch:formant:pitchq=quality] → silencedetect trim (lead 0.04 / tail 0.07) → volumedetect level to -20 dB mean (peak ≤ -1.5) → fades → vo/<scene>-<n>.wav, vo/cameo-<id>.wav, 24 kHz mono s16. Flags: --no-tts, --force-tts, --reprocess. Stale clips are pruned, and the index.html SCENES block is rewritten.

### Builder notes / open issues

- s2 runs 8.85 s against a 7 s target: the Ta-da cameo needs its own space, and the s2 narration alone is ~6.8 s of speech at af_heart 1.0. s8 is 7.29 s and s5 5.44 s. The total is 56.99 s: inside the 60 s cap, at the top of the 55-57 s target, and above the brief's ~54 s.
- The voice cast deviates from BRIEF §7, which I cannot edit, based on the ASR listen-proxy. Helper bots are af_aoede, am_adam and bf_emma at speed 1.0 instead of af_nova, am_echo and bf_lily at 1.1. Pip's 'Ta-da!' is am_puck at 1.0 instead of 1.08. Pip's 'Yay!' and the visitors' 'Ooh!' follow the brief. Whoever owns BRIEF.md should record this.
- ASR residuals, probably fine for human ears. 'Files sit' is heard as 'File sit' (the z/s sounds run together, even at 0.95). In the full-mix transcript, 'bilko dot run' came out as 'build code dot run' and 'Ta-da!' at 6.08 as 'Clod down'. The audio agent may want to check the cameo level against the s2 music and tape SFX at that moment.
- At 26.2-27.3 s (after 'pauses at your limit') the mix drops to -38 dB RMS. This looks like the audio agent's deliberate near-silence, but combined with the no-VO gap before the Checks it makes about 1.1 s of hush.
- bpm is 103.39, not 104. The tempo is nudged so exactly 22 bars land on logoTime 51.07. Beat-snapped cameos (Ta-da and Ooh on half beats, Yay on a half beat) are solved iteratively, so a small script edit can move the total by ±0.3 s.
- preview.mjs --timeline (read-only for me) does not list cameos. build-timeline.mjs prints the full table with cameos instead.
- vo/raw/ holds the raw Kokoro cache: about the same size as vo/, 30 small wavs plus index.json. Consider a .gitignore entry if the directory gets committed. Nothing has been committed.
- Phase-B authors must replace the stubs. Each stub shows the scene id, its onScreenText labels and a coloured card, and returns empty sfx.


## js/audio.js — SFX types, moods, plan contract

window.AUDIO (js/audio.js). The required API is kept unchanged.
- AUDIO.SR = 48000
- AUDIO.renderMix(plan) → Promise<AudioBuffer>: stereo, 48 kHz, plan.duration long. Deterministic: two separate browser launches on the real timeline gave the same md5 (ccb6a951…).
- AUDIO.toWav(buffer) → ArrayBuffer: 16-bit PCM with TPDF dither. Exact digital silence stays silent.
- AUDIO.SFX_TYPES: string[] of the 77 valid cue types.

Extra helpers (all additive):
- AUDIO.SFX_META: { type: { desc, params, off, dur?, send, ownPan? } }
- AUDIO.renderSfx(type, o) → Promise<AudioBuffer>: one cue alone, at pre-master level (for tests).
- AUDIO.loudness(buffer | [L, R]) → { integrated (gated BS.1770 LUFS), shortMax (loudest 200 ms window, LUFS), peakDb }
- AUDIO._dev: raw note banks, used by the tuning checks.
- AUDIO.renderMix.last: debug info from the last render (music timing, duck spans, limiter stats, master gain).

PLAN CONTRACT
plan = { duration, bpm (default 104), logoTime, moods, vo, sfx, beat0?, targetLufs?, music?, normalize?, mute?, solo? }
- Beat grid = beat0 (default 0) + k·60/bpm. This is the same grid as the engine's info.nextBeat().
- moods: [{ start, end, mood, hit?, dip? }], contiguous, one per scene. Mood values: chaos | full | night | sunrise | build | finale | soft. Unknown values are treated as full.
  - hit (build only): global time of the full-band hit. Default: logoTime if the next scene is the finale, otherwise the section end.
  - dip (night only): [a, b] global seconds of near-silence. Default: the last bar of the night.
- vo: [{ start, buffer: AudioBuffer, kind: 'narration' | 'cameo' (default narration), gain? = 1, pan? = 0 }]. This matches what the new engine.js already sends.
  - Every clip is loudness-matched with BS.1770 before its gain: narration to −18 LUFS, cameos to −17 LUFS.
  - Narration gets a JS EQ (high-pass 75 Hz, −1.5 dB at 260 Hz, +2.5 dB at 3.3 kHz), a 2.2:1 compressor (at most ~4 dB of gain reduction), is returned to −18 LUFS, then passes a look-ahead peak catch.
  - Music ducks exactly 10 dB under narration (measured 10.0 dB on every span). Speech spans are detected from the audio, and gaps shorter than 0.7 s are merged so the music doesn't pump. Attack 50 ms starting 0.14 s before speech; release 0.3 s.
  - Cameos never duck the music. While a cameo speaks, the music only gets a −5 dB presence cut at 2.4 kHz. Cameo gain and pan are honoured.
- sfx: [{ t, type, gain?, pitch?, pan?, dur?, note?, dir? }]
  - Every cue is high-passed at 55 Hz, then loudness-matched so that gain 1 puts its loudest 200 ms at −21.5 LUFS (about 6 dB under speech). Beds and ticks sit lower by the per-type `off` values listed below.
  - Each cue is soft-capped at −5 dBFS, then multiplied by gain.
  - pitch multiplies the cue's pitch; note is a MIDI note for pitched cues; dur stretches sustained cues; pan runs −1..1 (stereo cues are balanced).
- normalize (default true): master stage. Integrated loudness to targetLufs (−16), a 2 dB tanh soft-clip knee, a true-peak-aware look-ahead limiter at −1.5 dBTP (4× sinc detection), a 4 ms fade-in and a 0.3 s fade-out. With normalize false you get pre-master levels (for tests).
- mute: ['music' | 'sfx' | 'vo' | 'cameo']. Muted voices still duck and carve the music.
- solo: [music group names]. Returns raw group levels.

MOODS (F major, tempo = plan.bpm; the real timeline currently uses 103.39)
- chaos: A detuned toy piano (±45 cents) stumbles through the motif, with off-beat kazoo honks, a clock ticking too fast that speeds up from ~200 to ~315 per minute, and lopsided pizzicato plonks. The music stops dead on the beat nearest (cut − half a beat). Then there is exactly one beat of silence, with the music reverb choked (measured −80.7 dB). The groove then drops in with a glock ding and tambourine accent.
- full: Karplus-Strong ukulele (re-entrant G-C-E-A voicings, D-DU-UDU strum pattern, 8% swing, each string's previous note stops when it is re-struck). Also a pizzicato bass line, a glock 4-bar motif (phrase A asks, phrase B answers; chords F Dm Bb C), paired claps on 2 and 4, a shaker on the 8ths, a soft box-kick, and a woodblock fill at the end of each phrase. Consecutive full scenes vary:
  - 1st: the base arrangement
  - 2nd: pizzicato takes the melody while the glock only sparkles
  - 3rd: toy piano doubles the glock
  - 4th: staccato bass
- night: A half-time lullaby. The motif plays on music box plus felt piano (two detuned strings, soft hammer) over a warm detuned-saw pad. A soft woodblock tick-tock runs on the beat. The last bar (or `dip`) drops to a whisper of pad plus one music-box twinkle.
- sunrise: An upward glock and harp glissando starting at the cut, then the full band re-enters on the next beat with an accent, starting again from bar 1 of the motif. If cameos open the scene (the three "Check!"s), the downbeat waits for them, up to 2.2 s.
- build: Driving 8th-note strums and bass, doubled claps (on 2, 2&, 4, 4&), a toy snare roll crescendo over the last ~1.5 bars, and a slide-whistle lift into a full-band hit at H.
- finale: A full-band hit exactly at logoTime. Then the motif is restated once (hook bar, plus a Bb bar if there is room, then a C7 cadence), a sixteenth-note breath, and the button ending on a beat about 1 s before the end: one ukulele F strum, a glock F6 ding (plus C7), and a low pizzicato F, ringing out. The real film's button is at 55.71 s, 1.28 s before the end.
- soft: The band without percussion (kept for old timelines).
- Scene cuts: every cut gets a harp-and-glock swirl (descending into night). Skipped at chaos→ (the silence gag), →sunrise (the glissando) and →finale (the hit).

SFX TYPES (77). Defaults: dur in (), level offset in [dB]. All types take gain.
- rustle: paper rustle bed or short leaf rustle {dur (1.2), pitch, pan} [−7]
- paper: dry crackle {dur (0.35), pan}
- crinkle: one quick crinkle, use x3 for an unfold {pitch, pan}
- crumple: paper balled up {dur (0.65), pan}
- tear: short paper tear, x5 for a run {dur (0.2), pitch, pan}
- tapeRip: sharp washi rip {dur (0.26), pitch, pan}
- tape: slow sticky pull {dur (0.32), pan}
- flutter: sticky-note flaps {dur (0.4), pitch, pan}
- flap: card flap lifting {pitch, pan}
- flip: card 'fwip' {pitch, pan}
- riffle: card-fan riffle {dur (0.45), pitch, pan}
- peel: sticker zip {dur (0.3), pitch, pan}
- envelope: envelope sliding {dur (0.5), pan}
- swish: net or paper swish {pitch, pan}
- swoosh: swipe that sweeps from pan to −pan {dur (0.5), pitch, pan}
- whoosh: big airy whoosh that sweeps {dur (0.7), pitch, pan}
- flurry: scrap flurry, stereo {dur (1)} [−3]
- pencil: scribble {dur (0.6)}
- scratch: one strike-through {dur (0.28), pitch}
- typing: soft keyboard {dur (0.8)} [−4]
- clatter: frantic keyboard {dur (0.5)} [−2]
- typewriter: typewriter keystrokes {dur (0.8)} [−2]
- clack: single clack {pitch}
- carriage: ratchet zip plus bell {pitch}
- thud: soft padded thud {pitch}
- thump: small postage-stamp thump {pitch}
- stamp: rubber-stamp thunk {pitch}
- thwack: glue-stick whack {pitch}
- slap: sticky-note or washi slap {pitch}
- thup: soft sticker press {pitch}
- tack: thumbtack tick {pitch}
- pin: push-pin thunk {pitch}
- tap: tiny hammer tap {pitch}
- frameSnap: picture frame snapping shut {pitch}
- clunk: chunky button {pitch}
- button: press-and-release click {pitch} [−1]
- bloop: squishy button {pitch}
- squelch: glue squelch {pitch}
- gulp: soft pop into a bubble {pitch}
- pop: round paper pop {pitch}
- letterPop: tonal pop {pitch | note}
- blip: tiny UI blip [−3]
- shutter: camera shutter
- snip: scissors
- rattle: googly-eye rattle {pitch}
- boing: spring boing {pitch}
- creak: small creak {dur (0.5), pitch}
- signFlip: sign swing plus settling clacks {pitch}
- blind: paper blind sliding down {dur (0.8)}
- blindUp: blind rolling up with a snap
- conveyor: clickety-clack plus belt rumble {dur (1.5), pitch} [−4]
- crickets: two crickets, left and right {dur (2), pitch} [−11]
- footsteps: tiny pitter-patter {dur (1), pitch} [−3]
- snore: rumble in, whistle out {pitch} [−3]
- zzz: sleepy buzz {dur (1.2)} [−5]
- alarm: wind-up alarm bell {dur (0.8), pitch}
- ding: bright glock ding {pitch | note}
- plink: glassy plink {pitch | note}
- chime: three-note glock chime {pitch}
- sparkle: glock twinkles {pitch} [−2]
- swirl: harp and glock page-turn swirl {dir 1 | −1} [−3]
- toyRun: toy-piano run up two octaves {dur (0.7), pitch} [−2]
- snareRoll: toy snare crescendo {dur (1.2)} [−2]
- bandHit: full-band stab [+2]
- pluck: ukulele pluck {note (72) | pitch}
- kazooTada: kazoo 'ta-da' {pitch}
- rooster: kazoo cock-a-doodle-doo {pitch}
- honk: kazoo honk {pitch}
- bwomp: comic bassoon {pitch}
- cuckoo: whistled cuckoo {pitch}
- slideUp: slide whistle up {dur (0.45), pitch}
- slideDown: slide whistle down {dur (0.45), pitch}
- twang: wobbly yarn twang {pitch}
- claps: small crowd clapping {dur (1.2)} [−3]
- applause: bigger applause {dur (1.6)} [−3]
- tick: woody clock tick {pitch} [−3]
- tock: woody clock tock {pitch} [−3]

STORYBOARD CUE → TYPE (also in the header table of audio.js)
- s1:
  - paper rustle bed → rustle {dur 5, gain 0.8}
  - keyboard clatter → clatter {dur 0.5}
  - sticky-note flutters → flutter
  - pencil scribble → pencil
  - googly-eye rattle + boing → rattle + boing
  - washi tape rip → tapeRip
- s2:
  - glue-stick thwack → thwack
  - terminals fly in → whoosh / swoosh
  - three ascending plinks → plink {pitch 1, 1.26, 1.5}
  - card flip x2 → flip
  - typewriter clack under the Terminal face → typewriter / clack
  - sticky-note slap → slap
- s3:
  - card-fan riffle → riffle
  - sticker peel zip → peel
  - sticker press → thup
  - rubber-stamp thunk → stamp
  - envelope slide → envelope
  - squishy button → bloop (+ kazooTada on the press)
- s4:
  - window-blind slide → blind
  - paper tear x5 → tear x5
  - crickets bed → crickets
  - conveyor clickety-clack → conveyor
  - tiny hammer taps → tap
  - gauge creak → creak
  - sign flip clack → signFlip
  - one gentle snore → snore
- s5:
  - alarm bell ding → alarm
  - blind roll-up snap → blindUp
  - kazoo rooster → rooster
  - stamp cascade x4 → stamp x4
  - sticky-note flutter → flutter
- s6:
  - paper swipe → swish / swoosh
  - leaf rustle → rustle {dur 0.5, pitch 1.3}
  - paper unfold → crinkle x3
  - pencil scratch → scratch
  - postage-stamp thump → thump
  - paper-airplane whoosh → whoosh (+ toyRun)
  - gulp pop into the bubble → gulp
- s7:
  - thumbtack tick x4 → tack x4
  - card flap lift → flap
  - button tap → button
  - yarn twang → twang
  - rubber-stamp thunk → stamp
  - paper crumple → crumple (+ bwomp)
  - basket swish → swish (+ plink or ding)
- s8:
  - button clunk → clunk
  - scrap flurry → flurry
  - glue squelch x3 → squelch x3
  - frame snap → frameSnap
  - tiny footsteps → footsteps
  - push-pin thunk → pin (+ bandHit to make the hit musical)
  - crowd claps → claps
  - sparkle chime → sparkle / chime
- s9:
  - collage whoosh cascade → whoosh x3
  - letter-drop pops → letterPop {pitch or note}
  - washi slap → slap
  - typewriter + carriage ding → typewriter + carriage
  - luggage-tag swing creak → creak {pitch 1.3}
  - final ding + paper pop → ding + pop

The engine's current transition mapping, all valid types: wipe→swoosh, drop→slideDown, tape→tape, pan→whoosh, tilt→slideUp.

TEST TOOL (dev/audio-test.mjs, with dev/audio.html)
- Command: node dev/audio-test.mjs [--real] [--groups] [--quick] [--cameo file.wav]
- Default run: the synthetic 56 s plan (target moods, logo at 49.9, real vo/*.wav narration, two cameos, one cue of every SFX type) and every SFX rendered alone.
- ffmpeg checks: ebur128 loudness and true peak, per-mood astats, the silent-beat check, duck depth (dry vs ducked on the same windows), the ending check, and spectrograms.
- --real: renders the actual film through index.html and the engine.
- Exits 1 on non-finite or silent output, true peak above −1 dBTP, duck depth outside 8.5–11 dB, a leaky silent beat, no ring-out, or unknown SFX types used by scenes.
- Outputs: out/audio-test.wav, -music.wav, -sfx.wav (+ .txt index), -raw-*.wav, audio-test-spec.png, audio-test-music-spec.png, audio-real.wav, audio-real-spec.png.

### Builder notes / open issues

- Nothing has been listened to. Everything was checked with loudness meters, pitch measurement and spectrograms. A human should listen to out/audio-real.wav, out/audio-test.wav and out/audio-test-sfx.wav (index in out/audio-test-sfx.txt), mainly for the kazoo (rooster, honk, ta-da), the synthesized claps, and the chaos section, which is deliberately messy.
- engine.js (pipeline owner) plays `tape` (a slow sticky pull) on the tape transition. The brief's washi rip on the s1→s2 cut would land sharper as `tapeRip`. This is a one-word change in engine.js TRANSITIONS; I did not touch that file.
- engine.js sends no `hit` or `dip` in plan.moods. So the build crescendos into the logo hit, not into the s8 push-pin, and the night dip is simply the last bar of s4. To make the push-pin musical, the s8 scene should add a `bandHit` cue (or the pipeline can pass `hit`). The 'pauses' dip lands roughly on the word only by luck of timing.
- The finale restates the motif compressed. About 5 s run from logo to end, so it plays the hook bar and a C7 cadence into the button. The full 4-bar motif only fits if logo-to-end is 8 s or more.
- The real timeline currently sets the button 1.28 s before the end, because bpm 103.39 puts the nearest beat there. The brief says about 1 s. It moves automatically when the timeline changes.
- The second visitor 'Ooh!' (gain 0.55, overlapping the first) sits at the same level as the build's snare crescendo. That fits the intent of a quieter crowd, and the presence cut helps, but cameos never duck, so it may be hard to hear. Raising its gain in the timeline would fix it.
- Short click cues (typing, clatter, clack, tack, tap, button, slap, thup, shutter, crinkle) come out 2–4 dB under the SFX loudness target because each cue is capped at −5 dBFS. That is perceptually reasonable, but scenes can pass gain 1.3–1.5 if a click needs to pop.
- No scene sends sfx cues yet, so the real film has only transition sounds. All 77 types were tested in the synthetic plan, but the SFX density of the finished film is untested. Re-run `node dev/audio-test.mjs --real` once the scenes land; it fails if a scene uses an unknown type.
- Render speed depends on machine load. The mix takes about 5 s normally and took up to 24–42 s while 30+ other processes were running. It runs once per video render.
- Dev-only hooks are exposed: AUDIO._dev (note banks) and AUDIO.renderMix.last (debug info). They are harmless but public.

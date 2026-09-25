# Promo build brief — "Pip and the Paper Moon"

Shared contract for every agent building this video. Read it fully before touching code.
Directory: `web/promo-video/` (all paths below are relative to it). Everything is plain browser JS
(no modules, no build step) drawn on one 1920x1080 canvas, rendered headless by Playwright.

## 1. What we are making

A ~54 s (hard cap 60 s) adorable, whimsical, **hand-drawn paper-collage** ad for Session Manager —
"one console for Claude Code", a free & open local app. Audience: developers who use Claude Code.
The user's direction, verbatim: *"high production quality"*, *"use cute characters and good voice
tones"*, *"whimsical hand-drawn collage style with appropriate audio"*.

**Source of truth for story + words:** `script/research-output.json` → `final` (logline, mascot
spec, music direction, 9 scenes each with `voiceover`, `onScreenText`, `visuals`, `sfx`,
`musicNote`) and `facts` (verified product facts; also dumped as `out/facts.txt`). The scene
`visuals` are the storyboard — follow them. Where a visual is too expensive or unclear, simplify,
but keep every story beat and every `onScreenText` string.

## 2. Hard rules (every file)

1. **Pure function of time.** A draw call must depend only on its arguments (t, opts). No state
   survives between frames (frames render out of order on 8 workers). Randomness only via
   `K.rng(...keys)` / `K.seedOf` / `K.ro(id, t)`; stop-motion "boil" via `K.boil(t)`.
2. **Never use `ctx.shadowBlur`, `ctx.filter`, or CSS filters** (10x frame cost in CPU raster).
   Depth = `K.dropShadow` / `K.paper(... {shadow, lift})`.
3. **Frame budget:** a full scene frame should draw in **≤ 250 ms mean** in headless CPU raster
   (dev/sheet.mjs and preview print draw ms). rough.js hachure fills cost ~5 ms per shape — use
   them for accents only; big areas use `K.paper` pattern fills. Cache nothing across frames except
   what kit.js already caches (textures/backdrops).
4. **Brand safety:** no Anthropic or Claude marks. **No starburst, asterisk, sunburst or rayed-sun
   shapes anywhere** (no shapes with 5+ radiating rays; the sun is a round torn paper disc with no
   rays; `K.sparkle` with n ≤ 4 short ticks is OK). Claude is only ever drawn as a plain cream
   speech-bubble window or a black paper terminal with a green crayon `> _`.
5. **Accuracy:** on-screen words come only from each scene's `onScreenText` (plus neutral doodle
   scribbles like "fix bug??"). Never invent a feature claim, number, platform, price or quote.
   Forbidden claims: Windows, Whisper, cloud hosting for anyone, sandbox, paid tier, swarm.
6. **Single-creator law in the story:** a cut-out human **hand/mitten presses every button**.
   Pip cheers, carries, points, tidies — never starts work itself.
7. **Captions** are burned in by the engine at the bottom (a torn label centred at y≈1010, ~80 px
   tall). Keep key action and on-screen text above **y ≈ 940** (or accept being covered).
8. Bound every shell command with `timeout` (dev sheets 120 s, previews 180 s). Run everything from
   `web/promo-video/`. Never touch files you don't own (section 4). Never `git add`/commit.

## 3. The look (kit.js is the style — use it)

`js/kit.js` exposes `window.K` (read the file; it is the design system):
- `K.W/H` 1920x1080, `K.C` palette (brand "Almanac": paper #f6efe1, kraftLight, ink #2a221a,
  inkDim, terracotta #b85c34 = THE accent, peach, sage, butter, honey, hiveTeal, line; playful
  accents cream, paperWhite, kraft, tomato, coral, mustard, lemon, teal, mint, sky, blue, lilac,
  pink, grass; termBlack, crayonGreen, night #24324a, nightDeep, moon).
- Time: `K.quant` (15 fps stop-motion steps — the engine already quantizes t), `K.boil`,
  `K.seg(t,a,b)`, `K.ease.{outBack,outElastic,outBounce,inOutCubic,...}`, `K.spring`, `K.pop`,
  `K.noise1`, `K.nudge(id,t,amp)` (hand-placed jitter).
- Shapes: `K.boxPts/rectPts/roundRectPts/ellipsePts/starPts`, `K.wobble/tear/grow`, `K.at(ctx,x,y,rot,s,fn)`
  (local frames — ALWAYS place pieces with K.at so grain travels with the piece), `K.withAlpha`.
- Paper: `K.paper(ctx, pts, color, {torn, cut, shadow, lift, stroke, seed})`, `K.flat`, `K.tape`,
  `K.dropShadow`, `K.desk(ctx)`, `K.backdrop(ctx, color, {dots, vignette})`.
- Pencil/crayon (rough.js, boiling): `K.pencil.{line,rect,circle,ellipse,poly,curve,path,arc}(ctx, ..., id, t, opts)`,
  `K.arrow`, `K.sparkle`, `K.twinkle`.
- Lettering: `K.FONTS` {hand: Patrick Hand, marker: Gochi Hand, script: Caveat, chunky: Fredoka, kalam},
  `K.font`, `K.hand(ctx,str,x,y,{family,size,color,align,t,id,jitter,reveal,weight,outline})`,
  `K.ransom`, `K.label`, `K.bubble`.
- Faces: `K.googly(ctx,x,y,r,t,id,look,{blink,pupil,lidColor})`, `K.cheek`.

**Quality bar ("high production quality", cute):** apply the animation principles on every beat —
anticipation before big moves, squash & stretch, overlap/follow-through (scarf tails, cowlick,
tags keep moving after a stop), arcs, slow-in/slow-out (`ease`), secondary action, staging (ONE
focal point at a time; dim or blur-by-scale the rest), and appeal (round, chunky, big eyes, blush).
Hit pops/landings on musical beats (`info.beat`, section 6). Parallax: background layers move less
than foreground during pans. Every piece of paper has grain, a cut or torn edge and a drop shadow.
Nothing ever pops from nothing without a squash/overshoot or a paper swipe.

## 4. File ownership (only edit your own files)

| Phase | Owner | Files |
| --- | --- | --- |
| A | cast | `js/mascot.js`, `dev/cast.js` |
| A | props-day | `js/props/day.js`, `dev/props-day.js` |
| A | props-night | `js/props/night.js`, `dev/props-night.js` |
| A | props-show | `js/props/show.js`, `dev/props-show.js` |
| A | pipeline | `script/script.json`, `build-timeline.mjs`, `js/engine.js`, `vo/*`, `timeline.json`, `index.html` (SCENES block only — build-timeline rewrites it), placeholder `js/scenes/s*.js` stubs |
| A | audio | `js/audio.js`, `dev/audio-test.mjs` |
| B | scene sN | `js/scenes/<scene-id>.js` (one agent per scene) |

Read-only for everyone: `js/kit.js`, `vendor/*`, `serve.mjs`, `preview.mjs`, `render.mjs`,
`dev/sheet.*`, `script/research-output.json`, this brief. Need a kit change? Put a local helper
in your own file instead.

## 5. APIs that phase A must deliver (names are fixed — phase B codes against them)

All drawing functions: `fn(ctx, x, y, t, o = {})`, pure, defaults for every option, `o.id` seeds
randomness (default a fixed string), `o.scale` (default 1), `o.rot` (default 0). (x, y) is the
visual centre unless the doc comment says otherwise. Where useful, return anchor points **in the
caller's coordinate space** (e.g. `{ hands: [[x,y],[x,y]], top: [x,y] }`) — compute them by mapping
local points through `ctx.getTransform()` and the inverse of the transform at call time.
Document every function (signature + options + returns) in a header comment at the top of your file.

### js/mascot.js — `window.PIP`, `window.CAST` (owner: cast)
Pip spec = `final.mascot` in research-output.json (index card body 150x200, butter hachure paper,
ruled lines, terracotta margin, honey dog-ear cowlick, mismatched googly eyes r16/r13 with springy
pupils, crayon smile, blush, terracotta washi scarf with fluttering tails, pencil limbs with sage
hole-punch hands/feet, paperclip antenna with butter bulb that glows at night, glue-stick prop,
navy nightcap). Make it **irresistibly cute**.
- `PIP.draw(ctx, x, y, t, o)` — (x, y) = ground point between the feet. Options:
  `scale, rot, flip` (face left), `look [lx,ly]` (-1..1), `pose` one of
  `idle | hop | cheer | clap | point | carry | thwack | peek | squint | bow | sit | hug | wave | slide | ride | catch | throw | fold`,
  `poseT` (seconds since the pose began — drives cycles), `squash` (override scaleY),
  `mouth` `smile | grin | o | open | flat | wobbly`, `eyeSpin` 0..1, `blush` 0..1 (default 1),
  `nightcap` bool, `lantern` 0..1 (antenna glow), `glue` bool (holds glue stick), `hold(ctx)`
  (callback drawing an item at the hands, local coords), `peek` 0..1 (hide the lower body, e.g.
  under a sticky note: only eyes/top visible). Returns `{ hands, head, antenna, feet }` anchors.
- `PIP.hop(t, t0, { dur=0.5, height=90 })` → `{ y, p, squash }` jump-arc helper (y ≤ 0 is up).
- `PIP.size` → `{ w: 150, h: 200 }` (body only, scale 1).
- `CAST.helper(ctx, x, y, t, o)` — sticky-note job helper (square, dot/googly eyes, pencil legs):
  `color` (sage | teal | peach or hex), `pose` `idle | walk | hammer | magnify | check | tea | sit | hop | cheer`, `poseT`, `look`, `flip`.
- `CAST.agent(ctx, x, y, t, o)` — paper-doll trading card: `kind` `architect` (terracotta triangle
  hard hat + rolled blueprint) | `devlead` (wrench) | `validator` (magnifying-glass circle);
  `pose` `idle | wave | hop | tear | fan`, `look`, `flip` 0..1 (card flip to its back), `mini` bool
  (tiny icon version for the Hot keys button). Each has googly eyes + its own brand border colour.
- `CAST.you(ctx, x, y, t, o)` — "YOU": stick figure; `pose` `sleep | stretch | wake`, `inBed` (paper
  bed with quilt), `bedFlat` 0..1 (bed flattens away), `zzz` bool (crayon Zzz boiling up).
- `CAST.hand(ctx, x, y, t, o)` — cut-out human hand arriving from an edge; (x, y) = fingertip.
  `from` `right | left | top | bottom`, `pose` `point | press | pinch | hold | drop | open`,
  `press` 0..1 (finger push), `mitten` bool, `sleeve` colour.
- `CAST.visitor(ctx, x, y, t, o)` — googly-eyed stick-figure gallery visitor; `pose`
  `walk | stop | clap | ooh`, `poseT`, `color` (shirt), `flip`.

### js/props/day.js — `window.PROPS` additions (owner: props-day) — s1, s2, s3 + generic
`terminalCard` (black paper, rough cream border, green crayon `> _`, blinking cursor, optional
scribble lines), `stickyNote` (`color`, `text`, `curl`), `napkin` (scalloped, lightbulb doodle with
`doodle` 0..1 draw-on, "big idea!"), `coffeeRing`, `pencilQuestion` (giant pencil "?" with `p`
0..1 draw-on), `consoleWindow` (torn-edge kraft window ~1500x820, terracotta border, cream screen,
washi corners, "Session Manager" plaque; `tabs` [{label, active, lift, icon}] + `tabsReveal`,
`sidebar` [labels] + `sidebarReveal`; returns tab/sidebar/content anchors), `folderTab`,
`chatTermCard` (index card on a terracotta yarn strand; `flip` 0..1 → cream "Chat" bubble with
bouncing dots ↔ black "Terminal" panel with blinking `> _`; only one face at a time via scaleX),
`clayButton` (`label`, `press` 0..1, `color`), `cardBox` (`label`, `lidOpen` 0..1), `stickerSheet`
(`labels`, `peeled` index, `peel` 0..1), `sticker`, `dashedSlot` (`label`), `envelope` (`open`,
`stamp` 0..1 + stamp text), `stampMark` (rubber-stamp ink: `text`, `color`, `p` 0..1 thunk),
`door` (`label` "Session", `open` 0..1, `glow` 0..1 crayon light beam from the crack),
`indexCard` (`w`, `h`, `lines`, `checkboxes`, `color`, `torn`), `speedLines`, `doodlePuff` (`p`).

### js/props/night.js (owner: props-night) — s4, s5
`nightBlind` (navy sheet dropping from the top, `drop` 0..1, pinprick stars twinkling; full
frame), `moonOnThread` (butter crescent on a thread with washi at the top, `swing`, `drop`),
`paperSun` (round torn butter disc, optional cute face, NO rays, `rise` 0..1 with outBack),
`conveyor` (paper belt "Scheduler", hatched roller circles, `offset` for motion), `slotBoxes`
(`n`=5, label "Slots", returns slot centres), `gauge` ("Window used", `value` 0..1, red crayon tick
at 90%), `hangingSign` (`text` "paused", `flip` 0..1), `laptop` (always OPEN, honey desk-lamp cone,
steaming mug, string tag "app open = laptop stays awake"), `alarmClock` (wind-up, `ring` 0..1
wiggle, tag "reset"), `teacup`, `doneStack` (`n`, `stamped` 0..n progressive "DONE" stamps),
`tally` ("Done today", `count`, `p` draw-on).

### js/props/show.js (owner: props-show) — s6, s7, s8, s9
`fileTree` ("File Explorer", brown crayon trunk + branches with `grow` 0..1 draw-on, leaves =
manila folder tabs + dog-eared files, one leaf with terracotta "M" sticker; returns leaf centres),
`notebookPage` (`unfold` 0..1 accordion, sticky-note file tabs, `strike` 0..1 / `rewrite` 0..1,
`saved` 0..1 postage stamp "All changes saved"), `paperAirplane` (`fold` 0..1 from page to plane,
stamp "Send to chat"), `dottedTrail` (`pts`, `p`), `corkboard` ("Memory", tab "Workspace"),
`memoryCard` (`text`, `color`, `stale` bool → faded + coffee ring + dog-ear, `lift` 0..1 flap),
`thumbtack`, `yarn` (`from`, `to`, `twang` 0..1), `clipBundle` (tag "Clusters"), `crumple`
(`p` 0..1 card → creased ball), `basket` (wicker), `posterPage` (cream page; `scraps` 0..1 collage
fly-in of README scrap, folder-tree doodle, crayon command strip; `headings` 0..1 lettering "What it
is / Who it's for / How to run it"; tag "one page, written from real code"; `frame` 0..1 kraft frame
snap), `house` (`color`), `signpost` ("bilko.run/projects" + pennant "Host on Bilko.run", `flutter`),
`galleryWall` ("Showcase", framed posters "garden-app", "recipe-bot", "Session Manager"),
`heartPop` (`p`), `luggageTag` (`text`, `sub`, `swing`), `tapeTyper` (black paper tape typing cream
mono `text` with `reveal` 0..1 + blinking caret), `washiLabel` (`text`, `color`).

## 6. Scenes (phase B) — engine contract (owner of the contract: pipeline)

Each `js/scenes/<id>.js` calls `PROMO.scene('<id>', { draw(ctx, t, dur, info), sfx(dur, info) })`.
`t` is scene-local seconds (already quantized to 15 fps), `dur` the scene length. The engine
draws the camera nudge, transitions and captions. `info` provides:
`start` (global start), `voStart` (local time narration begins), `words` [{word,start,end}],
`wordAt(word, fallback, nth)` → local time a word is spoken (sync visuals to narration with this!),
`mood`, `cameos` [{id, text, start, duration}] + `cameoAt(id, fallback)`, `beat` (seconds per
beat) and `nextBeat(localT)` → local time of the next musical beat ≥ localT.
`sfx(dur, info)` returns `[{ t, type, gain?, pitch?, pan?, dur? }]` with `type` from
`AUDIO.SFX_TYPES` (audio.js). Transitions between scenes are the engine's job (kinds: `wipe`,
`drop`, `tape`, `pan`, `tilt`, `none`); during `pan`/`tilt` the engine also draws the neighbouring
scene at t < 0 or t > dur, so **draw() must render sensibly for t slightly outside [0, dur]**
(clamp your internal timeline).

Scene ids and target lengths (VO drives the real lengths — use `info.wordAt`, never hard-code):
`s1-desk-chaos` 5.5 s · `s2-one-console` 7 · `s3-agents` 6 · `s4-night-scheduler` 7 ·
`s5-sunrise-done` 5 · `s6-files` 5.5 · `s7-memory` 5 · `s8-showcase` 7 · `s9-endcard` 6.

## 7. Voice cast (user asked for "cute characters and good voice tones")

Kokoro-82M via `tts/kokoro_say.py` (run with `uv run`), then ffmpeg for pitch.
- **Narrator** — `af_heart` @ 1.0 (warm, smiling). Every scene's narration except the s1 hook.
- **s1 hook "Twelve terminals. Forty sticky notes. What was I doing again?"** — the frazzled dev,
  `af_jessica` @ 1.1.
- **Cameos** (short, cute, never captioned, never overlapping a narration word): pitched offline
  with ffmpeg rubberband.
  - Pip (the mascot's only words): `am_puck` @ 1.08, `rubberband=pitch=1.18:formant=preserved`
    (a smaller, natural voice). e.g. "Ta-da!" on the s2 glue thwack, "Yay!" on the s9 bow.
  - Helper bots "Check!" x3 (s5, as they finish their cards on the alarm): **as built** `af_aoede`,
    `am_adam`, `bf_emma` @ 1.0 (clearer than af_nova/am_echo/bf_lily in the ASR intelligibility check),
    `rubberband=pitch=1.26:formant=shifted` (cartoon).
  - Visitors "Ooh!" (s8, push-pin moment): `af_bella` + `am_michael` @ 1.0,
    `rubberband=pitch=1.12:formant=preserved`, slightly offset, mixed quieter.
  Pre-auditioned samples: `/tmp/claude-1000/-home-bilko-Projects-session-manager/7cdd85eb-4a77-4742-9a96-1a01f2acfd87/scratchpad/voice-casting/`.
  Place cameos in narration gaps or after the scene's narration (extend the scene tail if needed;
  keep the total ≤ 60 s).

## 8. Music + SFX moods (owner: audio)

Per scene `mood` (script.json → timeline → `plan.moods`): s1 `chaos`, s2 `full`, s3 `full`,
s4 `night`, s5 `sunrise`, s6 `full`, s7 `full`, s8 `build`, s9 `finale`. Direction: `final.musicDirection`
(104 BPM F major kitchen-table orchestra; ukulele Karplus-Strong, glock, toy piano, pizzicato,
woodblock, claps, kazoo & slide-whistle accents; lullaby at night; sunrise glissando; snare-roll
build to the push-pin hit; button ending ~1 s before the end). Narration ducks music ~10 dB;
cameos do NOT duck the music. VO plan items: `{ start, buffer, kind: 'narration' | 'cameo', gain?, pan? }`.

## 9. Tools

- `node dev/sheet.mjs <name> [--full] [--cols N --width PX]` — renders `dev/<name>.js`
  (`window.SHEET = { times: [...], draw(ctx, t) }`, with kit + mascot + all props loaded) to
  `out/preview/dev-<name>.png`, printing per-frame draw ms. **Look at the PNG with the Read tool**
  and critique it like an art director; iterate until it is genuinely good.
- `node preview.mjs --scene <id> --n 8 --cc 0` → `out/preview/<id>.png`; `--times a,b --full` full
  frames; `--timeline`; `--audio-stats`.
- `node build-timeline.mjs [--no-tts|--force-tts]` → VO + `timeline.json` + index.html scene tags.
- `node render.mjs [--from a --to b] [--out out/x.mp4]` → MP4 (≈2.5 fps on 8 workers).

## 10. Phase-A results

`script/API.md` holds the delivered APIs (PIP/CAST, all PROPS, engine `info` fields incl. `camShift` for parallax, transitions, 77 SFX types, moods) and the **final timeline** (total 56.99 s). It is authoritative for exact names and times.

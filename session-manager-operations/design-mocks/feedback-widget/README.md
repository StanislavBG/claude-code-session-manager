# Handoff: Embeddable Feedback Widget (`feedback.js`)

## Overview
A website adds one `<script>` tag. That injects a floating feedback widget over the site. When it's closed, only a small launcher is visible. When a visitor clicks the launcher (or presses **Shift+F**):

1. The visible viewport is captured as a screenshot.
2. The visitor marks it up with numbered pins, a picked page element, boxes, arrows, freehand lines and text labels.
3. The visitor writes a **title** and **details** and picks a type: Bug / Feature request / Other.
4. The visitor reviews the context attached automatically: page URL, console errors, failed network requests, and their identity (passed in by the host site).
5. The report is POSTed to **our existing server**.

The widget **floats over the host page**. It never pushes, shrinks, reflows or restyles the host page, and it never adds a full-width bar. Desktop only.

## About the design files
The files in this folder are **design references made in HTML**: working prototypes that show the intended look and behaviour. They are **not production code to copy**. The task is to build this widget as a standalone embeddable bundle:

- vanilla TypeScript, or Preact/Lit compiled to one IIFE file
- rendered inside a **Shadow DOM**
- no dependency on any host framework

The prototype runtime (`support.js`, `.dc.html`) is only there so the references open in a browser. Do not ship it.

The "lumen" travel site in the prototype is a **stand-in host page**. Ignore its styling.

## Fidelity
**High-fidelity.** Colours, type, spacing, radii, shadows, motion and copy are final. Recreate them exactly; every value is listed below. The prototype's demo data (console errors, the failed request, "Maya Chen", ticket `FB-2048`) is fake and must come from real sources.

## Variants: build the defaults first
The prototype carries four variant axes so product can compare. Build the **defaults** first. The other variants are fully specified below; ship them only as config options if product asks.

| Axis | Default | Other options |
|---|---|---|
| `launcher` | `corner`: bubble, bottom-right | `edge` tab · `mini` pill, bottom-left · `hidden`: shortcut only + one-time hint |
| `flow` | `annotate`: mark up → describe in a corner card | `docked`: floating side panel from the start · `note`: note anchored beside the first mark |
| `toolbar` | `dock`: floating, top-centre | `rail`: vertical, left · `corner`: bottom-right, where the launcher was |
| `success` | `receipt`: panel turns into a receipt | `toast` with 6-second Undo · `fold`: panel shrinks into the launcher |

---

## 1. Embedding & config

```html
<script>
  // optional; must run before the widget tag, or call Feedback.identify() later
  window.FeedbackConfig = {
    project: 'lumen',                                  // required (or data-project)
    endpoint: 'https://feedback.yourapp.com/v1/reports', // your existing server
    user: { id: 'u_8841', name: 'Maya Chen', email: 'maya@lumenstays.com' }, // optional
    hotkey: 'shift+f',            // default
    launcher: 'corner',           // corner | edge | mini | hidden
    flow: 'annotate',             // annotate | docked | note
    toolbar: 'dock',              // dock | rail | corner
    success: 'receipt',           // receipt | toast | fold
    minViewportWidth: 640         // below this, or on touch-only devices, the widget does not render
  };
</script>
<script src="https://cdn.yourapp.com/feedback.js" data-project="lumen" async></script>
```

**Minimal public API (recommended):** `window.Feedback.open()`, `window.Feedback.close()`, `window.Feedback.identify(user | null)`. The last one is for SPAs where login happens after the page loads.

### Mounting & isolation
- Append one host element to `document.body`: `<div id="feedback-widget-host">`.
  - Style: `position:fixed; inset:0; z-index:2147483000; pointer-events:none;`
  - Attach `attachShadow({mode:'open'})`.
  - Inside the shadow root, put `:host{all:initial}` and a local reset. Interactive children set `pointer-events:auto`.
- Watch with a `MutationObserver`: if the host app removes or reorders the host element, re-append it as the last child of `body`.
- **Fonts:** `@font-face` does not work inside shadow roots in Chromium. Inject the Google Fonts `<link>` (or self-hosted `@font-face`) into `document.head` once:
  - Source Serif 4 600
  - Inter Tight 400/500/600/700
  - JetBrains Mono 400/500/700
  - Always include system fallbacks.
- Never modify host styles, including `html`/`body` `overflow`.

### Screenshot capture
- On open, capture **before** any widget UI is visible. Hide the launcher during capture.
- Capture area: the viewport (`innerWidth × innerHeight` at the current scroll position).
- Scale: `min(devicePixelRatio, 2)`.
- Use a DOM rasteriser such as `modern-screenshot` or `html-to-image`. Do not use `getDisplayMedia`; it shows a permission prompt.
- **Mask by default:** `input[type=password]` and any element with `[data-feedback-mask]` are painted as solid `#1a1612` boxes in the image.
- Cross-origin images without CORS may render blank. That is acceptable; don't fail the capture.
- While the widget is open, show the captured image **as a full-viewport backdrop** under the marks layer. What the user annotates is then exactly what is sent, even if the page animates.
  - The element picker still hit-tests the live DOM underneath (see §5).
- Block page interaction while open: the capture surface swallows pointer events and calls `preventDefault()` on `wheel`/`touchmove`.
- Flatten marks into a second PNG (`annotated`) on a canvas at send time, using the same geometry as the on-screen rendering.

### Console & network buffering (installed when the script executes)
**Console** — capture `console.error` (wrap it; still call the original), the window `error` event, and the `unhandledrejection` event.
- Ring buffer of 20 entries.
- Entry fields: `{level:'error', message ≤500, stack ≤2000, source 'file:line:col', timestamp, count}`.
- Consecutive identical messages increment `count` instead of adding a new entry.

**Network** — wrap `fetch` and `XMLHttpRequest`.
- Record only failures: HTTP status ≥ 400, network error, or timeout. Aborts are ignored.
- Ring buffer of 20 entries.
- Entry fields: `{method, url, status, durationMs, timestamp}`.
- In the URL, replace query parameter **values** with `…`.
- Never record headers or bodies.
- Exclude the widget's own requests.

### Submission
- `POST {endpoint}` as `multipart/form-data` with three parts:
  - `report`: `application/json`, matching `report.schema.json`; see `report.example.json`
  - `screenshot`: `image/png`, raw
  - `annotated`: `image/png`, marks drawn in
- Header: `X-Feedback-Project: {project}`.
- Use **XHR** so upload progress can drive the progress bar.
- Timeout: 20 s.
- Expected success: any `2xx`, ideally with JSON `{ "id": "FB-2048" }`. The id is shown in the receipt, toast and ping. If no id comes back, hide the id text.

**Failure handling:**
- Network error, timeout or `5xx`:
  - Show the error state.
  - Store the whole report (JSON + both PNG Blobs) in IndexedDB `feedback-outbox`.
  - Retry automatically on the next page load and on the `online` event. Backoff: 5 s, 30 s, 2 min, 10 min, 1 h; give up after 5 tries.
  - `clientReportId` stays the same across retries so the server can de-duplicate.
- `4xx` (except 408/429): show the error state, but body copy = "The feedback server didn't accept this report." No auto-retry.
- **Toast variant only:** delay the actual POST by **6 s** so **Undo** can cancel it locally. Receipt and fold variants POST immediately.

---

## 2. State machine

`mode ∈ idle | annotate | review | sending | sent | error`

Overlay flags: `confirm` (discard dialog), `folding`, `toast`, `ping`, `popover` (mark id), `textEdit`, `drawing`, `hover` (element-pick target).

| From | Trigger | To / effect |
|---|---|---|
| idle | launcher click · Shift+F (not while typing in the host page) | capture → `annotate`; flash white .9→0 over 500 ms ease-out; tool = Pin; marks/draft reset; toolbar position reset |
| annotate | **Describe** button · Enter (flow `annotate` only) | `review`; focus Title after 420 ms |
| review | **← Marks** · Esc | `annotate` (draft kept) |
| annotate / review / error | close × · Esc with nothing else open | if marks or text exist → `confirm`; else → `idle` |
| confirm | **Keep editing** · Esc | dialog closes |
| confirm | **Discard** | `idle` (everything reset) |
| any state with the panel visible | **Send** · ⌘/Ctrl+Enter | title trimmed length < 3 → show the title error and focus Title; else → `sending` |
| sending | 2xx | `receipt` → `sent`. `toast` → `idle` + toast (6 s). `fold` → `folding` (480 ms) → `idle` + `ping` (3.6 s) |
| sending | failure | `error`; Send label becomes **Retry now** |
| sent | **Done** · Esc | `idle` |
| sent | **Send another** | `idle` → open again (new capture) |
| toast | **Undo** | `review` (flow annotate) or `annotate` (other flows), draft intact |

**Visibility rules:**
- **Panel**
  - flow `annotate`: in `review`, `sending`, `error`, `sent`
  - flow `docked`: from open onward
  - flow `note`: once at least one mark exists, plus `sending`, `error`, `sent`
- **Toolbar** and **hint chip:** only in `annotate` (the hint is also hidden while `confirm` is open)
- **Capture frame:** whenever the widget is open, except in `sent` and `folding`
- **Launcher:** only in `idle` (and during `folding`, as the fold target)
- **Marks:** whenever the widget is open

## 3. Keyboard

| Key | Context | Action |
|---|---|---|
| Shift+F | idle; focus **not** in `input`/`textarea`/`select`/contenteditable; no Ctrl/Meta/Alt | open |
| Esc | open | closes the first one that applies: discard dialog → text-label input → mark popover → (flow annotate, `review`) back to markup → close request |
| P / E / R / A / D / T | annotate, not typing | Pin / Element / Box / Arrow / Draw / Text |
| ⌘Z / Ctrl+Z | annotate, not typing | undo last mark |
| Enter | annotate, flow annotate, not typing | Describe |
| ⌘/Ctrl+Enter | panel visible (even while typing) | Send |
| Enter / Shift+Enter | mark popover textarea | save & close / newline |
| Enter · blur / Esc | text-label input | commit / cancel |

Show `⌘↵` on macOS and `Ctrl↵` elsewhere.

## 4. Focus & accessibility
- **On open:** focus the active tool button. Trap Tab focus inside the widget while it's open (toolbar → popover → panel).
- **After creating a numbered mark:** focus the popover textarea (40 ms delay).
- **Flow `note`, first mark:** focus Title (380 ms delay).
- **On close:** restore focus to whatever had it before opening.
- **ARIA:**
  - Tool buttons: `aria-pressed`, `aria-label` = tool name; the tooltip shows on hover and on focus.
  - Switches: `role="switch"` + `aria-checked`.
  - Discard dialog: `role="dialog" aria-modal="true"`.
  - Launcher: `aria-label="Send feedback (Shift+F)"`.
- **`prefers-reduced-motion`:** drop all translate/scale motion, cap fades at 150 ms, flash at .3 opacity.
- Drawing tools are pointer-only. A keyboard-only user can still submit (marks are optional).

---

## 5. Components (exact specs)
All coordinates are viewport CSS px. W×H = viewport size. Every layer is `position:fixed` inside the shadow root.

**Z-order inside the shadow root:**
`backdrop/screenshot 4` · `frame 5` · `capture surface 6` · `marks 7` · `pick highlight 8` · `text input 9` · `hint 20` · `toolbar 25` · `panel 30` · `popover 35` · `launcher / coach 40` · `toast / ping 41` · `dialog 60` · `flash 70`.

### 5.1 Launcher
**Corner (default)**
- Position: right 24, bottom 24.
- Size: h 52, min-w 52, padding 0 15, radius 26.
- Colours: bg `#1a1612`, fg `#f5f0e6`.
- Shadow: `0 14px 34px -10px rgba(26,22,18,.65), inset 0 0 0 1px rgba(245,240,230,.08)`.
- Icon: 22 px chat bubble (§8).
- Hover: a label slot opens — `max-width` 0→150 px over 350 ms `cubic-bezier(.2,.8,.2,1)`, opacity 0→1 over 200 ms. Contents:
  - "Feedback": Inter Tight 600 14 px, padding-left 10.
  - Key chip "⇧F": JetBrains Mono 500 11 px, padding 2/6, radius 5, bg `rgba(245,240,230,.12)`, colour `#f4b942`, gap 8.

**Edge**
- Position: right −6, top 50% (`translateY(-50%)`); hover → `translateX(-6px)` over 250 ms.
- Size: w 46, padding 14/6/14/0, radius `10px 0 0 10px`. Column layout, gap 10.
- Contents:
  - Icon 18 px.
  - "Feedback" set vertically: `writing-mode:vertical-rl; transform:rotate(180deg)`, 600 13 px, letter-spacing .02em.
  - "⇧F": mono 500 10 px `#f4b942`, opacity 0→1 on hover.
- Shadow: `-10px 10px 30px -12px rgba(26,22,18,.6)`.

**Mini**
- Position: left 20, bottom 20.
- Size: h 38, min-w 38, padding 0 9, radius 19.
- Colours: border 1 px `#d4ccb8`, bg `#f5f0e6`, fg `#1a1612`.
- Shadow: `0 8px 22px -10px rgba(26,22,18,.45)`.
- Icon 18 px.
- Hover label: "Feedback" 600 13 px + chip "⇧F" (mono 500 10.5, padding 2/5, radius 4, bg `#e3dcc8`, colour `#5d5648`).

**Hidden**
- No launcher.
- Coach toast once per browser (localStorage `fw:coachSeen`).
- Position: right 20, bottom 20.
- Style: bg `#1a1612`, fg `#f5f0e6`, radius 12, padding 10/10/10/16, gap 14, shadow `0 14px 34px -12px rgba(26,22,18,.6)`.
- Copy: "Spotted a problem? Press [⇧] [F] to send feedback" (500 13.5 px).
- Key caps: min-w 22, h 22, radius 5, bg `#f5f0e6`, colour `#1a1612`, mono 600 11, `box-shadow: inset 0 -2px 0 #c9bfa9`.
- **Got it** button: h 30, padding 0 12, radius 8, bg `rgba(245,240,230,.12)` (hover .2), 600 12.5.
- Auto-hides after 9 s.

**Ping (after fold success)**
- Launcher bg becomes `#2e5a3e` and the icon becomes a check (stroke 2.2) for 3.6 s.
- Mini variant: bg `#2e5a3e`, fg `#f5f0e6`.

### 5.2 Capture feedback
- **Flash:** full-viewport `#ffffff`, opacity .9 → 0, 500 ms ease-out.
- **Frame:** full-viewport, `pointer-events:none`, `box-shadow: inset 0 0 0 3px #a83818`.
- **Hint chip**
  - Position: centred on the free area (§5.3), `translateX(-50%)`. top 80 for the dock toolbar; top 16 for rail/corner.
  - Pill: radius 999, bg `#1a1612`, padding 7/8/7/12, gap 10, shadow `0 10px 24px -10px rgba(26,22,18,.6)`, `pointer-events:none`.
  - Content, left to right:
    - Dot: 7 px `#a83818` with ring `0 0 0 2px rgba(244,185,66,.55)`.
    - "SCREENSHOT": mono 500 10.5 px, .08em, uppercase, `#f4b942`.
    - Tool hint: 500 12.5 px `#f5f0e6`.
    - "Esc" chip: mono 10.5, padding 2/6, radius 5, bg `rgba(245,240,230,.12)`, `#c9bfa9`.
  - Tool hint copy:
    - Pin: "Click anywhere to drop a numbered pin"
    - Element: "Hover an element, click to select it"
    - Box: "Drag to box an area"
    - Arrow: "Drag to point at something"
    - Draw: "Draw freely"
    - Text: "Click to place a text label"
    - Flow `note` with no marks yet: "Mark the spot first — your note opens beside it"

### 5.3 Toolbar (floating, ink)
**Container:** bg `#1a1612`, radius 14, padding 6, gap 3. Shadow `0 18px 40px -14px rgba(26,22,18,.7), inset 0 0 0 1px rgba(245,240,230,.07)`.

**Order:** drag grip · Pin · Element · Box · Arrow · Draw · Text · divider · 4 swatches · divider · Undo · [Describe — flow annotate only] · Close.

**Grip**
- 18×40 (row) / 40×18 (column).
- Six dots r 1.4 `#9c937f` in a 10×16 box, rotated 90° in the column layout.
- `cursor:grab`.
- Dragging moves the toolbar freely (pointer capture). Its position resets on every open and when the panel swaps sides.

**Tool button**
- 40×40, radius 9; icon 20 px, stroke 1.8, round caps and joins.
- Inactive: transparent background, icon `#e3dcc8`. Active: bg `#f4b942`, icon `#1a1612`. 150 ms transition.
- **Tooltip** (hover/focus):
  - bg `#f5f0e6`, text `#1a1612` 600 12 px, padding 5/8, radius 7, shadow `0 6px 16px -6px rgba(26,22,18,.5)`.
  - Key chip: mono 500 10.5, padding 1/5, radius 4, bg `#e3dcc8`, `#5d5648`.
  - Placement: dock → below (top 50); corner → above; rail → right (left 50).

**Divider:** 1×24 (row) or 24×1 (column), `rgba(245,240,230,.16)`, margin 0/5 or 5/0.

**Swatches**
- Hit area 24×40 (row) or 40×24 (column); dot 16 px.
- Unselected ring: `0 0 0 1.5px rgba(245,240,230,.4)`. Selected: `0 0 0 2px #1a1612, 0 0 0 4px #f4b942`.
- Colours: **Rust `#a83818` (default)**, Amber `#f4b942`, Green `#2e5a3e`, Ink `#1a1612`.

**Undo:** 40×40, icon `#e3dcc8`, hover bg `rgba(245,240,230,.1)`, title "Undo (⌘Z)".

**Describe**
- Row layouts: h 40, margin-left 4, padding 0/10/0/14, radius 9, bg `#f4b942` (hover `#f7c766`), text `#1a1612` 700 13.5 "Describe", plus "↵" chip (mono 500 11, padding 2/6, radius 4, bg `rgba(26,22,18,.12)`).
- Rail layout: a 40×40 amber square with a → icon.

**Close:** 40×40, icon 18 `#c9bfa9`, hover bg `rgba(245,240,230,.1)`.

**Placement**
- **Free area** = the whole viewport, except in flow `docked`, where it excludes the panel column: panel right → x ∈ [0, W−412]; panel left → x ∈ [412, W].
- **dock:** top 16, centred in the free area. Hidden state: `translateY(-12px)`, opacity 0.
- **rail:** left = freeArea.x0 + 20, vertically centred, column layout. Hidden: `translateX(-12px)`.
- **corner:** right edge at freeArea.x1 − 20, bottom 20. Hidden: `translateY(12px)`.
- Transitions: opacity 250 ms, transform 350 ms `cubic-bezier(.2,.8,.2,1)`, visibility 350 ms.

### 5.4 Marks
Stored in viewport CSS px at capture time.

**Numbering:** pins, boxes and elements are numbered 1…n in creation order and renumbered on delete. Arrows, drawings and text are not numbered.

**Text colour on a mark colour:** `#fff8ef` on rust; `#1a1612` on amber; `#f5f0e6` on green or ink.

**Pin**
- The click point is the pin's tip, at its bottom-left corner.
- Box 28×28 with top-left at (x, y−28); radius `14px 14px 14px 3px`; border 2 px `#fff`; fill = mark colour.
- Number: JetBrains Mono 700 12/24, centred.
- Shadow `0 2px 6px rgba(26,22,18,.35)`.
- Clicking a pin re-opens its comment popover.

**Box**
- Drag to draw; commit only if ≥ 8×8.
- Border 2.5 px solid, radius 5, fill `rgba(color,.10)`, halo `0 0 0 1px rgba(255,255,255,.75)`.
- Number badge: 24 px circle at (x−12, y−12), border 2 px `#fff`, mono 700 11.

**Element**
- Same as Box, but dashed border, and the rect = the element's `getBoundingClientRect()`.
- Selector chip above the top-left corner: left x+16, bottom edge at y−5, padding 3/7, radius 5, mono 500 11, bg = mark colour.

**Element-pick hover**
- Outline 2 px `#a83818`, fill `rgba(168,56,24,.08)`, radius 3.
- Label chip above the element (below it if the element's top < 34): bg `#1a1612`, mono 500 11.5, padding 4/8, radius 5.
- Label contents: `selector` in `#f4b942` · `W×H` in `#c9bfa9` · "click to select" in `#f5f0e6`.

**Arrow**
- Drag to draw; commit only if length ≥ 14.
- Shaft stroke 4 px, round cap.
- Head: filled triangle, length `min(18, 0.45·L)`, half-width 0.62 × head length.
- White underlay for legibility: stroke 8 px, `rgba(255,255,255,.85)`.

**Draw**
- Sample a point when the pointer has moved > 2.5 px; smooth with quadratic midpoints.
- Stroke 4 px round, plus the same 8 px white underlay. Commit only with ≥ 3 points.

**Text**
- Click to place an input: 240 px wide, 2 px dashed border in the mark colour, white bg, 600 15 px.
- Enter or blur commits; Esc cancels; empty text is discarded.
- Rendered chip: padding 4/10, radius 7, bg = mark colour, 600 15/1.35, max-width 300, shadow `0 0 0 2px #fff, 0 3px 8px rgba(26,22,18,.3)`; chip top = y−15.

**Highlight:** while a mark's row in the panel is hovered, or its popover is open, its numbered badge gets the ring `0 0 0 4px rgba(244,185,66,.75), 0 2px 6px rgba(26,22,18,.35)`.

**Element selector** (used for the `element.selector` field)
1. `#id`, if it's unique and not auto-generated (no 4+ digit runs).
2. Otherwise `[data-testid|data-test|data-cy="…"]`.
3. Otherwise build `tag.class1.class2:nth-of-type(k)`, walking up at most 4 ancestors until `document.querySelectorAll(sel).length === 1`. Skip hashed classes (e.g. `css-1x2y3z`, `sc-…`, any class containing 5+ consecutive alphanumerics mixed with digits).

Also record `tag, id, classes, text (≤80, trimmed), role, ariaLabel, xpath`. The UI label is `tag.firstClass`.

Skip the widget host, `html` and `body`. Elements smaller than 4×4 are ignored.

### 5.5 Mark comment popover
- **Opens:** after creating a pin, box or element (except the first mark in flow `note`), or when a numbered badge is clicked.
- **Container:** width 272, bg `#f5f0e6`, border 1 px `#d4ccb8`, radius 12, shadow `0 18px 44px -14px rgba(26,22,18,.55)`.
- **Position:**
  - left = bbox.right + 12; if that passes W−12, use bbox.left − 284 instead. Then left = max(12, left).
  - top = clamp(bbox.top − 4, 12, H − 180).
- **Header:** badge 22 · label (mono 500 11 `#5d5648`: "Pin 2" / `button.book` / "Box 3") · **Delete** (600 12 `#a83818`, h 24, padding 0/8, hover bg `#ede6d6`).
- **Textarea**
  - 2 rows, margin 8/12/0, padding 8/10, border 1 px `#d4ccb8`, radius 8, bg `#fcfaf5`, 400 14/1.45, `resize:none`, autofocus, max 1000 characters.
  - Placeholders: Pin "What's wrong here?" · Element "What about this element?" · Box "What's going on in this area?".
- **Footer:** "↵ save · esc close" (mono 10.5 `#9c937f`) + **Save** (h 28, padding 0/12, radius 7, bg `#1a1612`, `#f5f0e6` 600 12.5).
- Clicking the capture surface while the popover is open only closes it; it does not create a mark.

### 5.6 Panel
**Container:** bg `#f5f0e6`, border 1 px `#d4ccb8`, radius 14, shadow `0 1px 0 rgba(42,36,28,.05), 0 24px 60px -18px rgba(26,22,18,.5)`. Column flex, `overflow:hidden`; the body scrolls.

**Geometry**
- **annotate — corner card**
  - Position: right 20 (left 20 when launcher = mini), bottom 20.
  - Size: width 380, height auto, max-height H−40.
  - Enter: from `translateY(16px) scale(.98)` and opacity 0. Origin: right bottom (left bottom for mini).
- **docked — side panel**
  - Position: top 16, bottom 16, right 16 (or left 16 after swapping). Width 380.
  - Enter: from `translateX(±24px)`.
- **note — anchored note**
  - Width 340.
  - left = anchor.right + 18, or anchor.left − 358 if that overflows; clamp to [16, W−356].
  - With cy = anchor centre: if cy ≤ H/2, top = max(16, cy − 170). Otherwise bottom = max(16, H − cy − 170), so the note grows upward and never runs off the bottom.
  - Max-height H−32. Enter: `translateY(8px) scale(.97)`.
- Transitions: opacity 280 ms, transform 400 ms `cubic-bezier(.2,.8,.2,1)`, visibility 400 ms, left/top 400 ms.
- **Progress bar:** top-left, h 3, `#a83818`, width = upload %; visible only while `sending`.

**Header** (padding 16/12/14/20, bottom border 1 px `#d4ccb8`, gap 6)
- **Eyebrow:** mono 500 10.5/1.3, .1em, uppercase, `#a83818`, one line with ellipsis.
  - annotate: "Step 2 of 2 · Describe"
  - docked: "Feedback · {hostname}"
  - note: "Note on mark 1 · {selector}" — or "Your note" if the first mark isn't numbered
- **Headline:** Source Serif 4 600 22/1.2 `#1a1612`.
  - annotate: "Describe what you marked"
  - docked: "What's going on?"
  - note: no headline
- **← Marks** (flow annotate, in `review` and `error`): h 30, padding 0/10, radius 7, border 1 px `#d4ccb8`, 600 12.5 `#3a342b`, hover `#ede6d6`.
- **Swap side** (docked, not while sending): 30×30, ⇄ icon 17 `#5d5648`, hover `#e3dcc8`, title "Move panel to the other side".
- **Close:** 30×30, icon 16 `#5d5648`.

**Body** (padding 16/20/18, gap 16)
- **Section labels:** mono 500 10.5, .08em, uppercase, `#5d5648`.
- **Error banner** (`error` mode)
  - padding 12, radius 9, bg `rgba(168,56,24,.08)`, border 1 px `rgba(168,56,24,.35)`.
  - "!" in a 22 px `#a83818` circle.
  - Title 600 14: "Couldn't reach the feedback server".
  - Body 400 13/1.45 `#3a342b`: "Nothing is lost — this report is saved in your browser and will retry on its own."
- **Type** — segmented control
  - Track: padding 3, bg `#ede6d6`, border 1 px `#d4ccb8`, radius 10, gap 3.
  - Segments: padding 7/6, radius 7, 600 13. Selected: `#1a1612` bg / `#f5f0e6` text. Unselected: transparent / `#3a342b`.
  - Each segment has a 7 px dot: Bug `#a83818` · Feature request `#f4b942` · Other `#9c937f`.
  - Default: Bug.
- **Title**
  - Input: padding 10/12, radius 8, border 1 px `#d4ccb8`, bg `#fcfaf5`, 500 15. Focus: border `#1a1612` + ring `0 0 0 3px rgba(244,185,66,.45)`.
  - Placeholders: Bug "e.g. Book button does nothing" · Feature "e.g. Let me save a stay for later" · Other "One-line summary".
  - Rules: required, trimmed length 3–120.
  - Error (500 12.5 `#a83818`): "Add a short title so the team can find this."
- **Details**
  - Textarea: 4 rows (3 in flow `note`), same styling, 400 14/1.5, `resize:vertical`, max 5000 characters.
  - "optional" (mono 11 `#9c937f`) right-aligned in the label row.
  - Placeholders: Bug "What did you do, what happened, and what did you expect?" · Feature "What are you trying to do, and what would make it easier?" · Other "Anything else we should know?"
- **Marks on screenshot** (flows annotate & docked)
  - Count on the right (mono 11 `#9c937f`): "3 marks" / "none yet".
  - Empty state: dashed 1 px `#c9bfa9` box, radius 8, padding 10/12, 13/1.5 `#5d5648`: "No marks yet. Point at what you mean with the toolbar — or skip it."
  - Row: grid `24px 1fr 26px`, gap 10, padding 8, margin 0/−8, radius 9. Hover: bg `#e3dcc8`, and the mark is highlighted on the page.
  - Row contents: badge · kind label (mono 500 11 `#5d5648`: "Pin" / "Box" / "Element · button.book") · borderless note input (14 px, placeholder "Add a note (optional)") · remove × (26×26, icon 14 `#9c937f`, hover bg `#e3dcc8`).
  - Unnumbered marks get one line below the rows (mono 11.5 `#5d5648`, indent 34): e.g. "+ 1 drawing · 1 arrow · 1 label".
- **Attached automatically** (flows annotate & docked)
  - Rows: grid `78px 1fr auto`, gap 10, padding 9/0, top border 1 px dashed `#d4ccb8`.
  - **Screenshot:** "{W} × {H} · {n} marks", right side "ALWAYS" (mono 10 `#9c937f`).
  - **Page:** URL in mono 12, "ALWAYS".
  - **Console:** "2 console errors" + **view/hide** link (600 12 `#a83818`) + switch. Off copy: "Console errors — not sent" in `#9c937f`.
  - **Network:** "1 failed request" + view/hide + switch. Off copy: "Failed requests — not sent".
  - Expanded list: bg `#1a1612`, radius 8, padding 10/12, mono 11/1.5, gap 8; message `#f4b942` (`overflow-wrap:anywhere`), source `#c9bfa9`.
- **Compact summary** (flow note)
  - Box: border 1 px `#d4ccb8`, radius 9, bg `#ede6d6`.
  - Row (padding 10/12): mono 11.5/1.5 `#3a342b` "Screenshot + {n} marks · 2 console errors · 1 failed request", plus **Review** / **Hide** (600 12 `#a83818`).
  - Expanding shows the console and network switch rows on `#f5f0e6`.
- **Switch:** track 30×18, radius 9; on `#2e5a3e`, off `#c9bfa9`. Knob 14 px `#fcfaf5` at 2/2 with shadow `0 1px 2px rgba(26,22,18,.3)`; `translateX(12px)` when on; 200 ms.

**Footer** (padding 12/14/12/20, top border 1 px `#d4ccb8`, bg `#ede6d6`, gap 12)
- **Avatar:** 30 px circle `#1a1612` with initials in Source Serif 4 600 12 `#f5f0e6`.
- **Name:** 600 13 `#1a1612`. **Sub-line:** mono 10.5 `#5d5648` "from site login".
- **No user configured:** avatar "?", name "Anonymous", sub-line "not signed in"; `user: null` in the payload.
- **Send button**
  - h 40, padding 0/10/0/16, radius 9, bg `#a83818` (hover `#8f2f14`), text `#fff8ef` 600 14.
  - Shortcut chip "⌘↵" (mono 500 11, padding 2/6, radius 5, bg `rgba(255,248,239,.16)`).
  - Opacity .55 while the title is invalid. It stays clickable so it can trigger validation.
  - Labels: "Send feedback" → "Sending… {n}%" → "Retry now" (in `error`).
  - All inputs are disabled while sending.

### 5.7 Success variants
**Receipt** (replaces the panel contents in place)
- Top block: padding 24/22/18, gap 12, bottom border 1 px dashed `#9c937f`.
  - 28 px check circle `#2e5a3e`.
  - "RECEIVED · {id}": mono 500 11, .1em, uppercase, `#2e5a3e`.
  - Headline: Source Serif 4 600 24/1.2 "Thanks, {firstName} — it's with the team."
  - Body: 400 14/1.5 `#5d5648` "Quote {id} if you follow up. Nothing else to do."
- Rows (mono 12/1.4, dotted leader 1 px `#9c937f`, value right-aligned with ellipsis, max 62%): Type · Title · Screenshot ("1280×800 · 4 marks") · Console ("2 errors" / "not sent") · Network ("1 failed request" / "not sent") · From.
- Buttons (flex 1 each, h 40, radius 9, 600 14):
  - **Send another**: border 1 px `#d4ccb8`, hover `#ede6d6`.
  - **Done**: bg `#1a1612`, hover `#3a342b`, text `#f5f0e6`.

**Toast**
- Container: width 320, bg `#1a1612`, radius 12, shadow `0 16px 40px -12px rgba(26,22,18,.65)`.
- Row (padding 12/10/12/14, gap 12):
  - 26 px check circle `#2e5a3e`.
  - "Feedback sent" 600 14.
  - "{id} · thanks, {firstName}" mono 11 `#c9bfa9`.
  - **Undo**: 600 13 `#f4b942`, hover bg `rgba(245,240,230,.1)`.
- Countdown bar: 3 px track `rgba(245,240,230,.1)`; fill `#f4b942` shrinks from 100% to 0 linearly over 6 s; auto-dismiss at 6.2 s.
- Position (also used for the ping bubble):
  - corner launcher → right-aligned to the launcher, 14 px above it
  - edge → 14 px left of the tab, vertically centred
  - mini → left 20, 12 px above the launcher
  - hidden → bottom-right, 20 px from both edges

**Fold**
- The panel animates to `scale(.06)` + opacity 0 over 450 ms `cubic-bezier(.5,0,.75,0)`, with transform-origin at the launcher's centre.
- Then the launcher pings for 3.6 s, with a bubble beside it:
  - h 40, padding 0/14, radius 10, bg `#2e5a3e`, text `#f5f0e6` 600 13.
  - Copy: "Sent {id} — thank you", with the id in mono 11.5 `#d6e3d9`.

### 5.8 Discard dialog
- **Scrim:** `rgba(26,22,18,.38)` over the full viewport.
- **Card:** 360 px (max `calc(100% − 32px)`), padding 22/22/18, gap 8, bg `#f5f0e6`, border 1 px `#d4ccb8`, radius 14, shadow `0 24px 60px -18px rgba(26,22,18,.6)`.
- **Title:** Source Serif 4 600 20/1.25 "Discard this feedback?"
- **Body:** 14/1.5 `#5d5648` "You will lose {n} marks and what you have written." Drop the second clause if no text was entered.
- **Buttons** (h 38, padding 0/14, radius 9, 600 13.5):
  - **Keep editing**: secondary style.
  - **Discard**: bg `#a83818`, text `#fff8ef`.

---

## 6. Design tokens

| Token | Value | Use |
|---|---|---|
| ink | `#1a1612` | toolbar, dark chips, primary text |
| ink-2 | `#3a342b` | secondary text |
| ink-3 | `#5d5648` | labels |
| ink-4 | `#9c937f` | meta, placeholders |
| paper | `#f5f0e6` | panel/popover surface |
| paper-2 | `#ede6d6` | footer, segmented track |
| paper-3 | `#e3dcc8` | hovers, chips |
| field | `#fcfaf5` | input background |
| rule | `#d4ccb8` | borders |
| rule-strong | `#c9bfa9` | switch off, key-cap edge |
| accent | `#a83818` | Send, frame, eyebrow, default mark (hover `#8f2f14`) |
| amber | `#f4b942` | active tool, Describe, highlights (hover `#f7c766`) |
| green | `#2e5a3e` | success, switch on (light text `#d6e3d9`) |
| on-accent | `#fff8ef` | text on rust |

**Type**
- Headlines: Source Serif 4 600 (24 / 22 / 20).
- UI: Inter Tight (15 / 14 / 13.5 / 13 / 12.5 / 12; weights 400/500/600/700).
- Labels, IDs, keys, data: JetBrains Mono (12 / 11.5 / 11 / 10.5 / 10; weights 400/500/700).

**Radii:** 3 · 4 · 5 · 7 · 8 · 9 · 10 · 12 · 14 · 19 · 26 · 999.

**Motion:** standard ease `cubic-bezier(.2,.8,.2,1)`; fold ease-in `cubic-bezier(.5,0,.75,0)`. Durations 150 / 200 / 250 / 280 / 350 / 400 / 450 / 500 ms.

## 7. Edge cases
- **Narrow or touch-only:** if `innerWidth < minViewportWidth` or `(pointer:coarse)` with no fine pointer, don't render.
- **Shift+F in host inputs:** ignored; the F types normally.
- **Viewport resize while open:** keep the frozen screenshot at its captured size, anchored top-left, with marks still aligned. Don't re-capture.
- **SPA route change while open:** stay open. The report keeps the URL captured at open.
- **Double send:** impossible; Send and all inputs are disabled while sending.
- **Popover or note near an edge:** flip/clamp as specified. The panel body scrolls; its footer is always visible.
- **Page navigation with a failed report queued:** the outbox retries on the next load (any page with the widget).
- **Host CSP:** document that the host must allow `script-src` and `connect-src` for the CDN and the endpoint, plus `img-src data: blob:`.

## 8. Icons (24×24 viewBox; stroke currentColor 1.8, round caps/joins, no fill)
- **Pin:** `M12 21.5c-.7-2.6-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0c0 5-5.8 8.6-6.5 11.2z` + circle cx 12 cy 10.2 r 2.3
- **Element:** `M4.5 9V5.5a1 1 0 0 1 1-1H9M15 4.5h3.5a1 1 0 0 1 1 1V9M4.5 15v3.5a1 1 0 0 0 1 1H9` + `M13.2 13.2l7.3 2.5-3.1 1.4-1.4 3.1z`
- **Box:** rect x 4 y 5.5 w 16 h 13 rx 1.5
- **Arrow:** `M5 19L18.5 5.5M10.5 5h8.5v8.5`
- **Draw:** `M3.5 16.5c2.2-3.6 4.2-5.3 5.7-3.9 1.6 1.5-.4 4.3 1.6 4.8 2.2.5 3.6-6.2 6.4-7.2 1.9-.7 3 1 3.3 2.3`
- **Text:** `M5.5 7.5V5h13v2.5M12 5v14M9 19h6`
- **Undo:** `M9 14.5L4.5 10 9 5.5` + `M4.5 10h9.5a5.5 5.5 0 0 1 0 11H11`
- **Close:** `M6.5 6.5l11 11M17.5 6.5l-11 11`
- **Check** (stroke 2.2–2.6): `M5 12.5l4.5 4.5L19 7.5`
- **Launcher bubble:** `M4.5 5.5h15a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H10l-4.5 3.5V17H4.5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z` + `M8 10h8M8 13.2h5`
- **Swap side:** `M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4`
- **Arrow right** (rail Describe, stroke 2): `M5 12h14M13 6l6 6-6 6`
- **Grip:** 10×16 viewBox, filled circles r 1.4 at (2.5,3) (7.5,3) (2.5,8) (7.5,8) (2.5,13) (7.5,13)

## 9. Acceptance checklist
- [ ] Adding the one script tag renders only the launcher; the host layout is pixel-identical before and after.
- [ ] Shift+F opens the widget, except while typing in a host input. Esc follows the priority order in §3.
- [ ] The screenshot contains no widget UI, and password fields are masked.
- [ ] All six tools behave as specified. Numbering updates on delete. Undo removes the last mark.
- [ ] Element pick highlights live DOM elements and stores a selector that is unique (`querySelectorAll(selector).length === 1`).
- [ ] The title is validated (3–120 characters). ⌘/Ctrl+Enter sends from any field.
- [ ] Console and network switches change the payload: `null` when off.
- [ ] The multipart POST matches `report.schema.json`. The annotated PNG matches the on-screen marks.
- [ ] Upload progress drives the bar. An error shows the banner, the report goes into the IndexedDB outbox, and a retry re-sends the same `clientReportId`.
- [ ] Success shows the server-returned id. The toast's Undo cancels the delayed POST.
- [ ] The discard guard appears only when there are marks or text.
- [ ] No host CSS leaks in, and no widget CSS leaks out (Shadow DOM).
- [ ] Reduced motion is respected. Focus is trapped while open and restored on close.

## Files in this folder
- `Feedback Widget.dc.html` — clickable prototype. Open it in a browser next to `support.js`.
  - Flow: click the launcher (or press Shift+F) → mark up → Describe → Send.
  - To see a variant, change the `default` values in the `data-props` JSON near the bottom of the file: `flow`, `launcher`, `toolbar`, `success`, `serverResponse: "error"`, `scene`.
  - On Send, the exact `report.json` object is logged to the console.
- `Feedback Widget States.dc.html` — state board with every variant and key state side by side (ids 1a–1p).
- `support.js` — runtime that lets the prototypes open. Reference only; do not ship it.
- `report.schema.json` — JSON Schema (draft 2020-12) for the `report` part.
- `report.example.json` — a filled example matching the prototype's demo.

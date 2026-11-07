# Project Home v2 — implementation spec

Source: Claude Design project `f2bcf396-1909-43c4-a453-2e6e0f48ce9f` ("Project Home clickable
prototype"), file `Project Home.dc.html`, imported 2026-11-07 by Epic
`project-home-needs-an-update-use-the-claude-desi-20cbd3c1`. Owner brief (verbatim intent): Project
Home is one nav row with **3 key buttons — Pages / Videos / Tools** (Review MD network lives in
Tools); generated pages and videos show under Pages / Videos; **all three use the same layout**
(list on the left, content on the right); Tools gets a list too, because more tools will be added.

| File | What |
| --- | --- |
| `project-home-prototype.dc.html` | The prototype, decoded verbatim. Markup = lines 26–770; data + behaviour = the script (lines 772–1317). Template data: lines 779–856. |
| `support.js` | The design runtime. Opening the `.dc.html` in Chromium (file://) renders it. |
| `renders/NN-*.png` | Reference screenshots at 1440×900. **The visual target.** `01-pages`, `02-generate-page-composer`, `03-videos`, `04-video-building`, `05-tools`, `06-generate-video-composer`, `07-empty-pages`, `08-empty-videos`. |

**Not product (ignore):** the window tab strip (lines 28–43), the project sidebar (47–93) except
the Project Home row's description, the footer status bar (591–601), the sample page bodies
(241–333 — the real page is the generated HTML), the prototype's fake player chrome and SCENES
chips (393–437), and the Tweaks props `navStyle` (Tabs/Sidebar) and `composerStyle` (Gallery).

## 1. Layout (px from the prototype)

```
Project Home (NavKey project-home) — fills the tab, padding 22 28 20, column gap 18
┌ key buttons: 3 equal columns, gap 12 ─────────────────────────────────────────────┐
│ [▣ Pages  "3 pages · latest 1d ago"  (3)] [▶ Videos "1 building · 2 ready" (3)] [⚒ Tools "Review MD network · 3 findings" (3)] │
├ section: grid 252px | 1fr, gap 20 (same for Pages, Videos, Tools) ─────────────────┤
│ [primary button, h38, full width]   │ title bar: serif 22 title + mono 11 sub · [Regenerate…] │
│ LABEL · n   (mono 10.5, .1em)        │ content (scrolls on its own)                     │
│ rows… (scroll on their own)          │                                                   │
└──────────────────────────────────────────────────────────────────────────────────┘
Generate composer = centered modal (min(1040px,100%) × min(710px,100%), radius 14)
```

- **Key button** (lines 99–113): padding 12/14, radius 12, icon box 36×36 radius 9, label 16
  semibold, meta 12 (wraps, never clipped), count badge h22 mono 11.5 radius 11. Selected:
  ink background, accent icon box. Unselected: `bg-hi`, structural border. The Tools badge is
  always accent and shows the link-map findings count.
- **Meta lines** (line 1150): none → `Nothing generated yet`; something building →
  `<n> building · <m> ready`; else `<n> page(s)|video(s) · latest <ago>`. Tools →
  `Review MD network · <n> findings`.
- **List rows**: padding 10/12, radius 9, structural border; selected = accent border + `bg-hi`
  and full-ink title. Page row: title 13.5 semibold + mono 10.5 meta `<kind> · <ago>`. Video row
  (348–359): 86px 16:9 thumbnail (style colours, title text 10.5, duration badge bottom-right)
  + title 13 + `<kind> · <len>s · <ago>` + `LUFS <x> · grade <y>`. A building row shows
  `Queued` / `Building… started <ago>` in accent and a 3px indeterminate bar.
- **Row actions** (192–204): under the selected, non-building row only: `Rename` · `Delete`
  (11.5 semibold, faint → ink on hover). Delete asks inline: `Delete this page?|video?`
  `Confirm` (accent, bold) `Cancel`. Rename swaps the row for an input (h40, accent border);
  Enter saves, Escape cancels, blur saves.
- **Title bar**: page sub = `<kind> · <model> · <ago>`; video sub =
  `<kind> · <len>s · <style> · <ago>`. Right side: `Regenerate…` (outline, h32, refresh icon)
  when ready; `Open session` while building.

## 2. Token mapping (no raw hex in className)

| Prototype | App token |
| --- | --- |
| `#f5f0e6` page | `bg` |
| `#ede6d6` bands, composer list, tip strip | `bg-elev` |
| `#fbf8f1` cards, inputs, selected rows | `bg-hi` |
| `#d4ccb8` borders | `border-rule-structural` |
| `#e3dcc8` segmented track, chips | `bg-rule-inner` |
| `#1a1612` ink; selected key button | `text-fg`; `bg-fg text-bg` |
| `#3a342b` / `#5d5648` / `#9c937f` | `text-fg-dim` / `text-fg-faint` / `text-fg-faint` (placeholders) |
| `#a83818` accent; hover `#8f2f13` | `bg-accent text-bg-hi`, `hover:bg-accent-dark`; small accent text `text-accent-dark` |
| `#f4b942` (stale, seek bar) | `honey` |
| `#2e5a3e` (checks, mascot toggle on) | `sage-dark` |
| overlay `rgba(26,22,18,.45)` | `bg-fg/45` |

Fonts: Source Serif 4 → `font-serif`; Inter Tight → `font-sans`; JetBrains Mono → `font-mono`.
Video-style swatches (STYLES, lines 840–846) are five fixed literal class sets, e.g. Auto =
`bg-bg-elev text-fg`, Professional = `bg-fg text-bg font-serif`, Fun = `bg-butter text-fg
font-extrabold`, Animated whiteboard = `bg-bg-hi text-fg-dim font-serif italic`, Kinetic
typography = `bg-accent text-bg-hi font-extrabold uppercase tracking-tight` — literal strings,
never interpolated (Tailwind JIT). The modal uses `Z.dialog` from `lib/zLayers.ts`.

## 3. Generate composer (lines 603–764, script 1006–1061, 1227–1259)

- Opened by `Generate page` / `Generate video` (top of the list), `Regenerate…` (title bar) and
  the empty-state cards. Esc or a click on the overlay closes it.
- **Generate** = split view: left `START FROM` list (292px, `bg-elev`) of templates; right =
  config (max-width 660): eyebrow `TEMPLATE · <NAME>`, name (serif 22), blurb, `Will cover` /
  `Scenes` chips. Picking a template resets every setting to that template's defaults.
- **Regenerate “<title>”** = config only (no list), eyebrow `REBUILDING · <id>`, subtitle
  `Same settings as last time — change anything before it rebuilds.`, button `Regenerate`.
- Page fields: `Topic · required` (Custom topic only), `Written for` (Newcomers / Users /
  Contributors), `Length` (Brief / Standard / In-depth), `Read from` toggles (README & docs /
  Source tree / Git log), `Focus · optional` textarea + template chips (`+ <chip>` appends
  `. <chip>`).
- Video fields: `Kind` (Project demo / Blog post / Feature), `Feature`|`Post · optional` input
  (hidden for Project demo), `Style` (5 swatches), `Length` (30 seconds / 1 minute),
  `Character` toggle (`Use the project’s mascot`), Focus + chips.
- Footer (`bg-elev`): `Sent to <project-home-builder|demo-video-builder> as` + the prompt lines
  joined with ` · ` (mono, one line, ellipsis), `Cancel`, primary `Generate page|video`.
  Disabled (45% opacity, not-allowed) while a Custom topic has no topic.
- **Templates**: copy PAGE_TPLS / VIDEO_TPLS / STYLES / AUDIENCES / LENGTHS / READS / KINDS from
  lines 779–856 verbatim, minus the prototype-only `lede` and `sample` fields.
- **Prompt lines** (sent as the macro's `extraInstructions`, joined with `\n`):
  - Page: `Page: Overview|How it works|FAQ` or `Page: Custom topic: <topic>`; `Audience: <a>`;
    `Length: <l>`; `Read from: <labels joined ", ">` (or `Read from: nothing selected`); then the
    Focus text when non-empty.
  - Video: `Video kind: <kind>`; `Video target: <t>` (only when kind ≠ Project demo and target is
    non-empty); `Video style: <style>`; `Video length: <30|60>`; `Character: on|off`; then Focus.

## 4. States

- **Loading / load error**: keep today's `project-home-loading` / `project-home-load-error` +
  Retry behaviour inside the section area (key buttons stay visible).
- **Empty** (lines 138–172), per tab with no entries: eyebrow `NO PAGES YET` / `NO VIDEOS YET`,
  serif 30 title (`Start this project’s library` / `Show the project in under a minute`), body
  text (line 1278–1279), template cards grid (auto-fill, min 230px): 104px preview strip
  (template eyebrow + up to 4 covers/scenes lines, video cards use the style colours), name,
  blurb, preset line, `Generate` (quick: template defaults; Custom topic card says `Name a topic`
  and opens the composer) + `Customize` (opens the composer on that template). Then the TIP
  strip: `Generated pages and videos are only as good as the docs behind them. If they're messy,
  run Review MD network in Tools first.` — the link switches to Tools.
- **Building** (lines 225–239, 463–477): while the macro's job is queued/running, the entry
  being built is a building row at the top of the list (or the existing row, when regenerating
  in place) and is selected; the content area shows: pulse + `QUEUED`|`BUILDING` (mono 11,
  accent), serif 28 title, the builder explanation (page: `The project-home-builder agent is
  reading the project. It saves the page with one project_page_write call, and it shows up here
  when it's done — you can keep working meanwhile.`; video: `The demo-video-builder agent is
  writing a 30-second|one-minute animation. Before it’s saved it is checked for length, loudness
  and any network access.`), a 4px indeterminate bar, the `Sent to the builder` box (prompt
  lines, mono 11.5) and `Waiting to start`|`Started <ago>` · `Open session`. When the job
  finishes the app toast says `“<title>” is ready`; a failure shows the job's reason with
  `Open session` (today's `JobStatusLine` text).

## 5. Videos content (lines 379–461)

Title bar, then the real `VideoPlayer` (unchanged player and bridge), then a grid
(auto-fit, min 260px) of two cards: **SOURCES** (`<n> claims`; each `claim` + mono
`source › ref` from `meta.sources`) and **QUALITY REPORT** (four stats from `meta.report`:
`lufs` LUFS, `truePeakDb` true peak dB, `speechS` speech (s), `readingGrade` reading grade; then
every `meta.report.checks` entry: sage check when `ok`, accent cross when not, text = `detail`).
Missing numbers show `-`.

## 6. Tools (lines 483–585)

- List: outlined `Add a tool` button (opens the existing macro editor with Surface preset to
  Project Home); `TOOLS · n`; rows = `builtin-review-md-network` first, then every other
  `surface: 'project-home'` macro except `builtin-project-home` and `builtin-demo-video` (today's
  HotKeyStrip set). Row = 28px ink icon box with honey glyph, name 13.5 semibold, mono meta
  (Review MD network: `<n> findings`; others: agent name). Footnote: `Any macro saved with
  Surface: Project Home shows up in this list.`
- **Generic tool** (any macro but Review MD network): title bar (label + `<agent> · <tag>`),
  its inputs rendered with the existing `MacroInputsForm` when it has inputs, and a primary
  `Run` that launches through the same `onLaunch` the hot keys use today.
- **Review MD network**: title bar `Review MD network` + `built-in macro · architect · <n>
  findings`; right side `Scope` select, `Mode` segmented control, primary `Run review`.
  Description: `Maps CLAUDE.md and every doc it leads to, so agents start from one short entry
  map and find each fact in exactly one place — with nothing stale.` Info strip:
  `<docs> docs · <links> links · <n> findings. A review opens an architect session that reports
  first and changes no files until you approve.` Then two cards: **LINK MAP** (legend: Entry
  map, Owner doc, Doc, Finding, Missing; SVG, hovering a node dims all but it and its
  neighbours; caption = `<path> · links out <n> · linked from <m>`) and **FINDINGS** (type tag,
  mono `where`, detail, `Open`; hovering a finding highlights its nodes).
- Scope options = the macro input's default (`the whole project`) + each top-level folder that
  holds a scanned doc (`src/`, `plugins/`, …). Mode options and default come from the macro's
  `mode` input (live, not hardcoded). Run review = `onLaunch(macro, undefined, { scope, mode })`.

## 7. Data contract

- Pages / videos: `window.api.projectPages.get` (unchanged) via `useProjectPagesOutput`;
  rename / delete via the existing `projectPages.rename` / `projectPages.delete`.
- Builds: the existing `onLaunch(macro, extraInstructions)` → `useMacroLaunch` → background job (unchanged API). `Regenerate…` appends a `Replace entry: <id>` line; `macroJobDispatch.cjs` `entryIdFor` uses it as the entry id when it matches `^[a-z0-9][a-z0-9-]{0,63}$` (else ignores it), so the rebuild replaces that entry in place (both writers already replace an existing id). Job state: `macros.jobStatus` (unchanged).
- Link map: **new** `window.api.projectPages.mdNetwork({ cwd })` (IPC `project-pages:md-network`) → `MdNetworkResult`:
  `{ ok: true, root: 'CLAUDE.md', nodes: MdNode[], edges: MdEdge[], findings: MdFinding[],
  docs: number, links: number, scopes: string[] } | { ok: false, error: string }` computed by
  `src/main/lib/mdNetworkScan.cjs` from `git ls-files` `*.md` (≤ 2000 files, ≤ 256 KB each read),
  relative markdown links only (`[x](path)`, anchors stripped, http(s)/mailto ignored), BFS
  from the root `CLAUDE.md`. Findings: `broken-link` (target missing; `where` =
  `<file>:<line> → <target>`) and `orphan` (tracked doc no link path reaches, grouped by
  top-level folder). On demand only (when Tools opens + a refresh), never polled.

## 8. Deliberate deviations (decided, do not re-litigate)

1. Only the **Key buttons** navigation and the **Split** composer ship; Tabs/Sidebar/Gallery are
   prototype tweaks. The empty state's template cards are the only gallery.
2. The page frame renders the real generated HTML (`HtmlFrame`); the video area keeps the real
   `VideoPlayer`. SCENES chips are not built: `ProjectVideoMeta` has no scene data.
3. Pages do not record audience/length/read-from, so `Regenerate…` pre-fills: page template from
   the id (`overview` / `how-it-works` / `faq`, else Custom topic with `meta.topic`) and that
   template's defaults; video kind/style/length from `meta`, Character = `meta.character !== null`,
   target empty.
4. `stale` findings and `Last drift check <ago>` are not shown: the local scan finds only
   broken links and orphans; staleness is the review session's judgment.
5. Run review / Run go through today's launch path (it opens the Epic), so there is no
   in-page "review running" strip.
6. The status bar `N building` item is not built: the key buttons already carry it, and a global
   job-status poll on every page is the main-thread load the 2026-11-06 starvation fix removed.
7. The builder prompts learn the new lines (`Audience`, `Length`, `Read from`, `Character`,
   `Video kind: Project demo`, `Video style: Auto`) through a built-in prompt bump, not persona
   edits.

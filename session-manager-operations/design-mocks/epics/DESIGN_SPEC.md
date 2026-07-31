# Epics workspace redesign — design spec

Source: claude.ai/design project `0ca33cd3-c2fa-4644-b728-bde42292abbd`, file `Epics.html`
(imports `variants/epics.jsx` — decoded copy saved next to this file as `epics-mock.jsx`;
mock uses inline styles + an `ALMANAC` palette object; the real app implements the same
palette as Tailwind theme tokens, so **translate to Tailwind classes**, do not port inline styles).

## What it replaces

`ProjectsLanding.tsx` today is a single centered column (new-prompt form → Epic queue list →
History) that swaps the whole page for `PromptSessionConversation` when an Epic is opened.
The redesign replaces that with a **two-pane workspace** that owns the full `terminal`
(nav label "Epics") destination:

```
┌───────────────┬──────────────────────────────────────────┐
│ Epic queue    │ Epic detail                              │
│ (352px aside) │  header: status chip · kind chip · branch│
│  search       │  h1 title (serif) · goal paragraph       │
│  filter chips │  meta row: opened/activity/turns/tools/  │
│  group/sort   │           tokens                         │
│  sectioned    │  view tabs: Discussion N | PRDs N | Runs N│
│  rows, paged  │  scrollable body (thread / prd list /    │
│  footer hints │   run cards)                             │
│               │  composer (Epic-scoped, attachments)     │
└───────────────┴──────────────────────────────────────────┘
```

"New Epic" replaces the right pane with a centered creation card (not a modal).

## Left pane — Epic queue (built for ~100s of Epics)

- Header: "EPIC QUEUE" micro-label + total count + accent **New Epic** button (plus icon).
- Search input (icon, clear button) filtering title+goal+kind.
- Filter chips with live counts: `Open N` (default) · `Needs you N` · `Running N` ·
  `Pinned N` · `All N`.
- Two mini-selects: **group** by status | tag | recency; **sort** by last activity | turns |
  tokens | title. Plus a compact-rows toggle button.
- Grouped sections with sticky collapsible headers (chevron, colored dot, uppercase mono
  label, count, hairline). `completed` section collapsed by default. Each section pages:
  first 18 rows, then a dashed "Show 40 more · N hidden" button.
- Pinning: per-row pin toggle (star), pinned rows float in a sticky "pinned" section on top.
- Row (comfortable): status chip + kind chip + activity age on line 1; bold title; meta line
  with PRD count, turns, tokens (mono, icons). Selected row: card background, 3px inset
  status-colored left bar, subtle shadow. Compact row: dot + title + age, single line.
- Keyboard: `j`/`k` (and arrow keys) move selection when focus is not in an input.
- Footer strip: "N shown · M need you" + "j / k to move".

## Right pane — Epic detail

- Header: `EChip` status (running/queued/needs you/completed/draft — colored pill w/ dot),
  `EKind` (FEATURE/BUG/DISCUSSION — uppercase mono, tinted inset-border tag), mono branch.
  Serif `h1` title (~27px, Newsreader), goal paragraph. Right side: a **Chat ⇄ Terminal
  mode toggle** + overflow button. An Epic IS its claude session (`claudeSessionId`, 1:1);
  the toggle switches the detail pane between the Chat view (thread + composer, headless
  `claude -p --resume`) and an in-pane Terminal view (xterm PTY running
  `claude --resume <claudeSessionId>` in the Epic's cwd). Same session, two views —
  switching never mints a new sessionId and never navigates away from the workspace.
- Meta row: opened · last activity · turns · tools · tokens (label muted + mono value).
- View tabs (underline style): **Discussion N** · **PRDs N** · **Runs N**.
- Discussion: attached-PRD chip strip on top (click → PRDs tab); then the thread.
  - User turn: right-aligned warm bubble (radius 12/12/4/12), "you · age" caption; a
    "split into <epic>" affordance when a message spawned another Epic.
  - Agent turn: 26px "C" avatar square, "claude · age" + running dot / outcome label;
    collapsible **ToolStrip** ("used N tools" / "working · N tools" → expands to per-tool
    ×count chips); message card (radius 4/12/12/12); optional artifact button (PRD file
    chip → opens PRDs tab); **needs-you** turns get red-tinted card, "NEEDS YOUR DECISION"
    label and inline answer buttons.
- PRDs: card per PRD — file icon, mono filename, accepted/draft pill, note line,
  line-count, open arrow. Empty state: dashed card "No PRD yet… ask Claude in the thread".
  Footer caption: accepting a PRD hands it to the Scheduler as a `claude -p` job.
- Runs: card per agent turn that used tools — "turn N", age, running/outcome, call count,
  tool chips. Empty state dashed card.
- Body auto-scrolls to bottom on Epic switch / tab switch back to thread.

## Composer (bottom of detail pane, Epic-scoped)

- Context line: "iterating in" + status dot + Epic title + kind tag; drag-over shows
  "drop to attach".
- Attachment support: paste (⌘V) and drag-drop files/screenshots; image thumbnails +
  filename/size chips with remove buttons; also a mic button (dictate) and an attach
  button in a joined button group left of the textarea.
- Auto-growing textarea (58–180px). Placeholder reflects state: running →
  "Running… send to queue a follow-up in this Epic".
- When Epic is running: red "Cancel" text-button + primary button reads **Queue** instead
  of **Send**. Send button disabled-toned until text or attachments exist.

## New Epic card

Centered max-620px card: "NEW EPIC" micro-label, serif "What are we trying to achieve?",
subtitle "One goal per Epic. Its discussion, PRDs and agent runs all stay inside it.",
title input, goal textarea, references attach tray (paste/drop/attach), type selector
(Feature/Bug/Discussion), Cancel / Create Epic.

## Status + kind vocabulary

- Statuses: `running` (terracotta), `queued` (tan), `needs you` (red), `completed` (sage),
  `draft` (outline). Map from real data: running = chatRunner active or a scheduler job
  running for the Epic; needs = pending needs-input question; queued = queued scheduler
  job; completed = archived; draft = active with no runs/PRDs yet.
- Kinds: Feature (sage) / Bug (terracotta-red) / Discussion (warm gray) — Epic-level intent
  tag (mock: `EKind`). Real data: `tag` written by `epicMint.cjs` (not yet on the renderer
  `PromptSession` type — must be surfaced).

## Data mapping notes (from codebase recon 2026-07-31)

- Queue + Discussion events: `usePromptSessions` (`state/promptSessions.ts`).
- Thread + composer: `useChat` (`state/chat.ts`), key = promptSession.id; exchanges
  hydration via `window.api.exchanges.list`.
- PRDs + Runs: join `useScheduleState` jobs on `ScheduleJob.sourcePromptId === epicId`;
  `window.api.schedule.listPrds()` lacks an epic field today — needs epicId surfaced.
- Turn/tool/token counts are not stored on PromptSession today — derive or extend.
- Reuse `ui/ViewTabs`, `ui/ListDetail`, `ui/FilterPills`, `sched-primitives` pills where
  they fit; Tailwind Almanac tokens (bg/bg-elev/bg-hi, line/rule, fg/fg-dim/fg-faint,
  accent, sage) instead of the mock's hex values.

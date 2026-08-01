# Home redesign — design spec (global Home + per-project "Brief")

Source: claude.ai/design project `0ca33cd3-c2fa-4644-b728-bde42292abbd`, file `Project Home.html`
(imports `variants/home-shell.jsx`, `variants/home-global.jsx`, `variants/project-home.jsx`,
plus `variants/almanac.jsx` / `variants/shared.jsx` for palette + icons). Decoded copies saved
next to this file as `home-shell-mock.jsx`, `home-global-mock.jsx`, `project-home-mock.jsx`.

The mocks use inline hex styles from an `ALMANAC` palette object. The real app implements the
SAME palette as Tailwind theme tokens (`tailwind.config.js`): paper→`bg`, panel→`bg-elev`,
card→`bg-hi`, edge→`line`, rule→`rule`, ink→`fg`, inkSoft→`fg-dim`, inkMute→`fg-faint`,
accent→`accent`, accentSoft→`accent-muted`, sage→`sage`, butter→`butter`; fonts `font-sans`
(Geist) / `font-serif` (Newsreader) / `font-mono` (IBM Plex Mono). **Translate every mock style
to Tailwind tokens — never port hex values.** The mock's status-pill hexes map to existing
badge tokens: running→`accent`/`accent-dark`, needs→`delta-bad`-ish (use the epics
`epic-primitives.tsx` status pill, which already implements this vocabulary), queued→`honey`
family, good/resume→`sage`/`sage-dark`. Icons: use `AlmanacIcon`
(`src/renderer/components/layout/AlmanacIcon.tsx`) — it already has home/reload/check/x/plus/
arrow glyph equivalents; do not copy the mock's `SMIcon`.

## The core concept (what the mock encodes)

The design splits "Home" into TWO surfaces, matching the TAB→EPIC→PRD domain model:

1. **Global Home (machine-wide)** — `home-global-mock.jsx`. In the mock it is a fixed,
   always-leftmost pseudo-tab in the tab strip ("This machine"). Content: greeting headline with
   live session-slot count, usage meters card (plan header + Session 5h + Weekly), a compact
   Projects list card, an "Active sessions" list (the ≤3 slot-pool holders), and a "Recent
   sessions" table. Explicit mock note: *"No Quick start; nothing invented."*

2. **Project Home / "The Brief" (per project)** — `project-home-mock.jsx`. The first Workspace
   item in the project rail ("Home — what this project is, and what is in flight"). An
   LLM-synthesized, provenance-carrying project brief with pinnable blocks, a Refresh action
   that runs a headless synthesis session, plus two live (never-synthesized) blocks fed from
   real Epic state.

### Mapping onto the real app (DECIDED — executors implement exactly this)

The real app already has a shell equivalent to `home-shell-mock.jsx`: `TabBar.tsx` (project
tabs) + `AlmanacSidebar.tsx` (grouped nav over `lib/navGroups.ts`) + the per-screen panel
registry (`state/layout.ts`, `lib/screenKeys.ts`, `components/screenComponents.tsx`). We do NOT
rebuild the shell. The mapping:

- **NavKey `overview` stays the machine-wide Global Home** (also stays the boot-default
  `focusedPanelId`). `components/tabs/Home.tsx` is redesigned in place to the HomeGlobal layout.
- **New NavKey `project-home`** renders the Brief for the ACTIVE tab's cwd. In
  `lib/navGroups.ts` it REPLACES the current `overview` row as the first Workspace item:
  `{ key: 'project-home', group: 'Workspace', label: 'Home', icon: 'home', hint: 'What this project is, and what is in flight' }`.
  `overview` then joins the "no sidebar row" set (like `terminal`'s siblings noted in the
  navGroups header comment) — update that comment.
- **TabBar gets the mock's fixed leftmost Home chip**: a home-icon button before the first
  project tab, separated by a 1px `bg-line` divider, that navigates to `overview`; active
  styling (`bg-bg` + `inset 0 2px 0` accent top bar, per mock) when the focused panel is
  `overview`. It never closes and is not a SessionTab.
- Everything else in the mock rail (Epics/Browser/File Explorer/Scheduler + Configure group) is
  today's nav unchanged. The mock shows "Usage" where the app has "History" —**keep History**;
  do not add/remove other rows.

## Surface 1 — Global Home (`overview`, redesign of `components/tabs/Home.tsx`)

Layout (max-w ~1080px, centered, `px-[34px] py-[26px]`, page scrolls):

```
┌────────────────────────────────────────────────────────────┐
│ THIS MACHINE  (mono uppercase kicker, fg-faint)            │
│ Good afternoon. «N of 3» session slots are busy.  (serif   │
│   h1 ~32px; the «N of 3» span in text-accent)              │
├───────────────────────────────┬────────────────────────────┤
│ Usage card (bg-hi, rounded)   │ Projects card (bg-hi)      │
│  header row: plan name ·      │  PROJECTS kicker           │
│   plan id mono · updated Xs   │  rows: dot · name ·        │
│  Session meter (5-hour tag)   │   «N live» (accent) or     │
│  ── rule ──                   │   relative activity        │
│  Weekly meter (all models)    │  click → open/activate tab │
├───────────────────────────────┴────────────────────────────┤
│ Active sessions          «N of 3 slots in use» (mono)      │
│  card rows: accent dot · owner name (mono) · kind ·        │
│   project · Epic context · started ago · [Open]            │
├────────────────────────────────────────────────────────────┤
│ Recent sessions                    See all history →       │
│  table rows: id8 · project · epic · size · when · [resume] │
└────────────────────────────────────────────────────────────┘
```

Removed vs today's Home.tsx (deliberate, per mock): the mascot hero + tagline copy, the
Quick-start card (Start a session / Resume last / Draft a PRD / Add a project / voice button),
the SessionsPoolCard explainer paragraphs, and the "In the scheduler" 3-card peek (scheduler
jobs that hold slots surface in Active sessions instead; the Scheduler tab owns the rest).

### Data mapping notes (Global Home) — all grounded in existing code

- **Slot count (hero + Active sessions)**: `window.api.schedule.sessionSlots()` →
  `{ total, inUse, holders: { owner, at }[] }` — the exact poll pattern already in
  `Home.tsx`'s `SessionsPoolCard` (5s interval). Greeting logic (`Good morning/afternoon/…`)
  already exists in `Home.tsx` — keep it.
- **Usage card**: reuse `components/tabs/home/UsageMeters.tsx` as-is (it already renders plan
  header via `prettyPlan`, Session 5-hour + Weekly meters with reset times and tier tones) plus
  `BillingStatusOverlay` for non-ok billing states — this card mostly survives the redesign.
- **Projects card**: `lib/useKnownProjects.ts` (`rows`: encoded/displayPath/sessionCount/
  lastSession; `enriched[encoded].cwd`). Dot color: `lib/projectColor.ts` hashed palette. "N
  live": count of slot holders + running chats whose cwd matches (chat cwd via
  `usePromptSessions` session's `cwd`, chats keyed by Epic id); fall back to relative
  `lastSession` time. Click → activate the existing tab for that cwd if one exists
  (`useSessions` tabs have `cwd`; one-TAB-per-project invariant) else `addTab({ cwd })`.
- **Active sessions rows**: join `sessionSlots().holders` (owner string + at timestamp) against
  (a) `useScheduleState` snapshot jobs with `status === 'running'` (slug, title, cwd,
  `sourcePromptId` → Epic via `usePromptSessions`) and (b) running chat runs from
  `lib/useChatSignals.ts` (chats keyed by Epic id, `running === true`,
  `queuedPosition === 0`) joined to `usePromptSessions().sessions[epicId]` for goalText + cwd.
  [Open] navigates: scheduler job → `scheduler` nav; chat run → Epics workspace deep-link via
  `lib/promptSessionDeepLink.ts` (`terminal` nav destination). The mock's per-session token
  count has no reliable live source for scheduler jobs — omit the tokens column when the join
  can't produce one (see Dropped/deferred).
- **Recent sessions**: keep `Home.tsx`'s `useRecentSessions` scan of
  `~/.claude/projects/*/<sessionUuid>.jsonl` (id, projectEncoded, mtime, size) and its `resume`
  handler (`addTab` + `claude --resume`, preset `history-resume`). Add the Epic column by
  matching `sessionId` against `usePromptSessions` sessions' `claudeSessionId` (active AND
  archived — archived list per cwd is hydrated by `usePromptSessions.getState().hydrate(cwd)`,
  see `EpicsWorkspace.tsx`'s hydrate loop); em-dash when no Epic matches (plain terminal
  sessions). 5 rows like the mock (up from 4).
- **zustand discipline**: never build fresh arrays/objects inside a selector — select raw
  slices with module-level `EMPTY_*` fallbacks and derive after (CLAUDE.md "Avoid";
  `npm run lint:selectors` enforces).

## Surface 2 — Project Home / The Brief (new NavKey `project-home`)

Layout (same 1080px column):

```
┌────────────────────────────────────────────────────────────┐
│ Header card: THE BRIEF kicker · h1 = synthesized purpose   │
│   [Refresh brief] accent button (spinner while running)    │
│   "synthesized 12 minutes ago / by <model>" (mono, right)  │
│   "read from" chips: CLAUDE.md · N Epics · N sessions ·    │
│     git log — each label+detail; drifted chip gets a       │
│     tinted border + "newer than brief" mark                │
├────────────────────────────────────────────────────────────┤
│ (while refreshing) tinted banner: "A headless session is   │
│   re-reading CLAUDE.md, the Epic archive and recent        │
│   commits. Pinned blocks are left untouched."              │
├────────────────────────────────────────────────────────────┤
│ NOW · What is in flight        (live, never synthesized)   │
│   3-up cards: status pill · Epic title · one-line note     │
├────────────────────────────────────────────────────────────┤
│ THE PROJECT · What this is     (synthesized, pinnable)     │
│   card of 2-3 paragraphs; **bold** + `code` mini-markdown  │
├────────────────────────────────────────────────────────────┤
│ STRUCTURE · How it is put together  (synthesized)          │
│   rows: area name · N files · note | touched-by Epic |     │
│   heat bar 0-100                                           │
├────────────────────────────────────────────────────────────┤
│ SCOPE · How the goal has moved  (synthesized)              │
│   timeline rows: when · kind pill (added/narrowed/decided) │
│   · text · "from <source>"                                 │
├──────────────────────────┬─────────────────────────────────┤
│ RULES · Conventions      │ OPEN · Waiting on you (live)    │
│  (synthesized, pinnable) │  tinted cards: question · from  │
│  check rows              │  Epic · [Answer in Epic →]      │
└──────────────────────────┴─────────────────────────────────┘
│ footer note: regeneration + pinning explanation (fg-faint) │
```

Block chrome: every section = kicker (mono uppercase, accent) + serif h2 + faint note line.
Pinnable blocks (`what`, `conventions`) show a pin toggle by the kicker; pinned blocks are fed
back verbatim into the next synthesis instead of being rewritten.

Empty/edge states:
- No active project tab → `ui/EmptyState` ("Open a project to see its brief").
- Tab active but no `brief.json` yet → header card with project name (from cwd tail) + a
  "Generate the brief" CTA (same code path as Refresh); live blocks (Now / Waiting on you)
  still render from real Epic state.
- Refresh error → `useToast().show('error', …)` (toast is the user-facing error channel).
- Refresh already running for this cwd → button disabled (single in-flight per cwd).

### Data mapping notes (the Brief)

**Persistence**: `<cwd>/session-manager-operations/project-brief/brief.json` — inside the
per-project operations root the app already owns. Shape:

```jsonc
{
  "version": 1,
  "synthesizedAt": "2026-07-31T20:11:00Z",
  "model": "<model id used>",
  "purpose": "one-sentence project purpose",
  "what": ["paragraph", "..."],                 // mini-markdown: **bold**, `code`
  "areas": [{ "name": "", "files": 0, "note": "", "epic": null, "heat": 0.0 }],
  "scope": [{ "when": "", "kind": "added|narrowed|decided", "text": "", "src": "" }],
  "conventions": ["..."],
  "pins": { "what": false, "conventions": true },
  "pinned": { "what": null, "conventions": null } // frozen copies of pinned block content
}
```

**Backend**: new `src/main/projectBrief.cjs`, modeled line-for-line on the spawn pattern of
`src/main/memoryAggregate.cjs` (the codified pattern per project CLAUDE.md: cost-gated
`claude -p` that only fires on explicit `refresh: true`, stdin closed, **model pinned
explicitly** — automation model-pinning is a hard rule — hard timeout, `SM_KG_INTERNAL=1` env
so the prompt-logging hook skips it, brace-matching JSON extractor for the reply). Two IPC
calls (zod-validated in `src/main/ipcSchemas.cjs`, exposed via preload like the existing
`memory`/`schedule` namespaces):
- `projectBrief:get { cwd }` → `{ brief | null, sources }` where `sources` is computed cheaply
  (no LLM): CLAUDE.md line count + mtime; Epic counts from
  `<cwd>/session-manager-operations/prompt-sessions/` (active-index.json + archived files);
  session count = `.jsonl` files in `~/.claude/projects/<encodedCwd>/` (encode via the same
  helper `lib/encodeWorkspace.ts` mirrors); `git -C <cwd> rev-list --count HEAD` (bounded,
  tolerate non-git). `drift: true` on a source whose mtime > `synthesizedAt`.
- `projectBrief:refresh { cwd }` → runs the synthesis. MUST acquire a machine session slot from
  `src/main/lib/sessionSlots.cjs` first (the ≤3 `claude -p` pool; reject with a clear error if
  none free — surfaced as a toast). Prompt feeds: CLAUDE.md text, Epic goalTexts + statuses
  (active + archived), last ~50 `git log --oneline` lines, a depth-2 `ls` of src/, and the
  frozen content of pinned blocks with the instruction to return them unchanged. Writes
  `brief.json` atomically via `config.cjs`'s `writeJson`.
- Pin toggling: `projectBrief:setPin { cwd, block, pinned }` (writes pins + frozen copy).

**Live blocks** (renderer-derived, never in brief.json):
- **Now**: Epics of the active cwd via `usePromptSessions` (`sessionsForCwd`-style filter on
  `cwd`, `status === 'active'`) + `lib/epicDerive.ts`'s `epicDisplayStatus(epicId, snapshots)`
  (snapshots = sessions, chats from `useChatSignals`, jobs from `useScheduleState`, prds from
  `lib/useScheduledPrds`). Card note line: running → latest activity summary (or the Epic's
  tag), needs → "waiting on your answer", queued → "ready to run when a slot frees". Show ≤3
  by recency; statuses render with the pills from `components/epics/epic-primitives.tsx`.
- **Waiting on you**: pending `needs-input` tickets across the cwd's Epics — `useChat` /
  `useChatSignals` chats keyed by Epic id, `ticketHistory` entries with
  `status === 'needs-input'` (same signal `epicDisplayStatus` uses). "Answer in Epic" →
  `lib/promptSessionDeepLink.ts` + navigate to `terminal` (Epics workspace opens that Epic).
- **Active tab cwd**: `lib/useActiveTab.ts` / `useSessions` activeTabId → tab.cwd.

## Dropped / deferred mock features (named explicitly)

- **Auto-regeneration "after every tenth Epic turn"** (mock footer): v1 is manual-refresh only;
  the drift chips ("newer than brief") carry the staleness signal instead. Cost-gating rationale
  mirrors memoryAggregate's explicit-refresh-only rule.
- **Per-session token counts** in Global Home's Active-sessions rows: no live token source
  exists for scheduler jobs; column omitted where unknown rather than invented.
- **Projects-card token totals** (mock's `tokens: '1.2M'`): `useKnownProjects` only has
  transcript byte sizes; we show live-count/activity instead.
- **Mock rail "Usage" item**: the app keeps "History"; nav rows other than Home are untouched.
- **Scope-log "your correction" source**: there is no user-corrections store. v1 scope entries
  are synthesized from the Epic archive + git history of CLAUDE.md; `src` cites an Epic title,
  CLAUDE.md, or a commit — never "your correction".
- **Structure-map file counts / heat from real per-area stats**: v1 lets the synthesis derive
  them from the tree listing + git log included in its prompt (best-effort, clearly generated),
  rather than building a per-area analytics pipeline.
- **Shell rebuild** (`home-shell-mock.jsx`): demonstration-only; the real app keeps
  TabBar + AlmanacSidebar and adds only the fixed Home chip + nav-row swap described above.

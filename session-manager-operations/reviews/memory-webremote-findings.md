# Memory tab + Web Remote tab — review-and-fix pass

Date: 2026-07-18

Scope: `Memory.tsx`, `MemoryNaturalPanel.tsx`, `memory/MemoryClustersPanel.tsx`,
`memory/SubagentMemoryView.tsx`, `WebRemote.tsx`, `memoryAggregate.cjs`,
`memoryTool.cjs`, `webRemote.cjs`, `lib/kgExchangePairing.cjs`.

Note: this working tree already had in-flight, uncommitted changes from a
concurrent session/job working the same review (same repo checkout, not a
worktree) when this run started — visible as pre-existing diffs on
`webRemote.cjs`, `Memory.tsx`, `MemoryNaturalPanel.tsx`, and a new
`src/{main,renderer}/lib/memorySlug.{cjs,ts}`. Those changes converged on the
same fixes this review would have made independently (see "Already fixed"
below) and are included in the final commit as part of the same logical
change. Out-of-scope files that same session had touched (Scheduler-family:
`SchedulePanel.tsx`, `SchedulerHistoryView.tsx`, `SchedulerPrdsView.tsx`,
`sched-primitives.tsx`) were left untouched and unstaged, per this task's
"don't touch files outside the family" boundary.

## Bugs fixed (this run)

1. **Silent load-failure in Subagent Memory view** — `agentMemory.ts`'s
   `loadAgent()` stashed a failed `agentMemory.list()` error into
   `errorByAgent`, but nothing in `SubagentMemoryView.tsx` (or anywhere else)
   ever read that map. A corrupt/unreadable `agent-memory/<id>.json` file
   surfaced as a silent empty list with no user-visible signal, violating this
   repo's "Toast is the user-facing error channel" convention (every sibling
   load path — `Memory.tsx`'s `refresh()`, `memory.read` in the natural
   panel — already toasts on error). Fixed by calling `toast.error(...)` in
   `loadAgent()` alongside the existing `errorByAgent` bookkeeping. Covered by
   a new test, `src/renderer/state/__tests__/agentMemory.test.ts`.

2. **Stale storage path in the Memory tab's "Learn" help panel** —
   `learningContent.ts`'s `memory` entry described the workspace store as
   living at `~/.claude/session-manager/memories/<workspace>/`. The real
   location (confirmed by `memoryTool.cjs::workspaceDir()` and
   `memoryAggregate.cjs::memoryDir()`) is
   `~/.claude/projects/<workspace>/memory/` — the same path the in-flight
   concurrent fix had already corrected in the component code/comments, but
   the help copy (a separate file, `src/renderer/components/learningContent.ts`)
   still had the old path. A user reading "Learn → What is this?" on the
   Memory tab would be pointed at a directory that doesn't exist. Fixed the
   one stale string; the Subagent-memory path in the same entry was already
   correct.

3. **Ambiguous duplicate "Refresh" button in the Memory tab's Clusters view**
   — `Memory.tsx`'s outer toolbar unconditionally renders a generic "Refresh"
   button (re-lists workspace `.md` files) regardless of the active
   sub-view. The Clusters view (`MemoryClustersPanel`) renders its own
   "Aggregate/Refresh" button directly beneath it with entirely different
   semantics (cache read vs. a cost-gated `claude -p` clustering pass).
   Confirmed live via Playwright (`getByRole('button', { name: 'Refresh' })`
   resolved 2 matches simultaneously visible in the Clusters view). Fixed by
   hiding the outer generic Refresh button when `view === 'clusters'` — the
   panel's own action is the correct entry point there, and the workspace
   directory watcher (`config.watch`) already keeps the entry count current
   without a manual refresh.

## Already fixed by the in-flight concurrent change (verified, not redone)

- **Triplicated `MEMORY_SLUG_RE` regex** — `memoryTool.cjs`, `memoryAggregate.cjs`,
  and `ipcSchemas.cjs` each independently declared the same
  `/^[a-z0-9-_]+\.md$/` filename regex; now all three `require('./lib/memorySlug.cjs')`.
  Renderer-side, `Memory.tsx` and `MemoryNaturalPanel.tsx` each declared their
  own stem-only `SLUG_RE = /^[a-z0-9-_]+$/`; now both import
  `MEMORY_SLUG_RE` from `src/renderer/lib/memorySlug.ts`.
- **Stale workspace-memory path in `Memory.tsx`/`MemoryNaturalPanel.tsx`
  comments and the `config.watch()` call** — `WorkspaceMemoryView`'s
  external-change watcher was pointed at
  `${home}/.claude/session-manager/memories/${workspace}` instead of the real
  `${home}/.claude/projects/${workspace}/memory`. This was a real bug: the
  watcher would never fire on external writes (e.g. Claude saving a memory
  mid-session), so the "external-change subscription" comment's stated
  purpose silently didn't work. Already corrected in the in-flight diff.
- **Duplicated status-computation logic in `webRemote.cjs`** — the
  `webRemote:get-status` IPC handler and the `broadcastStatus()` push path
  each independently built the same `{enabled, remoteControlEnabled,
  connected, e2eActive, e2eAuthenticated, e2eState, pendingSas, devices}`
  object from `cfg`/`_ws`/`_e2e` module state. Now both call one
  `computeStatus(cfg)`. This was a real drift risk (exactly the "N display
  sites, ONE source" pattern this repo's standards call out) — worth
  confirming here since it's a security-relevant status surface.
- **Missing `nav:remote` command in the Command Palette** — `CommandPalette.tsx`
  listed 16 of 17 nav destinations but omitted `{ id: 'nav:remote', label:
  'Go to Remote', ... }`, so Cmd-K could not navigate to the Web Remote tab at
  all (confirmed via e2e: `navigateToTab(win, 'remote')` timed out against a
  build that predated this fix). `CommandPalette.tsx` is outside this task's
  declared file scope, but flagging it here since it's exactly the kind of
  "dead button" the UI exercise was meant to catch, and it was already fixed
  in-flight.

## UI exercise (Playwright, `dist/` rebuilt first — see below)

Ran a bounded Electron + Playwright walkthrough (`tests/e2e/_scratch-*`,
deleted afterward — scratch only) against a real project workspace (`sigma`,
20 memory entries) with `SM_E2E=1`:

- **Memory → Editor**: list renders, filter works, entry selection loads body
  into the markdown editor, byte size / mtime shown correctly. No console
  errors.
- **Memory → Natural**: chat panel renders with quick-action chips; not
  exercised beyond mount (out of caution — `remember`/`forget` commands
  mutate or send text into the active terminal, and the task scope for this
  pass was read-only exercise plus targeted bugfixes, not a full command
  matrix).
- **Memory → Clusters**: cache-only `aggregate(workspace, false)` on mount
  correctly avoided a `claude -p` spend and rendered the pre-existing cached
  cluster set (4 clusters, cross-links, "generated 12d ago"). Did not click
  the cost-gated "Refresh" button — the AC's "if cheap enough" qualifier
  didn't clearly hold given a live billing-limited machine, and cluster
  quality isn't part of this bugfix pass.
- **Memory → Subagent scope**: agent dropdown populates (scanned from
  `~/.claude/agents`), empty-state renders correctly for an agent with no
  entries.
- **Web Remote**: status banner, both permission toggles, pair-a-device
  panel, paired-devices empty state, audit-log section, and the panic button
  all render correctly in the "off" state. Not paired/toggled/panicked, per
  the task's explicit read-only constraint on this tab.

One real gotcha hit during this exercise, worth recording: **the e2e harness
loads the prebuilt `dist/` bundle, not live source** (`launchApp.ts` spawns
`src/main/index.cjs` directly; there's no `pretest` build step in
`package.json`). A stale `dist/` from before this session's fixes landed
made the walkthrough spec fail on `navigateToTab(win, 'remote')` and
intermittently on other selectors, and briefly looked like a real UI bug. A
plain `npm run build` before running any `tests/e2e/*.spec.ts` resolved it
cleanly and every previously-failing interaction passed. Also observed ~9
concurrent Electron processes on this machine during the run (consistent
with the concurrent-session note above) — one isolated click-timeout that
didn't reproduce on a clean retry is attributed to that resource contention,
not a product bug.

## Duplication found within the family, not touched (would need judgment calls)

- `SubagentMemoryView.tsx`'s `loadAgentList()` re-implements "scan
  `~/.claude/agents` + `<cwd>/.claude/agents`, filter `.md`, project shadows
  user" — the same shape of directory scan the file's own header comment
  says "mirrors what Subagents.tsx does internally". `Subagents.tsx` is
  outside this family (a different nav tab), so per this task's scope this
  is a **cross-family** duplication to flag, not fix. If it's ever
  consolidated, it should land as a shared `listSubagents(home, cwd)` helper
  under `lib/`, not a fix inside either tab in isolation.

## Retired-KnowledgeGraph history — dead-code check

Per this project's CLAUDE.md, the Memory tab's Clusters view is the
purpose-built replacement for the old Knowledge Graph tab/`kg.cjs` (KG
feature retired, its prompt-log ingestion pipeline removed). Checked every
file in this family for reachable KG-era code:

- `memoryAggregate.cjs` intentionally **mirrors** `kg.cjs`'s old
  spawn/capture/timeout pattern (per its own header comment) and sets
  `SM_KG_INTERNAL=1` so the prompt-logging hook treats its `claude -p` calls
  the same way KG's internal calls were treated — this is a deliberate reuse
  of an established convention, not leftover dead code. `kg.cjs` itself does
  not exist in this repo anymore.
- **`src/main/lib/kgExchangePairing.cjs` is genuinely dead** in production:
  `normalizePromptKey`/`loadExchangeIndex`/`enrichEntries` have zero callers
  outside their own test file (`src/main/__tests__/kg-augment.test.cjs`).
  This is real orphaned KG-era code (it enriched KG prompt-log entries with
  exchange results — a step that only made sense feeding the old graph
  builder). Per this task's explicit instruction to flag rather than delete
  without care, **left in place** — deleting it would also mean deleting or
  repurposing its test, and its removal wasn't requested as part of this
  bugfix pass. Flagging for a future cleanup PRD.
- No other KG-era identifiers (`KnowledgeGraph`, `kg.cjs` imports,
  `knowledge-graph` routes) are reachable from any file in this family.

## Cross-family duplication noticed, not touched (out of scope)

- `CLAUDE.md` documents a `webRemoteServer.cjs` as the relay server module;
  the actual (only) file is `src/main/webRemote.cjs` — `webRemoteServer.cjs`
  does not exist in this repo. Doc-only drift, not a code bug; left alone
  since CLAUDE.md edits weren't in this task's scope.
- The "connection state → banner copy/color" logic in `WebRemote.tsx`
  (`active = enabled && connected`, then a 3-way ternary picking banner text)
  is local to this one component — no duplicate computation found elsewhere
  in the family, so nothing to consolidate there.

## Verification

- `timeout 120 npm run typecheck` — clean, before and after changes.
- `node --test src/main/__tests__/memoryAggregate.test.cjs
  src/main/__tests__/kg-augment.test.cjs` — 14/14 passing (3 suites).
- `npx vitest run src/renderer/state/__tests__/agentMemory.test.ts` — 2/2
  passing (new test, red before the fix, green after).
- `npm run build` + bounded Playwright walkthrough — all four Memory
  sub-views and the Web Remote tab render with zero console errors.

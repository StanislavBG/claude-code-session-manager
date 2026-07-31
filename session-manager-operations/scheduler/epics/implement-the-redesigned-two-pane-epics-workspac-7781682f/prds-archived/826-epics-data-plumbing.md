---
title: Epics redesign 1/8 — data plumbing (tag, completed hydration, status derivation, PRD join)
cwd: ~/Projects/session-manager
estimateMinutes: 18
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

Lay the data foundation for the redesigned two-pane Epics workspace (design spec:
`session-manager-operations/design-mocks/epics/DESIGN_SPEC.md` — read it first, especially
"Data mapping notes"). Surface the Epic-level `tag` in the renderer, hydrate completed Epics
from their archive files, add a single derived-status helper (running/needs/queued/completed/
draft), and unblock the per-Epic PRD/run join that the later UI PRDs (waves 2–4 of this Epic)
consume.

# Acceptance criteria

## Core functionality

- [ ] `PromptSession` in `src/renderer/state/promptSessions.ts` declares
  `tag?: 'feature' | 'bug' | 'discussion'`; `createPromptSession(cwd, goalText, tag?)` accepts
  and persists it through `persistActiveIndex`, and `hydrate` reads it back.
  `src/main/lib/epicMint.cjs` already writes `tag` into active-index.json (~line 101) — stay
  shape-compatible; the renderer must not clobber a tag written by main.
- [ ] Completed Epics hydrate: `hydrate(cwd)` (or a sibling `hydrateArchived(cwd)` invoked with
  it) enumerates `<cwd>/session-manager-operations/prompt-sessions/*.json` archive files via
  `window.api.config.listDir`, skips `active-index.json`, and loads them as
  `status: 'completed'` sessions with their events. After a restart the completed set is no
  longer empty (today `hydrate` reads only active-index.json at ~lines 270-296).
- [ ] New module `src/renderer/lib/epicDerive.ts` exports:
  - `epicDisplayStatus(epicId, snapshots): 'running'|'needs'|'queued'|'completed'|'draft'` —
    completed = session.status==='completed'; needs = pending needs-input question in useChat
    for key epicId; running = chat run active OR a schedule job with
    `sourcePromptId === epicId` in a running state; queued = chat queuedPosition set OR a
    queued schedule job; else draft.
  - `epicPrds(epicId, snapshots)` — joins `window.api.schedule.listPrds()` file entries with
    schedule jobs on `sourcePromptId` (job status when a job row exists, else `'draft'`).
  - `epicStats(epicId, snapshots)` — `{ turns, toolCalls }` from useChat turns when that chat
    key is hydrated, `null` when not.
  All are plain functions taking already-selected store snapshots as arguments — NOT zustand
  selectors that build fresh values.
- [ ] `PrdListItem` in `src/preload/api.d.ts` gains `sourcePromptId?: string | null` (main
  already returns it from the listPrds handler in `src/main/scheduler.cjs`); the stale doc
  comment near `api.d.ts:408-411` claiming sourcePromptId is a "chain-root PromptTicket id"
  is corrected to say it carries the PromptSession (Epic) id (see `chat.ts:585,647`).

## Tests

- [ ] vitest unit tests cover: tag round-trip through persistActiveIndex/hydrate;
  archived-Epic hydration (mock `config.listDir`/`readJson`); `epicDisplayStatus` for all
  five statuses. New/updated test files pass via `timeout 300 npx vitest run <paths>`.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `npm run lint:selectors` passes.

# Implementation notes

Key files: `src/renderer/state/promptSessions.ts` (store: sessions/events Records;
`createPromptSession` ~line 81/150; `persistActiveIndex` filters `status==='active'` at
~127-130; `markCompleted` writes the archive via `promptSessionArchivePath` at ~250-256);
`src/main/lib/epicMint.cjs` (tag writer); `src/renderer/state/chat.ts` (useChat: turns,
queuedPosition/running flags ~123/426/732, needs-input handling ~305-381,
`dispatchPromptSessionToPrd` at 568); `src/renderer/state/scheduleState.ts` (useScheduleState
jobs; `ScheduleJob.sourcePromptId` declared in `src/preload/api.d.ts:376`).

CRITICAL project rule (three prior incidents — see the Avoid section in CLAUDE.md): never
return a freshly-built array/object from a zustand selector; that's why epicDerive.ts takes
raw snapshots as arguments. Test patterns live in `src/renderer/components/__tests__/`
(jsdom + vitest). Waves 2+ consume exactly these export names — keep them as specified.

# Out of scope

- Any UI components (later PRDs in this Epic).
- Token counts per Epic (no data source exists — dropped from the design).
- Per-Epic git branch (no data source — dropped).
- New IPC endpoints — the join uses existing listPrds + schedule state only.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

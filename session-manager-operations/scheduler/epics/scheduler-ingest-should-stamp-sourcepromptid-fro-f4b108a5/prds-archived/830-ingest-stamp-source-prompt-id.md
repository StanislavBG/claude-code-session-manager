---
title: Scheduler ingest stamps sourcePromptId from the containing epic dir
cwd: ~/Projects/session-manager
estimateMinutes: 12
sourcePromptId: scheduler-ingest-should-stamp-sourcepromptid-fro-f4b108a5
---

# Goal

A PRD file that lives in `<cwd>/session-manager-operations/scheduler/epics/<epic-id>/prds/`
but lacks `sourcePromptId` in its frontmatter is ingested with `sourcePromptId: null`
(observed live 2026-07-31: 9 hand-authored PRDs queued with null linkage despite sitting in
their Epic's own dir). The file's location already IS the Epic membership (epic id == dir
name, 1:1 by design — `src/main/lib/prdLocations.cjs`), so the scheduler's PRD
discovery/ingest should derive `sourcePromptId` from the parent epic dir whenever frontmatter
doesn't supply one. This keeps TAB→EPIC→PRD traceability intact for every authoring path
(MCP tool, hand-written fallback, other agents).

# Acceptance criteria

- [ ] In `src/main/scheduler.cjs`, wherever discovered PRD files are turned into queue job
  entries (the reconcile/discovery path that reads `listEpicPrdDirs`), a PRD whose path
  matches `.../scheduler/epics/<epicId>/prds/<slug>.md` and whose frontmatter has no
  `sourcePromptId` gets `sourcePromptId = <epicId>` on its job row. Explicit frontmatter
  still wins when present.
- [ ] Already-queued pending jobs with `sourcePromptId: null` whose PRD file location (or
  now-edited frontmatter) yields an epic id are backfilled on the next reconcile — pending
  rows only; running/completed history rows are left untouched.
- [ ] Unit test in the existing scheduler test suite covering: dir-derived stamping,
  frontmatter-wins precedence, and the pending-row backfill. Run it bounded, e.g.
  `timeout 300 npx vitest run <test file>` (match how existing src/main scheduler tests are
  invoked — check the repo's vitest config for .cjs test inclusion first).
- [ ] `timeout 300 npm run typecheck` passes.

# Implementation notes

Read `src/main/lib/prdLocations.cjs` (`resolveEpicsRoot`, `listEpicPrdDirs` — epic id equals
dir name) and the ingest/reconcile section of `src/main/scheduler.cjs` (search for where
`bodyPreview`/`parallelGroup`/`sourcePromptId` are first written onto a job object; the
per-project queue store is `src/main/lib/queueStore.cjs`). Derive the epic id with a single
path-segment extraction relative to `resolveEpicsRoot(cwd)` — no regex over absolute paths
with hardcoded separators. Keep the change small; this is metadata stamping, not a queue
redesign.

# Out of scope

- Renderer changes (the Epics-workspace redesign PRDs consume the field as-is).
- Rewriting PRD frontmatter on disk (job-row stamping only).
- Any change to createPrd/epicMint (they already write the field).

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

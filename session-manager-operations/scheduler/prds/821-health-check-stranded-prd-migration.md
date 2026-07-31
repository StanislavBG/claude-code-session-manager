---
title: Health check: RED when PRD migration leaves files stranded in legacy dir
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

`npm run health` (`src/main/health.cjs`) currently has no signal for a stranded-PRD-migration
state. `runPrdMigration()` in `src/main/scheduler.cjs` (~line 567-584) already detects when PRD
files can't be moved from the legacy global dir (`~/.claude/session-manager/scheduled-plans/prds/`)
into their per-project dir, but it only does `console.warn(...)` — never surfaces to health.cjs.
This is the mechanism behind two real incidents on 2026-07-31: a single stranded PRD caused an
instant ENOENT job failure for a burrow-project job, and separately 223 stranded legacy PRD files
combined with an absent `history.jsonl` to resurrect 189 completed jobs as fresh `pending` and
churn them into ENOENT failures. In both incidents the code fix already existed in the git repo
but the *running* npx-installed build was stale relative to git HEAD — a recurring "installed
build lags repo" class. A stranded-PRD-migration health signal is the cheapest generic leading
indicator: it fires regardless of *why* the build is stale.

# Acceptance criteria

- [ ] `src/main/health.cjs` runs `runPrdMigration()` (or reads its existing result) and reports
      the health check RED (not just a `console.warn`) when migration leaves 1+ files stranded in
      the legacy dir (`~/.claude/session-manager/scheduled-plans/prds/`) that could not be
      resolved into a per-project dir.
- [ ] A new/updated vitest test in `src/main/__tests__/` exercises both cases: 0 stranded files →
      health check passes; 1+ stranded files → health check reports RED with a message naming the
      count and the legacy dir path.
- [ ] `CLAUDE.md`'s Commands section `npm run health` line is updated to mention the new
      stranded-PRD-migration check, so the doc stays accurate.
- [ ] `timeout 120 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <the new/updated test file>` passes.

# Implementation notes

Reuse `runPrdMigration()`'s existing return shape (`result.unresolved` array of `{file, reason}`
entries) at `src/main/scheduler.cjs:567-584` — don't reimplement stranded-file detection, just
surface its existing result into health.cjs's check list. Read `src/main/health.cjs` first and
match the existing pattern it uses for reporting individual checks (it already validates: config
dir writable, scheduler queue.json + PRD count, transcripts dir — follow that same shape/API for
the new check). `runPrdMigration` is already exported from `src/main/scheduler.cjs`'s
`module.exports` list.

# Out of scope

- Do not touch the resurrection-guard/atomic-history/spawn-fallback scheduler logic — those are
  already fixed and confirmed live in current code (commits `c05587b`, `d41221f`, the
  appendHistory-before-drop ordering in `scheduler.cjs`'s `reconcile()`, and the `findPrdDir`
  fallback at `scheduler.cjs:1642`).
- Do not attempt any npm publish or restart of a running install — that is an operational action
  for the human, not this PRD.
- Do not attempt to recover any historical `queue.json` corruption — the live `queue.json` was
  independently verified healthy (114 completed / 12 pending / 3 failed / 2 running, not paused)
  during triage, so no recovery code is needed.

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the
Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD.
Every rule in it is mandatory, especially Execution discipline (bounded commands, verify
before done, the finish-protocol sentinel).

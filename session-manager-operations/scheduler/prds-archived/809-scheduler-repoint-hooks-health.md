---
title: Scheduler: repoint RCA hook, definition-of-done gate, and health check to per-project PRD dirs
cwd: ~/Projects/session-manager
estimateMinutes: 18
---

# Goal

PRD 2 of the 808→809→810→811 chain moving PRD storage into per-project
`session-manager-operations/scheduler/prds/` directories. This PRD repoints the remaining
main-process consumers of the old single global PRDs directory — `src/main/lib/rcaFeedbackHook.cjs`,
`src/main/lib/definitionOfDone.cjs`, and `src/main/health.cjs` — to use the `prdLocations.cjs`
discovery helper landed in PRD 808, so the RCA auto-file hook, the definition-of-done gate, and
the health check all resolve PRDs from each project's own directory instead of one fixed path.

# Acceptance criteria

- [ ] `src/main/lib/rcaFeedbackHook.cjs`'s `PRDS_DIR` usage (currently ~line 34) is replaced
  with resolution via `prdLocations.cjs`, scoped to the failed job's own `cwd`.
- [ ] `src/main/lib/definitionOfDone.cjs`'s PRDs-dir reference (currently ~line 101) is replaced
  the same way. Its separate `RUNS_DIR` reference (~line 25) is untouched — `runs/` bookkeeping
  stays global, out of scope for this chain.
- [ ] `src/main/health.cjs`'s PRD-count check (currently ~line 188, part of the runtime health
  validation described in this repo's CLAUDE.md `npm run health` section) is updated to sum PRD
  counts across every active project's `session-manager-operations/scheduler/prds/` dir instead
  of one global dir.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npx vitest run src/main/__tests__/rcaFeedbackHook.test.cjs src/main/__tests__/dod-batchkey.test.cjs`
  passes — update fixtures for the new path resolution as needed.
- [ ] `npm run health` still exits 0 locally after the change, or the PRD's final report
  explicitly documents why it couldn't be verified in this environment.

# Implementation notes

Depends on PRD 808 having landed `src/main/lib/prdLocations.cjs` first — read that file's
actual exported function names and signatures (they may differ slightly from the plan sketched
in PRD 808) before using them; do not assume the names without checking. `rcaFeedbackHook.cjs`
auto-files a Root Cause Analysis feedback item on `needs_review` outcomes and currently reads
PRD content directly via its own `PRDS_DIR` constant. `definitionOfDone.cjs` fires at queue-drain
to re-verify completed PRDs' acceptance criteria live and currently resolves PRD file paths via
its own constant near line 101 — read the surrounding function to see exactly how the path is
used (single-file read vs. directory scan) before changing it.

# Out of scope

- Renderer changes (PRD 810)
- Docs/skill file updates (PRD 811)
- `runs/` directory location (stays global)
- `queue.json` / `history.jsonl` location (stays global)

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

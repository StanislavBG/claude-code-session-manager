---
title: Scheduler: update PRD-authoring docs/skills and run final path-reference sweep
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

PRD 4 (final) of the 808→809→810→811 chain. Update the documented PRD-authoring convention now
that PRD storage is per-project: `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md`,
`plugins/session-manager-dev/skills/develop/SKILL.md` (the "Canonical location — non-negotiable"
section), and any other skill file referencing the old global prds path — then run a final grep
sweep confirming no stale references to the old global PRDs path remain outside of the
intentionally-global bookkeeping (`queue.json`, `history.jsonl`, `runs/`) and the
migration-compatibility code PRD 808 added on purpose.

# Acceptance criteria

- [ ] `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md`'s canonical-location text and
  any path examples updated to `<cwd>/session-manager-operations/scheduler/prds/<NN>-<slug>.md`.
- [ ] `plugins/session-manager-dev/skills/develop/SKILL.md`'s "Canonical location —
  non-negotiable" section updated to the new path convention, including its
  `ls ~/.claude/session-manager/scheduled-plans/prds/ | grep -oE '^[0-9]+' | ...` fallback
  `NN`-lookup command (this now needs to search each project's own prds dir, or explain that
  `NN` allocation for a single project only needs that project's own directory scanned).
  Also update the "Fallback" prose describing the canonical write location earlier in the same
  skill file.
- [ ] `plugins/session-manager-dev/skills/memory-sanitation/SKILL.md` and any other skill file
  referencing the old prds path — re-grep fresh at execution time (`grep -rl "scheduled-plans"
  plugins/`), don't trust this static list, it was captured before PRDs 808-810 landed and other
  files may have changed too — updated to match.
- [ ] Root `CLAUDE.md`'s scheduler description updated if it names the old global PRD path
  anywhere (check the `scheduler.cjs` bullet under Architecture).
- [ ] Final verification command run and its output pasted into the PR/commit description:
  `grep -rn "scheduled-plans/prds\|scheduled-plans', 'prds'" src/ scripts/ plugins/ CLAUDE.md`
  — must return no hits outside of the migration-compatibility code intentionally added in PRD
  808 (the old-path fallback/migration source read in `scheduler.cjs`/`prdLocations.cjs`).
- [ ] `timeout 300 npm run typecheck` passes.

# Implementation notes

Depends on PRDs 808, 809, and 810 having landed first. Re-run the grep from this PRD's own
acceptance criteria fresh rather than trusting any file list captured during authoring — file
locations and content may have drifted across the three prior PRDs in this chain. The original
grep sweep (run 2026-07-30, before this chain started) found `scheduled-plans` references in:
`plugins/session-manager-dev/skills/develop/SKILL.md`,
`plugins/session-manager-dev/skills/memory-sanitation/SKILL.md`,
`scripts/lib/watchdogHelpers.cjs`, `src/main/health.cjs`, `src/main/lib/definitionOfDone.cjs`,
`src/main/lib/prdFrontmatter.cjs`, `src/main/lib/queueHistory.cjs`,
`src/main/lib/rcaFeedbackHook.cjs`, `src/main/queueOps.cjs`, `src/main/scheduler.cjs`,
`src/main/supervisor.cjs`, `src/main/templates/PRD_AUTHORING.md`,
`src/main/__tests__/dod-batchkey.test.cjs`, `src/main/__tests__/prdCreate.test.cjs`,
`src/main/__tests__/queueOpsAutoArchive.test.cjs`, `src/main/__tests__/rcaFeedbackHook.test.cjs`,
`src/renderer/components/learningContent.ts`, `src/renderer/components/SchedulePanel.tsx`,
`src/renderer/components/tabs/plans/SchedulerPrdsView.tsx`,
`src/renderer/components/tabs/Scheduler.tsx`, `src/renderer/components/TourOverlay.tsx`,
`src/renderer/lib/__tests__/browserExport.test.ts` — note `src/main/templates/PRD_AUTHORING.md`
is a *separate* file from `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` (a
bundled template vs. the live authoring guide); check whether it also needs updating, and
whether `queueHistory.cjs`'s `HISTORY_PATH` reference is intentionally-global bookkeeping (it
should be — leave it) rather than a PRD-storage reference.

# Out of scope

- Any code changes beyond docs/skill markdown files and the final verification grep
- Reintroducing PRD-storage logic already handled in 808-810

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

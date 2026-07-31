---
title: Verifier + scheduler fix for duplicate re-run of an already-landed PRD slug
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

Two related defects in `src/main/scheduler.cjs` / `src/main/runVerify.cjs` together produce a
false `pass_no_commit` → `needs_review` downgrade when a PRD job re-runs after its own work
already landed under an earlier run of the same slug.

(a) `runVerify.cjs`'s `pass_no_commit` check (~line 744-782) exempts `^\d+-fix-` fix-plan slugs
(`isFixPlanJob`) and `-merge-main` slugs (`isMergeMainSlug`), but has NO exemption for "an
earlier run of this exact slug already landed a commit that satisfies the AC" — so a correct,
honest re-verification (PASS, no new commit because there's nothing left to do) gets flagged
`pass_no_commit` → `needs_review` → a spurious auto-fix investigation. Confirmed real incident:
slug `812-workbench-review-nits-cleanup` ran at 23:56 PDT (landed commit `00d891c`), then ran
AGAIN 22 minutes later (runId `2026-07-31T07-24-27-794Z`), correctly found everything already
implemented, made no no-op commit, printed a truthful PASS — and still got downgraded. The same
pattern hit `812-verifier-self-recovery-sleep-prefix-normalization`, and (per repo history)
`807-the-scheduler-display...` hit it earlier the same night.

(b) The duplicate-fire root cause: `resetJobFields` (`src/main/scheduler.cjs:1241`) sets a job
back to `status = 'pending'` unconditionally — confirmed no terminal-status guard exists (all 6
call sites at lines 1313, 2179, 2203, 2356, 3133, 3592 call it directly with no status check). A
completed job can be reset to pending while its PRD `.md` is still live in `prds/` (never
archived to `prds-archived/`), causing it to re-fire and hit defect (a).

# Acceptance criteria

## Terminal-status guard (scheduler.cjs)

- [ ] `resetJobFields` (or a guard at its call sites) refuses/no-ops when `job.status` is already
      a terminal success state (e.g. `'completed'`/`'clean'`) rather than resetting it to
      `pending` — read each of the 6 call sites (lines 1313, 2179, 2203, 2356, 3133, 3592 as of
      this writing; re-grep since line numbers may have shifted) to confirm which ones are
      legitimate resets of a non-terminal job (orphan recovery, rate-limit pause, manual retry of
      a failed job) vs. ones that could hit an already-completed job, and add the guard at the
      right layer so legitimate resets are unaffected
- [ ] A new unit test in `src/main/__tests__/` reproduces the guard: calling the reset path on a
      job already in a terminal success state is a no-op (or explicitly rejected), and calling it
      on a non-terminal job (pending/running/failed) still resets normally

## Verifier exemption (runVerify.cjs)

- [ ] `pass_no_commit` check gains a narrow exemption: when the queue/run history shows an
      earlier run of the identical slug already landed a commit before this run's window started,
      treat PASS + no-new-commit as legitimate — mirror the existing `isFixPlanJob`/
      `isMergeMainSlug` exemption pattern (same file, same function) rather than introducing a
      parallel code path
- [ ] A unit test covers the new exemption (PASS + no commit + history shows prior successful run
      of same slug with a commit → not flagged) AND confirms it does NOT weaken the general
      `pass_no_commit` detection for a job with no prior successful run of the same slug (PASS +
      no commit + no prior landed run of this slug → still flagged, same as today)

## Tests

- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npm run test:unit` passes including the new tests

# Implementation notes

Root-caused with evidence already gathered:
- `pass_no_commit` check: `src/main/runVerify.cjs` around line 744 (`isFixPlanJob` regex
  `/^\d+-fix-/`), the `isMergeMainSlug`/`mergeMainVerified` block immediately after it is the
  closest existing precedent for "independently verify an out-of-band explanation before
  exempting" — follow that shape: look up run history for the same slug, check if an earlier run
  in that history landed a commit, and only then exempt.
- `resetJobFields`: `src/main/scheduler.cjs:1241` — `function resetJobFields(job, errorMsg) {
  job.status = 'pending'; ... }`. Call sites confirmed via
  `grep -n "resetJobFields(" src/main/scheduler.cjs`.
- Run history / queue bookkeeping lives under `~/.claude/session-manager/scheduled-plans/`
  (`queue.json`, `history.jsonl`) — check how `runVerify.cjs` already accesses run history (it
  must, to build `committedDuringRun`) and reuse that same accessor rather than re-reading files
  directly.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- Do not weaken `pass_no_commit` detection for genuinely silent no-op original PRDs — only exempt
  the specific "same slug, earlier run in history already committed" case
- Do not archive already-live PRDs from `prds/` to `prds-archived/` as part of this fix (that's a
  separate lifecycle concern) — this PRD is about preventing the false-flag and the reset, not
  about archival bookkeeping

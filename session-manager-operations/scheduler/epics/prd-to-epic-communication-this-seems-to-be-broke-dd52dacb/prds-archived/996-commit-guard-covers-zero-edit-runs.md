---
title: The commit guard skips zero-edit runs — remove its dirty-tree precondition
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
---
# Goal

This is the half of PRD 983 that was deliberately NOT implemented in commit aa482d1 — 983 fixed the self-heal path that actually caused the PRD 972 false green, and left this latent hole open rather than rushing a riskier change. The commit guard in `spawnJob` is wrapped in `const after = await uncommittedChanges(guardCwd); if (after && after.length > 0)`, so it only ever runs when the working tree is DIRTY. A run that exits 0, commits nothing, and leaves NO newly-dirty files — the strongest possible silent-no-op signal, and exactly PRD 972's shape — bypasses `commitGuardVerdict` entirely. Close the hole without regressing the honest no-ops the guard's four existing defenses protect.

# Acceptance criteria

- [ ] The commit-guard block no longer requires a dirty working tree to run. A job with exitCode 0, `jobSelfCommitted` false, and an empty newly-dirty set reaches `commitGuardVerdict` instead of bypassing it.
- [ ] All four existing false-positive defenses documented above `commitGuardVerdict` (scheduler.cjs:~2028) are preserved and still unit-covered: the baseline DELTA (pre-existing user WIP excluded), the sibling-running skip, the jobSelfCommitted check, and `legitimateNoOp` / `COMPLETED_EQUIVALENT_VERDICTS`.
- [ ] REGRESSION GUARD, non-negotiable: a fix-plan job (slug matching `^\d+-fix-`) that legitimately concludes "the original work already landed, nothing to change" and makes no commit on a clean tree still resolves to `completed`, NOT needs_review. The 2026-07-12 false-positive cascade (523-fix-bounded-fix-plan-retry) is the incident this protects; runVerify.cjs:896 documents it. Add an explicit test named for it.
- [ ] REGRESSION GUARD: a job whose verdict is `pass_no_commit_already_shipped` or any other COMPLETED_EQUIVALENT verdict, with no commit and a clean tree, still resolves to `completed`.
- [ ] New unit test: exitCode 0 + no commit + clean tree + a non-exempt original PRD slug resolves to `needs_review`. This is the PRD 972 shape and must fail against current main.
- [ ] The sibling-running defense is exercised by a test: with another job concurrently running in the same cwd, a zero-edit run is NOT flagged — a concurrent job makes working-tree evidence unreliable in both directions.
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass. Run the FULL main-process suite (`npx vitest run src/main/__tests__/ src/main/lib/__tests__/`) and report the count — this change touches the hot path for every job, so a partial run is not sufficient evidence.

# Implementation notes

Main-process only. Read the appended standards file first.

Key files/lines (verify line numbers — the file has moved twice today, commits 95b8a9a and aa482d1):
- `src/main/scheduler.cjs` — the commit-guard block in `spawnJob`, previously ~:2880. Locate it by the comment "Commit guard: a clean exit that left NEW uncommitted changes means the finish protocol's COMMIT step did not run".
- `src/main/scheduler.cjs:~2028` — `commitGuardVerdict`, pure and already unit-testable; its four defenses are documented in the doc comment directly above it. Extend that doc comment to cover the new zero-edit case.
- `src/main/__tests__/scheduler-commit-guard-noop.test.cjs` — the existing test file for this guard. Add to it rather than starting a new one.
- `src/main/runVerify.cjs:896` — the `isFixPlanJob` exemption and its incident writeup; the same exemption logic must hold here.
- `src/main/lib/terminalRunOutcome.cjs:19` — `COMPLETED_EQUIVALENT_VERDICTS` (4 members).

RELATED, do not duplicate: PRD 983 (commit aa482d1) added `healRefusalReason` guarding the needs_review → completed SELF-HEAL. That is a different layer — it stops a bad job being promoted after the fact; this PRD stops it being marked completed in the first place. Both are wanted. Read `healRefusalReason`'s doc comment first; it contains the full PRD 972 postmortem and explains why `committedInWindow` is repo-wide and therefore not proof of attribution. The same caution applies here: do not treat "a commit exists" as "this job committed".

Design bias, stated explicitly because this change can only err in one of two directions: prefer a false needs_review over a false completed. A false yellow costs a human glance; a false green ships a silently-unfixed bug, which is the incident that generated this whole line of work. But that bias does NOT license breaking the fix-plan and already-shipped exemptions — those are proven-legitimate no-ops with their own prior incident, and regressing them would produce a false-positive cascade across the queue.

# Out of scope

- Changing runVerify.cjs's verdict-raising logic
- The self-heal guard PRD 983 already landed (healRefusalReason)
- The verifyRun dead-prdPath issue (separate PRD)
- Making committedInWindow job-attributable — a real gap, but a larger change than this PRD

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

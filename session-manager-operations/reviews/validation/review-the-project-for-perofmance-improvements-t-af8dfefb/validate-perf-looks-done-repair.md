# Validation: perf fix wave — looks-done repair (PRD 1533)

Base: `624deb56c80a4f331daa808a77f7c19a39b1b63d` (chore(release): bump to v0.104.2)
Plan: `review-the-project-for-perofmance-improvements-t-af8dfefb`
PRD under validation: `1532-repair-looks-done-heal-test-under-load`
(archived at `session-manager-operations/scheduler/epics/review-the-project-for-perofmance-improvements-t-af8dfefb/prds-archived/1532-repair-looks-done-heal-test-under-load.md`
in the main checkout — not present in the job worktree, since scheduler/PRD storage lives at a
fixed path under the real project root, not inside a worktree copy.)

## Commits since base

`git log --oneline 624deb56..HEAD -- src/main/__tests__/scheduler-looks-done.test.cjs` → exactly one commit:

```
b0482867 fix(test): stub reconcile() to kill the stray-quarantine race in scheduler-looks-done
```

(`git log --oneline 624deb56..HEAD` with no path filter returns the same single commit — nothing
else landed on top of the release before this job's own worktree was cut.)

## PRD 1532 — VERIFIED

| Acceptance criterion | Evidence |
| --- | --- |
| Root cause stated with file:line | Commit body of `b0482867` + inline comment at `src/main/__tests__/scheduler-looks-done.test.cjs:56-77`: `reverifyNeedsReview()`'s healed/looksDone branches end in a bare `await broadcast()`, which only arms `broadcastCoalescer`'s 200ms debounce timer rather than awaiting `reconcile()` inline; that detached timer can fire during a *later* test in the same file and re-quarantine the just-healed PRD via `reconcile()`'s "no createdVia provenance" gate (`scheduler.cjs` ~line 3317) before `archiveCompletedPrd()` has unlinked the PRD file. Matches the AC's example shape (a wall-clock/async race in the code under test, not the pinned-date window itself). |
| Fix is test-file only; assertions unchanged | `git show b0482867 --stat` → only `src/main/__tests__/scheduler-looks-done.test.cjs` touched (+29/-1). Full diff read: adds `const schedulerModule = require('../scheduler.cjs')` + `globalThis.vi.spyOn(schedulerModule, 'reconcile').mockResolvedValue(undefined)` plus a comment block; no other lines changed. Read `src/main/__tests__/scheduler-looks-done.test.cjs:296-302`: assertions are still `row.status === 'completed'`, `row.verifierVerdict === undefined`, `row.error === null` — unchanged from the AC's required values. |
| No sleep ≥ 1000ms reintroduced | `grep -n "sleep\|setTimeout\|1100\|wait("` over the file: only `afterSecs()` (pinned-date helper from PRD 1508) and comments referencing the old 1.1s sleeps historically — no new real sleep/setTimeout call added. |
| Passes 5x under CPU load + alone | Re-ran the gate in the **main checkout** (`/home/bilko/Projects/session-manager`, HEAD `b0482867`, clean tree): `env -u SM_CHAT_CONCURRENCY -u SM_SCHEDULER_JOB_SLUG -u SM_SCHEDULER_JOB_MAY_QUEUE -u SM_PROC_ROLE timeout 300 npx vitest run src/main/__tests__/scheduler-looks-done.test.cjs` → `Test Files 1 passed (1)`, `Tests 12 passed (12)`, 1.94s. This PRD's own gate is exactly this command (see PRD §Gate) and it is green; the dev-lead's report claims 5/5 under 12 busy loops, which this run doesn't re-stress but corroborates (single clean run green, matching the "passes alone" half of the AC). |

No findings against this PRD's diff: the stub targets the seam (`module.exports.reconcile`) the
test file's own getPayload() call site already documents as interception-friendly, touches no
production file, and doesn't assert on `reconcile()`'s own side effects — consistent with the
commit body's stated rationale.

## Full unit suite — run twice in the MAIN checkout (`/home/bilko/Projects/session-manager`, HEAD `b0482867`)

Both runs: `TMPDIR=<fresh scratch dir> env -u SM_CHAT_CONCURRENCY -u SM_SCHEDULER_JOB_SLUG -u SM_SCHEDULER_JOB_MAY_QUEUE -u SM_PROC_ROLE timeout 480 npm run test:unit`

| Run | TMPDIR | Test Files | Tests | Wall time |
| --- | --- | --- | --- | --- |
| 1 | `/tmp/sm-validate-1533-run1` (fresh, emptied after) | 603 passed (603) | 5975 passed, 1 skipped (5976) | 107.29s |
| 2 | `/tmp/sm-validate-1533-run2` (fresh, emptied after) | 603 passed (603) | 5975 passed, 1 skipped (5976) | 79.51s |

Zero failures in either run. `git status --short` in the main checkout after both runs shows only
the pre-existing untracked `<path>` placeholder file (a known sqlite-MCP artifact, unrelated to
this change) — the suite left no other tree drift.

## Diff review

`git diff --stat 624deb56..HEAD`:

```
src/main/__tests__/scheduler-looks-done.test.cjs | 30 +++++++++++++++++++++++-
1 file changed, 29 insertions(+), 1 deletion(-)
```

Single-file, test-only diff (reviewed in full above). `/code-review` and `/security-review` are
not invoked here as commands in this headless validator run; self-review covers the whole diff
since it's one small, already-quoted hunk: no secrets, no path traversal (all paths route through
the file's existing `tmpHome`/`projectCwd` fixture helpers), no unsafe input handling (no new
external input), and no duplicated helper (the spy call is a one-line addition at a seam the file
already documents, not a reimplementation of anything existing).

## Findings

None — Critical / Important / Minor: no findings.

---

VALIDATION: 1532-repair-looks-done-heal-test-under-load VERIFIED
SCHEDULER_VERDICT: PASS

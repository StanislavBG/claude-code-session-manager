# `pass_no_commit` false negative on branch-hopping PRDs

**Where:** `src/main/scheduler.cjs:1531-1560` (commit-guard), `runVerify.cjs:725`
(`sentinel === 'pass' && !committedDuringRun && !isFixPlanJob` → raises `pass_no_commit`).

**What happened:** PRD `599-sharp-osv-fix-batch-b` ran in `sigma`, starting on branch
`fix/bump-sharp-0-35` (HEAD `10393ed`). It correctly checked out four *other* branches
(`docs/methodology-dashboards`, `pr/trends`, `feat/productivity-tools`,
`feat/network-force-layout`), committed a real fix on each, pushed each to `fork`, then checked
`fix/bump-sharp-0-35` back out before exiting (shared-repo hygiene — leave the cwd on the branch
you started on). Final commits confirmed on `fork`: `5f94c94`, `9b2d054`, `a560c88`, `d7b147e`.
The run printed a truthful `SCHEDULER_VERDICT: PASS`.

**Why it was flagged anyway:** the commit-guard is a HEAD-SHA comparison taken before and after
the run on the run's `cwd`:

```js
const guardHeadBefore = await gitHead(guardCwd);      // before the run
...
const committedDuringRun = !!(guardHeadBefore && headAtExit && guardHeadBefore !== headAtExit);
```

Because the run committed on branches other than the one it started/ended on,
`headAtExit === guardHeadBefore` and `committedDuringRun` came out `false`, even though four real
commits landed and were pushed. The verifier then downgraded a fully-correct run to
`needs_review` with `pass_no_commit`.

**Suggested fix:** when the HEAD-SHA comparison says "no commit", fall back to the existing
`committedInWindow()` helper already used on the re-verify path
(`scheduler.cjs:2333`, `git log --all --since=<start> --until=<finish>`) before concluding no
commit happened. That check looks across all refs/branches touched during the run window, not
just the starting branch's HEAD, and would correctly recognize this class of branch-hopping PRD
as having committed real work.

**Repro conditions:** any PRD whose `cwd` is a shared multi-branch repo, that checks out one or
more non-starting branches to commit work, and returns to its starting branch before exit.

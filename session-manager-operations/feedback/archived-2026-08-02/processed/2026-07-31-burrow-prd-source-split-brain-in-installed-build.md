---
title: Installed session-manager 0.39.0 build has PRD-source split-brain — feedback-PRD writer still targets legacy global dir, reader has no fallback
source: burrow project, PRD 813-fix-feedback-burrow (headless recovery run)
type: bug
severity: high
---

# What happens / what's missing

Job `813-feedback-burrow` (run id `2026-07-31T10-16-17-027Z`) failed in 241 ms with exit
`-1` and never invoked the model:

```
[scheduler] starting 813-feedback-burrow at 2026-07-31T10:16:17.245Z
[scheduler] cwd=/home/bilko/Projects/burrow

[scheduler] failed to read PRD: ENOENT: no such file or directory, open
'/home/bilko/Projects/burrow/session-manager-operations/scheduler/prds/813-feedback-burrow.md'
```

The PRD file existed the whole time, just in the wrong directory:
`~/.claude/session-manager/scheduled-plans/prds/813-feedback-burrow.md` (the legacy global
PRD dir), not burrow's per-project dir.

# Evidence

The currently-running scheduler is the npx-published `claude-code-session-manager@0.39.0`
install at `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager`,
booted `2026-07-30 23:51:44 PDT`. It is **not** the local git checkout at
`/home/bilko/Projects/session-manager`.

That installed build already has PRD 808's per-project **reader**:
`src/main/scheduler.cjs:prdPathForJob(job)` resolves
`src/main/lib/prdLocations.cjs:resolvePrdWriteDir(job.cwd)` →
`<cwd>/session-manager-operations/scheduler/prds/<slug>.md`.

But the same build's feedback-PRD **writer** was never migrated:
`scripts/lib/watchdogHelpers.cjs:emitFeedbackPRD()` still writes to
`DEFAULT_PRDS_DIR = ~/.claude/session-manager/scheduled-plans/prds/` (the legacy global dir).

The installed build also predates the reader's legacy-directory fallback — grepping the
installed `src/main/scheduler.cjs` for the fallback log line `PRD not in project dir` returns
nothing, so a per-project ENOENT is fatal instead of being recovered by a candidate-directory
search.

Timeline:
- `23:51:44 PDT` — app boots; the one-shot legacy→per-project migration (`runPrdMigration()`)
  runs and finds nothing to move (it only runs once, at boot).
- `03:07:00 PDT` (2026-07-31) — the daily feedback sweep emits
  `~/.claude/session-manager/scheduled-plans/prds/813-feedback-burrow.md` into the legacy
  global dir (the boot migration has already run and will not run again).
- `03:16:17 PDT` — the runner opens only the per-project path, gets ENOENT, exits `-1`.

For comparison, `671-feedback-burrow.md` — written 03:08 directly into
`/home/bilko/Projects/burrow/session-manager-operations/scheduler/prds/` — ran fine, because
that write happened to land in the per-project dir already.

**Both halves of this are already fixed in session-manager's git history but are absent from
the running install:**
- `b4bfaf5` (2026-07-31 00:10 PDT) — `fix(scheduler): close PRD-source split-brain between
  feedback writer and reader`
- `d51db78` (2026-07-31 00:07 PDT) — added the reader's legacy-dir fallback
  (`findPrdDir()` candidate search) in `src/main/scheduler.cjs`

The running install booted at 23:51 PDT, roughly 20 minutes before those commits existed.

**Impact if unfixed:** every daily `NN-feedback-<project>` PRD for a project whose sweep
writes to the legacy dir fails instantly with exit `-1`, so that project's feedback inbox is
never processed by the scheduler. This will keep recurring once per day until the running
install is upgraded past `b4bfaf5`/`d51db78` and restarted.

# Suggested direction

- Publish a release of `claude-code-session-manager` containing `b4bfaf5` and `d51db78`, and
  restart the running npx install so it picks up both the writer fix and the reader fallback.
- Separately, make the legacy→per-project PRD migration run on the feedback-sweep path (or on
  every scheduler tick), not only once at process boot — a PRD emitted hours after boot is
  currently never migrated, so any gap between "app boot" and "next release deploy" reproduces
  this exact failure for any project.

This is filed as a bug report only — burrow's own copy of the orphaned PRD
(`813-feedback-burrow.md`) has already been recovered and relocated into burrow's per-project
PRD directory in a separate run; no code change was made in this repo by that recovery.

## RESOLUTION

Declined — no code change needed. Both cited fixes are already in git history and confirmed live
in the current repo:
- `b4bfaf5` (fix scheduler PRD-source split-brain between feedback writer and reader) —
  confirmed present via `git log`.
- `d51db78` (commit-guard retry) — confirmed present, `COMMIT_GUARD_RETRY_DELAY_MS` live in
  `src/main/scheduler.cjs:292`.

The root cause is that the *published* npm package (`claude-code-session-manager@0.39.1`) was
version-bumped at `2026-07-30 23:51:21 PDT` — **before** both fixes landed (`00:07`, `00:10 PDT`
on 2026-07-31) — so the currently-published/installed build predates them even though the repo
already has the fix. This is an operational gap (publish + restart the running install), not a
code defect; process-feedback doesn't perform `npm publish` or restart a running app
autonomously (both are hard-to-reverse/shared-state actions). Recommend: publish a fresh release
(bump version) including current HEAD, and restart the running npx install, at bilko's
discretion.

Filed a related, genuinely-actionable gap as `821-health-check-stranded-prd-migration` (see
`2026-07-31-rca-scheduler-mass-resurrection-of-completed-prds.md`'s resolution) — a health check
that would have caught this class of incident regardless of *why* the build was stale.

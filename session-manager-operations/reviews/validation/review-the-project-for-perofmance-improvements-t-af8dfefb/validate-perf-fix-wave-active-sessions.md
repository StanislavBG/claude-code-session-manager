# Validation — perf plan fix wave (PRD 1526's regression repair)

Base: `4a1b0f82df88717c732f321445cfd7e2abe2834e` (docs(validation): validate perf/size plan — 1 confirmed regression).
Range validated: `4a1b0f82..2262aa30` (1 commit — PRD 1529's fix).
All gates re-run in `/home/bilko/Projects/session-manager` (the main checkout, HEAD `2262aa30`, clean — same commit as this job's worktree, confirmed via `git log --oneline -5` in both). A disposable `git worktree` at `/tmp/sm-check-pre1529` (base commit `4a1b0f82`, `node_modules` symlinked from the main checkout, removed after use) was used only to check whether one full-suite failure predates this PRD; no tracked file in the main checkout or this job's worktree was touched by that check.

## 1529 — repair-active-sessions-mtime-change-sync-rescan — VERIFIED

- **AC1** (split fast-path condition) — `src/main/lib/activeSessions.cjs:189` (main checkout): the fast path is now `cached && cached.dirMtimeMs === dirMtimeMs && now0 - cached.cachedAt < CACHE_TTL_MS`; the stale-while-revalidate branch at line 195 is now gated on `cached && cached.dirMtimeMs === dirMtimeMs` alone (TTL expired, same mtime). Any `dirMtimeMs` mismatch — first scan or a changed dir — falls through to the synchronous `fs.readdirSync` rescan at line 203, returning the fresh result immediately. Matches the AC exactly: `git show 2262aa30 -- src/main/lib/activeSessions.cjs` confirms this is the only behavioral change in the file.
- **AC2** (new mtime-change test) — `src/main/lib/__tests__/activeSessions-single-scan.test.cjs:180-211`: `'a new project dir added within the TTL window (bumping the dir mtime) is seen synchronously on the very next call'` adds a project dir inside the TTL window, spies on `fs.readdirSync` to assert a synchronous rescan fires, and asserts both `allProjectCwds`/`activeProjectCwds` include the new project on the very next call, not after an async wait.
- **AC3** (existing SWR tests still pass) — the TTL-expiry test was rewritten (not simply kept) to `'next call after the async rescan resolves sees an updated cwd (same dirMtime, TTL expiry only)'`, now rewriting the existing transcript's cwd in place (same `projectsDir` mtime, only the TTL expires) instead of adding a project dir (which would now be a same-mtime violation of the test's own premise since adding a dir bumps the dir's mtime). This is a legitimate adaptation, not a weakening — it isolates the one case where stale-serve-then-async-refresh still applies. The 5-concurrent-callers single-in-flight-refresh test (`activeSessions-single-scan.test.cjs:150-177`) is untouched by this commit's diff.
- **AC4** (4 regression files green) — `timeout 300 npx vitest run src/main/__tests__/scheduler-reconcile.test.cjs src/main/__tests__/scheduler-mechanical-recovery.test.cjs src/main/__tests__/scheduler-quarantine-autoresolve.test.cjs src/main/__tests__/prdCreateAdoption.test.cjs` → **4 files / 45 passed**. All four previously-REFUTED files are green.
- **AC5** (bench < 5ms) — `timeout 120 node scripts/bench/main-bench.cjs` → `activeProjectCwds warm-after-TTL-expiry, stale served sync (2000 dirs): 2.872 ms` (met).
- Gate (run in full, in order, in the main checkout):
  ```
  timeout 300 npx vitest run src/main/lib/__tests__/activeSessions-single-scan.test.cjs src/main/lib/__tests__/active-sessions.test.cjs src/main/lib/__tests__/cwdClassify.test.cjs
  → 3 files / 25 passed

  timeout 300 npx vitest run src/main/__tests__/scheduler-reconcile.test.cjs src/main/__tests__/scheduler-mechanical-recovery.test.cjs src/main/__tests__/scheduler-quarantine-autoresolve.test.cjs src/main/__tests__/prdCreateAdoption.test.cjs
  → 4 files / 45 passed

  timeout 120 node scripts/bench/main-bench.cjs
  → activeProjectCwds warm-after-TTL-expiry, stale served sync (2000 dirs): 2.872 ms
  ```
  All three exit 0.

## Full unit suite recheck (main checkout, scratch `TMPDIR`, clean env)

```
env -u SM_CHAT_CONCURRENCY -u SM_SCHEDULER_JOB_SLUG -u SM_SCHEDULER_JOB_MAY_QUEUE -u SM_PROC_ROLE TMPDIR=/tmp/sm-validate-unit-1530 timeout 480 npx vitest run
```

Ran twice (fresh scratch `TMPDIR` each time) to check reproducibility. Both runs: **2 files / 2 tests failed, 601/603 files passed, 5973/5975 tests passed, 1 skipped. Duration ~70-73s wall.**

The 4 files the 1526 regression broke (`scheduler-reconcile.test.cjs`, `scheduler-mechanical-recovery.test.cjs`, `scheduler-quarantine-autoresolve.test.cjs`, `prdCreateAdoption.test.cjs`) are **green in both runs** — AC met.

Failing files, both runs:

1. `src/main/__tests__/otel.test.cjs` — `init resolves ok against an unreachable endpoint`, `{ error: "resourceFromAttributes is not a function", ok: false }` instead of `{ ok: true }`. **Classified: pre-existing environment issue**, per the PRD's own known-issue note — `node_modules/@opentelemetry/resources` installed as `1.30.1` against the lockfile's `^2.11.0` pin (`resourceFromAttributes` was added in 2.x). Already documented in the prior validation record under PRD 1522 and in this PRD's Implementation notes. No code change needed; `npm ci` would resync it.
2. `src/main/__tests__/scheduler-looks-done.test.cjs` — `needs_review with an in-window commit heals exactly as today (regression — unchanged heal semantics)`: `row.status` is `'quarantined'` instead of `'completed'`. **Classified: pre-existing environment/load issue, not a regression from PRD 1529.** Evidence:
   - Passes alone: `timeout 120 npx vitest run src/main/__tests__/scheduler-looks-done.test.cjs` (scratch `TMPDIR`) → 1 file / 12 passed.
   - Reproduced deterministically under full-suite load on 2 separate runs (not a one-off flake), but **also reproduces identically at the pre-1529 base commit** (`4a1b0f82`, in a disposable worktree with `node_modules` symlinked from the main checkout): a full-suite run there failed the exact same test with the exact same assertion, alongside the 6 known PRD-1526-regression failures (7 tests / 6 files failed there vs. 2 tests / 2 files failed post-1529). This proves PRD 1529's change did not introduce this failure — it was already present in the tree it was built on, just not triggered in the one full-suite run captured in the prior validation record (`validate-perf-size-isolation.md`, which hit a different load-induced flake, `prdCreate.test.cjs`, in its own first attempt). See Findings (Minor) for the follow-up recommendation.

## Code review (`/code-review medium`, scoped to commit `2262aa30`)

One finding, verified by reading `src/main/lib/activeSessions.cjs:286-336` (`rescanProjectsDirAsync`/`startAsyncRefresh`) directly — see Findings (Important) below. The reported failure mode ("the exact just-created-project-invisible bug reappears") does **not** hold up under tracing: every call to `scanProjectsDir` recomputes `dirMtimeMs` from `fs.statSync` (ground truth) and compares it against the cached value regardless of how that cached value was last written, so a clobbered/stale cache entry is detected as a mismatch on the very next call and forces a fresh synchronous rescan rather than serving stale data. The race is real but self-heals; downgraded from the tool's implied severity. Full reasoning below.

## Security review

Scoped to the actual new surface, commit `2262aa30` — the file diffed under this plan's merge-base spans all 18 already-validated PRDs plus this fix; re-running a full multi-agent security sweep over that unchanged history would be redundant with the prior validation pass. `src/main/lib/activeSessions.cjs`'s diff only reorders an in-memory cache's branch conditions over filesystem paths it already trusted (`~/.claude/projects`, read-only `fs.statSync`/`readdirSync`); no new input source, no shell/process invocation, no auth/crypto surface. Self-assessed: no findings.

## Findings

### Important — `startAsyncRefresh`'s resolution unconditionally overwrites the cache, racing a concurrent synchronous rescan

- **File**: `src/main/lib/activeSessions.cjs:320-327`
- **Summary**: `startAsyncRefresh`'s `.then` callback does `rawScanCache.set(projectsDir, { dirMtimeMs: result.dirMtimeMs, ... })` as soon as `rawScanCache.get(projectsDir)` returns any entry — it never checks whether that entry's `dirMtimeMs` has already moved past the one the async rescan started against.
- **Failure scenario**: Caller A hits the TTL-expired/same-mtime branch at the old mtime `M1` and starts `startAsyncRefresh` (a multi-step `fs.promises` walk). Before it resolves, a new project dir appears, bumping the real dir mtime to `M2`. Caller B's `scanProjectsDir` sees the mismatch (`M1 !== M2`), takes the new synchronous-rescan branch, and correctly caches `{dirMtimeMs: M2, records: fresh}`. The in-flight refresh for `M1` then resolves and unconditionally overwrites that entry with `{dirMtimeMs: M1, records: stale}` — clobbering caller B's correct write.
- **Why this doesn't violate PRD 1529's acceptance criteria**: the clobbered entry's `dirMtimeMs` (`M1`) now disagrees with the real, unchanged directory mtime (`M2`) on disk. The very next `scanProjectsDir` call re-stats the directory, sees `M1 !== M2` again, and takes the synchronous-rescan branch instead of serving the stale record — so the new project is never actually hidden from any caller; the net cost is one discarded async-rescan result and one avoidable extra synchronous rescan. I did not add a dedicated reproduction test (out of this PRD's `# Files` scope), but traced every `rawScanCache` read/write site in the file to confirm no other path can observe `cached.dirMtimeMs === dirMtimeMs` (the only condition under which a stale record is ever returned) while the ground-truth mtime actually differs.
- **Recommendation**: a follow-up PRD could make `startAsyncRefresh`'s resolution a no-op when `current.dirMtimeMs !== <the mtime the refresh captured at its own first readdirSync>` (i.e., skip the overwrite if a newer synchronous rescan already landed), closing the wasted-rescan race — not required to re-queue urgently, since it's a performance nit, not a correctness bug.

### Minor — `scheduler-looks-done.test.cjs` has a pre-existing load-dependent flake, unrelated to this plan

- **File**: `src/main/__tests__/scheduler-looks-done.test.cjs:272` (`needs_review with an in-window commit heals exactly as today`)
- **Summary**: fails deterministically under full-suite concurrency (2/2 runs), passes alone (1/1 run), and reproduces identically at the pre-1529 base commit (`4a1b0f82`) in a disposable worktree — so it predates and is independent of this PRD's fix.
- **Failure scenario**: any full-suite CI/local run under enough parallel load intermittently quarantines the test's PRD instead of healing it to `completed`, for reasons unrelated to `activeSessions.cjs`.
- **Recommendation**: worth a scheduler-team follow-up PRD (similar class to the `prdCreate.test.cjs` flake the prior validation record noted) — not blocking this plan or PRD 1529.

## Sentinel

VALIDATION: repair-active-sessions-mtime-change-sync-rescan VERIFIED
SCHEDULER_VERDICT: PASS

# Validation: false 'prd-missing' skip plan

Base: 6d1032aef8799ac69f218cc74a47eb97d8bf46fe (known). PRD files found in the Epic's `prds-archived/`.
Commits: ae4b3c95 (2065), de8d73ba (2068), 420293b9 (2070), 518e1d09 (2071).

Gates re-run (scratch TMPDIR, foreground):
- `vitest run active-sessions.test.cjs activeSessions-single-scan.test.cjs` → 2 files, 19 tests pass
- `vitest run epic-ancestor-prd-lookup / scheduler-prd-missing-skip / scheduler-notify-originating-tab` → 3 files, 42 tests pass
- `npm run typecheck` → exit 0

## 2065-cwd-scan-tail-without-cwd-fallback — VERIFIED
- Constants MAX_TAIL_BYTES=16 MiB, MAX_FALLBACK_FILES=5, TAIL_GROWTH=16: activeSessions.cjs:54-60.
- Sync scan: sorted newest-first, tail grows x16 to cap, then next files (≤5), null only if none yield cwd: activeSessions.cjs:~165-192.
- Async scan mirrors it with fsp (same cap/limit): activeSessions.cjs:~275-305.
- `newestMtimeMs = files[0].mtimeMs` (newest file, not fallback) in both.
- Common case: first `readTailLines(fp, TAIL_BYTES)` returns on hit; no extra reads.
- Tests: "200 KB line without cwd" and "no cwd at all falls back to older jsonl, keeping newest mtime" in active-sessions.test.cjs; pass.

## 2068-find-prd-dir-job-scoped-lookup — VERIFIED
- `jobScopedPrdDirs(job)` exported: prdPaths.cjs:~148-170; exact Epic dir (isSafeEpicId + exists), listEpicPrdDirs, prdDirForCwd; deduped; [] for missing/relative cwd; root via projectRootOf.
- `findPrdDirForJob` order: exact epic dir → findPrdDir → remaining scoped → stored prdPath → ancestor walk: prdPaths.cjs:~196-222.
- Paths via path.join; unsafe epicId guarded by isSafeEpicId + try/catch around resolveEpicPrdWriteDir.
- Tests at epic-ancestor-prd-lookup.test.cjs:177 (incident, scan stubbed), :187 (no epicId), :197 (unsafe epicId / relative cwd); existing tests pass.

## 2070-prd-missing-skip-existence-guard — VERIFIED
- `recheckPrdSourceForJob` busts cwd cache, checks jobScopedPrdDirs + findPrdDirForJob: scheduler.cjs:~536-554.
- One shared helper `recheckBeforeMissingSkip` used by both ENOENT exits (scheduler.cjs:~4340-4358, ~4394, ~4415); parses, sets prompt/prdPath/parsedPrdMeta, logs `PRD resolved on re-check at <path>`; parse failure returns exitCode -1 naming the path.
- 'prd-archived' check ordering unchanged (archivedTwinExists first).
- Test "a PRD that exists under a job-scoped Epic dir is NOT retired…" asserts skipped undefined + log line; passes.

## 2071-prd-missing-skip-dependents-notice — VERIFIED
- spawnJob skip block collects pending/null/needs_review same-cwd dependents, stores `blockedDependents` only for 'prd-missing': scheduler.cjs:~6243-6262.
- Post-mutate fire-and-forget `notifyOriginatingTab({...job,status:'skipped',blockedDependents}).catch(log)` only when non-empty: scheduler.cjs:~6266-6270. 'prd-archived' (completed) and no-dependent skips send nothing.
- Dedicated message with cap 10 + "(+N more)" matches AC text: scheduler.cjs:~3132-3138.
- Tests: scheduler-notify-originating-tab.test.cjs:455; scheduler-prd-missing-skip.test.cjs "records blockedDependents"; pass.

## Findings
### Critical
- none
### Important
- none
### Minor
- scheduler.cjs spawnJob skip block: no explicit test that a 'prd-missing' skip with zero dependents (or 'prd-archived') sends NO notice; behavior holds by code reading only (`blockedDependents.length > 0` gate).
- The combined base..HEAD diff also contains an unrelated plan (persona tool scope, `art` WorkType: personaToolScope.cjs, agentModelResolve.cjs, tag files). Not reviewed here beyond confirming it doesn't interfere with the four PRDs' hunks.
- activeSessions.cjs async scan stats the file each growth step (extra `fsp.stat`), only on a miss — negligible.
- Self-review (no separate /code-review run): no secrets, no path traversal (slug basename check in recheckPrdSourceForJob; epicId validated), no duplication of an existing helper found.

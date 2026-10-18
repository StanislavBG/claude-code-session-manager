# Validation: ops-retention plan (PRDs 2021–2032)

Base: cf5b9a824d41bda817c4b926f1c642502af59477 (HEAD dc590794). 12 feature/docs commits found via `git log base..HEAD -- <paths>`.
Gate re-run (all foreground, scratch TMPDIR): one `vitest run` over every PRD's test files = 26 files / 289 tests passed; `npm run typecheck` exit 0; `npm run lint` clean; `npm run lint:docs` ok (21 junctions, 34 files). `/code-review` + `/security-review` not run as separate tools; combined diff self-reviewed (see Findings).

## 2021 runlog-retention-age-based — VERIFIED
- Age-driven bulk eligibility, newest run included: runLogRetention.cjs computeEligibility (`retained = maxAgeDays != null ? !(ageDays > maxAgeDays) : ...`, bulkEligible/metaEligible); semantics in module header.
- Newest run keeps meta/verdicts/outcome: `metaEligible = bulkEligible && !isMostRecent`; isMetadata covers .meta/.verdicts/.outcome.
- Live protection: `!isLive` in bulkEligible; LIVE_STATUSES untouched.
- DoD-only / empty dirs: computeReport removableDirs loop + dodFiles; applyRetention unlinks dodFiles.
- computeReport and applyRetention share `report.eligible[].removeFiles`; eligibleSummary has bulkBytes/metadataBytes.
- Tests added in runLogRetention.test.cjs (pass).
- Real-data read-only computeReport on ~/.claude/session-manager/scheduled-plans/runs (3.5 GB; 31 queue jobs, 4 live keys, policy 14d/3): 1739 eligible entries, 2.449 GB reclaimable (bulk 2,448,409,545 B / metadata 108,153 B), 93 removable dirs, 0 eligible entries are live. >1 GB confirmed.

## 2022 history-jsonl-slim-rows — VERIFIED
- slimHistoryRow replaces preRunDirtyPaths/guardBaseline/leftoverPaths with `<field>Count`, salvagePatch >2 KB with salvagePatchBytes (queueHistory.cjs ~L121-150); called in appendHistory write.
- Dedupe reads `readTailText(target, 2 MB)` instead of full file.
- Readers unchanged; tests (500-entry row <1 KB, duplicate not re-appended, old-row terminal lookup) pass.

## 2023 prune-stale-reserved-markers — VERIFIED
- pruneStaleReservations exported (prdParser.cjs ~L335): deletes NN <= max-keep AND mtime older than minAgeMs; returns {removed, kept}.
- Called once after successful allocation inside try/catch (swallowed).
- No NN reuse: allocator floor = max(scanMax, highWater from `.max-allocated-group`, extraFloor) (L377-381); test "allocation after prune is max+1" passes.

## 2024 archived-transcript-sidecar-primitive — VERIFIED
- archivedTranscript.cjs exports writeSidecar/readSidecar/sidecarPath; path via opsPath(cwd,'prompt-sessions','transcripts-archive',…); atomicFs write; assertOpsWrite as `epics`.
- Idempotent (sha-equal existing → no rewrite); assertSafeEpicId rejects `..`, `/`, `\`, NUL.
- opsOwnership.cjs: zero diff vs base (subpath already under the prompt-sessions namespace).
- Tests pass (round-trip, sha, idempotent, traversal, gz<bytes).

## 2025 audit-log-monthly-rotation — VERIFIED
- auditLog.cjs rotateIfNewMonth: gzips to audit-log-<YYYY-MM>.jsonl.gz beside the live file, unlinks live; failure caught and append proceeds; MAX_ROLLED=6 prune oldest.
- Live file stays plain JSONL; header comment and readTail comment updated.
- Tests (rollover, 8→6, rotation-error append) pass.

## 2026 health-nested-ops-roots — VERIFIED
- findNestedOpsRoots(projectRoot,{maxDepth:3}) exported; skips node_modules, .git, .claude/worktrees; read-only; WARN via status.issues "Warning: …" with ok:true component (not FAIL). Tests pass.

## 2027 ops-sweep-daily-runs-archive-tmp — VERIFIED
- staleTmpSweep.cjs: sweepStaleTmp (age + dead pid; queue.json.bak* reported only), pruneRunsArchive (mtime > maxAgeDays).
- index.cjs runRunLogRetentionPass: runBootSweep + both sweeps, one 'run-log-retention' log line with removedFiles/freedBytes; run in the 30 s deferred block and re-run via unref'd 24 h setInterval.
- Single-instance guard: new `lostInstanceLock` flag set where `app.requestSingleInstanceLock()` fails (next to terminateLosingInstance); pass returns early. Note: in dev/E2E (`isDev`) the lock is skipped, so the flag stays false there (pre-existing behavior).
- Tests pass.

## 2028 archived-transcript-sidecar-wire — VERIFIED
- registerIpc adds `promptSessions:archiveTranscript`; registered in index.cjs; preload `promptSessions.archiveTranscript`; api.d.ts updated.
- markCompleted (promptSessions.ts) writes `transcriptRef`, no `transcript` field; type makes `transcript` optional, adds transcriptRef.
- durableTurns fallback runs when `!transcriptRef`; IPC failure → error toast and archive still written without ref.
- Validation: absolute-cwd check + assertSafeEpicId. Tests + preload-surface pass; typecheck 0.

## 2029 archived-transcript-migration — VERIFIED
- migrateProject: skips active-index.json and status 'active'; ordering confirmed in archivedTranscriptMigration.cjs: writeSidecar → readSidecar → sha compare (throws on mismatch) → only then writeJsonAtomicSync of JSON with transcriptRef and no transcript; error path leaves JSON untouched; rerun skips (no `transcript`).
- index.cjs: runs after the deferred sweep over `allProjectCwds()` (cached list), limit 50, setImmediate yield. Tests pass. Not run against real data (per instructions).

## 2030 ops-retention-settings-main — VERIFIED
- opsRetentionSettings.cjs: DEFAULTS match spec; validatePatch clamps (maxAgeDays ≥ 3), rejects non-'forever' mode and unknown keys; corrupt file → DEFAULTS.
- resolveRetentionConfig prefers ops-retention.json runLogs; pruneRunsArchive default from runsArchiveDays.
- preview() calls computeReport / dryRun sweeps — the same eligibility code as apply; test proves nothing deleted.
- registerIpc: opsRetention:get/set/preview, set validated via validatePatch. Tests pass.

## 2031 ops-retention-settings-ui — VERIFIED
- index.cjs registers IPC; preload + api.d.ts expose window.api.opsRetention.{get,set,preview}; SettingsOpsRetention.tsx embedded in SettingsAppPrefs.tsx; component test passes; typecheck and lint clean.

## 2032 ops-retention-docs — VERIFIED
- prompt-sessions/README.md, scheduler/README.md and ops-maintenance-protocol.md edited (in `git diff --stat`); `npm run lint:docs` ok.

## Findings
### Critical
- none
### Important
- none
### Minor
- src/main/lib/opsRetentionSettings.cjs: `auditLogMonths` and `reservedMarkersKeep` are stored/validated/exposed in the DEFAULTS but nothing consumes them — auditLog.cjs hardcodes `MAX_ROLLED = 6` (auditLog.cjs ~L45) and allocateParallelGroup calls `pruneStaleReservations(prdsDir)` with its default keep=100. Out of the stated ACs, but the settings are inert if the UI exposes them.
- src/main/index.cjs (`lostInstanceLock`): guard is skipped under SM_DEV/SM_E2E, so a second dev instance would still sweep. Matches existing lock semantics.
- src/main/lib/scheduler/queueHistory.cjs ~L173: appendHistory doc comment has an over-long first line after the edit (cosmetic).
- Self-review of security: sidecar paths are traversal-checked and opsPath-built; IPC validates absolute cwd and epicId; no secrets, no new shell spawns; `pruneRunsArchive` uses rmSync recursive only on direct children of the archive dir (lstat, no symlink follow).

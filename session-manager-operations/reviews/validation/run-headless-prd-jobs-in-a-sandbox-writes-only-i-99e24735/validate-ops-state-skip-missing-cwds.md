# Validation: ops-state-skip-missing-cwds (PRD 3674)

Base: d4d5c249; PRD commit: 7071526a (4 files, exactly the PRD's # Files).

## ops-state-skip-missing-cwds — VERIFIED

- AC1: `src/main/lib/ephemeralCwd.cjs` — `tmpRoots()` (resolve + realpath of os.tmpdir()), `isInside()`; `isEphemeralCwd` returns true when the path is missing and inside a tmp root, else falls through to `classifyCwd` (today's result).
- AC2: `src/main/lib/scheduler/queueStore.cjs` `writeSplit` (the only writer; line ~580 uses `queuePathOrSkip`) — skips absolute missing cwd with one `console.warn('[queueStore] skip queue write for missing cwd', cwd)` and `continue`; no throw, no mkdir. Readers/projectQueuePath unchanged.
- AC3: `ephemeralCwd.test.cjs` adds three cases (missing under tmpdir; missing under non-tmp fake home; existing tmp paths).
- AC4: `queueStoreMissingCwd.test.cjs` — deleted cwd creates nothing and warns once; existing non-ephemeral cwd still writes queue.json.
- AC5: cwdClassify, opsOwnership, queueStoreAtomicWrite, queueStoreMachineStateRecovery tests untouched in the diff and pass.
- Gate re-run: vitest 6 files / 47 tests passed; `npm run typecheck` exit 0.

## Combined diff review
Self-review (small diff, 4 files): no secrets, no path-traversal exposure (paths only compared/stat'd), reuses existing helpers.

## Findings
- Critical: none. Important: none.
- Minor: the missing-cwd skip in `writeSplit` is guarded by `path.isAbsolute`; a relative cwd falls through to `queuePathOrSkip` as before (intended). The missing-cwd test fixture writes under `test-results/` (gitignored). No action required.

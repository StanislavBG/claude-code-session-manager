# Validation: main-heap-snapshot-on-high-heap (PRD 2233)

Base: 2f6b5e09. Commit: 345fdf9b (4 files, +168). PRD file: epics/.../prds-archived/2233-main-heap-snapshot-on-high-heap.md.

## main-heap-snapshot-on-high-heap — VERIFIED

- Module exports `maybeCaptureMainHeap`: `src/main/lib/telemetry/mainHeapSnapshot.cjs:69` (export), default writeFn `v8.writeHeapSnapshot` :49, threshold default 1800 :13, env `SM_MAIN_HEAP_SNAPSHOT_MB` :19, disable `SM_MAIN_HEAP_SNAPSHOT=0` :40, once-per-process via `state.captured` :41/:60, filename `main-heap-<iso>.heapsnapshot` :61, default dir `schedulerPaths.heapSnapshotDir()` :47, returns `{captured,filePath,reason}`.
- Prune to 2 + low-disk: `pruneOld(dir, KEEP-1)` :58 leaves 2 after write; `freeMb >= 3*heapUsedMb` else `'low-disk'` :56 (statfsSync default :49).
- crashDiagnostics sampler: `tryMainHeapSnapshot()` called from `heartbeat()` (crashDiagnostics.cjs diff +157..+174); logs `[crash-diag] main heap snapshot` with filePath, ms, heapUsedMb; skip reason logged once (`heapSkipLogged`); whole body in try/catch.
- `mainHeapUsedMb`/`mainHeapTotalMb` added to heartbeat meta (crashDiagnostics.cjs:191-192); the same log call emits both 'memory high' (:187) and 'memory heartbeat'.
- Test file `src/main/__tests__/mainHeapSnapshot.test.cjs`: below-threshold :30, at-threshold+second crossing :36, env disable :46, env override :53, prune keeps 2 :59, low-disk :70; injected writeFn/statfsFn, tmp dir.
- `scripts/lib-layout.json`: `"mainHeapSnapshot": "telemetry"` added.
- Gate 1 `npx vitest run src/main/__tests__/mainHeapSnapshot.test.cjs`: 1 file, 6 tests passed.
- Gate 2 `npm run lint`: ran to completion, final sub-lint "e2e budget ok: 19/19", no failures printed.
- Scope: only the 4 listed files changed; heapSnapshot.cjs and watchdog files untouched by this commit.

## Findings

### Critical
- none

### Important
- none

### Minor
- `mainHeapSnapshot.cjs:59-61`: `state.captured = true` is set before `writeFn`, so a failed write (e.g. ENOSPC) uses up the single per-boot attempt. Deliberate (avoids retry loops under memory pressure), but means no evidence if the first write fails.
- `crashDiagnostics.cjs` `tryMainHeapSnapshot`: `ms` is measured from before the `memoryUsage()` call, fine; but the synchronous snapshot blocks the main loop and is itself a memory risk near the threshold. Accepted by the PRD.
- Not exercised: the crashDiagnostics wiring has no test (Electron-only module); verified by reading only.
- Security/code review: self-reviewed. No user-controlled path input, filenames derive from ISO time, prune is restricted to the `main-heap-*.heapsnapshot` pattern in the one dir; no secrets; reuses `heapSnapshotDir`.

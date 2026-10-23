# Validation sweep 202610230803

Base: 8889f0ddd9eb7131be238cfe9e36a2e4a0364e51. Self-review only (no extra review skills run); diff is small type/deletion work.
Commits: 8014b48f (renderer/preload types), 0129a8b5 (timer delete + normalize).

## fire-policy-drop-on-reset-renderer — VERIFIED
- `src/preload/api.d.ts:625` `ScheduleFirePolicy = 'manual' | 'when-available'`; no `scheduledFor`.
- `computeStatus.ts:5` StatusKind has no `on-reset`; no branch remains.
- `grep -rn "on-reset\|scheduledFor" src/renderer src/preload` → no hits (rc=1).
- `dataModelErd.ts:485` firePolicy `'manual' | 'when-available'`; SchedulerTopBands has no on-reset.
- Gate 1 vitest (3 files, 28 tests) pass; `npm run typecheck` rc=0; `npm run lint` rc=0.

## fire-policy-on-reset-timer-delete — VERIFIED
- `grep fireTimer|clearFireTimer|computeFireAt|scheduledFor src/main/scheduler.cjs` → none.
- `scheduler.cjs:1127-1131` `normalizeConfig` maps `on-reset` → `when-available`; applied in readQueueSync (:1135) and readQueue (:1144); exported (:11028). `firePolicy` default at :446.
- `src/main/__tests__/scheduler-fire-policy-normalize.test.cjs` exists; `healthTickLiveness.spec.ts:45` uses `when-available`; `health.cjs` unchanged vs base.
- Gate vitest (7 files, 86 tests) pass; typecheck rc=0.

## Findings
### Minor
- `src/main/scheduler.cjs:1129`: AC says normalized value is "persisted"; implementation normalizes on every read and persists on the next mutate() write, not eagerly at load. Functionally equivalent.
- `grep -rn "on-reset" src/main` also hits tests (`ipcSchemasFirePolicy.test.cjs`, the new normalize test) beyond the one migration comment; expected test fixtures, non-code.

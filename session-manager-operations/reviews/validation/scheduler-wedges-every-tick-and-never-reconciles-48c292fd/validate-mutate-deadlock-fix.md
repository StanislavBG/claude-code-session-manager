# Validation: scheduler-wedges-every-tick-and-never-reconciles-48c292fd — mutate deadlock fix plan

Plan: fix the 2026-09-25 scheduler freeze (re-entrant `mutate()` deadlock via
`autoArchiveCompleted` → `archiveMany` → `retireCompletedSlugs` → `mutate()`).
PRDs 1442, 1443, 1444, planId `pl-muhhxf46-7fc0ec` / `pl-muhhyj2s-6eaecd`.

PRD files: untracked in the main checkout at
`session-manager-operations/scheduler/epics/scheduler-wedges-every-tick-and-never-reconciles-48c292fd/prds-archived/`
(all three terminal — `git ls-files` shows they were never committed; this is
consistent with other epics where PRD archival isn't always git-committed).
HEAD in this worktree (`a5fd8274`) contains all three landing commits as
direct ancestors (`git merge-base --is-ancestor` confirmed).

## PRD 1442 — auto-archive-skip-retire-deadlock

Commit: `7027895d` (merge), `fad45d5a` (child) — `src/main/queueOps.cjs`,
`src/main/scheduler.cjs`, `src/main/__tests__/queueOpsAutoArchive.test.cjs`.

**Verdict: VERIFIED**

- AC1 (`archiveMany` only retires when `retire: true`) — `src/main/queueOps.cjs:354` `async function archiveMany(slugs, cwd, { retire = true } = {})`; the `retireCompletedSlugsFn` call at `:369-372` is guarded by `if (retire && archivedSlugs.length > 0)`. Manual `schedule:archive-prd` handler at `:621` calls `archiveMany(parsed.slugs)` with no override, keeping the default `retire: true`.
- AC2 (`autoArchiveCompleted` passes `{ retire: false }` + doc'd why) — `src/main/queueOps.cjs:464` `await archiveMany(slugs, undefined, { retire: false })`; header comment at `:448-453` states the re-entrant-mutate-deadlock reason; `src/main/scheduler.cjs:1332-1341` `retireCompletedSlugs`'s JSDoc now states "MUST NEVER be called from inside a mutate() body" and names the 2026-09-25 incident.
- AC3 (new tests) — `src/main/__tests__/queueOpsAutoArchive.test.cjs:177` `test('autoArchiveCompleted never invokes retireCompletedSlugs', ...)` and `:196` `test('manual archiveMany still retires', ...)` both present.
- AC4 gate — re-ran `timeout 300 npx vitest run src/main/__tests__/queueOpsAutoArchive.test.cjs src/main/__tests__/scheduler-archive-completed-prd.test.cjs`: **2 files / 22 tests passed**.
- AC5 typecheck — re-ran `timeout 300 npm run typecheck`: clean (no output, exit 0).

## PRD 1443 — mutate-reentrancy-guard

Commit: `9b16deb5` (child), merged at `55b3ffd0` — `src/main/scheduler.cjs`,
`src/main/__tests__/scheduler-mutate-reentrancy.test.cjs`, `vitest.config.ts`.

**Verdict: VERIFIED**

- AC1 (module-level `AsyncLocalStorage`, chained body runs inside `mutateCtx.run`) — `src/main/scheduler.cjs:50` requires `node:async_hooks`; `:2488` `const mutateCtx = new AsyncLocalStorage();`; `:2512-2519` builds `ctx = { active: true }`, runs `await mutateCtx.run(ctx, () => mutateBody(fn))`, and sets `ctx.active = false` in the existing `finally`.
- AC2 (re-entrant call does not touch `mutateTail`) — `src/main/scheduler.cjs:2497-2503`: the `mutateCtx.getStore()?.active === true` check and `return Promise.reject(err)` sit before `mutateTail.then(...)` is ever referenced (`:2504`), so a re-entrant call never touches `mutateTail`.
- AC3 (audited reject, non-reentrant callback proceeds normally) — `:2500-2502` calls `console.error` + `appendAuditEvent('mutate_reentrant', { stack })` then rejects with the exact specified message; the `finally`-set `ctx.active = false` plus `AsyncLocalStorage` propagation into post-body callbacks (documented at `:2481-2487`) covers the "callback after body finished" case, exercised by the test file's second case below.
- AC4 (new test file, 3 named cases) — `src/main/__tests__/scheduler-mutate-reentrancy.test.cjs:62` `'nested awaited mutate rejects instead of hanging'`, `:86` `'mutate scheduled via setTimeout from a finished body runs normally'`, `:108` `'sequential mutates unaffected'` — all present.
- AC5 gate — re-ran `timeout 600 npx vitest run src/main/__tests__/scheduler-mutate-reentrancy.test.cjs src/main/__tests__/scheduler-archive-completed-prd.test.cjs src/main/__tests__/scheduler-broadcast-reconcile.test.cjs src/main/__tests__/scheduler-unreadable-queue-guard.test.cjs`: **4 files / 15 tests passed**.
- AC6 (no regression in full unit suite, no latent `mutate_reentrant` trips) — re-ran the FULL suite: `TMPDIR=/tmp/sm-validate-scratch timeout 890 npx vitest run src/main/__tests__ --reporter=dot`: **233 files / 2034 tests passed**, zero failures, zero mentions of `mutate_reentrant` in output. `vitest.config.ts` diff confirms the new test file was registered (`src/main/__tests__/scheduler-mutate-reentrancy.test.cjs` added to the explicit include list), consistent with the project's hand-registration convention.

## PRD 1444 — liveness-persistent-tick-wedged-is-dead

Commit: `a5fd8274` — `src/main/lib/watchdogHelpers.cjs`,
`src/main/lib/__tests__/watchdog-helpers.test.cjs`.

**Verdict: VERIFIED**

- AC1 (`DEFAULT_TICK_WEDGED_DEAD_MS` export, new param, branch ordering) — `src/main/lib/watchdogHelpers.cjs:99` `const DEFAULT_TICK_WEDGED_DEAD_MS = 10 * 60_000;`, exported at `:479`; `:120` signature adds `wedgedDeadMs = DEFAULT_TICK_WEDGED_DEAD_MS`; the branch at `:129-134` runs after the fresh-heartbeat (`:121-124`), dispatch-field (`:126`), and paused/draining (`:127-128`) checks, and before the `pendingDispatchable` check (`:135`) — exact required ordering.
- AC2 (branch logic) — `:129-134`: `d.lastTickReason === 'wedged'` and (`Date.parse` unparseable or `now - lastAttemptMs > wedgedDeadMs`) → `{ dead: true, reason: 'tick-wedged' }`, matching the spec exactly.
- AC3 (JSDoc updated, "must not relaunch" retained) — `:101-119` documents the new `tick-wedged` rule with the 2026-09-25 incident and keeps "Callers must NOT relaunch on this" at `:117-118`.
- AC4 (4 named tests) — `src/main/lib/__tests__/watchdog-helpers.test.cjs:378` `'wedged + stale lastDispatchAttemptAt → tick-wedged dead'`, `:388` `'wedged but recent attempt → not dead'`, `:399` `'wedged while paused → paused (not dead)'`, `:410` `'wedged with pendingDispatchable 0 still dead (the 2026-09-25 shape)'` — all four present, plus two extra cases (unparseable timestamp, default constant) beyond the AC minimum.
- AC5 gate — re-ran `timeout 300 npx vitest run src/main/lib/__tests__/watchdog-helpers.test.cjs src/main/lib/__tests__/watchdog-relaunch.test.cjs`: **2 files / 41 tests passed**.

## Cross-cutting check: no remaining re-entrant path into `mutate()`

Per this validation PRD's own AC, grepped every caller of `retireCompletedSlugs`,
`archiveMany`, and everything `reconcile()` invokes:

- `retireCompletedSlugs` is called from exactly two places: `queueOps.cjs`'s
  `retireCompletedSlugsFn` injection point (only invoked by `archiveMany` when
  `retire: true`, i.e. the manual `schedule:archive-prd` path outside any
  `mutate()` body) and its own definition in `scheduler.cjs:1344` (uses
  `mutate()` internally, as designed for the non-reentrant manual path).
- `archiveMany` has 4 call sites: the manual archive handler (`retire: true`,
  outside mutate), `autoArchiveCompleted` (`retire: false`, fixed by PRD 1442),
  and `prdAdminRoutes.cjs:162` (a separate admin IPC route, also outside any
  mutate body — not reachable from `reconcile()`).
- Every other function `reconcile()` calls directly (`consolidateAllFlatPrds`,
  `listPrdFiles`, `parsePrd`, `archivedTwinExists`, `queueHistory.appendHistory`,
  `queueHistory.historyTerminalBySlug`, `requeueForeignWipBlockedJobs`,
  `queueOps.autoArchiveCompleted`) was read in full — none call `mutate()`.
  `requeueForeignWipBlockedJobs` mutates the in-memory job objects directly
  (`resetJobFields`, `scheduler.cjs:4925-4949`) since it already runs inside
  the caller's `mutate()` body (`scheduler.cjs:3814-3815`, `reconcile(state)`
  called from inside `mutate(async (state) => { await reconcile(state); ... })`).

No remaining path from `reconcile()` or any `mutate()` body reaches `mutate()`
re-entrantly. The PRD 1443 guard (AsyncLocalStorage-based rejection) is
correctly the last line of defense should a future call site reintroduce one.

## Findings

None — Critical / Important / Minor: no findings. All three PRDs' acceptance
criteria are satisfied exactly as specified, all gates re-run green, the full
unit suite (2034 tests) passes with no regressions, and the diff introduces no
injection, secret-handling, or path-traversal issues.

# Validation: sched-adopt-prd-on-create

Plan: single-PRD `pl-muhibao4-048bf0`, PRD 1446 ("Scheduler: adopt a newly created PRD right
away, even when the queue has no pending rows"). Landed via `3bce6e28` (work commit) merged into
`main` at `4dbe2d6c` ("merge scheduler job 1446-sched-adopt-prd-on-create").

PRD file location: not tracked in git (the `session-manager-operations/scheduler/epics/`
namespace is local, single-writer scheduler state, not repo-versioned). Found on disk, terminal,
at `session-manager-operations/scheduler/epics/the-manual-needs-to-be-redone-delete-and-start-o-3ba80794/prds-archived/1446-sched-adopt-prd-on-create.md`
in the main checkout (`/home/bilko/Projects/session-manager`). `history.jsonl` confirms
`"status":"completed"`, `"landedCommit":"4dbe2d6cf9e40067c091fe01ea676c226f2c822b"`,
`"epicId":"the-manual-needs-to-be-redone-delete-and-start-o-3ba80794"` — the sourcing Epic is
unrelated to this PRD's content (a scheduler bugfix filed against the "redo the manual" Epic's
chat), which is consistent with the domain model: PRDs join whatever Epic minted them, they don't
have to match its original topic.

## PRD 1446 — VERIFIED

Gate re-run (symlinked `node_modules` from the main checkout into this job worktree — it ships
with none of its own):

```
$ ln -s /home/bilko/Projects/session-manager/node_modules node_modules
$ TMPDIR=/tmp/validate-scratch-1447 timeout 300 npx vitest run src/main/__tests__/prdCreateAdoption.test.cjs
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Per-AC evidence:

- **AC1** (`createPrd` triggers one reconcile through an EXISTING entry point, no second
  reconcile implementation) — `src/main/lib/prdCreate.cjs:494-504` calls
  `remote.requestReconcile()`; `src/main/scheduler.cjs:12509-12511` defines it as
  `async requestReconcile() { await broadcast({ flush: true }); }` — the identical
  `broadcast({flush:true})` seam `resetJob` already uses, which flushes
  `broadcastCoalescer` whose `getPayload` calls `module.exports.reconcile` (`scheduler.cjs:3762-3771`).
  `grep -n "async function reconcile(" src/main/scheduler.cjs` → exactly one hit, line 2765. No
  second implementation exists.
- **AC2** (`rescheduleTimer` still runs `mutate(reconcile)` when `refreshNextReset()` stalls,
  falling back to `cachedNextReset`) — `src/main/scheduler.cjs:3814-3831`: 10s
  `RESCHEDULE_TIMER_BILLING_RACE_MS` constant, `Promise.race([refreshNextReset(), <timeout
  resolving cachedNextReset>])`, `catch` block also falls back to `cachedNextReset`; the
  unconditional `mutate(async (state) => { await reconcile(state); ... })` at line 3832 runs
  regardless of which branch of the race wins.
- **AC3** (`enqueued` honestly reflects post-reconcile state, no more hardcoded false) —
  `prdCreate.cjs:494-504` sets `enqueued = Boolean(await remote.getJob(filenameSlug))` after the
  reconcile; return block (`prdCreate.cjs:515-527`) threads `enqueued` and a matching note instead
  of the old hardcoded `enqueued: false`. The admin HTTP route (`prdCreate.cjs:570`) now mirrors
  `result.enqueued` verbatim instead of its own hardcoded `false`.
- **AC4** (test coverage for both scenarios) — `src/main/__tests__/prdCreateAdoption.test.cjs`
  has 4 tests: `remote.requestReconcile()` adopts a fresh on-disk PRD with **no** `tickQueue`
  call (line 109); `createPrd()` wiring for both `enqueued:true` (line 123) and `enqueued:false`
  (line 157) outcomes; `rescheduleTimer` still reconciling when `usage.fetchUsage()` never
  resolves, using fake timers advanced past `RESCHEDULE_TIMER_BILLING_RACE_MS` (line 189). File is
  registered in `vitest.config.ts:106` — `grep -n prdCreateAdoption vitest.config.ts` confirms.
- **AC5** (gate command) — ran verbatim above: 4/4 passed.

## No second reconcile implementation / billing-fetch fallback — CONFIRMED

`grep -n "function.*[Rr]econcile" src/main/scheduler.cjs` returns `reconcileSourcePromptId`
(pre-existing, unrelated — normalizes a `sourcePromptId` field) and `async function reconcile`
(the one real implementation, line 2765) — no new reconcile body was added.
`rescheduleTimer`'s bounded race falls back to `cachedNextReset` in both the race-timeout branch
and the `catch` branch (`scheduler.cjs:3822-3831`), matching the AC's "for example a 10s
Promise.race falling back to cachedNextReset" wording exactly.

## Combined diff review

`git diff c8efc980..4dbe2d6c --stat`: 4 files, +272/-8
(`src/main/__tests__/prdCreateAdoption.test.cjs` new; `src/main/lib/prdCreate.cjs`,
`src/main/scheduler.cjs`, `vitest.config.ts` touched). Full diff reviewed inline (no
`/code-review` or `/security-review` slash command available in this headless environment —
self-reviewed instead).

- No injection, path traversal, or secret-handling surface — the whole diff is in-process
  reconcile plumbing and a response field; no new I/O, no new string built into a shell command,
  file path, or query.
- `requestReconcile()` reuses the existing `broadcast({flush:true})` coalescer rather than adding
  a parallel reconcile path — matches the single-writer/no-duplicate-implementation constraint the
  PRD itself called out.
- The abandoned `refreshNextReset()` promise in the loser branch of the race is left to resolve
  on its own (comment at `scheduler.cjs:3804-3813` states this explicitly) — it still updates
  `cachedNextReset` for next time and has no unhandled-rejection risk since `refreshNextReset`
  already wraps its own fetch in try/catch (pre-existing code, unchanged here).
- `setTimeout` in the race is `.unref()`'d when supported, so it cannot keep the process alive
  past the 10s window if `refreshNextReset()` wins first.
- `enqueued`'s `getJob` call is best-effort inside the same `try` as `requestReconcile()` — a
  throw from either leaves `enqueued` at its safe default (`false`) and only logs a warning,
  matching the PRD's "must not fail a write that already landed on disk" requirement.

### Findings

None — no Critical, Important, or Minor findings. The implementation matches every AC line
verbatim, reuses existing seams as required, and the diff is minimal and free of duplication.

VALIDATION: sched-adopt-prd-on-create VERIFIED

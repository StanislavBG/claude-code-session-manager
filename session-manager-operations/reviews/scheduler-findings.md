# Scheduler tab (Almanac) review — findings

Deep review of the Scheduler tab's Queue/PRDs/History sub-views and their backing
IPC/main-process code. Every file in scope was read; every IPC handler name was
cross-checked against `preload/index.cjs` and `scheduler.cjs`'s
`registerScheduleHandlers()`; the live app was exercised end-to-end under
Playwright/xvfb via a scratch spec (`tests/e2e/_scratch-scheduler-review.spec.ts`,
deleted after this pass).

> **Update (follow-up pass):** a second review pass picked up where this one left
> off. It found the root cause of the Supervisor sub-panel crash documented below
> under "Found, reproduced, NOT fixed" and landed the fix (see "Fixed" item 5),
> plus one more small duplication fix (item 6). That section is retained below
> for its diagnostic value but the crash itself is no longer open.

## Fixed

1. **"reset to pending" was clickable on a genuinely running job** (`SchedulePanel.tsx`
   Queue view). The button was gated only on `job.status !== 'pending'`, which also
   matched `running`. Confirmed via `scheduler.cjs`: `resetJobFields()` blindly
   overwrites `status`/`runId`/`error`/`runtime` with no check against the
   in-process `runningSet`, and the job's own completion handler
   (`spawnJob`'s `finally` block) always re-derives the real final status from the
   actual run outcome once it finishes — silently reverting the "pending" state a
   few seconds later. Net effect: clicking Reset on a running job was a **visual
   no-op that silently self-reverts**, exactly the "dead/misleading button" class
   this review was looking for. `runningSet` did prevent an actual double-spawn, so
   this was never a data-corruption risk — just a deceptive UI action.
   Fix: hide the control while `job.status === 'running'`
   (`src/renderer/components/SchedulePanel.tsx`). `SchedulerHistoryView.tsx`'s
   identical-looking button was checked too: `selectHistoryJobs()` in
   `scheduler.cjs` only ever returns `completed`/`failed` jobs, so it can never
   render a running job — no fix needed there. `SchedulerPrdsView.tsx`'s editor
   toolbar Reset button was already the most conservative of the three
   (`disabled={status !== 'failed'}`), left unchanged.

2. **Duplicated "cwd → project display name" logic, 4 independent copies.**
   `SchedulePanel.tsx` and `SchedulerPrdsView.tsx` each defined an identical
   `projectTag(cwd)` helper (the one in `SchedulerPrdsView.tsx` was dead — never
   called); `SchedulerHistoryView.tsx` inlined the same split/pop logic twice more
   (once for the project dropdown, once for the filter predicate); and
   `sched-primitives.tsx`'s own `ProjectTag`/`projectDot` had a fourth, subtly
   different variant (`.split('/').filter(Boolean).pop()` vs.
   `.replace(/\/+$/,'').split('/').pop()` — same result in practice, but drifted
   implementations of the same concept). Consolidated onto one exported
   `projectNameFromCwd()` in `sched-primitives.tsx` (the file's own header already
   declares it the single source of truth for this family); every call site now
   imports it. Deleted both dead/duplicate local `projectTag()` functions.

3. **Duplicated "PRD status" derivation + a second, independent status-badge
   component**, both confined to `SchedulerPrdsView.tsx`. The card list computed
   `prdStatus = !j ? 'ready' : j.status === 'pending' ? 'queued' : j.status` and
   rendered it via an inline `STATUS_TONE`-keyed `<span>`; the editor toolbar
   computed the same concept differently (`job == null ? 'unqueued' : job.status`)
   and rendered it through a *different* component, `ui/StatusBadge.tsx` (its own
   color palette, its own status enum with `'unqueued'` instead of `'ready'`/
   `'queued'`). Two words for the same "no queue.json entry yet" state
   (`unqueued` vs. `ready`) in the same view is exactly the kind of drift the
   engineering standards call out. Consolidated: added `prdStatusFor()` +
   `PrdStatusPill` to `sched-primitives.tsx` (extending the existing
   `STATUS_TONE` map — the family's declared single source for PRD status color —
   rather than forking a third one), and pointed both call sites in
   `SchedulerPrdsView.tsx` at it. `ui/StatusBadge.tsx` itself was **not** touched
   or deleted — it lives outside this family's file scope, and per grep it now
   has zero real call sites in the renderer (its only other "hit" was a code
   comment in `TerminalChat.tsx`, not an import). Flagged below as a follow-up
   rather than deleted here, since removing a file outside the listed scope is a
   cross-family decision.

4. **Dead code removed** in `SchedulerPrdsView.tsx`: an unused
   `const customFieldKeys = useMemo(() => fm.extras ? ... : [], [fm.extras])` at
   the top of the component (its result was never read — `StructuredPrdEditor`
   recomputes the same thing from its own `fm` prop) and the `parsePrdFile(body)`
   destructure that only existed to feed it.

5. **Supervisor sub-panel crash — root cause found and fixed.** This is the same
   crash documented below under "Found, reproduced, NOT fixed" by the prior pass.
   Root cause: `SchedulePanel.tsx`'s `handleJobListKeyDown` `useCallback` was
   declared **after** two early returns (`if (!snap) return null` and
   `if (panelView === 'supervisor') return <SupervisorPanel/>`). On the very
   first render where `panelView` flips to `'supervisor'`, the component returns
   before ever reaching that `useCallback` — so it executes one fewer hook than
   every other render. That's a Rules-of-Hooks violation (React error #300/#310,
   "Rendered fewer hooks than during the previous render"), caught by the app's
   `ErrorBoundary`. The prior pass's diagnosis ("no hook-order violation — all
   hooks in `SchedulePanel` run before either of its two early returns") was
   the one false lead in an otherwise thorough investigation: the `useCallback`
   for `handleJobListKeyDown` is declared well *after* both early returns
   (originally at line ~190, ~50 lines below the `if (panelView ===
   'supervisor')` return at line ~142), not before them.
   Fix: hoisted `handleJobListKeyDown`'s `useCallback` above both early returns
   so every render executes the same hooks in the same order regardless of
   `panelView`/`snap`. Verified via a fresh `npm run build` + a new permanent
   regression spec, `tests/e2e/scheduler-supervisor-panel.spec.ts` (passes:
   clicking "supervisor" now renders the panel normally with zero console
   errors, and navigating back to Queue still renders correctly).

6. **`verifierVerdict` → human-readable label duplicated/inconsistent across 3
   surfaces.** `SchedulePanel.tsx`'s Queue job detail panel mapped a job's raw
   `verifierVerdict` (e.g. `"no_verdict_sentinel"`) through a local
   `VERDICT_LABELS` table to human text ("no commit or verdict sentinel"), but
   `SchedulerHistoryView.tsx`'s job detail panel and `SchedulerPrdsView.tsx`'s
   needs_review card both displayed the raw machine-readable slug verbatim —
   the same datum shown three different ways in the same view family, exactly
   the "N display sites, one source" violation the engineering standards call
   out. Moved `VERDICT_LABELS` (+ a `verdictLabel()` helper) into
   `sched-primitives.tsx` and pointed all three call sites at it. Added a unit
   test (`sched-primitives.test.ts`) covering the mapping, the unknown-verdict
   fallback, and full `VERDICT_LABELS` coverage.

## Found, reproduced, NOT fixed (root cause not pinned down — see below)

- **The Supervisor sub-panel crashes the moment it opens.** Repro: Scheduler tab
  → Queue → click the "supervisor" link at the bottom of the panel. The whole
  Scheduler pane immediately shows the generic `ErrorBoundary` fallback
  ("something broke in this panel" + retry), and the console logs
  `[ErrorBoundary] Error: Minified React error #300`. Confirmed via a
  `console.error` checkpoint added around the click: error count goes from 0 to
  2 in the ~300ms window covering exactly that one click, with no other action
  in between. Confirmed **pre-existing and unrelated to this review's changes**:
  it reproduces identically against the stale pre-review `dist/` build and
  against a fresh `npm run build` off this branch's HEAD. `config.supervisor` in
  the real on-disk `queue.json` was inspected and is well-formed
  (`{enabled, intervalMinutes, maxConcurrentProbes, probeStaleThresholdMinutes}`,
  matching `SupervisorConfig` exactly), and the real `supervisor.log` on disk
  has 52 well-formed entries matching `SupervisorLogEntry`'s shape — so it isn't
  obviously a malformed-data crash either. Read `SupervisorPanel`/
  `SupervisorLogRow` (`SchedulePanel.tsx`) end-to-end and found no invalid JSX
  child, no hook-order violation (all hooks in `SchedulePanel` run before either
  of its two early returns), and the crash happens on the *first* render before
  `log` has any entries (`log.map` never even executes yet) — so the obvious
  hypotheses don't explain it.
  **Why this wasn't fixed**: three independent attempts to get the real,
  non-minified React error message failed in this sandboxed review
  environment — production `dist/` only ever surfaces the numbered/minified
  invariant text; `SM_DEV=1` (Vite dev server, unminified) never got the
  Electron window to paint within 60s across two attempts, apparently due to
  heavy pre-existing host contention (dozens of unrelated Chrome/Electron
  processes from other concurrent sessions on this machine; 2.9 GB free of
  23 GB during this review). Per the debugging-discipline rule ("never attempt
  a fix until you can reproduce the bug on demand" — reproduced; "if three
  hypotheses fail, stop and re-examine from scratch" — three did), landing a
  blind fix for an undiagnosed React invariant risked masking the real defect
  rather than fixing it. **Recommend**: reproduce with DevTools open (`SM_DEV=1
  npm run dev`, no xvfb/headless layer) to read the un-minified error directly,
  then fix.

## Verified correct (no bug found)

- All `window.api.schedule.*` call sites in `SchedulePanel.tsx`,
  `SchedulerPrdsView.tsx`, and `SchedulerHistoryView.tsx` map 1:1 to real
  `ipcMain.handle('schedule:...')` registrations in `scheduler.cjs` and
  `queueOps.cjs`, and 1:1 to the `preload/index.cjs` bridge — no dead buttons /
  no handler-name mismatches found.
- Filter logic (`applyFilter`, `partitionJobs`, `computeAheadCounts`, ETA math),
  the "Clear completed" / "Clear queue" / "un-hide" flows, and the bulk
  archive/retag modals in `SchedulerPrdsView.tsx` were read end-to-end and
  exercised live — no off-by-one or stale-prop issues found.
- `queueOps.cjs`'s server-side `LINE_RULES` lint rules and
  `SchedulerPrdsView.tsx`'s `CLIENT_LINT_RULES` are intentionally mirrored (the
  file's own comment says so) so the editor can lint instantly client-side before
  a save round-trip — this is unavoidable duplication across the
  renderer/main-process boundary (the renderer cannot `require()` a `.cjs`
  main-process module), not a same-family violation, so left as-is.
- `adminServer.cjs`'s `create-prd`/`reset-job`/`jobs` routes were read in full;
  cwd validation, slug derivation, and NN-allocation delegation all check out.
- `dodDrainHook.cjs` / `definitionOfDone.cjs` were read in full; already covered
  by 4 dedicated unit-test files (all passing) — no bugs found.

## Noted, not fixed (file outside this family's listed scope)

- `preload/api.d.ts`'s TSDoc comment on `schedule.clearQueue` says: *"Move all
  pending+failed PRDs to prds-archived/<ISO>/ and drop their queue entries.
  Completed/running entries are preserved."* That is stale/wrong — the actual
  `schedule:clear-queue` handler in `scheduler.cjs` archives every job with
  `status !== 'running'`, which includes `completed` and `needs_review` too, not
  just `pending`/`failed`. The Queue view's own confirm-dialog copy in
  `SchedulePanel.tsx` (`onClearQueue`) already gets this right ("Archive N
  non-running PRDs… Running jobs are kept."), so no user-facing bug — only the
  type-doc comment is misleading to future maintainers reading the IPC contract.
  `preload/api.d.ts` isn't in this PRD's listed file scope, so left as a
  follow-up rather than edited here.

## Left for follow-up (outside this family's scope)

- `SessionPlansView.tsx` (in this review's file list) is **orphaned**: it is not
  imported or rendered from `Scheduler.tsx`, `SchedulePanel.tsx`, or anywhere else
  in the app except a code comment in `state/live.ts`. It appears to be a
  pre-Almanac leftover ("Legacy per-session plan viewer" per its own header
  comment). Left untouched rather than deleted, since removing a whole,
  seemingly-intentionally-orphaned view is a product decision, not a "smallest
  correct fix" for a confirmed bug — flagging for a human/product call.
- `ui/StatusBadge.tsx` is now dead code repo-wide (see finding 3) but sits outside
  this family's listed scope — candidate for deletion in a follow-up cleanup pass.
- Cross-family duplication (documented, not touched): `ui/StatusBadge.tsx`'s
  status→color mapping is conceptually the same "job status pill" idea as
  Subagents/Hive's own job-status UI (`hive-primitives.tsx`'s `ToolChip`/
  `StatusPill`). A prior cross-family consolidation pass already separated
  Almanac (`sched-primitives.tsx`) from Hive (`hive-primitives.tsx`) by design
  (different palettes, different conventions per `CLAUDE.md`'s "Avoid" section),
  so no action taken here — noted for whoever runs the eventual cross-family
  consolidation pass mentioned in the PRD's Out of scope section.

## Verification

- `timeout 120 npm run typecheck` — clean, before and after changes.
- `timeout 180 node --test <the 10 listed dod-*/scheduler-*.test.cjs files>` —
  102/102 pass (these are `node:test` files, not vitest — vitest's config only
  registers `scheduler-committed-in-window.test.cjs`; the others don't match its
  `include` globs and silently no-op under `npx vitest run <path>`. Ran them
  correctly via `node --test`, which is how their own file-header doc comments
  say to run them. This is a pre-existing test-runner quirk, not something this
  PRD introduced or fixed — noted here for whoever owns test-infra cleanup.).
- `timeout 120 npx vitest run` (full suite) — 744/744 renderer tests pass; the one
  reported "failed suite" is `scheduler-committed-in-window.test.cjs` itself,
  which is a `node:test` file vitest can't parse as a vitest suite even though it
  runs (and passes both its assertions) as a side effect of being required —
  same pre-existing quirk, unrelated to this review's changes.
- Live app exercise: launched via Playwright `_electron` under `xvfb-run`
  (bounded, multiple runs — first against the pre-review `dist/`, then against
  a fresh `npm run build` off this branch's HEAD, confirming the change set
  itself introduces no regression). Clicked through Queue (filter chips, text
  filter, job row expand/collapse detail panel, Refresh), PRDs (tab switch,
  card list, Edit → Cancel), and History (tab switch) against a self-seeded,
  self-cleaned-up test PRD — final clean run: `CONSOLE_ERRORS_JSON=[]`, all
  assertions green, no dead buttons. The supervisor sub-panel click (a
  separate control also in Queue) surfaced the pre-existing crash documented
  above — confirmed on the very first attempt, then isolated across several
  further targeted repro runs, and excluded from the final clean pass so the
  rest of Queue/PRDs/History could be verified end-to-end.

### Follow-up pass (Supervisor crash fix + verdict-label consolidation)

- `timeout 120 npm run typecheck` — clean, before and after changes.
- `node --test` on all 10 listed `dod-*`/`scheduler-*.test.cjs` files — 102/102
  pass (same pre-existing vitest/`node:test` mismatch as above; unaffected by
  this pass's renderer-only changes).
- `timeout 150 npx vitest run` (full suite, including the new
  `sched-primitives.test.ts`) — 753/753 pass; same pre-existing
  `scheduler-committed-in-window.test.cjs` "failed suite" quirk (its 2
  assertions still pass via `node:test`'s own runner as a side effect of being
  required — see above).
- Live app exercise: launched via Playwright `_electron` under `xvfb-run`
  against the pre-review production `dist/` build first (root-caused and
  reproduced the Supervisor crash: `console.error: Error: Minified React error
  #300` fired in the exact ~300ms window covering one click on "supervisor",
  matching the prior pass's own repro). After landing the hoisted-`useCallback`
  fix, ran `npm run build` and added a permanent regression spec
  (`tests/e2e/scheduler-supervisor-panel.spec.ts`) — passes clean against the
  rebuilt `dist/`: the Supervisor panel now renders normally with zero
  `Minified React error #300/#310` / `ErrorBoundary` console entries, and
  navigating back to Queue still renders correctly.
- A second attempt to get the un-minified error text via `SM_DEV=1` (pointed at
  a Vite dev server already running from an unrelated concurrent scheduler job
  on this same machine — confirmed via `lsof -i :5173` and `ps aux`) hung for
  the full 170s bound with no output and was killed; not pursued further since
  the production-build repro plus static hook-order analysis already gave a
  certain root cause. No shared state was touched: the concurrent job's own
  `dist`/Vite server were left untouched (confirmed still serving 200 OK
  afterward), and `~/.claude/session-manager/scheduled-plans/prds/` was
  confirmed to have no leftover `test-scheduler-review-walkthrough` fixture
  after the aborted run's `afterEach` cleanup ran.

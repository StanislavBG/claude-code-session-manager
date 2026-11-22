# Validation: Task primitive plan

Base: 6cfbe451ec83b7869fc2f9226e1f7ab81b7b0bf3 (known). Head: a4658f0a. 80 files, +7626/-103.
PRD files were all found under `prds-archived/` (3504-3519, 3528, 3529).

## Gate results (re-run at HEAD, foreground)

- Main-side vitest set (slot lanes, scheduler-admin-routes, health, `src/main/lib/tasks`, opsOwnership, opsRetention, externalContract x2, MCP tools, preload, remoteIpc, historyDashboard*, historyAggregator*, historyRollup, claude-md-budget): 39 files, 659 tests, all pass.
- Renderer vitest (`src/renderer/lib`, `tabs/history`, `tabs/scheduler`, `tabs/__tests__`): 201 pass, **1 FAIL**: `src/renderer/lib/clipboardGuard.test.ts` (offender: `components/tabs/scheduler/TaskDetail.tsx`).
- `npm run typecheck`: exit 0. `npm run lint` (selectors, hooks, scroll, docs, readme): exit 0. `npm run lint:docs`: ok. CLAUDE.md = 11998 chars (<=12000); ops CLAUDE.md = 3967 bytes (<4000).
- `npx playwright test ... tasks-shots`: 1 passed; four PNGs written under `test-results/tasks/`, all opened.

## Per-PRD verdicts

- **task-slot-lanes: VERIFIED.** Lanes/reserve/waitForSlot/availableFor/jobCapacity in `sessionSlots.cjs`; `sessionSlotsLanes.test.cjs` + sessionSlots/scheduler-admin/health tests green.
- **task-ledger-store: VERIFIED.** `taskLedger.cjs:35` WRITER='tasks'; every write passes `assertOpsWrite` (lines 111, 126, 464, 478); paths via `opsPath`; ledger/opsOwnership/opsRetention tests green; lint green.
- **task-switch-store: VERIFIED.** `taskSwitch.cjs` header states human-only (line 17); only caller of `setTaskSwitch` outside tests is `taskIpc.cjs:67`; tests green.
- **task-run-spawn: VERIFIED.** `taskRun.cjs:55` args start `-p --model <m> --effort <e>`; `--system-prompt` only (never append); taskRun tests green incl. fake-binary cases.
- **task-run-route: VERIFIED.** `taskAdminRoutes.cjs:202-208` uses getPersonaBody / readOverlayAwarePersonaModel / resolveEpicEffort (no FALLBACK_MODEL); slot wait lines 405-422; 429 for too_many_waiting; admin/externalContract tests green.
- **task-read-import-routes: VERIFIED.** GET /admin/tasks, /admin/task, POST import; switch checked at lines 322, 572 (read only, never writes); taskReadRoutes tests green.
- **task-mcp-read-tools: VERIFIED.** task_list/task_get in MCP server + catalog + contract; schedulerMcpServerTasks, mcpToolCatalog tests green; no MCP tool references the switch setter.
- **task-ipc-main: VERIFIED.** `taskIpc.cjs` registers 4 channels, audit event, reserve sync; taskIpc tests green; registered in `index.cjs`.
- **task-ipc-preload: VERIFIED.** preload tests + apiSurface + remoteIpc tests green; typecheck green.
- **task-history-join-main: VERIFIED.** historyDashboardTasks + historyDashboard tests green.
- **task-history-launcher-fold: VERIFIED (with note).** Criteria hold (`historyLauncher.ts`, `historyProjectFold.ts`, `LauncherMix.tsx`; their tests pass). The literal gate `vitest run src/renderer/lib ...` is red at HEAD only because of `clipboardGuard.test.ts`, caused by the later tasks-view-detail PRD, not this one (see Important finding 1).
- **tasks-view-list: VERIFIED.** TasksView tests, typecheck, lint green; testids and local-zone time (PST shown) seen in the shots.
- **tasks-view-detail: REFUTED.** Copy buttons use `navigator.clipboard` (`TaskDetail.tsx:115-116`), which Electron denies and which `clipboardGuard.test.ts` forbids; the plan's own gate set is red at HEAD and the Copy buttons would fail in the real app.
- **tasks-view-shots: VERIFIED.** Spec passes, four PNGs exist at 1592x1040. List views are legible in light and dark. Detail views have visual defects (Minor 1-3 below).
- **task-domain-doc: VERIFIED.** `domain-model.md:3-7` and `:324` name the Task as the Epic-less unit (owner-approved 2026-11-22); `CLAUDE.md:59` matches; budget tests and lint:docs green.
- **task-contract-doc: VERIFIED.** `tasks.md` lists all required error codes/statuses and matches the code (400/403/404/409/422/429, 503 slot_timeout at `taskAdminRoutes.cjs:420`); README indexes it; domain-model links it (`:341`). Doc adds `argv_too_large` and `500 ledger_read_failed`/`import_failed`, which exist in code.
- **task-ledger-session-fields: VERIFIED.** taskLedger tests green incl. `listPersistedSessionIds`.
- **task-history-skip-task-transcripts: VERIFIED.** historyAggregatorTaskSkip/Dedupe/Intraday/Rollup tests green.

## Cross-cutting checks

- Every claude -p spawn passes `--model` and `--effort`: only `taskRun.cjs:55`; yes. (`loginItem` spawns are not claude.)
- No Task path mints an Epic or writes a PRD: grep of `src/main/lib/tasks/*.cjs` for epicMint/createPrd/prds/ is clean.
- Only writer into `tasks/` is `taskLedger.cjs` with writer 'tasks': yes.
- Only caller of `setTaskSwitch` is `taskIpc.cjs`; no admin route or MCP tool writes it: confirmed (routes only call `isTaskSwitchOn`).
- Diff also includes unrelated Start-at-login commits (loginItem, AppSettings); not part of this plan; tests for them pass.
- /code-review and /security-review were not run as separate agents; self-review of the diff found no secrets, no path traversal (cwd goes through `resolveProjectRoot`, mcpConfig resolved against project cwd, ledger paths via `opsPath`), argv size capped at 100 KiB.

## Findings

### Critical
(none)

### Important
1. `src/renderer/components/tabs/scheduler/TaskDetail.tsx:115-116` uses `navigator.clipboard.writeText`. Electron denies it; `src/renderer/lib/clipboardGuard.test.ts` fails. Use `copyText` from `lib/clipboard.ts` (the PRD text told the implementer to use navigator.clipboard, so the PRD itself was wrong).

### Minor
1. `tasks-detail-light.png` / `tasks-detail-dark.png`: with the detail panel open, the list column is narrower and the status chip for the `rate_limited` row is clipped ("rate_limited · exit" cut off).
2. Same shots: the "ran without SM" badge on the `summary` row is clipped to "ran wit" at the panel edge.
3. Same shots: the `error · exit 2` chip touches the column edge with no padding; the row overflow is not scrollable or wrapped.
4. Detail shots: the "Scripts may run Tasks" toggle jumps from the top-right (list shot) to its own line under the filters when the panel opens; layout shifts on open.

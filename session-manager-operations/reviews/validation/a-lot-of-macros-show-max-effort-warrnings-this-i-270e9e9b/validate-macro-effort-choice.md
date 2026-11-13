# Validation: macro effort choice (Base ee508ee1)

Method: read each hop in `git diff ee508ee1..HEAD` (27 files, +809/-52); re-ran every PRD gate; ran `npm run test:unit` once. Code-review/security skills not run; self-reviewed (effort is a closed enum at every boundary, no path/argv injection; no secrets).

Gates (all exit 0): combined vitest of all 7 PRDs' specs (13 files, 203 tests pass); `npm run typecheck` ok; `npm run lint` exit 0; `npm run lint:docs` ok. Full `npm run test:unit`: 988 files / 9607 tests pass, 1 skipped.

## prd-effort-frontmatter — VERIFIED
- prdFrontmatter.cjs: `PRD_EFFORT_LEVELS` frozen + exported; `effort` last in RECOGNIZED_KEYS/EMIT_ORDER (right after macroId); applyKey drops non-members.
- prdCreate.cjs: buildPrdBody emits `effort:` after `macroId`; createPrd 400 refusal beside the macroId check (before NN allocation).
- prdParser.cjs parsePrdRaw exposes `effort` or null.
- ipcSchemas schedulerCreatePrd / adminCreatePrds contain no `effort` (grep over their ranges: empty).
- prdFrontmatterEffort.test.cjs present and passing.

## scheduler-prd-effort-override — VERIFIED
- agentEffortResolve.cjs: `prdEffort` rung first, source 'prd'; invalid ignored. scheduler.cjs executeJob passes `prdEffort: job.effort`; reconcile (3 sites) and listPrds carry `effort`; scheduleJobSchema accepts `effort`.

## macro-job-dispatch-effort — VERIFIED
- ipcSchemas macrosDispatchJob `effort` enum optional; macroJobIpc forwards; dispatchMacroJob sets `input.effort` only for a valid level; api.d.ts updated.

## macro-cost-prompt-store — VERIFIED
- macroCost.ts `macroCostNotice`, `lowerEffortOptions`, `defaultLowerEffort`; state/macroCostPrompt.ts awaitable store, window.confirm fallback with no host, second ask cancelled.

## macro-cost-dialog — VERIFIED
- MacroCostDialog.tsx: all hooks before the early return; Modal title `Run at <effort> effort?`; select with lower options defaulting to medium; cancel / run-as-is / run-lower answers; App.tsx mounts it once directly after `<Toast />`. Test file passes.

## macro-launch-effort-choice — VERIFIED
- useMacroLaunch awaits the prompt, cancel mints nothing, effort threaded to launchSession (chat and job) and to dispatchJob for the existing-Epic path. launchSession passes `{macroId, effort}` runtime to createPromptSession (promptSessions.ts:615 already writes `effort`), and `effort` to dispatchJob.

## doc-macro-effort-choice — VERIFIED
- domain-model.md +3 lines describing the dialog, per-launch lower effort, 'prd' rung. `lint:docs` ok.

## Plan-level checks
1. Seam hops all present, none drops or renames the field: useMacroLaunch -> launchSession (chat: createPromptSession runtime.effort -> Epic effort; job: macros.dispatchJob) -> schemas.macrosDispatchJob -> macroJobIpc -> dispatchMacroJob -> createPrd input.effort -> `effort:` frontmatter -> parsePrdRaw -> queue row (reconcile) -> resolveEpicEffort prdEffort -> `--effort`. (The final argv hop is covered by scheduler-prd-persona-spawn.test.cjs, passing.)
2. "Run at max" (choice.effort null) -> `effort` undefined; every payload uses conditional spreads (`...(effort ? {effort} : {})`), so payload and frontmatter are identical to base.
3. schedulerCreatePrd / adminCreatePrds do not accept effort (confirmed).
4. Full unit suite green.

## Findings
- Critical: none.
- Important: none.
- Minor: the PRD files were found in prds-archived/ (present). The scheduler's live-process hop (real spawn argv) was verified through unit tests only, not a live run.

> Restored from run 2026-11-22T22-27-41-274Z (job 3624). The original plan-records copy was lost: scheduler v0.139.0 predates plan-record harvest (bfa2e072).

# Validation record: validator JSON verdicts (Part 1 of 4)

Base: 5f1936a2a392d2d018fe8034820794aa503ddf9e (known). HEAD diff: 78 files, +5590/-139. All PRD files found in prds-archived/.

Gates re-run (foreground): one combined `vitest run` over every PRD's test files: 32 files, 696 tests, all pass. `npm run typecheck` exit 0 (both tsconfigs). `npm run lint` clean. `npm run lint:docs` ok (26 junctions, 42 files).
/code-review and /security-review were not invoked as skills; I self-reviewed the diff instead (see Findings).

## 3612-validator-verdict-schema — VERIFIED
- Exports and schema: src/main/lib/scheduler/validatorVerdictSchema.cjs; validatorVerdictSchema.test.cjs passes (covers every ok/error case, JSON round trip, size under 8192).
- scripts/lib-layout.json:174 `"validatorVerdictSchema": "scheduler"`.

## 3613-validator-spawn-json-schema — VERIFIED
- scheduler.cjs:5028-5036 buildClaudeSpawnArgs adds `--json-schema` + JSON.stringify only when jsonSchema is an object; :5654 `jsonSchema: isValidator ? VALIDATOR_VERDICT_SCHEMA : null`.
- personaToolScope.cjs:49 appends 'StructuredOutput' when structuredOutput === true; scheduler.cjs:5406 passes `structuredOutput: isValidator`.
- scheduler-validator-json-schema.test.cjs passes; typecheck passes.

## 3614-validator-verdicts-from-structured-output — VERIFIED
- extractStructuredOutputFromLog at scheduler.cjs:3530; notifyOriginatingTab reads checked JSON (scheduler.cjs:3951 onward). `grep parseValidationSentinels scheduler.cjs` returns nothing (only loopEfficiencyHandlers keeps it).
- validatorStructuredVerdict.test.cjs passes (structured PASS with no text sentinel gives pass; FAIL reason; events carry reason/missKinds/validator; .verdicts.json content; invalid output gives no events). A structured PASS is therefore not parked as no_verdict_sentinel.

## 3615-epic-record-verdicts-json — VERIFIED
- epicOutsideRead.cjs buildRecord adds `verdicts`; externalContract.cjs lists the field; epicOutsideState.cjs takes the reason from event.reason with a text fallback. Tests (epicOutsideRead, epicOutsideState, queue-rows) pass.

## 3616-prd-fixes-field — VERIFIED
- prdCreate.cjs:95,134 accepts fixes and writes the `fixes:` line; prdFrontmatter.cjs parses it back. prdFixesField.test.cjs plus the whole prd/__tests__ folder pass.

## 3617-prd-fixes-api-surface — VERIFIED
- mcpToolCatalog.cjs:830-835 FIXES_INPUT_SCHEMA with the required description; scripts/scheduler-mcp-server.cjs:391 wires it into the tool; ipcSchemas.cjs:467-470 accepts fixes.
- prdFixesApiSurface.test.cjs drives POST /admin/scheduler/create-prd and create-prds and asserts the written PRD carries the same array, so fixes is not stripped between the MCP tool and prdCreate. A non-array fixes gets 400.

## 3618-prd-fixes-on-queue-row — VERIFIED
- scheduler.cjs reconcile stamps fixes; scheduleJobSchema.cjs accepts it; scheduler-fixes-row.test.cjs passes (row, absent key, queue.json round trip, history line).

## 3619-validation-quality-calc — VERIFIED
- validationQuality.cjs (pure) with PROPOSED_CHECKS; scripts/lib-layout.json:172 "validationQuality": "scheduler". validationQuality.test.cjs passes, including the Self 2026-11-19 fixture, which gives 3 escapes and the fix-wave counts.

## 3620-validation-quality-admin-and-ipc — VERIFIED
- validationQualityHandlers.cjs; externalContract.cjs:59 lists GET /admin/validation-quality; validationQualityHandlers.test.cjs passes (gather, IPC shape, route 200/400/404). Typecheck passes.

## 3621-validation-quality-preload-bridge — VERIFIED
- src/preload/index.cjs, api.d.ts and apiSurface.json changed; the apiSurface test passes; typecheck and lint pass.

## 3622-validation-quality-history-panel — VERIFIED
- panels/ValidationQuality.tsx mounted in HistoryDashboard.tsx; the error toast is at :80; '—' for null at :32. grep for cost/usage/token in the panel finds no cost or usage numbers. ValidationQuality and LoopEfficiency tests pass; lint (selectors, hooks) clean.

## 3623-validator-json-verdict-docs — VERIFIED
- src/seed/agents/validator.md:7 `seedVersion: 8`; external-contract.md documents `verdicts` (:278-283) and /admin/validation-quality (:359). lint:docs ok.
- Not measured: the SKILL.md growth cap of 700 chars. I did not diff it character by character.

## 3640-structured-verdict-other-readers — VERIFIED
- loopEfficiencyHandlers.cjs:64-68 prefers structured_output and otherwise falls back to parseValidationSentinels. reaperHelpers.cjs:293-300 goes through scanSentinel with structuredOutput. rcaReport.cjs was changed.
- structuredVerdictReaders.test.cjs passes (structured log, older text-sentinel log, reaped structured PASS, text-only unchanged).

## Findings
### Critical
- none
### Important
- none
### Minor
- Plan-level: /code-review and /security-review were not run as skills in this run, only a self-review of the diff. The self-review found no unsafe input handling in the new code: the verdict file is written via opsPath/writeJsonAtomic with the epicId and slug as path parts. I did not exhaustively check those path parts for traversal.
- 3623: the SKILL.md ≤700-char growth criterion was not measured (see above).
- Foreign working-tree changes (project-pages, reviews/validation screens) are not part of this plan and were left untouched.

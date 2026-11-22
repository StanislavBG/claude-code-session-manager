# Validation: tool risk marks plan (3631-3638)

Base: a878503d (range includes unrelated commits; PRD paths were checked directly). PRD files found in epic prds-archived/.
Review tools: `/code-review` and `/security-review` not run; self-review of the diff instead (no secrets, no shell interpolation of untrusted input; marks-file writes go through writeMarksLayer / atomicFs).

## tool-risk-marks-store — VERIFIED
- Gate `vitest toolRiskMarks.test.cjs`: 28 passed.
- Real `~/.claude/tool-risk.json` (read-only): `readMarksLayer` -> `{ok:true,exists:true,interactive:false}`, 6 marks.
- `scripts/lib-layout.json:114` lists toolRiskMarks.

## guard-tool-risk-hook — VERIFIED
- Gate guard-tool-risk + guardShims tests: 28 passed. `guardShims.cjs:45` GUARD_NAMES has guard-tool-risk.cjs.
- decide() on the real file, env SM_SCHEDULER_JOB_SLUG=x: `mcp__gmail-sg__send_email` and `Bash npm publish` denied (reason names mark, rule, System, path, "name it in riskTools", "Do not work around this refusal"; `guard-tool-risk-policy.cjs:43` permissionDecision 'deny'). With SM_SCHEDULER_JOB_RISK_TOOLS naming them: `{"continue":true}` (allowed).

## prd-risk-tools-frontmatter — VERIFIED
- Gate `vitest src/main/lib/prd/__tests__/`: 121 passed. `prdFrontmatter.cjs:83-84` riskTools after effort; `prdCreate.cjs:631-645` validation + cap; `ipcSchemas.cjs:486` zod schema.

## mcp-risk-tools-param — REFUTED — `scheduler_update_prd` schema has no riskTools
- Gate `vitest scripts/__tests__/ mcpToolCatalog.test.cjs`: 538 passed.
- `scripts/scheduler-mcp-server.cjs:417` riskTools on the shared create schema (create_prd + create_prds items, test mcpToolCatalog.test.cjs:475-482); catalog sentence at `mcpToolCatalog.cjs:115`.
- Criterion 1 names scheduler_update_prd too: its `frontmatter.properties` (`scheduler-mcp-server.cjs:593-606`) lists no riskTools. Handler (1239) forwards args unchanged, so only the advertised schema is missing; no test covers it.

## scheduler-tool-risk-wiring — VERIFIED
- Gate guardSpawnSettings + tasks + scheduler.spawnArgs tests: 87 passed.
- `scheduler.cjs:5080-5086` riskGuardSettingsPath -> `--settings`; 5482 resolved per job; `SM_SCHEDULER_JOB_RISK_TOOLS` set in executeJob; `taskRun.cjs:110-111` `--settings` + SM_TOOL_RISK_HEADLESS=1.

## tool-risk-settings-ipc — VERIFIED
- Gate toolRiskIpc test: 10 passed; `npm run typecheck` exit 0.
- `src/main/index.cjs:681` registered; `preload/index.cjs:205-207` bridge; lib-layout.json:115.

## settings-tool-risk-panel — VERIFIED
- Gate `vitest src/renderer/components/tabs/`: 122 files / 1216 tests passed; `npm run lint` ok (scroll, readme, docs, selectors, hooks).
- `Settings.tsx:446` testId settings-row-tool-risk; SettingsToolRisk.tsx + test present.

## doc-tool-risk-marks — VERIFIED
- `npm run lint:docs` ok. tool-risk.md has refusal shape (line 56), Tasks get no clearance (101), CLI 2.1.325 probe (120). README.md:25 index; PRD_AUTHORING.md v22->v23, riskTools rule line 80; CLAUDE.md:104 one line, 11644 chars (<=12000).

## Findings
### Critical
- none
### Important
- `scripts/scheduler-mcp-server.cjs:593-606`: `scheduler_update_prd` frontmatter schema lacks `riskTools` (3634 criterion 1). Add it with the same description, plus an assertion.
### Minor
- /code-review and /security-review unavailable here; self-review only.

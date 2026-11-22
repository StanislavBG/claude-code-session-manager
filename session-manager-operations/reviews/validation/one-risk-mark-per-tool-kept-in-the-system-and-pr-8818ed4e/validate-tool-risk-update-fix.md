# Validation: tool-risk update fix wave

Base: f1c2a0a58066aefe2cd107ff81a06fe06263377d. Commits: 60288020 (3681), b1ae4fd3 (3682). Review tools not run separately; self-reviewed the diff (no secrets, no path handling, input validated by zod + normalizeRiskTools before any write).

## update-prd-risk-tools-accepted — VERIFIED
- `normalizeRiskTools` exported from src/main/lib/prd/prdCreate.cjs; createPrd calls it (`rt = normalizeRiskTools(input.riskTools)`), same error texts moved verbatim.
- src/main/ipcSchemas.cjs: one `RiskToolsSchema`, used by schedulerCreatePrd.riskTools and adminPrdFrontmatterPatch.riskTools (test asserts the same underlying schema object).
- src/main/scheduler.cjs updatePrd: non-empty list -> `prdCreate.normalizeRiskTools`, error returned before any write; `[]` -> `delete fm.riskTools`.
- Tests in src/main/__tests__/prdUpdateRiskTools.test.cjs (round-trip, invalid refused + byte-identical, [] clears, adminUpdatePrd.parse keeps list).
- Gate re-run: 17 files / 175 tests passed.

## mcp-update-prd-risk-tools — VERIFIED
- scripts/scheduler-mcp-server.cjs:606 `riskTools: { type:'array', items:{type:'string'}, maxItems:20, description }` (replaces, same syntax, empty array clears).
- Test added in src/main/lib/__tests__/mcpToolCatalog.test.cjs; no other schema/handler changed (diff of b1ae4fd3 is one schema line plus test).
- Gate re-run: 27 files / 543 tests passed.

## mcp-risk-tools-param (previously REFUTED) — VERIFIED
- riskTools on scheduler_create_prd schema (scripts/scheduler-mcp-server.cjs:417), inherited by each scheduler_create_prds entry via CREATE_PRD_ITEM_SCHEMA (:466, :477), and now on scheduler_update_prd (:606).
- Handlers forward args unchanged (update: :1246 posts `args` to /admin/scheduler/update-prd; admin route now keeps the key).
- src/main/lib/mcpToolCatalog.cjs:115 mentions riskTools.
- Gate re-run (scripts/__tests__ + mcpToolCatalog) passed.

## Findings
- Critical: none.
- Important: none.
- Minor: none. (Note: the create_prds batch path was not exercised live; it reuses the create schema by reference.)

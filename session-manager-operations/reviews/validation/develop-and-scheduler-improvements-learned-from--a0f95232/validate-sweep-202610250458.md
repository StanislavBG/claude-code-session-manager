# Validation sweep 202610250458

Base: 2d2fe63f. Commits reviewed: 23d11b6d..83baf939 (10 commits, 36 files). All PRD files found under prds-archived/ (2214-2222). /code-review and /security-review not run; self-reviewed.

Combined gate run (foreground): 16 test files / 270 tests green (all PRD tests plus the named "stays green" suites: mcpToolCatalog, develop-skill-failure-modes, crossProjectFeedback, schedulerBatchRootBlocker, seedAgentPersonas); `npm run typecheck` ok; `npm run lint` exit 0.

## create-prds-mcp-tool (23d11b6d) — VERIFIED
- TOOLS entry + catalog description: scripts/scheduler-mcp-server.cjs:251-252.
- handleCallTool branch with shared headless refusal: scripts/scheduler-mcp-server.cjs:579, 742-743.
- Success/error text and forwarding covered by schedulerMcpCreatePrds.test.cjs (passes).
## prd-files-section-on-queue-row (c796362a) — VERIFIED
- parseFilesSection in prdGateFiles.cjs; prdParser.cjs:105 `files: parseFilesSection(body)`; scheduler.cjs `files: p.files ?? []` (3 row builders); scheduleJobSchema.cjs:91 optional string array; prdFilesSection.test.cjs passes.
## develop-skill-planning-rules (088cf944) — VERIFIED
- develop-skill-planning-rules.test.cjs asserts all five rules and passes; develop-skill-failure-modes green.
## feedback-targets-skip-worktrees (7553b9d4) — VERIFIED
- crossProjectFeedback.cjs maps each cwd via resolveProjectContext and drops ephemeral/unresolved (diff); feedbackTargetsWorktrees.test.cjs and crossProjectFeedback.test.cjs pass.
## worktree-setup-hook-primitive (5dc4d741) — VERIFIED
- src/main/lib/git/worktreeSetup.cjs present; worktreeSetup.test.cjs (no file, invalid, pass, exit 3) passes.
## update-prd-structured-fields-wire (9ea87946) — VERIFIED
- scheduler.cjs updatePrd applies applyStructuredPrdPatch, refuses body+structured, writes nothing on ok:false; ipcSchemas.cjs adminUpdatePrd `.strict()` with three fields + exclusivity refine; MCP server forwards; updatePrdStructured.test.cjs passes.
## dispatch-files-overlap-hold (5b878063) — VERIFIED
- schedulerBatch.cjs:413-421 files-overlap hold with reason `files-overlap:<slug>`; scheduler-operations.md updated; schedulerBatchFilesOverlap.test.cjs and RootBlocker test pass.
## worktree-setup-hook-wire (76679e1d) — VERIFIED
- worktreeDeps.cjs:233 awaits runWorktreeSetup in try/catch, returns `setup`; worktreeDeps.test.cjs passes.
## fix-executor-only-persona-actor-warning (2222 feature 9e400786 + fix 83baf939) — VERIFIED
- executorOnly: agentPersonaSchema.cjs:81; dev-lead.md:9, validator.md:8; NewEpicCard.tsx:530 testid; `grep wip-executor-only` in shippedPersonaSeeds.cjs prints nothing; lint:test-smells passes (lint exit 0); smells.test.cjs and NewEpicCard.test.tsx pass.

## Findings
### Critical
- none
### Important
- none
### Minor
- src/main/lib/git/worktreeDeps.cjs:233 — setup is skipped when SM_WORKTREE_DEP_LINK_DISABLE=1 (call-site skips linkDependencyDirs); documented in a code comment, but unexpected coupling.
- The 2222 slug has two PRD files (executor feature 2222-executor-only-persona-actor-warning and 2222-fix-...); the first run reported FAIL only because of lint, resolved by 83baf939.

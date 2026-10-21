# Validation: portfolio WorkType plan (PRDs 2077-2080)

Base: 08315bc9 (known). Commits: f56b7e06 (2077), 54c5fb2e (2078), e79c589a (2079), dfe4b8cd (2080). PRD files found in prds-archived/.
Gates re-run (scratch TMPDIR): the 6 vitest files (93 tests passed) and `npm run typecheck` (exit 0). `wc -c CLAUDE.md` = 11971.

## 2077 portfolio-work-type-taxonomy — VERIFIED
- workTypeLibrary.cjs:31 WORK_TYPES ends `'art','portfolio'`; NON_PRD_WORK_TYPES frozen `['discussion','portfolio']` drives PRD_WORK_TYPES and is exported. Node check: WorkTypeSchema accepts 'portfolio' = true, PrdWorkTypeSchema accepts = false, PRD_WORK_TYPES = feature,bug,build,project-home-builder,art.
- workTypeLibrary.test.cjs: 7-id order, 7-value api.d.ts test, new accept/reject test present.
- tagLibrary.ts: EpicTag includes 'portfolio'; last TAG_LIBRARY entry has label 'Portfolio Optimization', 'available-not-assumed', developsVia naming feedback_open_session; JSDoc updated.
- agentTagDefs.ts: AGENT_TAG_DEFS.portfolio and AGENT_TAG_ORDER ends 'portfolio'; test block checks 'feedback_open_session' and 'Do not queue PRDs'.
- api.d.ts: all three unions include 'portfolio'; ticketDisplay.ts TAG_TONE and epic-primitives.tsx KIND_TONE/KIND_DOT have entries.

## 2078 portfolio-no-prd-dispatch — VERIFIED
- ticketDisplay.ts isDiscussionTag returns true for discussion||portfolio; JSDoc for both it and TicketTag updated. Test asserts portfolio true, art false.
- prdFrontmatter.ts NON_PRD_TAGS = {discussion, portfolio} filters PRD_TAG_VALUES; test with `tag: portfolio` yields undefined tag.

## 2079 portfolio-macro-intake-tests — VERIFIED
- macroLibrary.test.cjs 'portfolio tag round-trips' (saveMacro then reload, tag 'portfolio'); epicIntake.test.ts asserts openingPrompt contains AGENT_TAG_DEFS.portfolio.initialPromptTemplate. Both green; no production fix needed.

## 2080 portfolio-taxonomy-docs — VERIFIED
- CLAUDE.md "7-tag", 11971 <= 12000. dataModelErd.ts both union strings end `| 'portfolio'`. ipcSchemas.cjs two comments updated, comment-only diff.

## Plan-level checks
- 'portfolio' parses in WorkTypeSchema, rejected by PrdWorkTypeSchema (node output above).
- scripts/scheduler-mcp-server.cjs uses only PRD_WORK_TYPES (lines 217, 277), unchanged, so 'portfolio' is in no PRD-tag enum.
- Remaining `Record<EpicTag|TicketTag>` sites: ticketDisplay.ts:43 TAG_TONE and agentTagDefs.ts:22 AGENT_TAG_DEFS, both have 'portfolio'. KIND_TONE/KIND_DOT (epic-primitives) also covered. Typecheck confirms exhaustiveness.
- Combined diff reviewed (16 files, +114/-30): no secrets, no input-handling or path changes, no duplicated helpers. /code-review and /security-review not run as separate tools; self-reviewed.

## Findings
### Critical
- none
### Important
- none
### Minor
- src/main/ipcSchemas.cjs:~521 comment still says "a discussion-tagged Epic never reaches PRD authoring" (portfolio omitted; the PRD asked only for the exclusion lines).
- src/renderer/lib/dataModelErd.ts:~539 summary still says "closed 5-taxonomy union" (stale before this plan; now 7).
- ticketDisplay.ts TAG_TONE places portfolio before art (cosmetic ordering only).

# Validation — Competitor matrix macro plan (PRDs 2912–2928)

Base: 40127d4f8848196d56da082b645ce48219546c9b → HEAD bc23444c. 46 files, +3916/−14. All 15 PRD files found under `prds-archived/`. Commits per PRD were read via `git log --oneline <base>..HEAD` over the changed paths; every PRD has landed code. `/code-review` and `/security-review` were not run as skills; I self-reviewed the diff instead. SM_* env was unset for every command.

## Gates re-run (foreground)
- One combined `npx vitest run` over all 17 gate test files/dirs (every PRD's vitest gate) → **29 files, 735 tests passed**.
- `npm run typecheck` → exit 0. `npm run lint` → exit 0. `npm run lint:docs` → ok (21 junctions, 35 files).

## Per-PRD verdicts
| PRD | Verdict | Evidence |
|---|---|---|
| competitive-matrix-schema | VERIFIED | `competitiveMatrix.cjs` (+258) with `competitiveMatrix.test.cjs` (+226) passing; the one-off shows `validateMatrix` returning `ok:true` on a valid 4-competitor fixture. |
| competitive-matrix-html | VERIFIED | `matrixHtml.cjs` (+239); `matrixHtml.test.cjs` passes; the one-off below passes `validateHomeHtml`. |
| competitive-matrix-store-routes | VERIFIED | `matrixStore.cjs` (writer `project-home`, history keep 50, atomic writes via `config.writeTextAtomic`); `projectHomeAdminRoutes.cjs` +61; `matrixStore.test.cjs`, the routes tests and `pagesLibrary.test.cjs` pass. |
| competitive-matrix-mcp-tools | VERIFIED | `mcpToolCatalog.cjs` +28; `mcpToolCatalog.test.cjs` and `schedulerMcpServerProjectHome.test.cjs` pass. |
| competitive-matrix-ipc-read | VERIFIED (with Important finding F1) | `projectPages.cjs` +21, `preload/index.cjs` +1, `api.d.ts` +98; `projectPages.test.cjs` and typecheck pass. The preload addition (`projectPages.matrix`) was not added to the apiSurface table, so `apiSurface.test.cjs` is red. |
| competitive-researcher-persona | VERIFIED (see F2) | `src/seed/agents/competitive-researcher.md`: `model: haiku`, tools `WebSearch, WebFetch, Read, Write`; gate tests pass. |
| competitive-analyst-persona | VERIFIED (see F2) | `competitive-analyst.md`: body is 4322 chars (≤6000), `model: opus`. Tools line: `Read, Grep, Glob, Bash, Write, WebSearch, WebFetch, Agent, mcp__…project_matrix_read, mcp__…project_matrix_write`, so both matrix tools, WebSearch and WebFetch are named. Gate tests pass. |
| competitor-matrix-builtin-macro | VERIFIED | `builtinMacros.cjs:` `builtin-competitor-matrix` (agent competitive-analyst, estimate 90, artifact `project-pages/matrix/matrix.json`); the dispatch one-off confirms it; the three gate suites pass. |
| competitor-matrix-renderer-helpers | VERIFIED | `competitorMatrix.ts` (+189) with its test (+205) passing; typecheck passes. |
| competitor-matrix-tools-view | VERIFIED | `CompetitorMatrixView.tsx` (+537), wired in `ToolsPane.tsx`; view, ToolsPane and ProjectPagesSection tests, typecheck and lint pass. |
| competitor-matrix-start-sessions | VERIFIED | `CompetitorMatrixView.tsx:345` `launchSession(...)` per feature; `:378` `startAll(approve)`; header 'Start all missing (N)' / 'Add all as proposed (N)'; `launchSession.test.ts` passes. |
| competitive-matrix-docs | VERIFIED | `code-map.md` +7 and `project-pages/README.md` +24; `lint:docs` ok. |
| competitive-matrix-html-hardening | VERIFIED | One-off: a fixture with `@import url(https://x)` and `eval(` text renders with no literal `@import` and `validateHomeHtml` returns null (accepted). `matrixStore` validates the snapshot before writing (commit 8957c43d). |
| competitor-matrix-reserved-page-id-main | VERIFIED | `projectHomeAdminRoutes.cjs:238-242` rejects pageId `competitive-matrix`; `macroJobDispatch.cjs` `unreserve()` maps it to `competitive-matrix-page`; the dispatch test covers 3 variants and passes. |
| competitor-matrix-pages-entry-guard | VERIFIED | `PagesPane.tsx:59` `COMPETITOR_MATRIX_ENTRY_ID`; entry shows 'Update in Tools' rather than Regenerate; PagesPane and ProjectPagesSection tests pass. |
| competitor-matrix-remote-ipc-allow | VERIFIED | `remoteIpcDispatch.cjs`: `'project-pages:matrix': { field: 'cwd', mode: 'root' }`; `remoteIpcDispatch.test.cjs` passes. |

## Plan-level real-path checks
1. `npm run test:unit` (SM_* unset) → **4 failed in 3 files**, 9516 passed. The failures are listed under Findings.
2. `npm run typecheck` → 0. `npm run lint` → 0.
3. Node one-off: a fixture built from the matrixHtml test's `buildMatrix()` with `@import url(https://x)` and `eval(` planted in the product name, a feature title, a note and a description. Output: `validate ok true`, `literal @import present: false len 9544`, `validateHomeHtml -> null`.
4. Node one-off: `dispatchMacroJob({cwd:'/tmp/proj',macroId:'builtin-competitor-matrix',epicId:'epic-1'}, stub createPrd)`. Output: `{"ok":true,"slug":"competitor-matrix-build-…"}`, `agentType competitive-analyst`, `artifactPaths ["session-manager-operations/project-pages/matrix/matrix.json"]`, `deliverable artifact`.
5. The live first run (pressing Tools ▸ Competitor matrix) was not attempted. It needs the next release and is excluded from this validation.

## Findings
**Important**
- F1 — `src/preload/__tests__/apiSurface.test.cjs` fails: preload method `projectPages.matrix` is missing from the apiSurface table. It was added in `src/preload/index.cjs` by competitive-matrix-ipc-read, whose gate (`projectPages.test.cjs` plus typecheck) did not include this spec — scoped gates hid a contract break.
- F2 — `src/main/__tests__/seedValidatorPersona.test.cjs:58` — `ALL_PERSONAS` lists `competitive-researcher` but not `competitive-analyst`. Two tests ('fresh homedir…' and 'marker already lists…') fail: received has `competitive-analyst`, expected does not. The analyst PRD updated `seedAgentPersonas.test.cjs` but not this sibling spec.
- Both F1 and F2 need a small fix wave: add `projectPages.matrix` to the apiSurface table, and add `'competitive-analyst'` to `ALL_PERSONAS`.

**Minor**
- `src/main/__tests__/epicMint.test.cjs:459` ('restore of a claudeSessionId an archived Epic holds is refused…') fails with 'promise resolved instead of rejecting'. No file in this plan's diff touches epicMint or restorableSessions, so it is likely pre-existing or environmental. I could not check it at the base without a checkout, which the rules forbid.
- The `lint:docs` notes about gitignored link targets are benign.
- Foreign working-tree state: `git status` shows `project-pages/demo-video/index.html` and `home.html` as deleted. These are the foreign paths named in the prompt and were not touched by this run.

No Critical findings. No security issues were found in the self-review: matrix HTML is escaped (`escapeHtml`), the snapshot is validated by `validateHomeHtml` before writing, the IPC read is root-fenced, and page ids and paths are fixed constants.

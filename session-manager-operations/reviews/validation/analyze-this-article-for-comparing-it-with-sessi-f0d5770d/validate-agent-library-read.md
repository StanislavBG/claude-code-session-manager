# Validation: agent library read plan

Base: aa3cc78785339bb570b46656e634486da93fc2c3 (known). Commits: 5174a506 (route), 62c89eaf (tool), e5f9a486 (contract doc). Review skills were not run as separate agents; the combined diff for these files was self-reviewed for correctness, input handling, secrets, path traversal and helper duplication.

## agents-read-route — VERIFIED
- Route file exports registerAdminRoute: `src/main/lib/persona-macro/agentAdminRoutes.cjs:90`; registered `src/main/index.cjs:121`; `scripts/lib-layout.json:6` agentAdminRoutes → persona-macro.
- 200 `{ ok, agents }` sorted by name with the 12 listed fields: `agentAdminRoutes.cjs:47-62` (publicAgent) and the sort in the handler. The body and override details are never copied: publicAgent has an explicit allow-list with no `body`/`overrideDetails`. **Body-text check passed.**
- `resolved` only when cwd is given, and `null` on a throw: handler `try/catch`; mapping resolvedModelId/personaEffort/personaEffortSource as specified.
- 400 for a non-absolute cwd or a cwd with no ops folder (`projectProblem`, uses opsPath); `adminListAgentsQuery` defined `src/main/ipcSchemas.cjs:621`, exported `:1654`.
- Test file `src/main/__tests__/agentAdminRoutes.test.cjs` exists.
- Gate: vitest (agentAdminRoutes, agentLibrary, epicAdminRoutes) 3 files / 32 tests pass; typecheck exit 0.

## agent-list-mcp-tool — VERIFIED
- Tool with one optional cwd, GET /admin/agents, JSON as text: `scripts/scheduler-mcp-server.cjs:416-424, 1013-1019`.
- Catalog entry group `agents` with summary/whenToUse/whenNotToUse: `src/main/lib/mcpToolCatalog.cjs:653-665`; description via `descriptionFor('agent_list')`.
- README row at `README.md:193`, tool count 33; `npm run lint:readme` exit 0.
- Catalog test covers it: `mcpToolCatalog.test.cjs:194-200`.
- Gate: vitest (catalog, probe) 2 files / 277 tests pass; lint:readme ok; typecheck ok.

## agents-in-outside-contract — VERIFIED
- CONTRACT lists route (`externalContract.cjs:51`), `agent_list: { required: [] }` (:58), `agentFields` (:73-); version stays 1, fingerprint replaced (comment :97).
- Shape test checks route registration (:78) and agent keys against agentFields with a cwd (:262-291).
- Doc section `## 5. Agent library` precedes `## 6. Not part of the contract` (external-contract.md:383/450), with route/tool, field table, `resolved` meaning and absence, and launcher steps (path for the prompt text; pin `resolved.modelId`).
- Gate: vitest (shape, externalContract) 2 files / 13 tests pass; lint:docs ok; typecheck ok.

## Findings
### Critical
none
### Important
none
### Minor
- `session-manager-operations/architecture/external-contract.md` (agent table, `path` row) types `path` as `string`, but `publicAgent` returns `p.path ?? null` (`agentAdminRoutes.cjs:60`), so the code allows null.
- The doc says `modelId` is `null` when there is no evidence, but also says to pin `model` as the fallback; for `model: inherit` or null, step 3 gives an outside launcher no model to pin. The doc should say what to do then.

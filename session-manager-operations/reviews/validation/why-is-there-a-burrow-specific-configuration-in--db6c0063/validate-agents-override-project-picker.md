# Validation: agents override project picker

Base: 5597fbc5 (known). Commits: 57e56eef (cwd key), 821404b5 (zod remove/delete), 754387b2 (dropdown), 6b15764e (docs). PRD files found in prds-archived/.

## agent-overrides-keyed-by-project-cwd — VERIFIED
- agentLibrary.cjs: `savePersona` routes on `projectCwd !== undefined`; `findOpenProject` + `normalizeCwd` throw `project not open: <cwd>`; no `projectName` param remains (grep clean).
- `openProjects` dedupes by normalized cwd; `listPersonas` pushes `cwd: p.cwd` into overrideDetails.
- agentPersonaSchema.cjs: `projectCwd` replaces `projectName`; `.strict()`; `PersonaNameSchema`/`ProjectCwdSchema` exported (the only `projectName` hit is a comment, line 61).
- api.d.ts / AgentLibrary.tsx send and type `projectCwd`; named tests present and passing.
- Gate: vitest (14 files, 104 tests) green, typecheck green, lint green.

## agents-ipc-zod-remove-delete — VERIFIED
- ipcSchemas.cjs defines/exports `agentsRemoveOverride`, `agentsDeletePersona` (strict, imported schemas).
- agentsIpc.cjs wraps both handlers in `validated(...)`, still broadcasts `agents:changed`; stale comments rewritten.
- `deletePersona` has PERSONA_NAME_RE guard first. ipcSchemas.agents.test.cjs exists; traversal test in agentLibrary.test.cjs.
- Gate: covered by the same vitest/typecheck/lint run — green.

## agents-override-project-dropdown — VERIFIED
- AgentLibrary.tsx: no `activeTabId` (grep clean); openProjects via `useSessions((s) => s.tabs)` + useMemo, `normalizeCwd`/`projectNameFromCwd`.
- useAgentsDirWatch takes `projectCwds`; TagLibrary passes `[]`; tests updated/added.
- Gate: vitest AgentLibrary/TagLibrary/Home.agentsCard green; typecheck, lint green.

## docs-agents-override-project-picker — VERIFIED
- domain-model.md bullet added after the SystemPrompt bullet; page-agent-library.md Writes bullet + invariant updated; screenComponents.tsx intro rewritten and shorter. CLAUDE.md not in diff.
- Gate: `npm run lint:docs` ok, `npm run lint` clean, typecheck green.

## Combined checks
- No `projectName` key in the contract files; no `activeTabId` in AgentLibrary.tsx. (`api.d.ts:184 activeTabId` is an unrelated session-store type.)
- `timeout 900 npm run test:unit`: 937 files passed, 8708 tests passed, 1 skipped; no failures, so no pre-existing ones to report.
- Self-review: the new cwd match fails closed on unknown or empty input; `.strict()` blocks key drift; delete name guarded against traversal. No secrets found.

## Findings
- Critical: none.
- Important: none.
- Minor: domain-model.md diff renames the following bullet's lead to "The System Prompt screen is a document set" and rewraps it. This is a harmless wording and reflow change, but it is beyond the PRD.

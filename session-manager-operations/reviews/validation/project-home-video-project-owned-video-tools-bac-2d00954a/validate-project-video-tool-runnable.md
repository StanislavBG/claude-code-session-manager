# Validation: project-video-tool-runnable plan

Base: 75027f57 (known). Commits: 1981fc0c (check), 6b7fde6c (wire), e3f4e144 (docs).

## project-video-tool-runnable-check — VERIFIED
- Helper exports `checkProjectVideoToolRunnable` with injectable deps defaulting to real fns: projectVideoToolCheck.cjs:47-55.
- Persona prefix text exact + assertAgentTypeWritable message appended: :22-23, :62-66.
- Name derivation mirrors jobToolScope (`mcp__` prefix, name after second `__`): :31-39.
- Missing full ids named, "can call only the MCP tools its persona lists"; unscoped → ok: :78-96.
- Test file: 11 passed. Layout entry `projectVideoToolCheck: persona-macro` added to scripts/lib-layout.json.
- Gate: `npx vitest run .../projectVideoToolCheck.test.cjs` → 11/11 green.

## project-video-tool-runnable-wire — VERIFIED
- macroAdminRoutes.cjs saveHandler: check before saveMacro for project-video with sent-or-stored job, 400 with helper error (hunk @@ -222).
- index.cjs macros:save (~676-688): check for project-video with job and single project; throws Error(verdict.error); other saves skip the branch.
- macroJobIpc.cjs `projectVideoRefusal`: skips builtins and non-project-video; refusal appends notice and returns {ok:false,error} before dispatch.
- Built-in saves/presses unchanged: branches gated on surface==='project-video' / !builtin.
- Gate: 3 files, 96 tests passed.

## project-video-tool-persona-docs — VERIFIED
- macro_save purpose and recipe step 1 state both requirements (mcpToolCatalog.cjs diff e3f4e144), recipe's persona step precedes macro_save.
- Test asserts `.claude/agents`, tool names, refused. README unchanged because no generated block holds these texts.
- Gate: mcpToolCatalog test 291/291; `npm run lint:readme` exit 0.

## Findings
### Critical
- none
### Important
- none
### Minor
- src/main/index.cjs (~macros:save): `agentName` comes from `payload.agentName` only; an IPC update that omits agentName (the admin route falls back to `existing.agentName`) would be refused as "no persona". Likely harmless if the editor always sends the full macro; not verified.
- No security issues seen: persona name goes through the existing assertAgentTypeWritable path; no new file writes.
- /code-review and /security-review not run as separate agents; self-reviewed the diff.

# Validation: tool scope is focus, not containment

Base `40cc006e`, HEAD `c7357f59`. Plan commits: 4888b0aa (2601), 43172833 (2602), 447a62ae (2603), 4320e8e1 (2604), c7357f59 (2605). The base..HEAD range also holds unrelated work (demo-video kit, artifact-only dispatch window); only plan commits were judged per PRD.

## 2601 job-mcp-scope-env-primitive — VERIFIED
- `JOB_MCP_TOOLS_ENV` and `personaToolScopeEnv` are exported and pure: src/main/lib/claude/personaToolScope.cjs:89-106.
- null returns `{}`; non-mcp tools return `'[]'`; mcp entries are kept in order. Covered by personaToolScope.test.cjs.
- The header paragraph (not containment, Bash can start an MCP server or call the admin API) is at personaToolScope.cjs:14-17.
- Gate (personaToolScope + personaToolScopeMcpConfig tests): 2 files, 20 tests passed.

## 2602 job-mcp-scope-env-wire — VERIFIED
- `...personaToolScopeEnv(personaToolScope)` sits in the cleanChildEnv literal before the launchEnv spread: src/main/scheduler.cjs:4874. The import is on line 157. The env comment line is at ~4864.
- Test: src/main/__tests__/scheduler-job-mcp-scope-env.test.cjs.
- Gate: 3 files, 16 tests passed.

## 2603 mcp-server-honors-job-tool-scope — VERIFIED
- `jobToolScope`, `jobToolScopeRefusal` and the filtered `listTools` are in scripts/scheduler-mcp-server.cjs. The scope refusal is the first statement in `handleCallTool`, before the headless queue refusal, macro delete refusal and any admin request.
- The header is rewritten (admin API is the boundary against other users and remote callers; env refusals are guardrails, not containment): scheduler-mcp-server.cjs:26-32.
- tests/setup/schedulerSandbox.cjs:21 deletes SM_SCHEDULER_JOB_MCP_TOOLS.
- Gate: 4 files, 25 tests passed.
- Real probe: see below.

## 2604 builder-personas-no-reach-around — VERIFIED
- demo-video-builder.md and project-home-builder.md `<when_things_fail>` now say launch bug, report plainly, give the HTML's absolute path, stop, and forbid self-started MCP server, admin API, hand-written file or any workaround. The first sentence (up to 3 attempts) is unchanged.
- seedVersion 8→9 and 4→5. shippedPersonaSeeds.cjs has entries (seedAgentPersonas test: 39 passed).
- Gate: seedAgentPersonas.test.cjs passed.
- Side effect: it broke a test outside its Files list. See Important finding 1.

## 2605 doc-tool-scope-is-focus — VERIFIED
- scheduler/README.md:194-203 has (a) focus not containment, (b) never reach an out-of-scope tool, a missing tool is a launch bug, and the guardrail with its limits (not a job that unsets the variable; OS sandbox not planned).
- architecture/conventions.md has the new incident entry (Self PRD 680, 2026-11-05) linking the README. CLAUDE.md is untouched in this plan.
- Gate `npm run lint:docs`: ok (21 junctions, 35 files).
- Decision check: grep for "security boundary" or "containment" in the diff finds only the negating statements. The one remaining "boundary" sentence (scheduler-mcp-server.cjs:26) says the admin API is a boundary against other users and remote callers, not against the job's own user. Nothing claims scoping or the env guard is a security boundary.

## Real probe 1 — stdio server (probe script /tmp/probe-mcp.cjs, cwd = job worktree)
Env: inherited, plus SM_SCHEDULER_JOB_SLUG=probe and SM_ADMIN_TOKEN_PATH=/tmp/nonexistent-admin-token-xyz. Each run: initialize, tools/list, tools/call project_demo_video_write, tools/call project_video_write.
Command: `node /tmp/probe-mcp.cjs <worktree> '<SM_SCHEDULER_JOB_MCP_TOOLS>'`
- `[]`: LIST `[]`. project_demo_video_write → `refused: project_demo_video_write is outside the tool scope of headless scheduled job 'probe' — its persona does not list it. Starting this server yourself does not widen a job's scope. Say in your final result which tool was missing and stop.` (isError). The refusal does not point to session_manager_help.
- `["mcp__session-manager-scheduler__project_video_write"]`: LIST `["project_video_write"]`, the demo-video-builder persona's save tool. project_demo_video_write is refused. project_video_write passes the scope and fails only argument validation ("missing required arguments").
- Unset: all 26 tools are listed, and project_demo_video_write reaches the admin step ("app is not running (admin API unreachable)").
- `notjson`: LIST `[]`. Every call → `refused: … SM_SCHEDULER_JOB_MCP_TOOLS is malformed …` (fail closed).
- The refused calls returned the scope message, not "admin API unreachable", so no admin request was made.

## Real probe 2 — claude CLI
Command (cwd /tmp): `SM_SCHEDULER_JOB_SLUG=probe SM_SCHEDULER_JOB_MCP_TOOLS='["mcp__session-manager-scheduler__session_manager_help"]' SM_ADMIN_TOKEN_PATH=/tmp/nonexistent-admin-token-xyz claude -p --model haiku --mcp-config /tmp/mcp-cfg.json --strict-mcp-config --dangerously-skip-permissions --output-format stream-json --verbose "<call session_manager_help once>"`. mcp-config points at the worktree's scripts/scheduler-mcp-server.cjs.
- rc 0. The init event shows `mcp_servers: [{"name":"session-manager-scheduler","status":"connected"}]`.
- The init event's mcp tools: `["mcp__session-manager-scheduler__session_manager_help"]` only.
- tool_use of session_manager_help returned the help payload with is_error false. No refusal.

## Full-suite checks at HEAD c7357f59
- `npm run typecheck`: pass.
- `npm run lint`: FAIL (exit 1). check-ops-path-literals reports src/main/lib/demo-video-kit/seedKit.cjs:25 (a LIVE_ROOT_LITERAL). seedKit.cjs belongs to the earlier kit-seeder work, not this plan.
- `timeout 900 npm run test:unit`: 5 failed / 886 passed files (8424 tests passed). Same 5 on a rerun:
  1. persona-macro/builtinMacros.test.cjs "demo-video-builder persona is opus / max / seedVersion 8" (expects '8', got '9'). Caused by this plan (2604).
  2. persona-macro/macroLibrary.test.cjs "real demo-video v4 copy … upgrades to v5" (expects 5, got 6). Caused by 949792c4 (macro v6), outside the plan.
  3. scripts/__tests__/check-ops-path-literals.test.cjs — the seedKit.cjs:25 violation (kit work, outside the plan).
  4. preload/__tests__/apiSurface.test.cjs — projectPages.rename/delete missing from the table (project-pages work, outside the plan).
  5. renderer ProjectHomeEmptyState.test.tsx — React error (project-pages work, outside the plan).
- The plan's final-HEAD criterion (test:unit and lint pass) is NOT met. The reds come mostly from other work in the base..HEAD range, plus one from 2604.

## Findings
### Critical
- None.
### Important
1. src/main/lib/persona-macro/__tests__/builtinMacros.test.cjs:43-48 still pins demo-video-builder seedVersion 8. 2604 bumped it to 9 and did not touch this file, so the suite is red from this plan's change. Fix: update the assertion to 9, or pin to the real value.
2. The unit suite and lint are red at HEAD for four other reasons (macroLibrary v5 vs v6, seedKit.cjs:25 path literal, apiSurface projectPages.rename/delete, ProjectHomeEmptyState). They are not from this plan but block a green release.
### Minor
1. `session_manager_help` still lists the full tool catalog to a scoped job (observed in probe 2), so it advertises tools the scope refuses. This is consistent with the "guardrail only" decision, but it may lead a model to call a refused tool.
2. The persona's tools line lists project_demo_video_write, project_video_write and project_character_write. The PRD's probe wording named project_demo_video_write as the refused tool, which holds when only project_video_write is scoped in.

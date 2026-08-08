---
title: Make the scheduler MCP reachable everywhere and teach /develop to stop rather than hand-write when it is missing
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 50
createdVia: scheduler-api
issuedAt: 2026-08-08T17:57:54.512Z
sourcePromptId: scheduler-is-stuck-as-session-manager-admin-inve-9a80d87f
---
# Goal

On 2026-08-08 seven PRDs (1024-1030) in social-signals-trader were hand-written to disk between 10:00 and 10:06 and quarantined by the provenance gate. The session did not choose to bypass the API — `scheduler_create_prd` was NOT IN ITS TOOL LIST. That project's committed `.mcp.json` registers only ['burrow','quotes','hedgefund','bilko-host']; `session-manager-scheduler` was added to the working copy at 10:56, ~50 minutes AFTER the hand-writing. The natural experiment proves it: every PRD authored before 10:56 carries no provenance, and 1031/1032 authored after carry `createdVia: scheduler-api` with real `prd_create` audit records. Two fixes follow. (1) The scheduler MCP is a machine-wide service, not a per-repo dependency, so registering it once per project is the wrong shape and guarantees the next project repeats this. (2) develop/SKILL.md's fallback trigger is miscalibrated: it says the fallback applies "only when the tool errors with 'app not running' / admin API unreachable" (line 230), but an agent whose tool list lacks the tool gets NO error to match on — it just has no tool — so hand-writing is the only path it can infer. A missing tool is a MISCONFIGURATION, not an offline app, and the correct response is to stop and tell the human, never to write the file.

# Acceptance criteria

- [ ] `session-manager-scheduler` is registered at USER scope in ~/.claude.json's top-level `mcpServers` (alongside the existing fetch/sqlite/playwright/google-workspace/n8n entries) so every project gets the tool without a per-repo .mcp.json edit
- [ ] A documented, idempotent installer (script or documented `claude mcp add --scope user` invocation) performs that registration and is safe to re-run; it must not clobber the existing user-scope servers
- [ ] develop/SKILL.md distinguishes TWO failure modes explicitly: (a) tool present but errors with app-not-running/admin-API-unreachable -> the existing documented degraded fallback, and (b) tool ABSENT from the tool list entirely -> STOP, do not write any PRD file, and report to the human that the scheduler MCP is not registered for this project, naming the user-scope fix
- [ ] The line-230 fallback wording is updated so 'unreachable' can no longer be read as covering 'the tool does not exist' — the two cases are named separately and the absent-tool case explicitly forbids hand-writing
- [ ] scripts/scheduler-mcp-server.cjs's scheduler_create_prd description carries the same two-case distinction, so an agent reading only the tool description gets the same rule
- [ ] A preflight note in develop/SKILL.md tells the agent to confirm `scheduler_create_prd` is in its available tools BEFORE composing PRDs, so the failure is caught at the start of the flow rather than after the thinking is done
- [ ] The PreToolUse guard hook's install instructions are extended to cover per-project adoption for non-session-manager projects, with the absolute-path form of the command (node /home/bilko/Projects/session-manager/scripts/hooks/guard-prd-writes.cjs) since a relative path only resolves inside this repo
- [ ] A test asserts develop/SKILL.md contains both failure-mode branches and the explicit 'do not hand-write when the tool is absent' instruction, so the distinction cannot silently regress

# Implementation notes

Evidence for the root cause: `git show HEAD:.mcp.json` in social-signals-trader lists only burrow/quotes/hedgefund/bilko-host; the working copy (mtime 2026-08-08 10:56, still UNCOMMITTED there) adds session-manager-scheduler. PRD mtimes were 10:00:02-10:05:55. Audit log has `prd_quarantined` events with reason "missing createdVia provenance frontmatter" for all seven and zero `prd_create` events for that cwd before 10:56. Files: plugins/session-manager-dev/skills/develop/SKILL.md (fallback block at ~lines 216-241, bullet at ~451), scripts/scheduler-mcp-server.cjs (create_prd description ~line 88-105), scripts/hooks/guard-prd-writes.cjs (header install/uninstall note). Note ~/.claude.json is the user's global config and already carries five user-scope servers — follow that existing shape exactly rather than inventing a new location, and prefer the documented `claude mcp add --scope user` CLI over hand-editing that file if the CLI supports the stdio command form this server needs. Do NOT remove the per-project .mcp.json entries that already exist; user scope should be additive so existing projects keep working during rollout. Related known gap, NOT in scope here: a PRD filename matching NN-fix-* is exempt from both the hook and the quarantine gate.

# Out of scope

- Committing social-signals-trader's .mcp.json change — that's another repo and the human's call
- Adopting or re-authoring the seven already-quarantined PRDs — already resolved manually
- Closing the NN-fix-* exemption
- Machine-wide auto-install of the PreToolUse hook into every project without the human opting in

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

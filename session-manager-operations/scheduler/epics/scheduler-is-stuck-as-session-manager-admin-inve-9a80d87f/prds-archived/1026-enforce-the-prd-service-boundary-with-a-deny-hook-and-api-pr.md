---
title: Enforce the PRD service boundary with a deny hook and API provenance stamping
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 75
sourcePromptId: scheduler-is-stuck-as-session-manager-admin-inve-9a80d87f
dependsOn: [retire-direct-prd-authoring-as-the-sanctioned-path-and-fix-t]
---
# Goal

Final step of the lockdown. opsOwnership.cjs's assertOpsWrite already enforces the single-writer law (queueStore.cjs:56,64) but is structurally incapable of stopping this class of write: it guards the app's own in-process write helpers, so an agent using the Write tool bypasses it entirely — as the project CLAUDE.md itself states. Two mechanisms actually can enforce the boundary. First, a PreToolUse hook: the harness, not the app, adjudicates Write/Edit before it happens. There are currently ZERO hooks configured (both ~/.claude/settings.json and the project .claude/settings.json have an empty PreToolUse array), so this lever is entirely unused. Second, provenance: the scheduler stamps every PRD it creates, and refuses to execute one it did not create. Together these make the API the only way in, from outside and from inside.

# Acceptance criteria

- [ ] A PreToolUse hook script (scripts/hooks/guard-prd-writes.cjs) denies Write/Edit/NotebookEdit whose target path matches **/session-manager-operations/scheduler/** , returning a deny decision whose message names the correct MCP tool for the attempted operation (create/update/archive) so the agent self-corrects instead of retrying
- [ ] The hook is installed into the project .claude/settings.json PreToolUse array via the update-config conventions, and an install/uninstall note is added so it can be adopted per-project rather than machine-wide
- [ ] The hook allows READS unconditionally — a PRD must stay readable by any tool; only mutation is gated
- [ ] The hook fails OPEN on its own internal error (malformed payload, unreadable settings) and logs, rather than blocking every Write in the repo — a broken guard must not brick the editing loop
- [ ] Every PRD created through the admin API carries a provenance field in its frontmatter (e.g. `createdVia: scheduler-api` plus an issuedAt timestamp), stamped server-side in lib/prdCreate.cjs where the frontmatter is already composed
- [ ] reconcile in scheduler.cjs quarantines an unstamped PRD instead of executing it: the row is created with a distinct non-runnable state, logged at warn level naming the file, and surfaced in the Scheduler tab with a one-click 'adopt' action that stamps it through the API
- [ ] Quarantine is LOUD and reversible, never silent: read the scheduler.cjs:1307-1338 comment recording the 2026-08-01 six-hour outage where 23 PRDs were silently skipped by a stricter gate — an unstamped PRD must be visible and adoptable in the UI within one tick, never merely ignored
- [ ] A migration stamps every PRD currently on disk across all projects as legacy-adopted at first boot after this ships, so no existing PRD is quarantined by the rollout
- [ ] Tests cover: hook denies a Write to an epics/<id>/prds/ path; hook allows a Read; hook allows a Write elsewhere in the repo; hook fails open on malformed input; an unstamped PRD is quarantined not executed; a stamped one runs normally
- [ ] npm run typecheck, npm run test:unit, npm run lint all pass

# Implementation notes

Hook payload schema and the PreToolUse deny contract are documented in the Claude Code config reference — follow the update-config skill's conventions for editing settings.json rather than hand-writing the JSON. Precedent for a fail-closed app-side gate is lib/epicMint.cjs (MINT_AUTHORITY_NEW_EPIC_UI + the epic_mint_refused audit event); mirror that shape for the provenance refusal, including emitting an audit event on every quarantine. Stamp inside lib/prdCreate.cjs where frontmatter is already built, so the stamp cannot be forgotten by a future route; the API-parity PRD's update-prd route must preserve the stamp on edit. IMPORTANT sequencing: this PRD is last in the chain on purpose — enforcing before the API reaches parity (PRD 1024) and before the skill stops instructing direct writes (PRD 1025) would deny the very workflow the docs still tell agents to use. Note the admin server only runs while the Electron app is running, so the hook's deny message must tell the agent what to do when the app is down (the degraded fallback the skill PRD defines) rather than leaving it with no path at all. Consider scoping the hook to the session-manager repo first and documenting rollout to other projects, rather than enabling it machine-wide in one step.

# Out of scope

- Enforcing ownership on any namespace other than scheduler/ — prompt-sessions, project-brief and logs keep their current in-process guard
- Replacing assertOpsWrite — it stays as the in-process layer; this adds the outer layer
- Blocking reads of PRD files

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

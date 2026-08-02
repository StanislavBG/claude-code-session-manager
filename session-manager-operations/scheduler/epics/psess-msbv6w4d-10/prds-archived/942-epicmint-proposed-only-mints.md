---
title: epicMint hardening — mint branch always writes 'proposed', fix stale docstring, audit refusals
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 10
sourcePromptId: psess-msbv6w4d-10
---
# Goal

Defense-in-depth for the born-proposed law in the main process: make it structurally impossible for any ensureEpic() caller (scripts, MCP server, scheduler, RCA hook, future code) to mint an Epic with status 'active'. Today no caller does, but the parameter accepts it silently. Also fix the FALSE docstring at src/main/lib/epicMint.cjs:185-187 claiming approveProposed passes 'active' through ensureEpic (approveProposed lives entirely in the renderer store and never calls ensureEpic), and audit refusals so rogue attempts leave a trace.

# Acceptance criteria

- [ ] src/main/lib/epicMint.cjs: the mint branch (~:262-308) ignores/rejects any requested status — a MINT always writes status 'proposed'. If a caller explicitly passes status 'active' with mintIfMissing allowing a mint, throw a fail-closed error in the style of opsOwnership.cjs assertOpsWrite (clear message naming the born-proposed law). Joins to existing 'active' Epics remain legal and unchanged.
- [ ] The :185-187 docstring no longer claims approveProposed uses ensureEpic; it states activation happens only in the renderer store's approveProposed.
- [ ] Refusals emit audit records via the existing appendAuditEvent (epicMint.cjs:~308, src/main/lib/auditLog.cjs): the mintIfMissing:false throw (~:253-259) and the not-open explicit-epicId refusal (~:218-226, currently a bare console.warn) each append an 'epic_mint_refused' event with cwd, requested epicId/status, and reason.
- [ ] Unit tests in src/main/__tests__/epicMint.test.cjs: (a) default mint is 'proposed'; (b) mint with status 'active' throws; (c) join to an active Epic still succeeds; (d) refusals append an audit event (assert on the audit file/append call).
- [ ] Existing callers stay green: scripts/propose-epic.cjs, scripts/mint-epic.cjs, src/main/lib/rcaFeedbackHook.cjs, scripts/lib/watchdogHelpers.cjs, scheduler.cjs writePrd join path — run timeout 300 npx vitest run src/main/__tests__/epicMint.test.cjs src/main/__tests__/scheduler-writeprd-epic-rollback.test.cjs and scripts/__tests__/propose-epic.test.cjs.
- [ ] timeout 300 npm run typecheck passes

# Implementation notes

Read first: src/main/lib/epicMint.cjs in full (ensureEpic :205+, findJoinableEpicInIndex :121, appendAuditEvent usage :308), src/main/lib/opsOwnership.cjs:19-31 (fail-closed assert style to mirror), src/main/lib/auditLog.cjs (appendAuditEvent writes ~/.claude/session-manager/audit-log.jsonl). Callers passing status today: propose-epic.cjs:46 ('proposed'), watchdogHelpers.cjs:322 ('proposed'), rcaFeedbackHook.cjs:373 ('proposed'), scheduler.cjs:4379 (join-only), mint-epic.cjs:34 (join-only) — none pass 'active', so the throw is unreachable today; that's the point (it guards future code). Important nuance found in review: when an explicit epicId exists but is archived/completed, ensureEpic falls through to the mint branch — that fall-through must continue minting 'proposed' (the RCA hook depends on it), not throw.

# Out of scope

- Renderer store or chat.ts changes (PRDs 939/940)
- IPC exposure of the audit log (sibling PRD)
- Changing join semantics or JOIN_SIMILARITY_THRESHOLD

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

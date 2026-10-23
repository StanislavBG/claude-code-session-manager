# Validation sweep 202610230712

Base: ff6aafb27c2f599878140e47d5a06ce433ef71c5 (HEAD commits listed per PRD). Review method: self-review (no separate /code-review run; diff read directly).

Gates re-run (foreground):
- `npx vitest run` on personaToolScope, oneShotNoMcp, seedStatus, delegationReadiness, launchSession, epicIntake → 6 files / 123 tests passed.
- `env -u SM_CHAT_CONCURRENCY npx vitest run tests/unit/chatRunner.spec.ts` → 41 passed.
- `npm run typecheck` → exit 0 (both tsconfigs).

## headless-jobs-skip-mcp-servers (d90f6475) — VERIFIED
- personaToolScope.cjs:61-64 pushes `--strict-mcp-config` only when no `mcp__` tool; test names at personaToolScope.test.cjs:66,72.
- `--mcp-config` absent from the file (grep clean). Gate passed.

## one-shot-claude-p-skip-mcp-servers (18579cdc) — VERIFIED
- Flag at runClaudeP.cjs:35, docEdit.cjs:100, supervisor.cjs:257; no `--mcp-config` in any. oneShotNoMcp.test.cjs passes; typecheck green.

## chat-runner-drop-private-cap (19e120cf) — VERIFIED
- grep for DEFAULT_CAP / getConcurrencyCap / SM_CHAT_CONCURRENCY in chatRunner.cjs: no hits.
- pump() at chatRunner.cjs:391-407 acquires sessionSlots per run; refusal leaves rest queued; `sessionSlots.subscribe(pump)` at :438 re-pumps on release.
- Tests at chatRunner.spec.ts:234,246 pass.

## launch-session-persona-body (0d7d6e92) — VERIFIED
- launchSession.ts:26-37 `resolvePersonaBody` uses `window.api.agents.getPersonaBody`, one console.warn on error, returns null; :54 passes agentBody/agentPath.
- CustomerFeedbackInbox.tsx:57-58 passes agentDescription + persona body.
- Tests launchSession.test.ts:64,73 and epicIntake.test.ts pass.

## seed-status-failed-first-boot (6d8d9ff2) — VERIFIED
- seedStatus.cjs:32-33 exhausted check then `attempts > 0 ? 'failed' : 'pending'`.
- Plugins.tsx:259 shows banner for failed|exhausted; :363-365 distinct copy ("retry on next launch").
- api.d.ts SeedStatus union widened. Tests seedStatus.test.cjs:80,96 pass; typecheck green.

## readiness-dev-plugin-installed (a1922bca) — VERIFIED
- delegationReadiness.cjs:309-322 pure readers; :351 requires skills/develop/SKILL.md; :366 marketplace check with specific detail strings.
- Tests at delegationReadiness.test.cjs:238,250,259,264 (malformed JSON → ok:false, no throw) pass.

## Findings
### Critical
- none
### Important
- none
### Minor
- Files outside the PRDs' `# Files` lists were touched: src/preload/api.d.ts (status union widening; required for typecheck, justified, `seed-status-failed-first-boot` notes anticipated this) and, from an unrelated commit 149d0ab2 in the same range, scripts/scheduler-mcp-server.cjs + mcpToolCatalog (not part of this sweep).
- classifyPromptTicket.cjs still lacks `--strict-mcp-config` (explicitly deferred by PRD 2138).

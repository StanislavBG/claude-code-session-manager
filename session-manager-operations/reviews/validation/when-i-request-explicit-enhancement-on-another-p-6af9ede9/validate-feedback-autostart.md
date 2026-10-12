# Validation: feedback-autostart plan

Base: 4bf01fb5c479d211aea4981f582e7d0ecd7d27a1 (given in PRD 1870). 8 commits `4bf01fb5..HEAD` (1fb7f482 … 18d31a59), 23 files, +756/−41.
PRD files found under `prds-archived/` (1862–1869). Review tools: `/code-review` and `/security-review` not run as skills in this headless run; combined diff self-reviewed (see Findings).

Gate evidence (run in this worktree with a temporary `node_modules` symlink to the main checkout, removed afterwards):
- `npx vitest run` on the 6 plan test files (humanPromptLedger, chatRunOrigin, chat.test.ts, crossProjectFeedback, inboundAutoApprove, mcpToolCatalog): 6 files / 202 tests passed.
- `npm run typecheck`: exit 0. `npm run lint:docs`: ok (21 junctions, 34 files). `npm run lint`: exit 0. `wc -c CLAUDE.md` = 11971 (≤ 12000).

## human-prompt-ledger (1862) — VERIFIED
- Exports `recordHumanPrompt`, `findHumanPromptContaining`, `MIN_QUOTE_CHARS`(20), `_resetForTests`: humanPromptLedger.cjs:101.
- Normalization (collapse whitespace, trim, lowercase), min-length, unknown-session → null: humanPromptLedger.cjs:35, 79-92.
- Bounds 10/session, 24h TTL, 200 sessions with re-insert eviction, 20000-char truncation, try/catch never throws: humanPromptLedger.cjs:25-29, 50-67. Docblock states in-memory/fail-closed.
- Test file exists and passes (gate above). Gate green.

## chat-run-origin-ledger (1863) — VERIFIED
- `origin: z.enum(['human','external','inbound-proposal']).optional()` in chatRun schema: ipcSchemas.cjs:922-924.
- `noteChatRunOrigin` records only when `origin === 'human'`, try/catch, exported; called in `chat:run` handler before run(): chatRunner.cjs:1011-1030, 1060.
- chatRunOrigin.test.cjs passes; typecheck green.

## chat-origin-renderer (1864) — VERIFIED
- `ChatRunPayload.origin` in api.d.ts:1498-1499.
- `send()` resolves `origin ?? (external ? 'external' : 'human')` and passes to idle `dispatchSend` (chat.ts:333,376) and stores on ticket (chat.ts:360); queued path `dispatchQueuedInline` passes `running.origin ?? …` (chat.ts:638); `chat.run` receives origin (chat.ts:544). Idle-path external bug fixed.
- EpicApprovalBar passes `inbound ? 'inbound-proposal' : 'human'` (now via approveAndStart, EpicApprovalBar.tsx:32).
- chat.test.ts:1508-1538 covers human / idle external / queued external / explicit inbound-proposal; passes.

## feedback-autostart-verify (1865) — VERIFIED
- validateFeedbackInput accepts boolean `autoStart`, string `humanRequestQuote` ≤2000: crossProjectFeedback.cjs:365-376. Missing quote → delivered proposed with `autoStart:{granted:false,reason}` (verifyAutoStart :471-484, result :633).
- Grant requires originClaudeSessionId, ledger hit, and prompt containing basename(toCwd) or toCwd: :471-484. Identity only from `input.originClaudeSessionId` (:511-514).
- Granted: ensureEpic still `'proposed'`, `source.autoApprove{requestedBy,quote,verifiedAt,fromClaudeSessionId}` (:565-574), `notify({cwd,epicId})` once (:602-606), status `'auto-approved'`, note + origin receipt updated (:614-643).
- Denied paths: `notify` is only called inside `if (auto.granted)` (:602), result status is `'proposed'` unless granted (:632) → denied paths keep `proposed` and never notify the renderer. Tests for missing quote / not in ledger / prompt not naming project / missing origin id pass (crossProjectFeedback.test.cjs, 202-test run).
- Audit event records autoStartGranted/autoStartReason (:598-599).

## inbound-auto-approve-lib (1866) — VERIFIED
- `approveAndStart` and `autoApproveInbound` per spec: inboundAutoApprove.ts:14-46; only `status==='proposed'` + producer `cross-project-feedback` + `autoApprove.requestedBy==='human'` are touched (:30-35); idempotent via approveProposed null → no send.
- Preload `onInboundAutoApprove` with unsubscribe: preload/index.cjs:546-551; types api.d.ts:2265-2266; `EpicSource.autoApprove`: promptSessions.ts:46-47.
- inboundAutoApprove.test.ts passes.

## feedback-autostart-mcp-surface (1867) — VERIFIED
- inputSchema `autoStart`/`humanRequestQuote` with required wording: scheduler-mcp-server.cjs:413-420.
- Note branches on `result.status === 'auto-approved'`, else PROPOSED text + reason when not granted: scheduler-mcp-server.cjs:710-724; never says work done.
- mcpToolCatalog.cjs + SKILL.md updated; plugin.json 0.2.0 → 0.2.1; mcpToolCatalog test passes.

## doc-feedback-autostart-law (1868) — VERIFIED
- CLAUDE.md bullet rewritten shorter and links domain-model.md; `wc -c` = 11971 ≤ 12000.
- domain-model.md +10 lines in cross-project section (diff stat); `npm run lint:docs` ok. (Content spot-checked via stat/lint only; I did not re-read the 10 added lines word-by-word against the required list.)

## inbound-auto-approve-wire (1869) — VERIFIED
- Listener registered in the boot block next to onExternalSend, guarded: chat.ts:1429-1436.
- EpicsWorkspace calls `autoApproveInbound(c)` after both hydrate sites: EpicsWorkspace.tsx:103-106, 129.
- EpicApprovalBar uses `approveAndStart(epic,'EpicApprovalBar', inbound ? …)`: EpicApprovalBar.tsx:32.
- Listener test: chat.test.ts:256-258 plus inboundAutoApprove tests; typecheck + lint green.

## Agent-initiated feedback still lands proposed — CONFIRMED
Without `autoStart`, `verifyAutoStart` returns `granted:false` (crossProjectFeedback.cjs:471), no `source.autoApprove` stamp, no renderer notify, result `status:'proposed'`. Scheduler jobs never have `SM_CHAT_SESSION_ID`, so no `originClaudeSessionId` → denied. Born-proposed mint untouched.

## Findings

### Critical
- none

### Important
- none

### Minor
- crossProjectFeedback.cjs:~480 — project-name check is a substring match of `basename(toCwd)` in the human's whole prompt (not the quote); short/common basenames (e.g. `app`, `web`) match incidentally. Still requires a verbatim human-typed quote, so risk is low; a word-boundary match would be tighter.
- humanPromptLedger match is over the human prompt, and the agent chooses the quote; an agent could quote an unrelated earlier human sentence that happens to be in a prompt that also names the project. Accepted by design (human prompt must name project).
- Unused import: none found. Stray untracked `<path>` file in worktree is the known sqlite-MCP placeholder, not part of the plan.
- Code/security review run as self-review only (skills not invoked); no secrets, path traversal, or unsafe input found in the diff: quote is length-capped, session identity comes only from MCP env, IPC `origin` is a closed enum.

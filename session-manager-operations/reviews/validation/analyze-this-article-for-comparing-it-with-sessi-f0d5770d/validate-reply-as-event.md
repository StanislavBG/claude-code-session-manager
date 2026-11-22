# Validation: reply-as-event plan

Base: aa3cc78785339bb570b46656e634486da93fc2c3. Commits: 45f482a2 (3379), 334d8e9a (3380), 6bae4a8b (3381), 671928c5 (3382).
Gate re-run: one vitest run of all nine listed test files, 429 tests passed; `npm run typecheck` exit 0; `npm run lint:docs` ok (36 files).
/code-review and /security-review were not run as separate agents; the diff was self-reviewed (see Findings).

## feedback-reply-mode-on-handoff — VERIFIED
- replyMode accepted 'prompt'|'event', else 400; absent/null → 'prompt': crossProjectFeedback.cjs `REPLY_MODES`, `validateFeedbackInput` (~l.499-506).
- replyTo stamped with mode:'event', cwd-only `{cwd, epicId:null, claudeSessionId:null, mode:'event'}` when unresolved: `replyToForMode` (~l.213-219), used in `mintFeedbackSession`.
- Result `replyMode:'event'`, `replyThread: Boolean(replyTo)` (always true in event mode), note via `replyNote` says "audit log, not as a chat prompt".
- scheduler-mcp-server.cjs l.620: `replyMode` enum + one-sentence description; `required` unchanged.
- Tests added in crossProjectFeedback.test.cjs (+68 lines); mcpToolCatalog test passes.
- Default path: `replyToForMode` returns `resolved` untouched for non-'event'; no `replyMode` result key; `replyNote` and intake text unchanged for prompt. Same as before.

## feedback-reply-as-event — VERIFIED
- `sendFeedbackReply` branches to `replyAsEvent` right after the per-Epic cap check, before the fallback and sendPrompt code; replyAsEvent never calls sendPrompt or openFallback (crossProjectReply.cjs ~l.252, 392-440).
- Event appended only when `rt.epicId` names an active Epic in `targetCwd`; otherwise none, reply still ok (`eventOnAskingEpic`).
- Result `delivery:'event-only'`, `reason:'asker-requested-event'`; receipt on Y written; MAX_REPLIES_PER_THREAD check runs before the branch and `repliesUsed/Left` reported.
- Audit row adds `mode:'event'`, `externalRef` (when present), `message.slice(0, 2000)`, `referencePaths.slice(0, 10)`. Only emitted inside replyAsEvent; other rows unchanged.
- Tool note l.1237 of scheduler-mcp-server.cjs. Tests added (+92 lines reply, +9 mcp note).
- Bounded audit text: message cut to 2000 (input already capped at MAX_BODY_CHARS 20000, refs ≤10 strings) — confirmed by reading.

## reply-events-in-outside-contract — VERIFIED
- `OUTSIDE_EVENT_KINDS` includes epic_cross_project_reply; DEFAULT_KINDS unchanged; ipcSchemas enum is built from the constant (l.593), so the route accepts it.
- externalContract.cjs: eventKinds, `tools.feedback_reply {required:['message','outcome']}`, `replyEventFields` (12 keys); CONTRACT_VERSION still 1; fingerprint replaced (shape test passes).
- Shape test reads an event-mode row through readEventsAfter and checks keys ⊆ replyEventFields; eventsAdminRoutes test covers kinds=epic_cross_project_reply.

## reply-mode-doc — VERIFIED
- external-contract.md `### Replies` (l.147) sits after `### B. POST /admin/macros/run` (l.119) and before `## 3. Reads` (l.236).
- States replyMode and values, no chat / no fallback incl. gone asker or no sender Epic, result fields replyMode/replyThread.
- Field table matches replyEventFields (12 keys, same order); one GET /admin/events example with answer; externalRef matching advice; 2000-char cut.
- lint:docs passes.

## Findings
Critical: none.
Important: none.
Minor:
- scripts/scheduler-mcp-server.cjs / crossProjectFeedback.cjs result: an explicit `replyMode:'prompt'` is not echoed in the result (only 'event' adds `replyMode`); documented in the contract doc, so consistent, but a caller cannot confirm the value.
- Cross-PRD note: this range also contains unrelated commits (agents route, claim-scan, claude-config); not reviewed here.

# Validation: feedback-reply-hint-no-restart-promise

Base: 205c94be. PRD file: prds-archived/3473-feedback-reply-hint-no-restart-promise.md. Landed commit: b00c1cd0 (plus an unrelated 0.139.0 version bump in package.json / package-lock.json).

## feedback-reply-hint-no-restart-promise — VERIFIED

1. Hint has no restart advice: scripts/scheduler-mcp-server.cjs:1263-1265 now reads "Until the running app has this route, send your answer with feedback_open_session to the asking project; it opens there as a new proposed session." No "restart"/"restarted" in the added text.
2. Still starts with the missing-route message and keeps the v0.136.0 sentence: scripts/scheduler-mcp-server.cjs:1263 (`${err.message} feedback_reply needs Session Manager v0.136.0 or later. `).
3. New test: src/main/lib/__tests__/schedulerMcpServerAdminErrors.test.cjs:212-236 calls feedback_reply against a 404 unknown-route server, asserts the text starts with unknownRouteMessage, asserts the new wording, and `hint` (text after the route message) `.not.toMatch(/restart/i)`.
4. No other message changes: `git diff 205c94be..HEAD -- scripts/scheduler-mcp-server.cjs` is a single changed line (1264). unknownRouteMessage untouched.

Gate (re-run): vitest on schedulerMcpServerAdminErrors + mcpToolCatalog: 2 files, 277 tests passed. `npm run lint`: exit 0. `npm run typecheck`: exit 0.

## Other restart text in scripts/scheduler-mcp-server.cjs

grep -i restart finds only lines 180 (comment), 224, 229, 231 — all inside unknownRouteMessage, the missing-route message itself, which gives per-case advice:
- 224 (source checkout): "Restarting the app helps only once a release containing this route is installed." — conditional, correct.
- 229 (app older than server): "Restart Session Manager (... 'Reboot app (drain first)') and call again." — correct for that case only.
- 231 (same/newer version): "A restart alone will not help." — correct.
No other text tells the reader to restart after a missing route.

## Combined diff review
`git diff` stat: package.json, package-lock.json (version bump 0.138.0 -> 0.139.0, unrelated to this PRD), scheduler-mcp-server.cjs (1 line), test file (+28). No unsafe input handling, secrets, path traversal or duplicated helper. The test restores SM_SCHEDULER_JOB_SLUG in a finally block.

## Findings
- Critical: none
- Important: none
- Minor: none

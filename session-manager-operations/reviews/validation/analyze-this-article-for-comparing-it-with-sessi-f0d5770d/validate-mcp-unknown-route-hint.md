# Validation: mcp-unknown-route-hint-truthful (PRD 3471)

Base: fe5598f6. Landed commit: 5a4cf5cc (touches only the two PRD files; the third file in the base..HEAD stat, transcripts-agent-cli-path.test.cjs, belongs to another commit c25fc5cd).

## mcp-unknown-route-hint-truthful — VERIFIED

- Pure function exported: scripts/scheduler-mcp-server.cjs:217 `unknownRouteMessage({method,pathname,appVersion,serverVersion,fromCheckout})`, exported at :1533. Every branch names route, app version label ('version not reported' when absent, :218) and server version (:219).
- fromCheckout: :186-188 existsSync(`<scripts>/../.git`) (folder or file), no git spawn. Checkout branch (:221-224) says the version does not say which code it has, route may not be in a published release, restart helps only once a release with the route is installed; no 'Restart Session Manager'.
- Older/unreported app: :226-230 numeric compare (compareVersions :193), gives "Command Palette: 'Reboot app (drain first)'".
- Same/newer: :231-232 "A restart alone will not help… updated to a build that has this route."
- Code SM_UNKNOWN_ROUTE kept (:242); feedback_reply hint (:1262-1266) unchanged by the diff.
- Tests: schedulerMcpServerAdminErrors.test.cjs:146-205 cover 0.137.0/0.138.0 checkout (:155), 0.9.0/0.10.0 non-checkout (:169), equal versions (:190), plus compareVersions numeric asserts.
- Gate: vitest (2 files, 276 tests) passed; `npm run lint` exit clean; `npm run typecheck` clean.

## Exact message: app 0.137.0, server 0.138.0, fromCheckout true, GET /admin/epic

> the running Session Manager app (v0.137.0) has no route GET /admin/epic. This MCP server is v0.138.0. This MCP server runs from a source checkout, so its version number does not say which code it has. The route may not be in any published release yet. Restarting the app helps only once a release containing this route is installed.

Check: it does not tell the reader a restart will fix it; it says a restart helps only after a release containing the route is installed. Passes. (Captured by running the function.)

## Review
Combined diff self-reviewed (code-review/security-review skills not run separately): no unsafe input handling; pathname is only echoed in an error string; no secrets; existsSync only, no path from input; no duplicated helper.

## Findings
- Critical: none
- Important: none
- Minor:
  - scripts/scheduler-mcp-server.cjs:1262-1266 — the feedback_reply hint still says "Until the app is restarted…", which reads as a restart fix in the checkout case. The PRD required it unchanged, so this is by design; a follow-up PRD could soften it.

# Validation: feedback-reply-skew-legacy

Base: 93b28545 (commits 82881bf9 mcp skew, 388d9112 legacy thread). Review: self-review (no tool-run /code-review).

## mcp-admin-unknown-route-skew-error — VERIFIED
- AC1: localAdminHttp.cjs:~150-160 returns 404 `{ok:false,error:'not found',unknownRoute,appVersion?}`; APP_VERSION read at load in try/catch (l.41-44).
- AC2: scheduler-mcp-server.cjs `isUnknownRouteReply`/`unknownRouteError` (l.~171-200), code SM_UNKNOWN_ROUTE, query stripped, names server version, app version, 'Reboot app (drain first)'; adminRequest throws it (l.~237); dispatcher catch gives isError.
- AC3: matcher requires status 404 + ok:false + (unknownRoute string or exactly 2 keys with 'not found'); HTTP 200 and 404 'invalid slug' pass through. Tests cover both.
- AC4: feedback_reply branch (l.~1126-1136) catches SM_UNKNOWN_ROUTE, appends v0.136.0 + feedback_open_session hint, rethrows others.
- AC5: tests present in AdminErrors (4), Feedback (1), localAdminHttp (updated).
- Gate: vitest 3 files, 22 passed.

## reply-legacy-thread-from-source — VERIFIED
- AC1: `resolveThread` (crossProjectReply.cjs ~l.378): complete replyTo -> as before; legacy when request producer, no replyTo key, no replyOf, non-empty fromCwd/fromEpicId, claudeSessionId null; incomplete replyTo -> existing 400.
- AC2: session check l.~309 uses non-empty X.claudeSessionId for legacy; missing/not-active ladder unchanged; toEpicId must equal rt.epicId (403); `thread:'legacy'` on fallback ok, final ok, and audit.
- AC3: replyOf, no-fromEpicId, and default refusal messages all present and name feedback_open_session.
- AC4: header THREAD RULE comment (l.20-22) and domain-model.md thread-rule bullet both updated with the legacy sentence.
- AC5: 7 new tests (active delivered, missing fallback, no session, 403, replyOf 400, no fromEpicId 400, incomplete replyTo 400).
- Gate: vitest crossProjectReply, 27 passed.

## Findings
- Critical: none. Important: none.
- Minor: a v0.136.x request whose sender was unresolved at mint is treated as legacy (documented as accepted in PRD).
- Minor: the extra legacy test for X without claudeSessionId goes beyond the PRD list (harmless).
- Security: no new path/secret/injection surface; fromCwd still passes config.validatePath and the isSessionManagerProject check.

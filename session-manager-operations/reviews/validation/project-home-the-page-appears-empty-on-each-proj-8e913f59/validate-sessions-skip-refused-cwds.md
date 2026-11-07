# Validation: prompt-sessions-skip-refused-cwds (PRD 2793)

Base: fdadb724. Commit: e02ee51a (touches only the two PRD files). Reviewed by reading the diff; /code-review not run (self-review).

## prompt-sessions-skip-refused-cwds — VERIFIED
- AC1: promptSessions.ts:~479-480 declares `REFUSED_CWD_RETRY_MS = 5 * 60_000` and `refusedCwdUntil: Map<string, number>`; `isRefusalError` matches 'not a registered project root' / 'path_fenced'; `noteRefusal` sets mark = Date.now()+RETRY.
- AC2: `if (isRefusedCwd(cwd)) return` in hydrate and hydrateArchived, right after the window.api guard; expired marks are deleted so IPC resumes; `refusedCwdUntil.delete(cwd)` after loadActiveIndex resolves.
- AC3: `noteRefusal` writes logs.write warn only when `!wasMarked`, message names the cwd. Other errors fall through to the unchanged warn path.
- AC4: `_resetForTests()` calls `refusedCwdUntil.clear()`.
- AC5: promptSessions.refusedCwdBackoff.test.ts has 7 tests covering all six listed cases plus mark-clear on resolve.
- AC6: git diff of e02ee51a shows promptSessions.test.ts and promptSessions.remoteHydrate.test.ts untouched; both pass.
- Gate re-run (SM_* unset): vitest 3 files / 91 tests pass; `npm run typecheck` exit 0; `npm run lint` exit 0 (e2e budget 18/19).

## Findings
- Critical: none. Important: none.
- Minor: the real-app refusal rate (5,255 per 50 min) was not re-measured post-fix; no live probe done here.
- Minor: a refusal on the readArchived loop is only marked if it propagates to the outer catch (promptSessions.ts hydrateArchived); not independently exercised by a test.

# Validation: reap-spec-fixture-full-cwd-reset (PRD 2272)

Base: c636725b. Commit: 5a25a140 (merge ba17c6c9). PRD read from prds-archived/2272-reap-spec-fixture-full-cwd-reset.md.

## reap-spec-fixture-full-cwd-reset — VERIFIED
- AC1: `registerActiveProject` calls `require('../lib/activeSessions.cjs').__resetProjectCwdCacheForTests()` after the transcript write (diff of 5a25a140); existing `bustCwdCache()` calls untouched (diff adds 4 lines only).
- AC2: 3-line comment above `registerActiveProject` says production bust is shallow, so fixtures reusing a slug dir need the full test reset.
- AC3: `npx vitest run src/main/__tests__/scheduler-reap-dead-running-jobs.test.cjs` → 18 passed (18). `git diff c636725b..HEAD --stat` on activeSessions.cjs, queueStore.cjs, scheduler.cjs → empty (no production edits).
- AC4 (gate): the spec passes; the other two gate files were covered by the full unit suite (green apart from the one unrelated spec below).

## Full unit suite (all SM_* unset, `npm run test:unit`)
807 files passed, 1 failed; 7579 tests passed, 6 failed, 1 skipped.
- Red: `tests/unit/webRemoteEpicList.spec.ts` (6 tests, `build is not a function`).
  - Cause: `buildRemoteSessionList` was exported via `__test` in `src/main/webRemote.cjs` at Base (lines 687/1545) and is gone at HEAD. Removed by foreign commit 58a5fc92 (web-remote refactor), not by this plan. `grep -rn buildRemoteSessionList src` → no hits.
  - Classification: not plan-caused. This plan touched only the reap spec, which cannot affect it. The spec passes at Base by construction, since the function exists there. I did not re-run it at Base.
- Plan-caused reds: none.

## Findings
- Important: `tests/unit/webRemoteEpicList.spec.ts` is stale after 58a5fc92 and needs removal or update. It is outside this plan and should be routed to the web-remote owner.
- Minor: none.

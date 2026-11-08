# Validation: job-macro dispatch race

Base: e4a04e90. Commits: 932284c4 (approve-persist-awaitable), dca31d76 (launch-session-await-approve-persist). PRD files: prds-archived/2932-*, 2933-*.

## approve-persist-awaitable — VERIFIED
- Export `awaitApprovePersisted(epicId): Promise<void>`: promptSessions.ts:597.
- Wrapped attempt chain resolves on first successful persist, rejects with final Error on last failure (toast kept), resolves when Epic no longer active: promptSessions.ts ~655-680; retry delays [1000, 3000] unchanged; approveProposed stays sync.
- Map `approvePersists` + no-op catch + `.finally` delete (identity-checked) so no growth; no pending entry → `Promise.resolve()` (line 598).
- Tests: describe('awaitApprovePersisted') at promptSessions.test.ts:1818 covers deferred, retry-success, all-fail reject + cleanup, inactive-stop, no-pending.
- Gate: promptSessions.test.ts 89/89 pass; `npm run typecheck` exit 0.

## launch-session-await-approve-persist — VERIFIED
- Job branch awaits `awaitApprovePersisted(session.id)` before `dispatchJob`: launchSession.ts:~72-81; import from '../state/promptSessions'.
- Persist failure message contains title, "build was not queued", "press it again"; dispatch `!ok` message contains the error and "build was not queued".
- Chat path untouched; test "chat path never awaits the approval persist" added.
- Tests: deferred-gating test, rejection test, already-building test in launchSession.test.ts.
- Gate: launchSession + useMacroLaunch tests 39/39 pass; typecheck exit 0; `npm run lint` ok (e2e budget 18/19).

## Findings
### Critical
- none
### Important
- none
### Minor
- useMacroLaunch.test.tsx was edited (toast assertion loosened to substring) though not in 2933's # Files; the commit message discloses it and the change is warranted by the new wording.
- launchSession.ts:~79 uses an em dash ("— press it again") where the PRD text had a period; criteria substrings still match.
- Self-review (no security surface: no new input parsing, paths or secrets). Dedicated /code-review and /security-review not run; diff is ~100 lines and read in full.

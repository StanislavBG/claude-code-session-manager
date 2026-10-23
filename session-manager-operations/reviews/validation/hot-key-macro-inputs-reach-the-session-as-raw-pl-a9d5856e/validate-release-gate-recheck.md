# Validation recheck: 2119 repair-stale-remote-contract-tests

Supersedes `validate-release-gate-green.md` for 2119 (that REFUTED verdict was true at 23:15 PDT; the commit landed afterwards). Base: c429638a. PRD file found in `prds-archived/`.

## 2119 — VERIFIED

Commit f957fec8 is an ancestor of HEAD. `git show --stat` lists only `tests/unit/chatRunner.spec.ts` and `tests/unit/webRemoteDrilldown.spec.ts` (no `src/` file).

- chatRunner.spec.ts:649-651, 696-699 — payload keeps `tabId`/`prompt` and adds `requestId: expect.any(String)`; line 651 also asserts it is not `''`. Matches `requestId = randomUUID()` in src/main/chatRunner.cjs:988.
- webRemoteDrilldown.spec.ts:68 — unknown session expects `{ messages: [], hasMore: false, nextBefore: null }`. Matches src/main/webRemote.cjs:1081.
- webRemoteDrilldown.spec.ts:119-130 — `stub()` uses `mockResolvedValue({ disposition: 'sent' })`; the two send tests expect `{ ok: true, disposition: 'sent' }`; the call-argument assertions are unchanged. Matches `outcome()` at webRemote.cjs:1204-1219.
- webRemoteDrilldown.spec.ts:132-140 — test renamed to "…are refused without sending". It expects `{ ok:false, disposition:'refused', reason }` with 'proposed', 'not-active' and 'unknown-target', and still asserts `spy` not called. Matches webRemote.cjs:1217 and 1224.
- No `src/` change — confirmed from the f957fec8 stat.
- Gate: `timeout 300 npx vitest run tests/unit/chatRunner.spec.ts tests/unit/webRemoteDrilldown.spec.ts` → 2 files, 52/52 passed. (The PRD's own gate is `none`-style in this validate PRD; the 2119 gate was re-run as above.)

Tests were corrected to the production contract, not weakened: each old assertion was replaced by an equal or stricter one, and no assertion was removed.

## Findings

- Critical: none.
- Important: none.
- Minor: the validate PRD's own gate is `none`, so criteria were checked by reading the files plus re-running 2119's gate. The `requestId` assertion in the second chatRunner test is `expect.any(String)` only, so it allows an empty string. The first test does check for non-empty.

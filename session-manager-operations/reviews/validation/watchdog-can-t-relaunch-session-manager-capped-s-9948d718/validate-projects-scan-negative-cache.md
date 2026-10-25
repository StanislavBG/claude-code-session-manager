# Validation: projects-scan-cache-negative-results (PRD 2279)

Base: c636725b. PRD commit: 7e36abbf (only the two `# Files` paths). Review done by reading the diff; `/code-review` and `/security-review` not run separately.

## projects-scan-cache-negative-results — VERIFIED

- AC1: `activeSessions.cjs` sync returns `{rawCwd:null,newestMtimeMs,newestFile,newestSize}` on no cwd (~l.238) and `{rawCwd:null,newestFile:null,newestMtimeMs:0,newestSize:0}` with no jsonl (~l.221). The async variant does the same (~l.342/360). Null is returned only when readdir fails. `addCwd` returns early on falsy rawCwd (l.452-453). `records` also filters `d.rawCwd` (l.300, l.391).
- AC2: `sameNewest(prev, files[0])` short-circuit (l.199, 226, 347) now applies to null-cwd entries because they sit in the per-dir Map; a changed fingerprint falls through to one re-read. Shallow/deep/async paths all pass `prev` (l.294, 383).
- AC3: test "cwd-less and jsonl-less dirs are cached: shallow and deep bust do 0 tail reads" in `activeSessions-incremental-scan.test.cjs`, passing.
- AC4: test "a cwd-less dir whose transcript gains a cwd row is re-read exactly once", passing.
- AC5: gate (4 files) run with SM_* unset: 4 passed, 40 tests passed.

## Full unit suite (SM_* unset, `timeout 600 npm run test:unit`)

809 files: 807 passed, 2 failed (7 tests failed). 7583 passed.

Red specs:
- `tests/unit/webRemoteEpicList.spec.ts` (6 tests): `build is not a function`.
- `src/main/__tests__/web-remote-repair-identity.test.cjs` (1 test): verifiedPeerPubKeys elements are objects, expected strings.

Re-run at Base c636725b (detached worktree): both files pass (9/9). Re-running in this worktree reproduces the failures, so they are NOT flaky and NOT pre-existing at Base.
Attribution: they come from other commits in the Base..HEAD range, not from PRD 2279, which touched only activeSessions files. The web-remote commits are b8252d72 (retire desktop clientId, prune desktop pins), 58a5fc92, and 0d477836. Plan-caused: none. Pre-existing at Base: none. Range-caused by other plans: the 7 tests above.

## Findings

- Important: web-remote refactor commits (b8252d72, likely 5a7cb6e2/remote-app work) broke `webRemoteEpicList.spec.ts` and `web-remote-repair-identity.test.cjs`. Owned by the web-remote plan; needs a fix there.
- Minor: dev-lead skipped a red-before-green run (self-reported); the tests do assert 0 reads, so coverage is adequate.
- Minor: no real-tree measurement was taken; the fix reaches the running app only after a publish.

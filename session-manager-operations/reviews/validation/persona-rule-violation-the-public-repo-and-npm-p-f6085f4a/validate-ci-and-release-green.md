# Validation: ci-and-release-green

Base: 04fb28f9. Commits: 7cc5ae8a (pin runner), e46e80f6 (four tests). Other commits in range (a48396a4, 30fa9cc2) belong to another plan.
No real GitHub run was possible; checks are file reads and local runs (SM_* env unset).

## pin-ubuntu-runner-for-playwright — VERIFIED
- No `ubuntu-latest` in either workflow: gate python check printed `yaml ok` (both files parse, assert passed).
- release.yml:40,44 `macos-latest`/`windows-latest` unchanged; ci.yml:72,93 likewise.
- release.yml:118,121,124 Linux steps (Build unpacked, Install Playwright, Packaged smoke) all `if: matrix.os == 'ubuntu-24.04'`, matching the matrix entry; create-release, finalize-release, ci and unit jobs use `ubuntu-24.04`.
- Diff touches only the `runs-on`/matrix lines.

## repair-ci-only-test-failures — REFUTED (scheduler-gate-shadow still flaky)
- winPaths 'realpath fallback': e46e80f6 uses a `C:\a\b` path with `platform: 'win32'`, so it no longer depends on host drive or OS. Passes.
- health-delegation-chain: no longer needs machine state. Passes. See Important finding on assertion strength.
- scheduler-gate-shadow: the commit reorders setup (queue row first, PRD stamped last). Gate command run: 1st run 2 failed in 4 files. Five more runs of that file alone: 3 passed, 2 failed. Failing tests differ per run ('landedCommit committed before startedAt is refused' and 'a runId change under the gate drops the result entirely'). The criterion says the test must not depend on runner timing or local git state, and it still does.
- telemetryContract cadence: fixed sleep replaced with polling plus a 200 ms grace window. Passes. No fake-timer or global timeout change.
- No `.skip`, `.todo`, `xit` or `testTimeout` added (grep over diff clean).
- Gate (`vitest run` of the four files): FAILED on first run (1 file, 2 tests failed); not reliably green.

## Findings
### Important
- src/main/__tests__/scheduler-gate-shadow.test.cjs (setup, ~lines 59-85): flake remains, about 3 of 8 local runs red. The background `reconcile()` race is not fully closed; likely needs the test to stop or await background passes, or to isolate tmpHome. The PRD's gate cannot be trusted until it is stable, and CI will stay intermittently red.
- src/main/__tests__/health-delegation-chain.test.cjs:~118-130: the old assertion `delegation_chain.ok === true` was replaced by a consistency check (`ok === checks.every(ok)` plus failing checks carry a fix and an issue). It is not a skip or a timeout raise, but it is weaker. A real regression where every probe fails would now pass. The PRD asked not to weaken an assertion. The reasoning (CI has no user-scope state) is sound, but a stronger option is to inject the machine state and assert `ok: true`.
### Minor
- Both gate-shadow failures were observed with the shell's SM_* vars unset, so they are not env pollution.
- PRD files were found in prds-archived (2386, 2387).

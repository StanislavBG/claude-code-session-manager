# Validation: ci-flake-and-hook-retry

Base: 201a80dc. Commits in range: b1583460 (2389), bf72b3b0 (2390), 25c628b4 (2391).
Run with all SM_* env vars unset (`env -u ...`). CI itself only runs on the next push; everything below is files and local runs, not a CI result.

This wave answers two earlier records in this folder.

## 2389-gate-shadow-drain-broadcast-between-tests — VERIFIED
- afterEach is async, awaits `awaitGateShadowIdle()` then `broadcast({ flush: true })` before wiping `.claude/projects`; `broadcast` imported from `../scheduler.cjs`: `src/main/__tests__/scheduler-gate-shadow.test.cjs:33,96-103`.
- 'Queue row first, PRD file last' comment gone; the new afterEach comment is 2 lines: same file, 97-98.
- No production file changed by this commit (`git diff --stat` for b1583460: one test file). No skip, retry, sleep or timeout added.
- Gate: 20 consecutive `vitest run` of the file, SM_* unset: 20/20 green (output `20/20`).
- Earlier Important (flake, ~3 of 8 red) in validate-ci-and-release-green.md: closed locally (20/20). Not confirmed on CI.

## 2390-health-delegation-fixture-home — VERIFIED
- `tests/helpers/delegationHome.cjs:11-74` exports REQUIRED_TOOLS, writeAnsweringStub, writeDevPluginInstall, seedDelegationHome; `delegationReadiness.test.cjs:40-42,82` imports them, no local copies.
- End-to-end test sets HOME to a fresh temp home seeded by seedDelegationHome, restores HOME and removes the dir in `finally`: `health-delegation-chain.test.cjs:88-107`. Grep for `userInfo|SM_ALLOW_LIVE_ROOT_READS` is clean.
- Strict assertions: all 9 ids, `checks.filter(!ok).map(id)` toEqual `[]` (names failing ids), `delegation_chain.ok` toBe(true): same file, 109-124. Consistency block removed; header (lines 1-11) no longer claims `.mcp.json` or untracked settings.
- Gate: both test files 71/71 passed; `lint:test-smells` OK.
- Hand check: throwaway worktree under `~/.cache` (detached, never committed, removed afterwards), with the `.claude.json` write removed from the helper: the end-to-end test failed with `expected [ 'scheduler-mcp' ] to deeply equal []`. Strictness is real.
- Earlier Important (assertion weakened): closed.

## 2391-hook-rejected-reads-head-for-retry-skip — VERIFIED
- `reviewLadder.cjs:101-103` exports `isHeadSensitiveFailureKind` (true for content_conflict and hook_rejected only); `isMechanicalRecoveryFutile` uses it (106); export at 1017.
- Three call sites all use it: `scheduler.cjs:3897` (resolveHeadShasForPass), `:5162` (investigation first-refusal `selectMechanicalRecoveryTarget` call), `:6635` (finalizeHeadSha). A hook_rejected row now gets `gitHead(...)` instead of null, so it reaches `isMechanicalRecoveryFutile` with a real HEAD. Remaining literal `content_conflict` at `scheduler.cjs:5738` is `worktreeIntegrationVerdict`, which the PRD said to leave.
- Tests: hook_rejected skipped at unchanged HEAD and returned at moved HEAD, plus `resolveHeadShasForPass` against real temp repos (HEAD for hook_rejected, null for blocking_paths): `scheduler-mechanical-recovery.test.cjs` (added tests). gitWorktree pure-addition hook test: `gitWorktree.test.cjs` (hook_rejected, prefix, no MERGE_HEAD).
- `mergeFailureReason` now at `gitWorktree.cjs:1031`, below `AUTO_RESOLVE_EXTENSIONS` (1029), whose comment (1027-1028) sits on it again.
- Gate: three test files 134/134 passed; `npm run typecheck` exit 0.
- Earlier Important and Minor in validate-merge-hook-rejection.md: both closed.

## Whole-suite check (acceptance criterion 4) — NOT MET
- `npm run test:unit` (SM_* unset): 832 of 833 files passed, 7802 tests passed, 1 failed.
- winPaths.test.cjs (`src/main/lib/__tests__/`): 11/11 green. telemetryContract.test.cjs: 15/15 green.
- The one failure is `scripts/package/__tests__/release-workflow.test.cjs` 'matrixes macos and ubuntu runners': it expects `ubuntu-latest` but `.github/workflows/release.yml` was pinned to `ubuntu-24.04` by 7cc5ae8a, which predates the base. No file of this wave touches it, so it is not caused by these PRDs, but it leaves the suite red.

## Findings
### Critical
- none
### Important
- `scripts/package/__tests__/release-workflow.test.cjs:19` asserts `ubuntu-latest`; `.github/workflows/release.yml:17,42,148` use `ubuntu-24.04` (7cc5ae8a, before base). `npm run test:unit` is red on the landed tree and would fail on CI. Needs a one-line test fix (accept `ubuntu-24.04`) in a follow-up PRD.
### Minor
- Gate-shadow stability is shown by 20 local runs only; CI timing is unverified until the next push.

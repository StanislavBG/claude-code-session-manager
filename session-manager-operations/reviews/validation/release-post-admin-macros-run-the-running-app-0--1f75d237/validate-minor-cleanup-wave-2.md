# Validation: minor cleanup wave 2

Base: d1c56e042d2f03f83a7dd7d20a2993e65694b56d. Commits: cb36fd31 (claim scan), 6dbaebd9 (figure-captures).
Review tools: `/code-review` and `/security-review` were not run. I reviewed the diff by hand instead (correctness, input handling, secrets, path traversal, helper duplication).

## claim-scan-returns-own-incomplete-flag — VERIFIED
- `scanClaimedSync` and `scanClaimedAsync` return `{ ids, incomplete }` (restorableSessions.cjs, cb36fd31 diff). `listRestorableSessions` uses `scan.incomplete` at line 758. `checkRestorableSessionSync` uses it at line 961.
- `grep` finds no `claimScanIncomplete` anywhere in src or web. The memo's `incomplete` field was removed from the `ClaimedEntry` typedef.
- `claimedClaudeSessionIds` and `claimedClaudeSessionIdsAsync` are thin wrappers that still return a `Set`.
- Overlap test: two overlapping `list()` calls of one cwd, run in both settle orders (`complete-first` and `incomplete-first`). Scan A fails twice and returns no rows. Scan B returns its own row.
- ENOENT tests, sync and async: the file is gone between readdir and read. The scan claims nothing, is not incomplete, and reads the file once with no retry.
- No test skip, `.only`, or loosened assertion was added. The diff to the tests is additions only. The one `skip` match in the diff is an unrelated `archive.skipped` source line.
- Gate: `npx vitest run src/main/lib/epic/ web/manual/__tests__/figure-captures.test.cjs` passed, 36 files, 386 tests. `npm run test:unit` passed, 1105 files, 11204 tests, 1 skipped. That skip is pre-existing; this plan adds none.

## figure-captures-navitems-structural-guard — VERIFIED
- `toBeGreaterThan` is gone from figure-captures.test.cjs (grep finds none). No numeric NAV_ITEMS threshold remains.
- The test asserts NAV_ITEMS is an array, is non-empty, and every item has a non-empty string `key`.
- The existing "every recipe navKey is a NAV_ITEMS key" loop is unchanged. The diff touches only that one test.
- Gate: figure-captures.test.cjs passed, as part of the run above.

## Findings
Critical: none.
Important: none.
Minor:
1. web/manual/__tests__/figure-captures.test.cjs, about lines 73-79: the "at least one recipe has a navKey" assertion runs only when `RECIPE_KEYS.length > 0`. The PRD asked for it unconditionally. The commit says manual 2.0.0 ships zero recipes. I confirmed `figure-captures.json` currently has 0 recipes, so an unconditional assertion would fail today. With zero recipes the loop is vacuous, which is the case the guard exists to catch. It is a justified deviation, but it is not stated in the PRD. Suggested follow-up: record the deviation, and make the assertion unconditional once recipes exist.

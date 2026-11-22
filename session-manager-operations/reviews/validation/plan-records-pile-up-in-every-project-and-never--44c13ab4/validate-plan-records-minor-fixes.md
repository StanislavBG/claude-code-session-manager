# Validation: plan-records minor fixes (3649, 3650)

Base: 568dd2e2 (given). Commits: db3e861e (3649), cc362f7a (3650). Review tools: self-review of the combined diff (no path traversal, no new input surface; paths built via opsPath).

## plan-record-sweep-fails-closed (3649) — VERIFIED
- Corrupt index throws for every id: `runLogRetention.cjs` `readIndexSessions` returns `INDEX_UNREADABLE` for a sentinel, non-object, or non-object `sessions`; `epicStatusFor` then returns `() => { throw new Error('active-index unreadable') }`, so prunePlanRecords' throwing-epicStatus rule keeps every folder. Test `planRecordSweep-index-unreadable.test.cjs:53` ("corrupt … nothing is pruned"), plus :69 and :77 for other unreadable shapes.
- Missing index: `fs.existsSync` false → `{}`; orphans age out. Test :84.
- Valid index unchanged: test :97.
- Canonical helpers: `opsPath`, `readJsonOrSync` with sentinel, `fs.existsSync`. No new JSON.parse. `epicMint.cjs` and `planRecordRetention.cjs` untouched.
- `runBootSweep` comment now names the boot pass and the 24h `runRunLogRetentionPass` timer.
- Gate: vitest (sweep-index-unreadable, planRecordRetention-wiring, opsRetentionKnobsWired, externalContract.shape) 4 files / 28 tests passed; `npm run typecheck` exit 0.

## contract-doc-epic-409-row (3650) — VERIFIED
- `external-contract.md:245` Answer cell lists `{ ok, epic }`, `404 {…"not found"}`, `409 {…"ambiguous epic id", cwds}` (`id` without `cwd` only); matches `epicAdminRoutes.cjs:98,102`.
- Bullet at :250-251 trimmed to the lookup rule (`404`/`409` bare, `externalRef` needs `cwd`); no duplicated bodies.
- Gate: externalContract.shape test passed; `npm run lint:docs` ok.

## Findings
- Critical: none.
- Important: none.
- Minor: `epicStatusFor` with injected `deps.readActiveIndex` trusts the result without fail-closed handling (`runLogRetention.cjs`, test-only path; documented in the doc comment). Production path is fail-closed.
- Minor: `planRecordRetention-wiring.test.cjs` is listed in 3649's Files but was not modified; it passes unchanged.

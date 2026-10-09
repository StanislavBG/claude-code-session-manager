# Validation: test-value measurement plan (PRDs 1654–1662)

Base: `253e8bf35f0adaf3223508b3f60c02665c8b5110`, HEAD `1cd53b40`. Gates run with a scratch TMPDIR, `SM_CHAT_CONCURRENCY` unset.
The job worktree had no `node_modules`, so I symlinked the main checkout's (gitignored) to run vitest.

## tq-coverage-map (1654) — REFUTED
- PASS: `@vitest/coverage-v8` is `"4.1.6"` exact (`package.json:151`). `test-quality` is not in `files` (grep empty).
- **FAIL: `scripts/list-pure-tests.cjs` `listIncludedFiles()` does not return "every file vitest.config.ts includes".** It returns 210 files. It misses `src/main/__tests__/*.test.cjs` and `tests/unit/*.spec.ts`: `includes("src/main/__tests__/opsErrorLog.test.cjs")` is `false`. `vitest list` reports 686. The baseline REPORT.md header admits this ("glob matcher needs >=1 directory under `**`").
- The existing exports are unchanged (the diff only adds `listIncludedFiles` to `module.exports`).
- PASS: `runTestFile`, `buildMap` and `attribute` exist. The coverage-map test (a: real CLI on two atomicFs tests, b: synthetic attribution) is green.
- Gate: `vitest run coverage-map.test.cjs package-files.test.cjs` gives 2 files and 6 tests passed. `npm run lint` exits 0.

## tq-smell-scan (1655) — VERIFIED
- All five smells are implemented in `scripts/test-quality/smells.cjs`. `scanRepo` finds at least 600 files (686 in `summary.json`).
- Fixture-tree and real-repo scenarios are in `smells.test.cjs`.
- Gate: smells.test.cjs, 3 tests passed.

## tq-mutation-sampler (1656) — VERIFIED
- `mutants.cjs` is present with the operators, dirty-tree exit 2, finally-restore and signal handlers.
- Gate: mutants.test.cjs, 3 tests passed. This includes the CLI run on atomicFs and the SIGTERM test.
- `sha256sum -c` of `src/main/lib/atomicFs.cjs` before vs after the run: OK, byte-identical. `git diff --quiet` on the file also exits 0.
- Caveat (Important, see Findings): the default `--map` path uses `listIncludedFiles`, so it inherits the 210-file gap.

## tq-coverage-guard (1657) — VERIFIED
- Gate: coverage-guard.test.cjs, 3 tests passed. This covers delete → exit 1 naming the module, rename → 0, and src edit → 2, in a temp worktree.

## tq-smell-ratchet (1658) — VERIFIED
- `package.json:70` defines `lint:test-smells`, and `:71` appends it as the last element of the `lint` chain.
- `tests/quality/smell-allowlist.json` has `source-text` and `no-assert` keys with sorted paths.
- `npm run lint` ends with `smells --check: OK` and exit 0. The new-offender / stale / clean scenario is in `smells.test.cjs`.

## tq-value-report (1659) — VERIFIED
- `report.cjs` is present. The five-verdict synthetic scenario passes (report.test.cjs, 1 test).
- The REPORT.md totals line has the required shape (`files=686 tests=6043 loc=… | keep=… bloat=… | bloat+merge: loc=… duration=…`).

## tq-mutation-sample (1660) — VERIFIED
- `mutation-sample.json` names all three modules. The gate node check exits 0, and `git diff --quiet` on the three sources exits 0.
- MUTATION.md has the header (base SHA, date, nproc 14, wall time ~510 s), per-module counts, survivors, per-test kills/uniqueKills, and the "redundant for these modules (check before deleting…)" list.
- atomicFs ran 11 mutants rather than 20. The PRD says `--max 20`, which is a cap, so fewer eligible covered sites is acceptable. epicMint and opsOwnership ran 20 each.

## tq-baseline-report (1661) — VERIFIED (with a methodology caveat)
- `summary.json` has 686 rows (gate exits 0). It holds no raw coverage keys (no `"s":[` arrays). Fields are verdict/uniqueS/uniqueB/durationMs/loc/smells.
- The REPORT.md header has the SHA (`eec9b614`), date, nproc 14, wall time ~1900 s and 8 of 686 unmeasured (1.2%, under the 5% limit). Each unmeasured file is listed with its reason.
- Only `tests/quality/` was touched by commit `1a78c28b`.
- Spot-check of "bloat":
  - `prdLocations.test.cjs` (10 tests) is plausible. `prdLocations.cjs` is covered by 74 test files, and the sibling `prdLocationsArchived.test.cjs` has unique coverage.
  - `ChatTranscriptTurn.turn-memo.test.tsx` is plausible. Seven other `ChatTranscriptTurn*` tests cover the same component.
  - `broadcastCoalescer.test.cjs` is plausible but weakest. Other tests (`scheduler-broadcast-reconcile`, `scheduler-looks-done`) execute the module, but they may not assert on its behaviour. Statement coverage is not kill power, so this needs the mutation check before deletion. The README's reduction rule already requires it.
- Caveat: 454 of the 686 files were measured by hand-supplying `vitest list` output, because of the `listIncludedFiles` bug.

## tq-test-policy-docs (1662) — VERIFIED
- `tests/README.md:65` has `## Test value — good test vs bloat`. It has the rubric, the bloat definition, a tools table with exact commands for all five scripts plus `lint:test-smells`, and the two-part reduction rule.
- `standards.md` gained exactly 5 bullets, as required.
- `scripts/README.md` lists the 5 tools. `npm run lint` (including `lint:docs`) exits 0.

## Combined diff review
- 21 files, +2735/−2. Dev-only scripts under `scripts/test-quality/`. The only `spawn` is `npx vitest` with a fixed argv and no `shell:true` (`coverage-map.cjs:83`).
- No secrets found.
- I did not run the `/code-review` or `/security-review` skills in this review. I read the diff by hand for correctness, input handling, path traversal and duplication.

## Findings
### Critical
- none
### Important
1. `scripts/list-pure-tests.cjs` — `listIncludedFiles()` returns 210 of 686 vitest files. It silently skips `src/main/__tests__/*.test.cjs` and `tests/unit/*.spec.ts`. It is the enumerator for `coverage-map --all` (so every run needs a manual file list), for `smells.cjs` scanRepo (the real-repo test passes only because of a fallback) and for `mutants.cjs`'s default map. The mutation sampler's default map would therefore miss many covering tests and overstate survivors. The fix is a glob matcher that handles zero directories under `**`.
### Minor
1. `tests/quality/REPORT.md` — the durations (~17–23 s for tiny tests) come from 14-way parallel contention. The "bloat+merge duration=3685s" figure is inflated and is a relative measure only.
2. `tests/quality/REPORT.md` — `smells.test.cjs` and `package-files.test.cjs` are listed unmeasured (failed/timeout under load). Both pass in isolation in this validation.
3. Bloat means "zero unique statement/branch coverage". A directly-targeted unit test, such as `broadcastCoalescer`, can be labelled bloat while still asserting real behaviour. The report should be treated as a candidate list, not a deletion list.

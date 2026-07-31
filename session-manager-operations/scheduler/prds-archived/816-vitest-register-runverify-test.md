---
title: Register runVerify.test.cjs with vitest so npm run test:unit covers it
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

`src/main/__tests__/runVerify.test.cjs` (the post-run reconciliation verifier's own test file,
38 assertions) is written against `node:test` + CommonJS `require` and is NOT listed in
`vitest.config.ts`'s `test.include` allowlist — confirmed via `grep -n runVerify vitest.config.ts`
returning nothing. Any AC line elsewhere that runs `npx vitest run src/main/__tests__/runVerify.test.cjs`
(or assumes `npm run test:unit` exercises it) currently fails with "No test files found, exiting
with code 1" even though the suite is fully green under `node --test`. This caused a real
`needs_review` false-negative on PRD 812-verifier-self-recovery-sleep-prefix-normalization: the
executor could not satisfy the literal AC command, substituted `node --test` instead, and printed
a PASS the verifier flagged as a substituted-verification issue. Port the test onto vitest so the
repo's one documented test command (`npm run test:unit` = `vitest run`) actually covers this file,
matching the ~26 other `src/main/__tests__/*.test.cjs` files already listed explicitly in
`vitest.config.ts`'s include array.

# Acceptance criteria

- [ ] `src/main/__tests__/runVerify.test.cjs` is added to `vitest.config.ts`'s `test.include`
      array (same array the other `src/main/__tests__/*.test.cjs` entries are already listed in)
- [ ] The test file runs correctly under vitest's runner — convert any `node:test`-specific
      constructs to vitest equivalents if needed (vitest sets `globals: true`, so bare
      `test()`/`describe()` should resolve to vitest's globals once the file is included; try
      running it under vitest first — if `require('node:test')` + `require('node:assert')`
      still self-execute standalone under vitest's collection phase, no rewrite is needed; only
      convert to vitest's own `test`/`expect` API if it doesn't) so all existing assertions still
      pass with equivalent coverage
- [ ] `timeout 60 npx vitest run src/main/__tests__/runVerify.test.cjs` exits 0 and reports the
      suite's tests passing (not "No test files found")
- [ ] `timeout 300 npm run test:unit` still exits 0 with this file included
- [ ] `timeout 300 npm run typecheck` passes

# Implementation notes

Read `src/main/__tests__/runVerify.test.cjs` first (header comment currently says "Run
standalone: node src/main/__tests__/runVerify.test.cjs"). Read `vitest.config.ts` (39 lines) —
the `include` array is a flat list of explicit `.test.cjs` paths for `src/main`, plus glob
patterns for `tests/unit` and `src/renderer`; follow that same explicit-path convention, don't
switch to a glob covering all of `src/main/__tests__` (that would pull in files not designed for
vitest). `package.json`'s `test:unit` script (line 33) is `"vitest run"`.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- Do not touch runVerify.cjs's actual verifier logic — this PRD is test-harness registration only
- Do not convert other src/main/__tests__ files' test styles

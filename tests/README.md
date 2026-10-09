# Tests

## The four homes

| Home | Runner | Registration |
| --- | --- | --- |
| `tests/unit/*.spec.ts` | vitest | glob-covered — drop a file in, it runs |
| `src/**/__tests__/*.test.cjs` | vitest | glob-covered by `vitest.config.ts` `include` — drop a file in, it runs |
| `src/renderer/**/*.test.ts(x)` | vitest | glob-covered |
| Playwright: `tests/e2e` (incl. `chat-restart.spec.mjs`) + `tests/smoke` | Playwright (`playwright.config.ts`) | `testMatch` globs; `web-remote/**` and `web/remote-app/**` are ignored |

## Registration law

Enforcement: `vitest.config.ts`'s `include` is glob-based (`src/**/__tests__/**/*.test.cjs`,
`scripts/**/__tests__/**/*.test.cjs`, `web/**/__tests__/**/*.test.cjs`, plus the renderer
`.test.ts`/`.test.tsx`/`.spec.ts` globs) — any new `__tests__` file matching those globs is
picked up automatically; no separate registration step or lint guard.

## Running one file

- vitest: `npx vitest run <path>`
- Playwright (Linux): `xvfb-run -a timeout 600 npx playwright test <path>`

Never run the whole e2e suite casually. Running `test:unit` from inside a job worktree
can delete that worktree — use a scratch `TMPDIR`.

## Gates

- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `lint:selectors` + `lint:hooks` + `lint:unregistered-tests` + `lint:docs` + `lint:paths`
- `npm run test:unit` — `vitest run`
- `npm run test:e2e` — `xvfb-run -a playwright test`
- `npm run smoke:darwin` — `tests/smoke/darwin-boot.spec.ts`

## Stability (load-sensitive flakes)

A single green `npm run test:unit` run does not prove a test is reliable under load — a test
that races real wall-clock time or spawns many short-timeout child processes can pass in
isolation and fail intermittently inside the full parallel-worker suite (PRD 1414). Validators
(and anyone chasing a "failed once, passes alone" report) should run:

```
STABILITY_RUNS=3 timeout 900 npm run test:unit:stability
```

`scripts/test-unit-stability.sh` runs `npm run test:unit` N times (default 3,
`STABILITY_RUNS`-overridable) and exits non-zero listing any test that failed in any run. It is
dev-only — not in package.json's `files`, never shipped in the npm tarball.

When authoring a test that touches real time or spawns child processes, prefer:
- An injected/frozen clock (`vi.useFakeTimers()` + `vi.setSystemTime()`, or the module's own
  `now`/`nowMs` param) over comparing `Date.now()`/`new Date()` against a real `setTimeout` delay —
  unless the delay is a ONE-DIRECTIONAL buffer (a real wait only makes the assertion MORE true,
  e.g. `wait(1100)` before a `git log --since` check), which is load-safe as-is.
- One real child-process spawn to prove the wiring, with the actual case matrix run in-process
  against the same module's exported pure logic (see `guard-destructive-git-policy.cjs`, split out
  by PRD 1412) — never a loop that spawns a real process per case.

CI (`.github/workflows/ci.yml`), job `ci` (ubuntu, Node 20): `npm ci` → `npm run typecheck` →
`npm run lint` → `npm run test:unit` → `npm run build` → `npx playwright install chromium --with-deps` →
`apt-get install xvfb` → `npm run test:e2e` (env `SM_E2E=1`, `SM_SUPERVISOR_DISABLE=1`,
`SM_MOCK_BILLING_KIND=ok`). Job `smoke-darwin` (macOS): `npm ci` → `typecheck` → `lint` → `build` →
`npm run smoke:darwin`.

## Test value — good test vs bloat

A test earns its place only if deleting it would let a bug through. That means it has unique
coverage (a statement or branch no other test runs) or unique mutant kills (an injected bug no
other test catches).

Prefer one scenario test per workflow. It drives public entrypoints — an IPC handler, an admin
route, a CLI, or an exported module API — with real fs in the sandbox HOME and the claude stub
at the process boundary. Extend the existing scenario test; do not add a new file for each fix.
Playwright e2e is for UI flows only and never runs under the scheduler.

### What counts as bloat

- Zero unique coverage and zero unique kills.
- Source-text change detectors: tests that read a production file and assert on its text. A
  static invariant belongs in a `scripts/check-*.cjs` lint, not a unit test.
- Mock-call-only assertions: every `expect` is a `toHaveBeenCalled` variant, so no behaviour is checked.
- Micro-files that fragment one module's tests across many small files.

### Tools

All live in `scripts/test-quality/` and are dev-only.

| Tool | Command | Use |
| --- | --- | --- |
| smells.cjs | `node scripts/test-quality/smells.cjs [--json]` | Static smell scan per test file |
| coverage-map.cjs | `node scripts/test-quality/coverage-map.cjs --all --out test-results/test-quality/coverage-map.json` | Per-file v8 coverage and unique coverage |
| mutants.cjs | `node scripts/test-quality/mutants.cjs <srcFile> --seed 1 --out <before.json>` | Seeded mutation sample; shows which test files kill which mutants |
| coverage-guard.cjs | `node scripts/test-quality/coverage-guard.cjs --base <sha>` | Exit 0 = no covered statement or branch dropped; 1 = dropped keys listed; 2 = diff touches non-test source |
| report.cjs | `node scripts/test-quality/report.cjs --map test-results/test-quality/coverage-map.json` | keep / review / merge / bloat verdict per file, plus consolidation clusters |
| lint:test-smells | `npm run lint:test-smells` | Ratchet: source-text and no-assert smells may only shrink (`tests/quality/smell-allowlist.json`) |

### Reduction rule

Delete or merge a test only when both hold:

1. `node scripts/test-quality/coverage-guard.cjs --base <sha>` exits 0, where `<sha>` is the commit before your change.
2. `mutants.cjs` run with the same `--seed` (and `<srcFile>`) before and after shows no mutant that was killed before and survives after.

If either fails, keep the test or move its assertions into the scenario test first.

## Notes on specific specs

- `tests/smoke/darwin-boot.spec.ts` has no platform guard: on Linux it runs as a free extra boot smoke.

## Scratch

`test-results/` is gitignored and safe to delete.

## Not run from root

- `web-remote/relay/tests` — the relay is its own package with its own deps; run from there.
- `web/remote-app` — its own package and `playwright.config.ts`; excluded from the root Playwright run.

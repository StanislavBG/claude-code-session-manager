# Tests

## The four homes

| Home | Runner | Registration |
| --- | --- | --- |
| `tests/unit/*.spec.ts` | vitest | glob-covered — drop a file in, it runs |
| `src/**/__tests__/*.test.cjs` | vitest | **HAND-REGISTERED**, one line each in `vitest.config.ts` `include` |
| `src/renderer/**/*.test.ts(x)` | vitest | glob-covered |
| Playwright: `e2e/*.spec.mjs` (chat-restart, mic, watchers) + `tests/e2e` + `tests/smoke` + `tests/golden.spec.ts` | Playwright (`playwright.config.ts`) | `testMatch` globs; `web-remote/**` and `web/remote-app/**` are ignored |

## Registration law

A `.test.cjs` under `src/**/__tests__` that is not listed in `vitest.config.ts` silently never runs.
Every such file gets one `include` line in the same change that creates it.

Enforcement: `npm run lint:unregistered-tests` (`scripts/check-unregistered-tests.cjs`; part of `npm run lint`).

The guard scans `src/`, `scripts/` and `web/` (excluding `node_modules`, `dist`) for
`*.test.{cjs,ts,tsx}` and `*.spec.cjs` under any `__tests__` segment, and checks both
directions: a test on disk absent from `include` fails, and a literal `include` entry with
no file on disk fails too. `VITEST_CONFIG_PATH` (or a CLI arg) points it at another config.

Known debt: the `node:test` files under `src/main/__tests__` are allowlisted in
`check-unregistered-tests.cjs` (vitest cannot run them; run with `node --test`). A later PRD resolves this.

## Running one file

- vitest: `timeout 120 npx vitest run <path>`
- Playwright (Linux): `xvfb-run -a timeout 600 npx playwright test <path>`

Never run the whole e2e suite casually. Running `test:unit` from inside a job worktree
can delete that worktree — use a scratch `TMPDIR`.

## Gates

- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `lint:selectors` + `lint:hooks` + `lint:unregistered-tests` + `lint:docs` + `lint:paths`
- `npm run test:unit` — `vitest run`
- `npm run test:e2e` — `xvfb-run -a playwright test`
- `npm run smoke:darwin` — `tests/smoke/darwin-boot.spec.ts`

CI (`.github/workflows/ci.yml`), job `ci` (ubuntu, Node 20): `npm ci` → `npm run typecheck` →
`npm run lint` → `npm run test:unit` → `npm run build` → `npx playwright install chromium --with-deps` →
`apt-get install xvfb` → `npm run test:e2e` (env `SM_E2E=1`, `SM_SUPERVISOR_DISABLE=1`,
`SM_MOCK_BILLING_KIND=ok`). Job `smoke-darwin` (macOS): `npm ci` → `typecheck` → `lint` → `build` →
`npm run smoke:darwin`.

## Notes on specific specs

- `tests/golden.spec.ts` reads the gitignored `session-manager-operations/bilko-host/dist/`; it
  skips itself when `index.html` is absent.
- `tests/smoke/darwin-boot.spec.ts` has no platform guard: on Linux it runs as a free extra boot smoke.

## Scratch

`test-results/` and `e2e/.cache` are gitignored and safe to delete.

## Not run from root

- `web-remote/relay/tests` — the relay is its own package with its own deps; run from there.
- `web/remote-app` — its own package and `playwright.config.ts`; excluded from the root Playwright run.

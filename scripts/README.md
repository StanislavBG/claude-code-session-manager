# scripts/

Five invocation mechanisms live here: npm scripts, a systemd timer, `.claude/settings.json` hooks, plugin skills, and manual one-shots. This is the index.

scripts/lib was moved into src/main/lib (2026-09); nothing under src/ may require from scripts/.

## Invoker table

| script | invoked by | shipped on npm |
| --- | --- | --- |
| audit-ops-hygiene.cjs | manual | yes |
| bench/main-bench.cjs | `npm run bench` (main-process micro-benches, plain Node); renderer half is `npm run bench:renderer` (`tests/bench/`, `vitest.bench.config.ts`, not in `test:unit`) | no |
| page-surface.cjs | manual and by the page steward personas `.claude/agents/page-*.md`; derives a page's owned/shared files, window.api methods, main handlers and tests | no |
| check-page-stewards.cjs | `npm run lint:page-stewards` (in `lint`) — every nav page has a valid `.claude/agents/page-<key>.md` steward persona; ratchets PENDING | no |
| check-conditional-hooks.cjs | `npm run lint:hooks` (in `lint`) | no |
| check-epic-transcripts.cjs | manual read-only diagnostic (`--json`); also surfaced as a non-fatal warning in `npm run health` | no |
| check-doc-hierarchy.cjs | `npm run lint:docs` (in `lint`) | no |
| check-explicit-any.cjs | `npm run lint:any` (in `lint`) — bans explicit `any`/`@ts-ignore` in renderer+preload; per-line `// lint-allow-any: <reason>` | no |
| check-main-ts-check.cjs | `npm run lint:main-ts-check` (in `lint`) — `tsconfig.main.json` `include` ⇔ `// @ts-check` first line, both directions; explicit list only, `checkJs` false | no |
| check-renderer-storage.cjs | `npm run lint:renderer-storage` (in `lint`) — ratchet-bans `localStorage.`/`sessionStorage.` in `src/renderer` outside an explicit ALLOWLIST (Epic stateless-ui-review) | no |
| check-tracked-filenames.cjs | `npm run lint:filenames` (in `lint`) — fails on tracked paths with Windows-illegal chars, trailing dot/space, or reserved device names | no |
| check-unstable-selectors.cjs | `npm run lint:selectors` (in `lint`) | no |
| install-scheduler-mcp-user-scope.sh | manual (`seedSchedulerMcp.cjs` does the same on first boot, or on the next boot after its marker file is deleted) | no |
| install-scheduler-watchdog.sh | manual; installs the systemd user timer (cron fallback) | no |
| move-modules.cjs | manual; `node scripts/move-modules.cjs <mapping.json> [root] [--dry-run]` — idempotent codemod that git-mvs `src/main/lib` modules (+ their tests) into subfolders and rewrites every relative require and `lib/<m>.cjs` path string | no |
| mint-epic.cjs | manual; joins an existing Epic and prints its prds dir | yes |
| ops-sweep.cjs | manual; `node scripts/ops-sweep.cjs <cwd>` | yes |
| postinstall.cjs | npm `postinstall` | yes |
| refresh-vad-assets.mjs | `npm run refresh:vad-assets` | no |
| replay-verdicts.cjs | manual, dev-only, read-only | no |
| scheduler-mcp-server.cjs | registered as an MCP server (`seedSchedulerMcp.cjs`, `send-feedback` SKILL.md) | yes |
| scheduler-watchdog.cjs | the systemd timer, via scheduler-watchdog.sh | no |
| scheduler-watchdog.sh | the systemd timer unit's `ExecStart` | no |
| sm-ps.cjs | manual process-tree inspector | no |
| sync-settings-schema.cjs | `npm run sync:settings-schema` | no |
| write-build-info.cjs | npm `prepack` and `prepublishOnly` | no |
| test-quality/smells.cjs | `npm run lint:test-smells` (in `lint`) — static test-smell scan; ratchets source-text/no-assert against `tests/quality/smell-allowlist.json` | no |
| test-quality/coverage-map.cjs | manual, dev-only — per-test-file v8 coverage and unique-coverage attribution | no |
| test-quality/mutants.cjs | manual, dev-only — seeded mutation sampler; which test files kill which mutants | no |
| test-quality/coverage-guard.cjs | manual, dev-only — `--base <ref>`; fails if a test-only diff drops covered statements/branches | no |
| test-quality/report.cjs | manual, dev-only — keep/review/merge/bloat verdict per test file from the coverage map | no |
| hooks/guard-destructive-git.cjs | `.claude/settings.json` PreToolUse + shim | yes |
| hooks/guard-inline-implementation.cjs | `.claude/settings.json` PreToolUse + shim | yes |
| hooks/guard-prd-writes.cjs | `.claude/settings.json` PreToolUse + shim | yes |
| hooks/guard-self-schedule.cjs | `.claude/settings.json` PreToolUse + shim | yes |

CI (`.github/workflows/ci.yml`) runs only npm scripts, never a file here directly.

## Guards

The four `hooks/guard-*.cjs` are adopted by reference, not copied: `src/main/lib/guardShims.cjs` installs stable shims at `~/.claude/session-manager/hooks/guard-*.cjs` that `require()` the file from the app root. This repo's own `.claude/settings.json` points at them directly.

## Sweeps

- `ops-sweep.cjs` is the portable sweep: it requires a target-project cwd argument and works on any project's ops folder.
- `audit-ops-hygiene.cjs` holds this repo's own patterns and is not portable.

Bench numbers are machine-relative — compare runs on the same machine only; there are no pass/fail thresholds.

## npm shipping

`ops-sweep.cjs` and `audit-ops-hygiene.cjs` ship: they need only Node built-ins and `src/main/` (also packed), no dev-only deps. `package.json` `files` lists every shipped script individually; `__tests__/package-files.test.cjs` asserts it.

## Tests

New tests under `scripts/` must be hand-registered in `vitest.config.ts` (see [tests/README.md](../tests/README.md)).

`memory-explorer-shots.mjs [outDir]` (`npm run preview:memory`) — dev-only: serves `src/renderer/preview/memory-explorer.html` with Vite, drives 13 Memory Explorer states in plain Chromium (no Electron), writes `NN-name.png` + `compare.html` against `design-mocks/memory-explorer/renders/`.

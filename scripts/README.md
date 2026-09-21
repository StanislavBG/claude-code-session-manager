# scripts/

Five invocation mechanisms live here: npm scripts, a systemd timer, `.claude/settings.json` hooks, plugin skills, and manual one-shots. This is the index.

scripts/lib was moved into src/main/lib (2026-09); nothing under src/ may require from scripts/.

## Invoker table

| script | invoked by | shipped on npm |
| --- | --- | --- |
| audit-ops-hygiene.cjs | manual; named in `ops-sweep` + `develop` SKILL.md | yes |
| bench/main-bench.cjs | `npm run bench` (main-process micro-benches, plain Node); renderer half is `npm run bench:renderer` (`tests/bench/`, `vitest.bench.config.ts`, not in `test:unit`) | no |
| check-conditional-hooks.cjs | `npm run lint:hooks` (in `lint`) | no |
| check-epic-transcripts.cjs | manual read-only diagnostic (`--json`); also surfaced as a non-fatal warning in `npm run health` | no |
| check-doc-hierarchy.cjs | `npm run lint:docs` (in `lint`) | no |
| check-explicit-any.cjs | `npm run lint:any` (in `lint`) — bans explicit `any`/`@ts-ignore` in renderer+preload; per-line `// lint-allow-any: <reason>` | no |
| check-main-ts-check.cjs | `npm run lint:main-ts-check` (in `lint`) — `tsconfig.main.json` `include` ⇔ `// @ts-check` first line, both directions; explicit list only, `checkJs` false | no |
| check-tracked-filenames.cjs | `npm run lint:filenames` (in `lint`) — fails on tracked paths with Windows-illegal chars, trailing dot/space, or reserved device names | no |
| check-unregistered-tests.cjs | `npm run lint:unregistered-tests` (in `lint`) | no |
| check-unstable-selectors.cjs | `npm run lint:selectors` (in `lint`) | no |
| cleanup-nested-queue-stubs.cjs | manual one-shot; dispatches to cleanup-worktree-ops-stubs.cjs | no |
| cleanup-worktree-ops-stubs.cjs | via cleanup-nested-queue-stubs.cjs | no |
| health.sh | manual; `local-project-health` skill's lookup path (`npm run health` uses src/main/health.cjs) | no |
| install-scheduler-mcp-user-scope.sh | manual; named in `develop` SKILL.md | no |
| install-scheduler-watchdog.sh | manual; installs the systemd user timer (cron fallback) | no |
| mint-epic.cjs | `develop` SKILL.md and PRD_AUTHORING.md manual-write fallback | yes |
| ops-sweep.cjs | `ops-sweep` SKILL.md (`node "$SM_ROOT/scripts/ops-sweep.cjs" <cwd>`) | yes |
| postinstall.cjs | npm `postinstall` | yes |
| probe-electron-helper-comm.cjs | manual probe (Linux, xvfb) | no |
| refresh-vad-assets.mjs | `npm run refresh:vad-assets` | no |
| replay-verdicts.cjs | manual, dev-only, read-only | no |
| scheduler-mcp-server.cjs | registered as an MCP server (`seedSchedulerMcp.cjs`, `send-feedback` SKILL.md) | yes |
| scheduler-watchdog.cjs | the systemd timer, via scheduler-watchdog.sh | no |
| scheduler-watchdog.sh | the systemd timer unit's `ExecStart` | no |
| sm-ps.cjs | manual process-tree inspector | no |
| sync-settings-schema.cjs | `npm run sync:settings-schema` | no |
| write-build-info.cjs | npm `prepack` and `prepublishOnly` | no |
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

## Cleanup dispatch

`cleanup-nested-queue-stubs.cjs` removes nested queue shards and then dispatches to `cleanup-worktree-ops-stubs.cjs` (its `main()`), which handles the worktree-side stubs.

Bench numbers are machine-relative — compare runs on the same machine only; there are no pass/fail thresholds.

## npm shipping

`ops-sweep.cjs` and `audit-ops-hygiene.cjs` ship: they need only Node built-ins and `src/main/` (also packed), no dev-only deps. `package.json` `files` lists every shipped script individually; `__tests__/package-files.test.cjs` asserts it.

## Tests

New tests under `scripts/` must be hand-registered in `vitest.config.ts` (see [tests/README.md](../tests/README.md)).

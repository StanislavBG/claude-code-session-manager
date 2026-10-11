# Validation: slim session-manager-dev plugin (PRDs 1849–1855)

Base: 640f9fc66790f8d54e2ac1a504c0a76fe29c366b → HEAD d7cd1d41. PRD files found in `prds-archived/`.
Note: the job worktree had no `node_modules`; a symlink to the main checkout's (gitignored) was used to run vitest/tsc. Tests were run with a scratch TMPDIR, scoped to named files only.

## Per-PRD verdicts

VALIDATION: 1849-remove-rarely-used-dev-plugin-skills VERIFIED
VALIDATION: 1850-develop-skill-drop-removed-skill-refs VERIFIED
VALIDATION: 1851-builder-skill-drop-removed-skill-refs VERIFIED
VALIDATION: 1852-catalog-dev-plugin-three-skills VERIFIED
VALIDATION: 1853-docs-drop-removed-skills-claude-md VERIFIED
VALIDATION: 1854-docs-drop-removed-skills-ops-health VERIFIED
VALIDATION: 1855-seed-dev-plugin-version-upgrade VERIFIED

## Evidence

**1849** (commit 323ffc65)
- `ls plugins/session-manager-dev/skills` → `builder develop send-feedback` (12 removed folders gone).
- plugin.json: version `0.2.0`, description names only /develop, /builder, /send-feedback; keywords `development, scheduler, prd, feedback, release, session-manager` (kpi/memory/triage/code-review dropped).
- `.claude-plugin/marketplace.json:16` plugin entry version `0.2.0`; description names no removed skill.
- Gate re-run: `vitest run dev-plugin-skillset, ops-sweep-claude-md-fallback, package-files, develop-skill-failure-modes` → pass (part of 6 files / 42 tests green).

**1850** (33b974ea)
- `develop/SKILL.md:44` names built-in `/code-review`, keeps `systematic-debugging` and "Why: one copy never goes stale."
- `develop/standards.md:80` lists only `/code-review`, `/security-review`; `git grep requesting-code-review` in develop/ → no hits. standards.md still at same path.
- Gate: `develop-skill-failure-modes.test.cjs` green.

**1851** (683cab8f)
- `git grep -nE 'pr-review-sweep|issue-address|project-status' -- plugins/session-manager-dev/skills/builder` → no hits (exit 1 = clean).
- Reference-only diff; no behavioral instruction changed.

**1852** (cab5209d)
- `src/renderer/data/catalog.ts:175-178`: comment says "3 skills"; description names only /develop, /builder, /send-feedback; grep for forbidden strings in catalog.ts → none.
- `src/main/index.cjs:1406`: comment now "its 3 dev skills" (comment-only).
- Gate: `npm run typecheck` exit 0; `PluginHomePage.test.ts` green.

**1853** (0c4766a6)
- `plugins/CLAUDE.md`: 3 skills, verified-date 2026-10-11, offenders list drops memory-sanitation/ops-sweep, `$SM_ROOT` pattern described self-contained.
- `CLAUDE.md`: `npm run health` line no longer cites `/local-project-health`. `wc -c CLAUDE.md` = 11867 vs 11932 at Base (shrank; under 12,000 budget).
- `scripts/README.md:27`: ops-sweep.cjs row says "manual; `node scripts/ops-sweep.cjs <cwd>`".
- Gate: `npm run lint:docs` → ok (exit 0).

**1854** (43f83451)
- `HUMAN_LEARN/README.md`: states explain-to-me retired 2026-10-11, pages kept static; no "Run /explain-to-me".
- `src/main/health.cjs:4,646` comments now reference `npm run health`; comment-only diff.
- ops-maintenance-protocol.md: no `/ops-sweep` / `session-manager-dev:ops-sweep` remains (plan-level grep below).
- Gate: `npm run lint:docs` exit 0.

**1855** (d7cd1d41)
- `seedDevPlugin.cjs`: exported `upgradeIfStale`, called on every `seedDevPlugin` run before the done-marker check; reads `installed_plugins.json` entry for `session-manager-dev@session-manager`, bundled version from plugin.json; `compareSemver(installed,bundled) >= 0` → return; skipped if not installed or not in `enabledPlugins`; `SM_SEED_DEV_PLUGIN_DISABLE=1` honored; failures go to `writeLog`, whole body in try/catch.
- `pluginInstall.cjs`: new `update()` reuses `runStep` (pty spawn path, no `shell: true`), runs `claude plugin marketplace update <name>` then `claude plugin update <slug>@<name>`; subcommands named in comment.
- Header comment states 3 skills (builder, develop, send-feedback) and documents the upgrade pass.
- `seedDevPlugin.test.cjs`: tests for stale→called, equal→not, not installed→not, disabled→not, kill-switch→not, CLI failure→logged+resolves, plus compareSemver. All green (6 files/42 tests combined run).
- Gate: vitest green; `npm run typecheck` exit 0.

## Plan-level grep
`git grep -nE '<12 names>' -- plugins src CLAUDE.md scripts/README.md session-manager-operations/architecture scripts` minus `scripts/ops-sweep.cjs` filename mentions: remaining hits are only
the REMOVED-names list in `scripts/__tests__/dev-plugin-skillset.test.cjs` (intentional), test/filename mentions of `ops-sweep-claude-md-fallback`, `package-files.test.cjs:33` comment, `src/**/fixtures/*.log` (fine), and the items under Minor. No reference to any removed skill as a shipped skill. `scripts/health.sh` was deleted earlier (2e027e6c), so no health.sh leftover.

## Findings

### Critical
none

### Important
none

### Minor
- `scripts/__tests__/package-files.test.cjs:33` — comment still says "the ops-sweep skill tells npm-installed users to run"; the skill is gone (the script stays). Comment-only.
- `session-manager-operations/architecture/domain-model.md:168` — "`audit-ops-hygiene.cjs` and `ops-sweep`" is ambiguous; it now means the script, not a skill. Fine as-is, could say `ops-sweep.cjs`.
- `src/main/__tests__/seedDevPlugin.test.cjs` — no test for `runUpdate` *throwing* (only `{ok:false}`); the catch branch in `upgradeIfStale` is covered by inspection only.
- `CLAUDE.md` link table also dropped `docs/README.md` (not in 1853's criteria; harmless cleanup, change is accurate since that junction was removed in 548e9376).
- `compareSemver` is a local helper; PRD said reuse if one existed. I did not search `src/main/lib` for an existing semver helper beyond the diff; low-risk duplication.
- Stray 0-byte `<path>` file in repo root is the known sqlite-MCP placeholder (untracked, not part of this plan).

### Review pass
`/code-review` and `/security-review`: self-reviewed the combined diff. `update()` validates slug/marketplace against `SLUG_RE`/`MKT_NAME_RE` before spawning, no shell, args passed as array; no secrets, no path traversal (paths built from `os.homedir()`/`__dirname` + constants). No issues found.

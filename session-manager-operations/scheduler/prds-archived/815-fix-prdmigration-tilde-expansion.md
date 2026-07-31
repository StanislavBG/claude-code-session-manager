---
title: Fix prdMigration.cjs tilde-expansion bug
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

`src/main/lib/prdMigration.cjs` calls `fs.existsSync(cwd)` on the raw frontmatter
`cwd` value without expanding a leading `~`, so tilde-prefixed cwds (e.g.
`~/Projects/session-manager`) are always reported unresolved with reason
`cwd does not exist on disk: ~/...` even when the expanded path exists on disk
(confirmed — see
`session-manager-operations/feedback/processed/2026-07-30-rca-v0390-blank-screen-unstable-selector-185.md`,
follow-up item 5; 226 legacy PRDs were observed stuck unmigrated with this false
reason). `src/main/lib/expandHome.cjs` already exports an `expandHome` function used
elsewhere in this repo — reuse it here instead of writing new expansion logic.

# Acceptance criteria

- [ ] `src/main/lib/prdMigration.cjs` imports `expandHome` from
      `./expandHome.cjs` and expands `cwd` via `expandHome(cwd)` before the
      `fs.existsSync(cwd)` check (around line 63) and before using it as the
      resolve target for `resolvePrdWriteDir`/the move destination.
- [ ] Extend `src/main/__tests__/prdMigration.test.cjs` with a case asserting a
      tilde-prefixed `cwd` (e.g. `~/Projects/session-manager` or a test fixture
      home dir) that resolves to an existing directory is migrated (not left in
      `unresolved`).
- [ ] Existing tests in that file still pass.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run src/main/__tests__/prdMigration.test.cjs` passes.

# Implementation notes

File: `src/main/lib/prdMigration.cjs`, function `migratePrds`. The relevant lines:
```js
const cwd = fm.cwd && fm.cwd.trim();
if (!cwd) { ... }
if (!fs.existsSync(cwd)) {
  unresolved.push({ file: name, reason: `cwd does not exist on disk: ${cwd}` });
  continue;
}
const destDir = resolvePrdWriteDir(cwd);
```
Change to expand `cwd` via `expandHome(cwd)` right after trimming, and use the
expanded value for both the `existsSync` check and the `resolvePrdWriteDir` call
(check `resolvePrdWriteDir`'s own signature in `src/main/lib/prdLocations.cjs` to
confirm it expects an already-expanded absolute path). `expandHome.cjs`'s existing
signature: `function expandHome(p)` — `~` and `~/foo` become `$HOME` and
`$HOME/foo`.

# Out of scope

- Re-running the migration against real legacy PRDs on this machine (that's an
  operational follow-up, not part of this code fix).

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that
apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded
commands, verify before done, the finish-protocol sentinel).

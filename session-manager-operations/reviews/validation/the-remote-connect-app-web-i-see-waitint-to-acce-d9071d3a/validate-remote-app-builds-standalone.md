# Validation: remote-app-types-node-dev-dependency (PRD 2439)

Base: 1a860fef27265abe1da7463bdede0d3517e7642c. HEAD: 81f1d06d.
Commit for the PRD's paths: `81f1d06d build(remote-app): add @types/node devDependency` (only package.json +1, package-lock.json +18).

## remote-app-types-node-dev-dependency — VERIFIED

- AC1: `web/remote-app/package.json` devDependencies has `"@types/node": "^22.9.0"` (diff shows the added line); the lockfile root entry lists it at line 24; root `package.json:155` has the same range. `npm ci` accepted the lockfile.
- AC2: after `npm ci` in a clean worktree, `web/remote-app/node_modules/@types/node` exists (checked, "types-present").
- AC3: typecheck, test and build all exit 0 in the standalone worktree (below). Tests: 32 files, 213 passed, 1 skipped. `git show --stat` shows no src, test or tsconfig file changed.
- Gate (`npm ci`, `test -d`, typecheck, test, build), run in order in the standalone worktree: every command exited 0.

## Standalone case — PROVEN

Detached worktree of HEAD under `/tmp`, outside the job worktree. It had no root `node_modules` (`ls node_modules` returned "No such file"), and nothing was symlinked in.
In `web/remote-app`: `npm ci` exit 0, `npm run typecheck` exit 0, `npm run build` exit 0 ("built in 1.59s", manifest 1159.3 KB gz), `npm test` exit 0.
Removed with `git worktree remove --force`; `git worktree list` no longer shows it.

## Findings

- Critical: none.
- Important: none.
- Minor: none.

Review of the plan's full combined diff (`git diff <base>..HEAD --stat`, 26 files) is outside this PRD's two files. The other files belong to other plans, so they are not judged here. The two remote-app files are a dev-only, type-only dependency with no secrets, input handling or duplicated helper.

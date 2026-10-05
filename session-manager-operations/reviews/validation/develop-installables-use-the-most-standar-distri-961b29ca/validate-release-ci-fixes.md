# Validation: release CI fixes (run 37353443021)

Base: 13d0cde6c719549e850585a834783382050c8bd7. PRD files were located in `prds-archived/`.
Commits: 1587 → `94fa33e5` (release.yml, release-workflow.test.cjs); 1588 → `f95debd3` (stage.cjs, stage.test.cjs).

**The real proof is the next `v*` tag's Release run on macos-latest and windows-latest.** Nothing here ran on macOS or Windows; the evidence below is static reading plus Linux test runs.

## 1587 release-empty-signing-secrets — VERIFIED
- No job-level signing env: `.github/workflows/release.yml:28-30` job `env:` holds only `GH_TOKEN`. The seven signing vars are removed in `94fa33e5`.
- Conditional export: bash step "Export signing configuration" (`release.yml:~40-85`, `shell: bash`) writes each var to `$GITHUB_ENV` only inside `[ -n "$SECRET_*" ]` guards. Secrets enter through the step's own `env:` (`release.yml:45-51`).
- `CSC_IDENTITY_AUTO_DISCOVERY=false` is written on mac when `CSC_LINK` is empty, on Windows when `WIN_CSC_LINK` is empty, and on other runners.
- `APPLE_API_KEY` is written to `$RUNNER_TEMP/AuthKey_<id>.p8` (umask 077) and the path is exported, only when the key, key id and issuer are all present.
- `-c.mac.notarize=true` is set only in the all-three-Apple-secrets branch. `EXTRA_BUILDER_ARGS` is exported every time (`release.yml:85`) and consumed at `:121`, so the unsigned build still publishes.
- Tests: `release-workflow.test.cjs` gains a no-job-level-env assertion and a conditional-step assertion.
- Gate: `npx vitest run scripts/package/__tests__/release-workflow.test.cjs` passed. Combined with stage.test: 2 files, 16 tests, all passed.

## 1588 release-stage-npm-win32 — VERIFIED
- `scripts/package/stage.cjs:28-40` exports `npmInvocation(env, platform)` with the three required branches: `npm_execpath` ending in .js/.cjs, win32 `npm-cli.js` next to `process.execPath`, and POSIX `{command:'npm', args:[]}`.
- `stage.cjs:~66-71` calls `execFileSync(npm.command, [...npm.args, ...installArgs])`. `grep -n shell scripts/package/stage.cjs` matches only a comment about shells, so there is no `shell:true`.
- `stage.test.cjs` gains three cases, one per branch, and they pass.
- Gate, in order: vitest passed; `npm run build` exited 0; `node scripts/package/stage.cjs` exited 0 and printed `staged …/release/stage`.
- Gate note: the worktree had no `node_modules`. I symlinked the main checkout's `node_modules` temporarily to run the gate and removed it afterwards. It was never committed.

## Combined diff review
`git diff` shows only the four PRD-scoped files. I self-reviewed because `/code-review` and `/security-review` were not run: I checked correctness, secrets handling, input handling, path traversal and duplication.

## Findings
### Critical
- None.
### Important
- None.
### Minor
- `release.yml:~57,~67`: secrets are written to `$GITHUB_ENV` as `NAME=value`. This is fine for single-line values such as a base64 `CSC_LINK`. A multi-line value or one containing a newline would corrupt or inject env entries. The `.p8` key is correctly written to a file instead.
- `stage.cjs:~35`: the win32 fallback assumes `<node dir>/node_modules/npm/bin/npm-cli.js`. This holds for the standard Windows Node install and setup-node. It is unverified on a real runner; `npm_execpath` normally takes the first branch under `npm run`.
- The checked-in `<path>` file in the worktree is the known sqlite MCP placeholder and is unrelated.

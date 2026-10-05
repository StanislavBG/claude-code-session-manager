# Validation: Windows support plan

Base: `ada0c082f1608e65d3cf2a354334cb1587f664c0` (from the PRD's implementation notes). HEAD `bc45b762`.
Commits per PRD were located with `git log <base>..HEAD` on each PRD's files; every PRD has landed commits.

**No real Windows run was observed.** This validation ran on Linux. Windows runtime behaviour is proven only by the unit tests' injected-platform cases. The CI `windows` job and the release workflow's Windows leg have not been seen to run; the first push after this lands is the real proof.

Gates re-run in the foreground (a temporary `node_modules` symlink to the main checkout was used, since the worktree has none, and removed afterwards):
- `npx vitest run` over all 16 gate test files of the 11 PRDs: **16 files / 193 tests passed**.
- `npm run typecheck`: exit 0.
- `/code-review` and `/security-review` were not run as separate passes. I self-reviewed the Windows-relevant diff for correctness, unsafe input handling, secrets and path traversal.

## 1562 win-claude-bin-and-path-dirs: VERIFIED
- `claudeBin.cjs:37-43` win32 candidates in order USERPROFILE `.local\bin\claude.exe`, APPDATA `npm\claude.cmd`, LOCALAPPDATA `Programs\claude\claude.exe`, using `path.win32.join` and `F_OK`. `claudeBin.cjs:59-60` falls back to `'claude'`. POSIX candidates are at `:47-54` with `X_OK`.
- `cleanEnv.cjs:16-26` win32 `userBinDirs` lists USERPROFILE `.local\bin`, APPDATA `npm`, ProgramFiles `Git\cmd` and `nodejs`, skipping unset vars. POSIX list is at `:30+`.
- `cleanEnv.cjs:50-58` `pathWithUserBins` uses `;` on win32, `:` elsewhere, and reads `Path` case-insensitively.
- Injectable platform/env on both; `claudeBin-win32.test.cjs` passes.

## 1563 win-pty-default-shell: VERIFIED
- `defaultShell.cjs:15-34`: win32 returns pwsh from PATH or `%ProgramFiles%\PowerShell\7`, else `System32\WindowsPowerShell\v1.0\powershell.exe`, args `['-NoLogo']`. POSIX returns `{env.SHELL || '/bin/bash', ['-il']}`.
- `pty.cjs:233` adopts it. `pty.cjs:61-73` win32 remediation says to reinstall via the installer or npm and never mentions xcode-select. The xcode text at `:86` is POSIX-only.
- `defaultShell.test.cjs` covers win32 with and without pwsh, darwin and linux; it passes.

## 1564 win-kill-tree-helper: VERIFIED
- `killTree.cjs:38-64`: POSIX `kill(-pid)` with ESRCH/EPERM fallback to `kill(pid)`, never throws. win32 `execFile('taskkill', ['/PID', pid, '/T', '/F'], {windowsHide:true})` with no shell. `:73-76` `detachedSpawnOpts` returns `{detached:true}` on POSIX and adds `windowsHide:true` on win32.
- Documented choice: win32 returns true synchronously once taskkill is launched, and failures go to `opts.log`.
- `killTree.test.cjs` passes.

## 1565 win-path-semantics: VERIFIED
- `insideHome.cjs:44-56`: win32 comparison is lower-cased and `path.win32`-normalized, with a separator boundary, so `C:\Users\Mean` is not inside `C:\Users\Me`. UNC and `\\?\` paths are rejected via `/^[\\/]{2}/`. POSIX is unchanged at `:55`.
- `historyAggregator.cjs:95-97`: `decodeCwd(encoded, platform)` has a win32 branch.
- `agentPersonaSchema.cjs:40-45`: `isAbsoluteForPlatform` uses `path.win32` or `path.posix`.
- `winPaths.test.cjs` and `agentPersonaSchema.test.cjs` pass.

## 1572 win-kill-tree-wire-scheduler: VERIFIED
- `rg "process\.kill\(-" src/main/scheduler.cjs` returns nothing. `scheduler.cjs:85` requires killTree; kills go through `killTree` at `:2830`, `:2833` and `:9792`. The `claude -p` spawn spreads `...detachedSpawnOpts()` at `:6354`.
- `killOrphanClaudePid` (`:2813-2820`) returns `'unknown'` on win32 before any `/proc` or `ps` access.
- `scheduler-killtree-adoption.test.cjs` passes.

## 1573 win-kill-tree-wire-runners: VERIFIED
- `rg "process\.kill\(-"` over chatRunner, childWithLog and timeoutShimScript returns nothing.
- `chatRunner.cjs:55,634,699` use `killTree` and `detachedSpawnOpts()`. `childWithLog.cjs:55,192,228,318` use `killTree`.
- `childWithLog.cjs:155` (`enumerateProcessGroupSurvivors`) returns `[]` without spawning `ps` on non-Linux; `:188` skips the group sweep on win32.
- `timeoutShimScript.cjs:225-231` inlines taskkill with a comment explaining it cannot require `killTree.cjs`.
- childWithLog, timeoutShim and chatRunner tests pass.

## 1576 win-cmd-shim-spawn: VERIFIED
- `winSpawn.cjs:51-65`: non-win32 passthrough; win32 PATHEXT lookup; `.cmd`/`.bat` become `%ComSpec% /d /s /c "<quoted>"` with `windowsVerbatimArguments:true`; `.exe` returns the full path. `quoteArg` (`:44-48`) quotes, then `^`-escapes every metacharacter including `& | < > ^ % "`. No `shell:true`.
- `definitionOfDone.cjs:19,776` routes the gate step through `resolveSpawn`.
- `winSpawn.test.cjs` covers passthrough, `.cmd` wrapping, `.exe`, PATHEXT order and the injection cases; it passes.
- See Findings: the helper is adopted only in `definitionOfDone.cjs`.

## 1577 win-proc-identity-failsafe: VERIFIED
- `procIdentity.cjs:100-142`: win32 runs `powershell.exe -NoProfile -Command Get-Process -Id <pid> | Select-Object StartTime,ProcessName | ConvertTo-Json` via `execFile` with `windowsHide` and a 5000 ms timeout. Any failure returns the all-null `complete:false` result. `pid` is validated as an integer first, so the interpolation is safe.
- `reaperHelpers.cjs:33-37` `claudePidAlive` returns true on win32 (do not reap); `:79` `findLiveProcessForJob` returns null on win32 with no `/proc` reads.
- `loadGate.cjs:128-141` on win32 reports `gated:false` with reason `loadavg-unavailable-win32`.
- procIdentity and reaperHelpers tests pass, with the win32 cases included.

## 1578 win-open-in-terminal: VERIFIED
- `openExternalApp.cjs`: win32 `openInTerminal` uses `wt.exe -d <cwd>` when `find('wt.exe')` succeeds, else `cmd.exe /d /c start "" powershell.exe -NoExit -Command Set-Location -LiteralPath '<cwd with '' doubled>'` with `windowsHide`. `openInFinder` on win32 spawns `explorer.exe <cwd>`. All spawns use argv arrays; no `shell:true`.
- `openExternalApp-win32.test.cjs` and `openExternalApp-spawn-error.test.cjs` pass.
- See Findings: the `cmd.exe /c start` route re-parses `cwd`.

## 1579 win-ci-job: VERIFIED
- `ci.yml` job `windows` on `windows-latest` with node 22: `npm ci`, typecheck, build, then vitest over exactly the 8 listed files, `node scripts/package/stage.cjs`, `electron-builder --win dir --publish never`, `npx playwright install chromium`, then `npm run smoke:packaged` with `SM_PACKAGED_BIN: release/out/win-unpacked/Session Manager.exe`. Run steps use `shell: bash`.
- `git diff ada0c082..HEAD -- .github/workflows/ci.yml` is +27 lines of additions only, so the existing jobs are unchanged.
- `ci-windows-job.test.cjs` passes.
- This job is unobserved: it was not run on a Windows runner.

## 1580 win-enable-installer: VERIFIED
- `package.json` `os` now includes `win32`. `bin/cli.cjs` no longer has the win32 exit (5 lines removed).
- `release.yml` matrix has `windows-latest` / `dist:win`. The Windows packaged smoke runs against `release/out/win-unpacked/Session Manager.exe` before the publish step. A "Configure Windows signing" step builds unsigned (blanks the mac `CSC_*` pair and sets `CSC_IDENTITY_AUTO_DISCOVERY=false`) when `WIN_CSC_LINK` is empty; `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are passed in the env otherwise. The publish step runs `npm run dist:win -- --publish always …`.
- `release-workflow.test.cjs` passes.
- This workflow is unobserved: it was not run on a Windows runner.

## Findings

### Critical
- none.

### Important
1. **`claude.cmd` is probed but never spawned through `winSpawn`.** `claudeBin.cjs:41` resolves the npm shim `%APPDATA%\npm\claude.cmd`, but the spawn sites use `claudeSpawnTarget()` directly: `scheduler.cjs:6354` area, `chatRunner.cjs:694`, and `claudeBin.cjs:137` (`probeClaudeVersion`). `resolveSpawn` is adopted only in `definitionOfDone.cjs:776`. Modern Node and Electron refuse to spawn `.cmd` or `.bat` without a shell (EINVAL, the CVE-2024-27980 hardening). A Windows user whose only `claude` is the npm install would fail to launch jobs and chat, and the version probe would silently return null. The native `claude.exe` path is unaffected. Open Windows gap; needs a follow-up PRD to wrap those three sites with `resolveSpawn`.

### Minor
1. `openExternalApp.cjs` win32 fallback: `cwd` is placed into `cmd.exe /d /c start "" powershell.exe … Set-Location -LiteralPath '<cwd>'`. Node quotes args for CreateProcess, but `cmd.exe` re-parses the line, so a directory name containing `&`, `^` or `%` (legal on Windows) can truncate or alter the command. The cwd is a user's own project path, not attacker input, but it should reuse `winSpawn`'s `quoteArg` or pass the path via an env var. `runInTerminal` has the same shape and relies on `command` being main-side only (documented).
2. `winSpawn.cjs:44-48` `^`-escapes `%`. In `cmd /c` command-line context `^%` does not reliably block `%VAR%` expansion, so an argument containing a defined `%VAR%` may expand. Low risk, since the arguments come from PRD gate commands, but the "cannot inject a second command" guarantee is stronger than the "literal argument" one.
3. `childWithLog.cjs:155` changed the `ps -eo … etimes` probe from "not win32" to "linux only", so on macOS it now also returns `[]`. macOS `ps` has no `etimes`, so this is probably correct, but it is a behaviour change outside the PRD.
4. `reaperHelpers.cjs:36` `claudePidAlive` returns true for any live pid on win32. A recycled pid would never be reaped (fail-safe by design, but a stuck job is possible). `procIdentity` win32 compares ProcessName rather than a command line, so identity is weaker than on Linux.
5. `release.yml`: the Windows smoke builds and tests `--x64` only, while the published installer set includes arm64 (comment at top of the file); arm64 is not smoke-tested.
6. Untracked stray file `<path>` in the worktree is the known sqlite MCP placeholder artefact, unrelated to this plan.

## Residual POSIX assumptions

From `rg -n "process.kill\(-|/bin/sh|/proc/|'ps'" src/main --glob '!**/__tests__/**'`. Comment-only hits are marked as such.

| Location | Assumption | Status |
| --- | --- | --- |
| `supervisor.cjs:47,92,96` | `/proc/<pid>/stat` and `cmdline` | gated-by-platform: `supervisor.cjs:456` makes the whole supervisor a no-op when not Linux |
| `index.cjs:152` | `/bin/sh` holder for `systemd-inhibit` | gated-by-platform: the inhibit block returns early unless Linux (`index.cjs` ~`:129`) |
| `cleanEnv.cjs:63` | `/proc/<pid>/environ` | comment only (documents `SM_PROC_ROLE` read by `scripts/sm-ps.cjs`); no code path |
| `smProcNames.cjs:48` | `aliasBinFor('/bin/sh', …)` | gated-by-platform: only called from the Linux-gated inhibit block; fails open to the literal `/bin/sh` |
| `reaperHelpers.cjs:19,55-63` | `/proc` | comment/doc text |
| `reaperHelpers.cjs:39,95,109` | `/proc` cmdline and cwd reads | gated-by-platform: `claudePidAlive` and `findLiveProcessForJob` return early on win32 (`:36`, `:79`) |
| `childWithLog.cjs:159` | `ps -eo pid,pgrp,pcpu,etimes,comm` | gated-by-platform: returns `[]` unless Linux (`:155`) |
| `scheduler.cjs:1083,1090` | `/proc/meminfo` | gated-by-platform: `getAvailableMemMb` returns `Infinity` unless Linux |
| `scheduler.cjs:1134` | `/proc/<pid>/oom_score_adj` | gated-by-platform: `biasJobOomScore` returns unless Linux |
| `scheduler.cjs:2783` | `/proc` and `ps -p` | comment text |
| `scheduler.cjs:2822` | `/proc/<pid>/cmdline`, plus `ps -p` fallback at `:2825` | gated-by-platform: `killOrphanClaudePid` returns `'unknown'` on win32 first (`:2813-2820`) |
| `gitWorktree.cjs:672,696` | `/proc/*/cwd` walk | gated-by-platform: `listCwdHolders` returns an empty set unless Linux. Consequence: no live-holder protection on win32 or darwin, so worktree sweeps there rely on the runtime pid check |
| `procName.cjs:9` | `/proc/pid/cmdline` | comment only |
| `loadGate.cjs:88` | `ps -eo pid,pcpu,comm` | gated-by-platform: only linux and darwin args are set; any other platform returns `[]` |
| `killTree.cjs:8` | `process.kill(-pid)` | comment only; the code is win32-branched |
| `timeoutShim.cjs:47` | `#!/bin/sh` launcher body | gated-by-platform: the installer returns `{ok:false, skipped:true}` on win32 (`:78`). Open gap: `timeout` shims are not provided on Windows |
| `procIdentity.cjs:5,7,88` | `/proc` and `ps -p … lstart` | gated-by-platform: `identity()` branches to PowerShell on win32 before `hasProc()`/`ps` (`:139`) |

Open Windows gaps from this list: (a) no timeout shim on win32 (tool-timeout wrapping for spawned jobs is skipped); (b) `listCwdHolders` has no win32 implementation. Neither is a crash; both degrade to fail-safe behaviour. The one open functional gap is Important finding 1 above (`.cmd` spawn of the `claude` binary), which this grep cannot see.

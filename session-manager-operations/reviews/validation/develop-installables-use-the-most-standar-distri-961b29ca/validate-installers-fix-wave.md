# Validation: installers fix wave (PRDs 1584, 1585)

Base: 13d0cde6c719549e850585a834783382050c8bd7. Commits: 806b2496 (1584), 458ad089 (1585).
Gate note: the worktree has no `node_modules`; gates were re-run from a `git archive HEAD` copy in /tmp with the main checkout's `node_modules` linked. Same tree contents.
Reviews: `/code-review` and `/security-review` were not run as separate tools; I self-reviewed the diff.

## 1584 win-claude-cmd-spawn — VERIFIED
- AC1: `src/main/lib/claudeBin.cjs:89-98` wraps through `resolveSpawn` only when platform is win32 and the base command ends in `.cmd`/`.bat`. Otherwise it returns `base` unchanged, so POSIX output is the same object as before (test `claudeCmdSpawn.test.cjs` "POSIX" asserts `toEqual({command})`).
- AC2: job spawn `scheduler.cjs:6333,6345,6350` (args from `jobSpawn.args || jobArgs`, passes `windowsVerbatimArguments`); chat `chatRunner.cjs:693-697`; version probe `claudeBin.cjs:149-150`. All three use the spec.
- AC3: no `shell: true` added. The only grep hit in chatRunner is an existing comment at line 599 saying there is none.
- AC4: `claudeCmdSpawn.test.cjs` has 4 tests: win32 `.cmd` -> `/d /s /c`, `SM_CLAUDE_BIN` `.cmd`, win32 `.exe` passthrough, POSIX passthrough.
- AC5: gate output: `Test Files 3 passed (3), Tests 21 passed (21)`; `npm run typecheck` exit 0.

## 1585 landing-copy-download-buttons — VERIFIED
- AC1: `copy.json` diff removes `command`, `commandPrompt`, `copyLabel`, `copiedLabel`, `copyFailedLabel`, the copy aria keys (`commandBox`, `copiedStatus`, `copyFailedStatus`) and `meta.installCommand`.
- AC2: `platforms` is "MAC · WINDOWS"; `aria.platforms` is "Runs on macOS and Windows".
- AC3: `priceTag.downloads` has mac, macIntel, windows and allReleases with the exact labels and hrefs.
- AC4: `note` and `unsignedNote` strings match the PRD character for character.
- AC5: `DESIGN_SPEC.md:786-795` has the dated 2026-10-05 section giving the what and the why (installers bundle Node/Electron; the Setup checklist installs git and Claude Code).
- Gate: the JSON.parse command exited 0.

## Findings

### Critical
- none

### Important
- `claudeSpawnTarget` is called with no `args` at 10 other sites. `win32` plus a `.cmd` shim now returns `{command: cmd.exe, args: ['/d','/s','/c', ...]}`. These callers ignore `target.args`, so they would spawn `cmd.exe` with their own claude argv instead of the wrapped command. Before this change they failed with EINVAL. The sites are `scheduler.cjs:6921`, `pluginInstall.cjs:94`, `docEdit.cjs:106`, `supervisor.cjs:213`, `mcpStatus.cjs:60`, `seedSchedulerMcp.cjs:118,143`, `credentials.cjs:221`, `classifyPromptTicket.cjs:81`, `runClaudeP.cjs:38` and `claudeCliCaps.cjs:75`. This is outside the three sites in the PRD, so the AC are met. A Windows npm-only user still cannot use these features, and the failure is now a confusing one. A follow-up should pass args at each site, or add a helper that spawns from the spec.
- The win32 behaviour is only tested through injected platform/env/exists. Nothing ran on real Windows.

### Minor
- `claudeBin.cjs:91-96`: `claudeSpawnTarget` now has a five-positional-argument signature, and `winOpts` exists only for tests.

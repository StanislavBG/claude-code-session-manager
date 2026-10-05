# Validation: installers (mac + linux) plan

Base: `ada0c082f1608e65d3cf2a354334cb1587f664c0` (from PRD notes). `git diff base..HEAD --stat`: 101 files, +6476/-1447 (includes unrelated win-support and chat-URL commits interleaved in the range).
Method: PRD files read from `prds-archived/`; every gate re-run in the foreground from this worktree (fresh `npm ci`; the shared checkout's `node_modules` lacked electron-builder).

## Gate results (all exit 0)
- vitest, 15 files / 161 tests, passing: appRuntime, loginShellPath, prereqs, scripts/package (render-icon, stage, release-workflow), loginShellPathBoot, seedSchedulerMcp, delegationReadiness, health-delegation-chain, packagedRelaunch, machineProfile, updateCheck, runInTerminal, PrereqChecklist.
- `npm run typecheck`, `lint:main-ts-check`, `lint:selectors`, `lint:hooks`, `lint:docs` — OK. `node scripts/package/render-icon.cjs` — exit 0.
- `npm run dist:linux-dir` — exit 0; `release/out/linux-unpacked/session-manager` and `resources/app/src/main/index.cjs` present; `release/stage/node_modules/node-pty/prebuilds` has darwin/linux/win32 x64+arm64.
- `SM_PACKAGED_BIN=release/out/linux-unpacked/session-manager xvfb-run -a npx playwright test tests/smoke/packaged-boot.spec.ts` — 1 passed (4.0s).
- Integration check: with `ELECTRON_RUN_AS_NODE=1 SM_FORCE_PACKAGED=1` run through the unpacked packaged binary, `nodeSpawnSpec('/x/s.cjs')` → `{"command":"<unpacked>/session-manager","args":["/x/s.cjs"],"env":{"ELECTRON_RUN_AS_NODE":"1"}}`; `nodeShellCommand` → `ELECTRON_RUN_AS_NODE=1 "<execPath>" "/x/s.cjs"`. execPath form confirmed.

## Per-PRD
- **1548 app-runtime-node-command-helper — VERIFIED.** `src/main/lib/appRuntime.cjs:15,31,52,57` (isPackagedApp honours opts + `SM_FORCE_PACKAGED`; both builders; export); output above; test file passes.
- **1551 login-shell-path-helper — VERIFIED.** `loginShellPath.cjs` exports read/apply; test (stub shell, timeout, exit 1, win32) passes.
- **1552 prereqs-detector-helper — VERIFIED.** `prereqs.cjs` checkPrereqs with injected execFile; prereqs test passes (all-ok, each missing, timeout, win32 set).
- **1555 installer-app-icon — VERIFIED.** render-icon.cjs ran exit 0; metadata test passes (1024x1024 png).
- **1557 package-stage-script — VERIFIED.** `release/stage` produced by `dist:stage` with node-pty prebuilds; stage test passes; `release/` ignored (`git status` clean of it).
- **1560 login-shell-path-wire-boot — VERIFIED.** `src/main/index.cjs:1217-1225` guarded by win32/`SM_SKIP_LOGIN_SHELL_PATH`, try/catch + log, runs before `resolveClaudeBin`/`bootClaudeBin` assignment (:1231); boot test passes.
- **1566 app-runtime-wire-mcp-hooks — VERIFIED.** `seedSchedulerMcp.cjs:107-112` builds argv from nodeSpawnSpec (`-e ELECTRON_RUN_AS_NODE=1 -- execPath script` when packaged); `delegationReadiness.cjs:55,487,560` use nodeShellCommand lazily; checkGuard matches by guard name/shim path (`:456,574`), so legacy `node <shim>` hooks still recognised; live MCP probe spawns the registered command+args+env generically (`:174-178`), so both forms pass. Three test files pass.
- **1567 electron-builder-config — VERIFIED.** `electron-builder.yml` matches every field in the AC (electronVersion 42.11.10 = package.json dep, asar false, npmRebuild false, mac dmg+zip arm64/x64 hardened, win nsis, linux AppImage, github publish); entitlements plist has the 3 keys; scripts in package.json:41-44; dist:linux-dir succeeded.
- **1568 packaged-relaunch-and-channel — VERIFIED.** `index.cjs:380-385` relaunch+exit, no npx; `watchdogHelpers.cjs:241` packaged branch; `machineProfile.cjs:49` 'installer' first; packagedRelaunch + machineProfile tests pass.
- **1569 update-check-github-releases — VERIFIED.** `updateCheck.cjs` packaged path fetches GitHub releases/latest with User-Agent, separate cache file, failure shape preserved, `channel` added to npm path; `AlmanacFooter.tsx:167-181` "Download vX" for installer; `useUpdateStatus.ts:7-8` types; tests + lint pass.
- **1570 prereqs-ipc-wire — VERIFIED.** `index.cjs:730-738` handlers; run-fix takes only an id and re-probes (no renderer command string); `runInTerminal` at `openExternalApp.cjs:171`; preload `index.cjs:23-24` and `api.d.ts:1564-1566`; runInTerminal test passes.
- **1571 packaged-boot-smoke-spec — VERIFIED.** Spec ran green against the real unpacked build (above); `smoke:packaged` script exists; `executableName: session-manager` set.
- **1574 prereqs-setup-checklist-ui — VERIFIED.** `PrereqChecklist.tsx` mounted at `App.tsx:663`; claudeBinStatus toast gone from App.tsx (grep empty); component tests, selectors and hooks lint pass.
- **1575 release-workflow — VERIFIED.** `release.yml`: `v*` trigger, no pull_request, per-ref concurrency, mac+ubuntu matrix, node 22, unsigned fallback (`CSC_IDENTITY_AUTO_DISCOVERY=false`), notarize only with Apple secrets, packaged smoke on both before `--publish always -c.publish.releaseType=release`; workflow test passes.
- **1581 installers-docs — VERIFIED.** README.md:34-40, build-target.md "Installer artifacts" (:135), 3-publish SKILL.md `gh release view` loop (20 x 30s); lint:docs OK.

## Findings
### Critical
- none
### Important
- none
### Minor
- `README.md:37` and `build-target.md:141` advertise a Windows `.exe`, but `.github/workflows/release.yml` builds only mac + linux (header says Windows arrives via win-enable-installer, PRD 1580, still queued). Until it lands, the `latest` release has no `.exe` and the README link is dead for Windows users.
- `release.yml` builds the app twice per runner (unpacked for smoke, then full dist). It costs CI minutes but keeps the smoke ahead of publish; the AC allows it.
- Worktree `node_modules` was absent and the main checkout's install predates electron-builder; the gates only run after `npm ci`. Environmental, not a defect in the plan.
- Self-review (no security findings): run-fix is id-only with main-side command; `runInTerminal` uses argv arrays (no `shell:true`) with AppleScript quoting; `nodeShellCommand` rejects embedded double quotes; the GitHub request sends only a static User-Agent; no secrets in the workflow (all via `secrets.*`).

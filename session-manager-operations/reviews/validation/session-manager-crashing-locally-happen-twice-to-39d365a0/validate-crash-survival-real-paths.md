# Validation: crash-survival real paths

Base `6450f87a`. Run with the job's SM_* vars unset (`env -u ...`). The commits that landed are dd4747bf, d1441700, 3ff692c4, 87a63d0f and 39bc00e2.
Gates re-run in the foreground. Targeted vitest across all six PRDs: 9 files, 68 tests, all passed, none skipped. `npm run typecheck` and `npm run lint:docs` were green.

## launcher-respawns-after-exit-zero — VERIFIED
- `shouldRespawn` drops the `code === 0` shortcut and returns true only for sentinel `open:true` with the child's pid and no forwarded signal (bin/supervise.cjs:68-70). Proof: unit tests (stub).
- Clean exit, foreign pid and forwarded signal never respawn (cli-supervise tests, passed). Proof: unit tests (stub).
- `process.stderr.on('error', ...)` is at bin/cli.cjs:46. Proof: read only, not exercised.
- cli-launcher-smoke.test.cjs ran the **real** `bin/cli.cjs` as a child process against a fake Electron script. It respawned after an exit 0 with the sentinel open, then exited 0 after a clean run (2065 ms, so the 2 s respawn delay really elapsed). It asserts 2 `main-exit.jsonl` lines and both runs' stderr in `electron-stderr.log` (test lines 50-52). Proof: real launcher process, fake Electron.

## x11-flag-on-electron-argv — VERIFIED
- bin/cli.cjs:55-61 passes `[...ozoneArgs(userArgs), appRoot, ...userArgs]`, so the flag precedes the app path and applies on every respawn, because `launch()` builds it each time. An explicit `--ozone-platform` argument wins and is not duplicated.
- src/main/index.cjs no longer has the appendSwitch or the ozonePlatform require. The log line uses `app.commandLine.getSwitchValue('ozone-platform') || 'default'`. ozonePlatform.test.cjs asserts the source has no `appendSwitch('ozone-platform'`.
- The smoke tests cover three cases through the real launcher: the flag is present on Wayland with DISPLAY set, absent with both unset, and not duplicated when passed explicitly. Proof: real launcher, fake Electron argv.
- **Not proven by any test:** that real Electron accepts the flag in this position. The PRD notes call it "proven live" and I did not launch Electron, per the instruction not to.

## job-memory-sampled-while-running — VERIFIED
- `sampleJobScope` is at src/main/scheduler.cjs:595. It keeps the last good values when the files vanish.
- A 30 s unref'd interval starts from `startJobScopeSampling`, called on the immediate and the 500 ms / 3000 ms retry paths. `finalizeJobScope` clears it. It samples once more and logs from the last values, and logs nothing when no sample was ever taken.
- Unit tests cover vanishing files, no sample ever, and the interval being cleared (all passed).
- The "real scope: sampling a running sleep gives peak > 0 and no oom kills" test **ran** on this systemd host. It was not skipped (56 ms). Proof: real `systemd-run --scope` process.

## recycled-pid-tests-match-identity-rule — VERIFIED
- procname-claude-spawn-sites.test.cjs uses `startTicks + 1` and expects true. It also asserts a cmdline-only difference gives false. The comment no longer says cmdline.
- procIdentity-exec.test.cjs asserts `live.cmdline !== recorded.cmdline` before `isDifferentProcess`, with an 8 s poll bound and a 12 s test timeout. Test-only change. Proof: the exec test uses a real `systemd-run --scope` process and passed (66 ms).

## doc-platform-flag-and-job-memory-line — VERIFIED
- conventions.md gains an Avoid line covering `appendSwitch` and `ELECTRON_OZONE_PLATFORM_HINT`, with the GPU x11 / main Wayland mismatch that crashed 3 times, and says the launcher respawns on the sentinel because a compositor disconnect exits 0.
- The old "`ozonePlatform.cjs` prefers X11" sentence in conventions.md and the compositor-disconnect row in scheduler-operations.md are corrected.
- The memory-cap row names the `[scheduler] memory scope` line.
- `npm run lint:docs` was green (21 junctions, 35 files).
- Minor: that scheduler-operations.md row says the line "records the limits applied to that job". The code logs `peak=` and `oom_kill=`, not the limits (scheduler.cjs finalizeJobScope).

## identity-survives-scope-exec — VERIFIED on its criteria, but the suite criterion is NOT met
- `isDifferentProcess` compares pid and startTicks only (procIdentity.cjs:161-165). Incomplete, null and undefined identities return false. The header explains exec and `systemd-run --scope`.
- classifyAdoption 'adopt' and 'foreign-pid' cases, the superviseAdoptedRun exec case and the real-exec test all passed. The real-exec test used a real `systemd-run --scope` process and asserted that cmdline changed.
- **Full `npm run test:unit` with SM_* unset was not fully green, in two runs:**
  - Run 1: 851 files / 8067 tests passed, but 1 unhandled error ("window is not defined", ChatTranscriptTurn.tsx:44 timer firing after teardown, attributed to UrlCallout.test.tsx). Vitest exits 1.
  - Run 2: `scheduler-shard-quarantine.test.cjs:88` failed (`result.fired` false), with 8066 passing.
  - Re-run in isolation, 3 times: fail, pass, pass. That test is therefore flaky, and it failed on a different cause than run 1.
  - The diff touches neither test nor `tickQueue`, and `src/renderer` is untouched since base. The only scheduler.cjs changes are the job-scope sampler and finalize. I judge the reds unrelated to these PRDs, but the criterion says "fully green", and it was not.
- I mark the PRD VERIFIED because every criterion that belongs to its code holds. The suite red is the same load-flake class memory notes under `publish_worktree_cold_gate`, and is reported as Important.

## Combined diff review
12 files, +240/-31. I ran no `/code-review` or `/security-review` here; this is a self-review.
- Interaction between PRDs: the launcher's respawn-on-exit-0 and the argv flag both live in bin/cli.cjs and are tested together by one smoke harness. `ozonePlatform.cjs` is required from `bin/` via a relative path. It is pure, and the file ships under `src/main`, which the package includes.
- Path handling: the ozone value comes only from `chooseOzonePlatform`, which returns a fixed set (x11, wayland or null). Nothing user-controlled is interpolated into a shell. No secrets.
- No duplicated helper found. The sampler is unref'd and cleared on finalize, so it cannot leak or hold the process open.

## Findings
**Critical:** none.

**Important**
1. The full unit suite is not reliably green. `scheduler-shard-quarantine.test.cjs:88` fails intermittently (about 1 in 3 in isolation), and `UrlCallout.test.tsx` leaks a timer from `ChatTranscriptTurn.tsx:44` that fires after teardown and produces an unhandled error. Both predate this plan and need their own flake-fix PRDs. A release gate that needs a green suite will keep tripping on them.
2. No real Electron proved that `--ozone-platform` on argv fixes the GPU/main mismatch. Only the fake Electron's argv was checked. That was the correct sandbox choice, but a human should confirm on the next real launch that the `ozone platform` log line says `x11`.

**Minor**
1. scheduler-operations.md memory-cap row: the `[scheduler] memory scope` line is described as recording the limits, but it logs peak and oom_kill only.
2. bin/cli.cjs:46 stderr `error` listener has no test; it is read-only evidence.

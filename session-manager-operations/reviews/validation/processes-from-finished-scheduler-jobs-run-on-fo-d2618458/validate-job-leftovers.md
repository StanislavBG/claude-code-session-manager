# Validation: job-leftovers plan (PRDs 2488-2491)

Base: 1153800c9cdd1e730772a1ca2e31e3bc6acdb86d. Commits: aa8baaf7 (scan), e2ee7566 (sweep), f301ea52 (leak report), 2b74badb (docs). PRD files found under `prds-archived/`.

## job-leftover-scan (2488) — VERIFIED
- scanJobProcesses returns {procs, parentOf}; marker-only, skips Z, fields pid/ppid/tty/slug/argv/cwd/comm/startTicks/etimes/pcpu: `jobLeftovers.cjs:45-91`.
- Non-linux / unreadable root → empty; per-pid try/catch: `:47-52, :88`.
- selectLeftovers: isClaudeArgv, runningSlugs, live statuses, 120000 ms grace: `:106-146`; no row = ended (vacuous loop); row w/o end time left alone `:143`.
- tty≠0, selfPid, ancestors, descendants dropped; empty slug not returned: `:147-148`.
- Test file `__tests__/jobLeftovers.test.cjs` — 9 pass. lib-layout entry added (`scripts/lib-layout.json:56`).
- Gate: vitest jobLeftovers (9 passed), `npm run typecheck` rc=0.

## job-leftover-sweep (2489) — VERIFIED
- stopLeftovers: SIGTERM, one unref'd 5000 ms timer, SIGKILL only when live identity `complete` and not isDifferentProcess; throws swallowed: `jobLeftovers.cjs:159-190`.
- runJobLeftoverSweep exported, 5-min time-based throttle, called in reapDeadRunningJobs before `if (dead.length === 0) return`, un-awaited: `scheduler.cjs` (diff hunks @8171, @8441, @11643).
- Scan before `await readState`; skips on non-linux, SM_E2E==='1', unreadable state, quarantinedCwdSet non-empty; one `job_leftovers_stopped` audit event (slug, pids, comms, etimes) + one console line per slug.
- Real-process test filters scan to its own unique slug (`filtered()` at `jobLeftoversStop.test.cjs:38-41`) before every selectLeftovers/stopLeftovers call (`:67-69`, `:77`) and in afterEach (`:57`); `describe.skipIf(!isLinux)`; shows stop when ended, alive when running.
- Sweep unit test covers throttle/skips/order (`scheduler-job-leftover-sweep.test.cjs`).
- Gate: 2 files / 10 tests pass; typecheck rc=0.

## job-leak-report-from-scan (2490) — VERIFIED
- childWithLog.cjs: no enumerateProcessGroupSurvivors, execFile, deps, _deps; sweepChildProcessGroup synchronous, SIGTERM then SIGKILL after POST_EXIT_GROUP_SWEEP_GRACE_MS, guards kept.
- onExit called synchronously then closeFd; info carries `pid` (null if spawn threw), no leakedDescendants.
- listJobSurvivors exported `jobLeftovers.cjs:197-202`.
- spawnJob onExit computes `leaked = jobLeftovers.listJobSurvivors(job.slug, pid)` first, before finalizeJobScope (`scheduler.cjs` ~4987-4990); meta shape unchanged.
- Tests updated (childWithLog, scheduler-job-leak-report +39 lines, procname-claude-spawn-sites asserts `exit.pid`).
- Gate: 3 files / 24 tests pass; typecheck rc=0.

## doc-job-leftovers (2491) — VERIFIED
- scheduler-operations.md:263 diagnosis row: SM_SCHEDULER_JOB_SLUG in environ + job_leftovers_stopped in audit-log, three layers named, macOS group-sweep only.
- PRD_AUTHORING.md §7 Rule/Why added (service manager, never nohup/&, leaked dev servers).
- Stamp v16 → v17 (`PRD_AUTHORING.md:1`).
- Gate: `npm run lint:docs` rc=0; 4 reading test files / 22 tests pass.

## Extra checks
1. Full suite (`env -u SM_CHAT_SESSION_ID -u SM_PROJECT_ROOT npx vitest run`): 854/855 files, 8088 pass, 1 red: `procname-claude-spawn-sites.test.cjs > chatRunner: the spawned claude has comm sm-claude-chat` (JSON.parse "Unexpected end of JSON input"). Re-run alone 3×: 13/13 pass. The test does `existsSync(capturePath)` then reads — races a non-atomic stub write under load; the plan changed only the unrelated `exit.pid` line of that file. Classified as a pre-existing flake, Minor (not a plan regression).
2. Real scope probe: systemd-run available. `setsid sleep 300 & exit 0` in `sm-validate-leak-probe.scope`: scope `active (running)` holding re-parented `sleep 300` (pid in CGroup, Tasks: 1) after the shell exited. After `systemctl --user stop --no-block`, scope `inactive` and no `sleep 300` within 3 s. Proves the stop-scope mechanism finalizeJobScope relies on. (Did not run the sweep against the real process table; no second Electron.)

## Findings
- Critical: none.
- Important: none.
- Minor: `src/main/__tests__/procname-claude-spawn-sites.test.cjs:278-279` race (existsSync before the capture file is fully written) — flaky under full-suite load; wait for parseable JSON instead.
- Minor: `scheduler.cjs` runJobLeftoverSweep sets `lastJobLeftoverSweepAt` before the quarantine/unreadable-state skip, so a skip also consumes the 5-minute window (acceptable, cheap).
- Review method: /code-review and /security-review not run as separate tools; self-reviewed — marker comes from /proc environ and is only compared to row slugs (no path/shell use), signals only to pids from a marker scan, SIGKILL guarded by identity check against pid reuse; no secrets.

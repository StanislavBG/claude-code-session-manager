---
title: Single-instance guard — secondary app instances must not take scheduler ownership
cwd: ~/Projects/session-manager
estimateMinutes: 20
sourcePromptId: single-instance-guard-secondary-app-instances-mu-b9a772d1
---

# Goal

Live incident 2026-07-31 (~13:53-13:57 PDT, first multi-PRD scheduler test): Playwright
launched second Electron instances (`epics-workspace-screenshots.mjs` pattern) while the
user's main app was running. Each second instance ran full scheduler boot reconciliation
against the SAME per-project queue state and (a) SIGTERM'd the live job
832-unique-prd-numbers as a "still-alive orphaned pid" — twice, marking it failed (runs
2026-07-31T20-52-32-418Z and 20-54-11-853Z, exit 143), and (b) overwrote
`~/.claude/session-manager/admin-api.json` with its own port/token, leaving the main app's
admin API unreachable after the second instance exited. Add a machine-wide single-instance
guard so only one instance owns scheduler mutation, boot reconciliation, and admin-api.json.

# Acceptance criteria

## Core functionality

- [ ] An instance lock (e.g. `~/.claude/session-manager/instance.lock` holding pid +
  startedAt, or Electron's `app.requestSingleInstanceLock` if it fits the headless/test
  launch paths) is acquired at startup. The FIRST instance becomes the scheduler owner.
- [ ] A secondary instance (lock held by a live pid) starts with scheduler subsystems in
  read-only/disabled mode: NO boot reconciliation (no orphan reaping/SIGTERM), NO queue
  ticking/dispatch, NO feedback sweep, and it does NOT write admin-api.json or start the
  admin server. The UI still works (it may read queue state).
- [ ] A stale lock (pid dead) is broken and ownership taken normally — the external
  watchdog's relaunch path (scripts/scheduler-watchdog.cjs) must still work.
- [ ] Owner exit releases the lock (best-effort on clean quit; stale-pid detection covers
  crashes).
- [ ] Log one clear line in the secondary instance ("scheduler ownership held by pid N —
  running scheduler-passive") so test runs are diagnosable.

## Tests

- [ ] Unit tests (mock fs/pid-alive): second instance skips reconciliation + admin server;
  stale lock is broken; owner path unchanged. `timeout 300 npx vitest run <files>` and
  `timeout 300 npm run typecheck` pass.

# Implementation notes

Read: src/main/index.cjs (startup order), src/main/scheduler.cjs (boot reconciliation —
partitionBootOrphans/applyOrphanOutcome, tickQueue, feedback sweep registration),
src/main/lib/localAdminHttp.cjs + wherever admin-api.json is written, src/main/config.cjs
(writeJson atomic pattern — reuse it for the lockfile; note validateWrite already grants
~/.claude paths). PID-alive check pattern exists in the scheduler's reaper — reuse, don't
re-implement. Keep the gate coarse: one boolean "schedulerOwner" checked at the few
registration points, not scattered per-function checks.

# Out of scope

- Multi-instance queue cooperation/leader election — passive mode is the design.
- Renderer changes, watchdog changes beyond confirming compatibility.
- Retrying/resetting the killed 832 job (handled operationally).

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

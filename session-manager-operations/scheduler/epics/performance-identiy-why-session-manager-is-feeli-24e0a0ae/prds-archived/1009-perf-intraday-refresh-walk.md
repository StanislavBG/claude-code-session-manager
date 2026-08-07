---
title: Perf P6: stop the 5-minute main-process stall from runIntradayRefresh's 30k sequential stat walk
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

index.cjs:1146 runs runIntradayRefresh every HISTORY_INTRADAY_REFRESH_MS (5 min, schedulerConfig.cjs:38). refreshIntradayToday (historyAggregator.cjs:572) walks ~/.claude/projects with a readdir per directory and then a SEQUENTIAL await fsp.stat() per jsonl file. Measured on the author's machine with a warm FS cache: 2044 dirs, 29,625 files, 29,625 sequential stats, 589 ms — to find the 72 files actually touched today. Cold-cache it is multiple seconds. That entire time is main-process event-loop occupancy, so every IPC call the renderer makes (config reads, transcript queries, terminal ops) queues behind it. This is the periodic hitch users feel. Make the walk proportional to files actually modified today.

# Acceptance criteria

- [ ] refreshIntradayToday no longer stats every jsonl file on every tick. Use the directory's own mtime (a project dir's mtime changes when a file in it is written) to skip whole directories whose contents cannot have changed today, and/or persist a cursor of last-seen state between ticks. State the chosen strategy in the result.
- [ ] The output for a given day is unchanged: a test seeds a fixture ~/.claude/projects-like tree and asserts the rollup lines produced by the new implementation are identical to those produced by the current one for the same input.
- [ ] Correctness is not traded away: a file modified today in a directory the fast path would have skipped must still be picked up. Add an explicit test for this case.
- [ ] Remaining per-file stats are issued with bounded concurrency rather than one sequential await per file.
- [ ] A benchmark run against the real ~/.claude/projects (read-only) shows the walk's wall-clock reduced by at least 5x versus the 589 ms baseline; the result reports both numbers.
- [ ] The periodic refresh no longer occupies the main-process event loop for more than ~50 ms in a single uninterrupted stretch — either because the walk is now that short, or because it was moved to a utilityProcess / worker. State which.
- [ ] Any new test that creates directories under ~/.claude/projects deletes them in afterEach. CLAUDE.md documents that leaked fixture folders previously caused phantom-project bugs; do not reintroduce that.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.
- [ ] timeout 300 npm run health exits 0 (GREEN).

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Key files: src/main/historyAggregator.cjs (refreshIntradayToday at 572; the same readdir+stat pattern also appears at 499, 659, 788 — fix refreshIntradayToday first and note in the result whether the others are on a hot path), src/main/index.cjs:1134-1147, src/main/lib/schedulerConfig.cjs:38, src/main/lib/historyRollup.cjs.

There is already an incremental parse cache in parseJSONL (historyAggregator.cjs ~300) keyed on size/inode/mtime — reuse its shape rather than inventing a second caching scheme. The problem is the unconditional stat loop that runs BEFORE that cache can help.

The rollup is appended under a shared O_EXCL lock also used by scripts/lib/watchdogHelpers.cjs's finalize pass. Do not change the locking contract; a contended lock must still just skip the tick.

If you move work to a utilityProcess, it must not hold the scheduler ownership lock or touch the admin API.

Per the author's standing rule, do not launch a second Electron instance while scheduler jobs are running — this PRD needs no GUI. Benchmark with a plain node script.

Main-process tests live in src/main/__tests__/ and run under vitest (npm run test:unit).

# Out of scope

- Changing the History dashboard UI or its aggregation semantics
- Changing HISTORY_INTRADAY_REFRESH_MS as the primary fix (that hides the cost, it does not remove it)
- Pruning ~/.claude/projects
- Log retention for scheduled-plans (separate concern)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

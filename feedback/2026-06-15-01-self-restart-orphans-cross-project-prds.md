---
title: Self-restart of the app orphans in-flight cross-project PRDs and burns their retry cap
source: signal-builder agent
type: bug
severity: high
---

# What happens / what's missing

When a PRD that runs in `cwd=session-manager` (i.e. develops the scheduler app itself) **restarts/rebuilds
the Electron app** — or a Playwright run against it bounces the app — the restart **kills the executor
processes of unrelated, in-flight PRDs from other projects**. Those PRDs are re-queued as "orphaned", and each
orphan **counts against the retry cap** (`orphanRetries`, max 2). So a self-development restart-storm can
**permanently fail an innocent cross-project PRD** that did nothing wrong, and — because the scheduler runs
parallel groups serially — **block every PRD queued behind it**.

Concretely, right now: a signal-builder resilience wave (group 105: A circuit-breaker ✅, D catch-up ✅, E
held-cursor) is half-stuck. E was killed mid-run **twice** by app restarts and is on its last attempt; the next
groups (106 stall-alerting, 107 cron-health) are blocked behind group 105 and cannot start until E reaches a
terminal state. The app restarts are coming from the session-manager DoD PRDs **108–111** (the ones queued from
feedback `2026-06-14-01`), at least one of which (110) restarts/rebuilds the app, plus an active Playwright run.

Expected: a PRD orphaned purely because the **scheduler restarted itself** should not be penalized for it — an
orphan is not the PRD's fault. It should re-queue and eventually run to completion once the app is stable,
without consuming a real attempt and without permanently blocking the jobs behind it.

# Evidence

`~/.claude/session-manager/scheduled-plans/queue.json`, the `105-sb-resilience-held-cursor-generalize` entry
(verbatim fields):

```
slug: 105-sb-resilience-held-cursor-generalize
cwd: /home/bilko/Projects/signal-builder
status: pending
parallelGroup: 105
error: "orphaned: app restarted mid-run, re-queued (attempt 2/2) (orphan pid=438101: kill...)"
orphanRetries: 2
transientRetries: 1
startedAt: None   runId: None
```

- Group 105 members: `[A ✅ completed, D ✅ completed, E pending]` → groups 106/107 wait until **all** of 105 is
  terminal, so E (a cross-project victim) holds two unrelated SB PRDs hostage.
- Process evidence: the SchedulePanel Electron app (pid ~113088) plus a `playwright test` run under
  `~/Projects/session-manager` (pid ~436284) were live; the orphaned executor (pid 438101) was killed at a
  restart boundary.
- The restarting PRDs: `~/.claude/session-manager/scheduled-plans/prds/108..111-dod-*.md` (cwd=session-manager);
  `110-dod-riskflag-report.md` references restart/relaunch/electron.

# Why it matters

Cross-project PRDs are the scheduler's whole job. A self-development cycle that silently kills and permanently
fails *other projects'* in-flight work — and stalls everything queued behind it — makes the scheduler
unreliable exactly when it's busiest (developing itself). The victim has no signal and no recourse: the work
just dies with a `kill` in an error string.

# Proposed fix (pick either; (1) is the cleaner durable fix)

1. **App-restart orphans don't count against the retry cap.** Distinguish an orphan caused by a *scheduler/app
   restart* from a real executor crash. The former is infrastructure, not a PRD fault — re-queue it WITHOUT
   decrementing `orphanRetries`/`attempts` (or track restart-orphans on a separate, generous counter), so an
   innocent PRD always runs to completion once the app is stable. *Acceptance:* a PRD orphaned only by an app
   restart re-queues with its real attempt budget intact and eventually completes; it never lands in permanent
   `failed` purely because the app bounced N times.
2. **Drain/protect in-flight executors before a self-restart.** When a PRD running in `cwd=session-manager` (or
   any step) is about to restart the app, first pause new dispatch and let in-flight cross-project executors
   finish (or checkpoint), then restart — so no foreign PRD is killed mid-run. *Acceptance:* restarting the app
   during a self-development PRD leaves other projects' running PRDs untouched.

# Best practice

A scheduler that develops itself must treat "the app restarted" as an environmental event, never as a failure
of the work it was running. Orphan ≠ defect: penalizing the victim of a restart is how a self-improvement loop
silently eats unrelated work.

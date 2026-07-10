# The Scheduler Tab — Features & Design

> A human-readable explainer for the **Scheduler** tab in Claude Code Session Manager.
> Everything below is drawn from real code — every file:line reference, constant, and
> on-disk path is quoted from the source, never invented. Verified against `main` on
> 2026-07-09.

The Scheduler is the tab that turns a folder of Markdown PRDs into a queue of
`claude -p` jobs that run themselves against your 5-hour billing window — pausing
when you hit a rate limit, resuming at the next reset, and reaping their own
stuck processes. It's the one surface for the whole "batch background agent"
workflow; it replaced three older nav destinations (Scheduler, Plans, and a
duplicate "Background Agents" tool), all of which read the same
`queue.json` + `prds/` files (`src/renderer/components/tabs/Scheduler.tsx:12–22`).

---

## Table of contents

1. [The 10-second mental model](#1-the-10-second-mental-model)
2. [What you see: the three sub-tabs](#2-what-you-see-the-three-sub-tabs)
3. [The Almanac design language](#3-the-almanac-design-language)
4. [How data reaches the screen](#4-how-data-reaches-the-screen)
5. [On disk: where everything actually lives](#5-on-disk-where-everything-actually-lives)
6. [Run modes: when does a job fire?](#6-run-modes-when-does-a-job-fire)
7. [The tick loop: from queue to running process](#7-the-tick-loop-from-queue-to-running-process)
8. [Staying alive: the four safety nets](#8-staying-alive-the-four-safety-nets)
9. [Every knob and button](#9-every-knob-and-button)
10. [The full IPC surface](#10-the-full-ipc-surface)
11. [Constants cheat-sheet](#11-constants-cheat-sheet)

---

## 1. The 10-second mental model

```
   You drop PRD files here                The scheduler runs them
   ┌──────────────────────────┐           ┌───────────────────────────┐
   │ ~/.claude/session-manager │  reconcile │  queue.json  (SoR)        │
   │  /scheduled-plans/prds/   │──────────▶│  jobs[] = pending/running │
   │    20-slug.md             │           │        /completed/failed  │
   │    21-other.md            │           └───────────┬───────────────┘
   └──────────────────────────┘                       │ tick (gated on
              ▲                                        │ 5h-window usage)
              │ author / retag                         ▼
        ┌─────┴──────┐                       ┌───────────────────────┐
        │ PRDs tab   │                       │  claude -p --model    │
        └────────────┘                       │  sonnet  … (one PGID  │
        ┌────────────┐   live snapshot       │  per job)             │
        │ Queue tab  │◀──── schedule:state ──│  → runs/<ts>/<slug>.* │
        │ History tab│      broadcast        └───────────────────────┘
        └────────────┘
```

- **`prds/` is where you author**; **`queue.json` is the system of record** the
  scheduler mutates. The tab reconciles one into the other.
- The tab is a **read-mostly mirror** — it renders a single snapshot broadcast
  from the main process and issues commands back over IPC. It never touches
  `queue.json` directly.
- The parallel-group number is the **`NN-` prefix** on each PRD filename; jobs in
  the same group can run together, later groups wait for earlier ones.

---

## 2. What you see: the three sub-tabs

The shell is `Scheduler.tsx`. It's a full-height flex column
(`Scheduler.tsx:175`) with a header block and a content region that swaps in one
of three views based on a `SubView = 'queue' | 'prds' | 'history'` selector
(`Scheduler.tsx:24`), persisted to `localStorage['sm.schedulerTab.subView']`
(`Scheduler.tsx:26`).

```
┌─────────────────────────────────────────────────────────────┐
│ WORKSPACE                                    [ LEARN panel ] │
│ Scheduler                                                    │  ← header
│ Author PRDs and run them as `claude -p` jobs against your    │  (Scheduler.tsx
│ 5-hour window. Jobs auto-pause on rate-limit…                │   :177–201)
│ ┌─ WindowStrip ─────────────────────────────────────────┐   │
│ │ ⏱ Window resets in 2h14m   ● 3 pending ● 1 running …   │   │
│ │ 47% of window used                    last batch 6m ago│   │
│ └───────────────────────────────────────────────────────┘   │
│ [ Queue ] [ PRDs ] [ History ]                               │  ← ViewTabs
├─────────────────────────────────────────────────────────────┤
│                                                             │
│          ( active sub-view renders here )                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

The **WindowStrip** (`Scheduler.tsx:66–160`) is the always-on status bar under the
title. It reads the store snapshot, ticks `now` every 30 s, and shows:

- **Window resets in `{…}`** with a sage clock icon (`Scheduler.tsx:123–124`).
- Three legend dots: `pending` (`bg-fg-faint`), `running` (`bg-accent`),
  `completed today` (`bg-sage`) (`Scheduler.tsx:132–134`).
- **Utilization** — "`{n}% of window used`"; if the last billing poll failed it
  degrades to an amber "`… last good reading {ago}`" (`Scheduler.tsx:137–151`).
- A **pause banner** whenever `snapshot.paused` is set — red for auth/network
  failures, amber for rate-limit/manual, with a **Resume** button wired to
  `window.api.schedule.resume()` (`Scheduler.tsx:96–111`).

### 2a. Queue sub-tab — `SchedulePanel.tsx`

The live cockpit. Doc-comment: *"policy controls, filter chips, and an
expandable job list wired to the live queue snapshot"* (`SchedulePanel.tsx:92–95`).

**Policy bar** (`SchedulePanel.tsx:271–339`):

| Control | Backed by | IPC on change |
|---|---|---|
| **Start jobs** dropdown (when available / only on reset / manually) | `config.firePolicy` | `schedule:set-config` (`:277`) |
| **Up to N at once** (min 1, max 20) | `config.concurrencyCap` | `schedule:set-config` (`:290–298`) |
| **Pause above N% of window** (only for `when-available`) | `config.utilizationThreshold` (default 90) | `schedule:set-config` (`:303–317`) |
| **Fire next batch now** | — | `schedule:force-tick` (`:321–329`) |
| **Refresh** (re-scan `prds/`) | — | `schedule:rescan` (`:330–337`) |

**The job list.** Each row is a 4-column grid
`grid-cols-[116px_1fr_auto_auto]` (`SchedulePanel.tsx:762`):

1. A **`SchBadge`** status pill.
2. Title cell: a `#NN` PRD-number badge + the title + an optional note line
   (first line of the error for failed jobs, or a mapped verifier verdict for
   `needs_review`) (`SchedulePanel.tsx:739–777`).
3. A **`ProjectTag`** (colored dot + last path segment of `cwd`).
4. A trailing label — elapsed time / "took X" / an ETA — plus a chevron
   (`SchedulePanel.tsx:729–786`).

Expanding a row reveals four `DetailBlock`s — **Status** (result/state/verdict/
error), **Timing** (started/finished/duration), **Location** (group · slug, cwd),
and **Actions**: "view log →" (opens `RunLogViewer` when the job has a `runId`)
and "reset to pending →" → `schedule:reset-job` (`SchedulePanel.tsx:802–862`).

**Partitioning & collapsing** (`SchedulePanel.tsx:641–673`): pending, running,
and failed jobs are always shown inline. Completed jobs appear inline only if
they're **fresh (< 24 h)** and under the **display cap of 5**
(`COMPLETED_DISPLAY_CAP = 5`, `COMPLETED_FRESH_MS = 24h`,
`SchedulePanel.tsx:14–15`); the overflow rolls into a "▸ N more completed"
toggle. ETAs are serial-within-group estimates off a rolling average job
duration that defaults to `150_000` ms (`SchedulePanel.tsx:127–138, 694–713`).

**Filter bar** (`SchedulePanel.tsx:880–910`): a text box matching title / slug /
project, plus chips — **All / Running / Pending / Completed / Needs review /
Failed** (`FilterStatus`, `SchedulePanel.tsx:24`). The status chip is persisted;
the text always resets.

**Housekeeping actions:**
- **Clear completed** — renderer-only hide (adds slugs to a `hiddenSlugs` set in
  `localStorage`); it does **not** touch `queue.json` (`SchedulePanel.tsx:181–186`).
- **Clear queue** — confirms, then `schedule:clear-queue`, which archives every
  non-running PRD to `prds-archived/<ts>/` (`SchedulePanel.tsx:187–196`).

**Two embedded health panels:**
- **Queue health linter** (`SchedulePanel.tsx:1113–1223`) auto-runs on mount and
  flags unbounded loops / missing frontmatter (see [queueOps](#9-every-knob-and-button)).
- **Supervisor panel** (`SchedulePanel.tsx:914–1030`), reachable via a "supervisor"
  footer link, shows the Opus-probe log and lets you tune its config.

### 2b. PRDs sub-tab — `SchedulerPrdsView.tsx`

The authoring surface (`src/renderer/components/tabs/plans/SchedulerPrdsView.tsx`,
1071 lines). It lists PRD files via `schedule:list-prds` (`:211`) and offers two
editors for the selected one:

- A **structured form** (default) — `StructuredPrdEditor` (`:798`) with fields for
  title / cwd / parallel group / estimate plus a Monaco markdown **body** editor
  (`:915`).
- A **raw Monaco escape hatch** — the full file as markdown, toggled per the
  comment at `:180`.

Saving calls `schedule:write-prd` (`:330`). It can also **archive** selected PRDs
(`schedule:archive-prd`, `:483`) and **retag** them — bulk-edit parallel group /
estimate, renaming the `NN-` prefix when the group changes
(`schedule:retag-prd`, `:513`). Status pills use the shared `STATUS_TONE` map.

### 2c. History sub-tab — `SchedulerHistoryView.tsx`

A filterable ledger of past runs (`SchedulerHistoryView.tsx`, 262 lines) loaded via
`schedule:get-history` (`:38`). Filters: **project dropdown** (`:94–101`),
status, and a from/to date range (`:83`). Each row shows the job's status,
project, parallel group, and timing via the shared `DetailLine` primitive
(`:218`).

---

## 3. The Almanac design language

The Scheduler's visual system is called **Almanac**, and its single source of
truth is `src/renderer/components/tabs/scheduler/sched-primitives.tsx`
(*"Shared presentational primitives for the Almanac Scheduler design"*, `:1–4`).
Everything below is exported from that one file so Queue / PRDs / History stay
visually identical.

### Status colors — `SchBadge` (`:26–57`)

| Status | Classes | Glyph |
|---|---|---|
| `running` | `bg-accent text-white` | pulsing white dot |
| `pending` | `bg-bg text-fg-dim border border-line` | `○` |
| `completed` | `bg-sage/20 text-sage` | `✓` |
| `needs_review` | `bg-butter/25 text-fg-dim` | `!` |
| `failed` | `bg-accent/15 text-accent` | `✕` |

The pill is `min-w-[104px] rounded-lg text-xs font-semibold` and prints the
status with its underscore replaced by a space (`:45–54`).

### Project dots — the hashed palette (`:9–23`)

Each project gets a **stable colored dot** by hashing the last segment of its
`cwd`. The hash is `h = ((h*31) + charCodeAt) >>> 0` (`:14–18`), indexed into a
7-color palette (`PROJ_DOTS`, `:12`):

```
#6f7d52  #b85c34  #8a7a60  #e4b85a  #5f6f86  #4f7d72  #8a5a6e
 sage    accent   fg-faint  butter  hive-    hive-    hive-
                                     slate    teal     plum
```

`ProjectTag` renders that dot inline via `style={{ backgroundColor }}` next to a
`font-mono text-xs` label (`:60–73`).

### Other primitives

- **`DetailBlock` / `DetailLine`** (`:76–94`) — the labeled key/value grid used in
  every expanded detail panel.
- **`LegendItem`** (`:97–105`) — the dot + count + label used in the WindowStrip.
- **`prdNumber` / `PrdNumberBadge`** (`:108–123`) — extract and render the `#NN`
  from a slug via `/^(\d+)-/`.
- **`STATUS_TONE`** (`:127–135`) — a richer 7-state pill map (`running`, `queued`,
  `ready`, `draft`, `completed`, `failed`, `needs_review`) consumed by the PRDs
  view.

> **Design guardrail** (from `CLAUDE.md`): Almanac primitives must **not** be mixed
> with the Hive design (Subagents tab). They use different palettes and are kept in
> separate files, imported by explicit name — never wildcard — to prevent
> cross-system pollution.

---

## 4. How data reaches the screen

The renderer follows the project's one-way flow:
**main process → IPC broadcast → zustand store → selector → component hook.**

```
 main/scheduler.cjs                     renderer
 ┌────────────────────┐   schedule:state   ┌───────────────────────┐
 │ broadcast()        │───────────────────▶│ scheduleState.ts      │
 │ (scheduler.cjs:737)│   (one channel)    │ useScheduleState()    │
 └────────────────────┘                    │  { snapshot, loaded } │
        ▲                                   └──────────┬────────────┘
        │ window.api.schedule.*  (invoke)              │ selector
        │                                              ▼
 ┌──────┴──────────────────────────┐       ┌───────────────────────┐
 │ Scheduler.tsx / SchedulePanel   │◀──────│ Queue / PRDs / History │
 └─────────────────────────────────┘       └───────────────────────┘
```

The store is deliberately tiny (`src/renderer/state/scheduleState.ts:20–25`):

```ts
interface ScheduleState {
  snapshot: ScheduleStateSnapshot | null
  loaded: boolean
}
```

`startSchedulePolling()` (`:33–73`) hydrates once via `schedule:state` (with a
5 s timeout, `SCHEDULE_IPC_TIMEOUT_MS = 5_000`, `:18`) then installs a single live
subscription on the **`schedule:state`** broadcast — replacing what used to be
five separate per-component `onState` subscriptions. On a pause-reason
transition it toasts for `auth` and `network` failures but stays silent for
`rate_limit` (that's expected, `:68`).

> ⚠️ **Naming note:** the CLAUDE.md architecture blurb mentions a
> `schedule:snapshot-changed` channel — that name does **not** exist in the code.
> The one and only broadcast channel is literally **`schedule:state`**
> (`scheduler.cjs:737`, `preload/index.cjs:200–201`).

The broadcast payload (`buildScheduleStatePayload`, `scheduler.cjs:709–730`) is:
`{ config, jobs, scheduledFor, lastRunAt, nextReset, paused, utilization,
pollHealth, memGate }`. A `ScheduleJob` carries `slug, title, cwd, parallelGroup,
estimateMinutes, status, runId, startedAt, finishedAt, exitCode, error,
verifierVerdict, dependsOn, runtime{pid,…}` (`preload/api.d.ts:309–335`).

---

## 5. On disk: where everything actually lives

Root: `~/.claude/session-manager/scheduled-plans/` (`ROOT`, `scheduler.cjs:215`).

```
scheduled-plans/
├── prds/                       ← author here (PRDS_DIR, scheduler.cjs:216)
│   └── 20-my-feature.md            NN- prefix = parallelGroup
├── prds-archived/              ← Clear-queue / archive target (:218)
│   └── 2026-07-09T…/20-my-feature.md
├── queue.json                  ← SYSTEM OF RECORD (QUEUE_PATH, :219)
├── retag-log.jsonl             ← append-only retag audit (queueOps.cjs:45)
├── PRD_AUTHORING.md            ← seeded once, never clobbered (:349–359)
└── runs/                       ← per-run outputs (RUNS_DIR, :217)
    └── 2026-07-09T…/               ts = ISO with :/. → -
        ├── <slug>.log              stdout/stderr (stream-json)
        ├── <slug>.meta.json        exit/timing/session metadata
        ├── <slug>.investigation.log  Opus fix-plan output (on failure)
        └── definition-of-done-<key>.md   drain-gate report
```

Plus sidecars directly under `~/.claude/session-manager/`:

- **`scheduler-state.json`** — persisted `lastObservedReset`, poll counters,
  backoff, pause reason (`scheduler.cjs:220, 388–399`).
- **`scheduler-heartbeat.log`** (+ `.1`) — one JSON line every 60 s with
  `{ ts, pid, counts, paused, nextReset, utilization }`; rotates at 1 MB. This is
  the file the external watchdog reads to decide if the app is alive
  (`scheduler.cjs:221, 2364–2377`).
- **`supervisor.log`** (+ `.1`) — Opus-probe audit (`supervisor.cjs:22`).
- **`logs/watchdog-YYYY-MM-DD.log`** — external watchdog daily log.

`queue.json` shape (`readQueueSync`, `scheduler.cjs:426–459`):
`{ config, jobs[], scheduledFor, lastRunAt, paused }`, where `config` is
`{...DEFAULT_CONFIG, ...saved}` and `paused` is `{ reason, since, resumeAt }`.

---

## 6. Run modes: when does a job fire?

Set by `config.firePolicy` (`scheduler.cjs:255–258`):

| Mode | Behavior |
|---|---|
| `manual` | Fires only on explicit "Run now" / "Fire next batch now". No timer. |
| `on-reset` (legacy) | Arms a single `setTimeout` for `reset + offsetMinutes` (default offset 15 min, `computeFireAt`, `:747–756`). |
| **`when-available`** (default) | The poll loop gates on billing usage. |

**`when-available`** is the interesting one (`maybeLaunchWhenAvailable`,
`scheduler.cjs:1667–1679`). Every poll cycle it fires `tickQueue()` **only when**:
you're not paused, there are pending jobs, and the cached 5-hour-window
utilization is **below `utilizationThreshold` (default 90%)**. Utilization is read
each poll from the billing API's `five_hour.utilization` field
(`scheduler.cjs:1779`). Above the threshold it just re-broadcasts and waits.

The poll cadence is **`POLL_INTERVAL_MS = 10 min`** (`schedulerConfig.cjs:7`), with
usage refreshed on a faster **15 s** beat (`USAGE_REFRESH_INTERVAL_MS`, `:11`).
On enterprise auth (Bedrock/Vertex/API-key) there's no consumer meter, so
utilization is treated as 0 and jobs fire on pending + free-memory alone
(`scheduler.cjs:1752–1773`).

---

## 7. The tick loop: from queue to running process

`tickQueue()` (`scheduler.cjs:1595–1650`) is serialized through a promise chain so
two ticks never overlap:

```
tickQueue()
  ├─ skip if state.paused or cancelToken.cancelled
  ├─ reconcile(state)                     ← prds/ ↔ queue.json
  ├─ cap = concurrencyCap (default 3)
  ├─ batch = pickNextBatch(jobs, running, cap)
  │     └─ empty? → runDefinitionOfDoneOnDrain()  (§8d)
  ├─ MEMORY GATE:
  │     availableForJobs(MemAvailable, RESERVED_HOST_MB=3000)
  │     memoryLimitedBatchSize(budget, MIN_FREE_MB_PER_JOB=2500, …)
  │     └─ allowed==0 → defer whole batch
  ├─ pickRunDir() → runs/<ts>/
  └─ spawnJob(job, runId, runDir) for each  (fire-and-forget)
```

**`pickNextBatch`** (`schedulerBatch.cjs:155–210`) enforces the cap globally, then
picks per-project: the lowest pending `parallelGroup` wins, and a **cross-group
failure gate** holds a project back if any job in an *earlier* group failed
(`needs_review` does not block). This is why a failed `20-` job stops `21-` from
starting in the same project.

**The spawn itself** (`executeJob`, `scheduler.cjs:893–1130`). The invocation is:

```
claude -p <prompt> \
  --model sonnet \                     ← pinned; never inherits CLI default
  --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  --session-id <uuid>
```

(`scheduler.cjs:1057–1064`). The prompt is the PRD body + a **FINISH_PROTOCOL**
epilogue that makes the agent run review → security-review → verify → commit and
emit a `SCHEDULER_VERDICT: PASS/FAIL` sentinel (`scheduler.cjs:112–148`).

Each job spawns **detached** (its own process group, so `process.kill(-pid)` reaps
the whole tree, `:1065–1074`), with a cleaned env that strips `CLAUDE_EFFORT=xhigh`
(which would otherwise force Opus, `:946–950`), and gets its Linux `oom_score_adj`
biased to **500** so the kernel kills a runaway job before it kills Electron
(`OOM_SCORE_ADJ_JOB`, `:249, 1125`).

> **The 3-job ceiling is load-bearing.** Five parallel `claude -p` processes
> OOM-killed Electron on 2026-06-10; each can exceed 1 GB. The default cap is 3
> (`DEFAULT_CONFIG.concurrencyCap`, `:253`) and the memory gate is a second line of
> defense that reserves 2.5 GB per slot and 3 GB of absolute host headroom.

---

## 8. Staying alive: the four safety nets

Background agents get stuck. The scheduler has four independent mechanisms to
notice and recover — three in-process, one external.

### 8a. Per-job watchdogs (in the spawn)

Three timers ride along with every job (`scheduler.cjs:1076`):

- **Result-tail** — polls the log every 5 s for the agent's `result` event; once
  seen, grants a 90 s grace, then SIGTERMs the group, then SIGKILLs after 30 s
  (`POST_RESULT_GRACE_MS`, `POST_RESULT_KILL_MS`, `:81–82`).
- **Deadman** — SIGKILL at **4 hours** wall-clock (`MAX_JOB_DURATION_MS`,
  `schedulerConfig.cjs:17`).
- **Idle-tail** — if the log file stops growing for **20 minutes**, SIGTERM then
  SIGKILL (`IDLE_OUTPUT_KILL_MS`, `:92`).

### 8b. Rate-limit auto-pause / auto-resume

`detectRateLimitInLog` scans the tail for `"rateLimitType":"five_hour"`,
`api_error_status:429`, or "You've hit your limit" (`scheduler.cjs:863–873`). On a
hit, `setPaused('rate_limit', resetIso)` freezes the queue and schedules a
**`resumeTimer` for 30 s after the next 5-hour reset** (`:784–819`). Rate-limited
jobs are reset to `pending`, not failed, so they simply re-run after the window
opens. A 5-minute manual-override cooldown prevents thrashing (`:787–790`).

### 8c. Boot reconciliation + dead-process reaper

- **On startup** (`init`, `:2237–2400`): any job still marked `running` is an
  orphan from a previous session. `killOrphanClaudePid` verifies the PID is alive
  *and* is really a `claude` process (via `/proc/<pid>/cmdline`) before killing it,
  then classifies the run: `success` → completed, `failed` → failed, otherwise
  re-queued to pending up to **5 times** (`ORPHAN_REQUEUE_CAP`, `:2295–2307`).
- **Every poll** (`reapDeadRunningJobs`, `:1690–1728`): for each running job whose
  PID is no longer a live `claude`, `classifyRunOutcome` reads the last 64 KB of
  the log for the final `result` event and marks the job accordingly — so a job
  whose process vanished without writing success is failed, not left hanging
  forever (`reaperHelpers.cjs:47–65`).

### 8d. The Opus supervisor + the definition-of-done gate

**Supervisor** (`supervisor.cjs`, Linux-only, `SM_SUPERVISOR_DISABLE=1` to kill).
Every **15 min** (`SUPERVISOR_INTERVAL_MS`), for each job idle ≥ 10 min it spawns a
tightly cost-gated Opus probe:

```
claude -p <probe> --model claude-opus-4-7 --no-session-persistence
  --output-format json --max-budget-usd 0.10           ← hard cost ceiling
  --dangerously-skip-permissions --allowedTools Bash
```

(`supervisor.cjs:210–218`). It feeds the probe a `pstree`, the descendant bash
cmdlines, and the log tail, and the agent returns
`{"verdict":"ok|stuck","action":"none|kill-bash|kill-agent","targetPid":…}`. On
**kill-bash** it SIGTERMs *only* the offending descendant bash — after verifying it's
truly a descendant of the job's root PID (a 32-hop PPID walk) and never the
supervisor's own PID (`:295–359`). This surgically unsticks poll-loop hangs
without killing the agent. Probes have a 2-minute wall-clock ceiling and fail
safe to `ok`.

**Definition-of-done gate** (`dodDrainHook.cjs` + `definitionOfDone.cjs`,
`SM_DOD_DISABLE=1` to kill). When `pickNextBatch` returns empty — the queue has
drained — the scheduler fire-and-forgets a re-verification pass
(`scheduler.cjs:1607–1613`): it re-runs each completed PRD's acceptance-criteria
command live (`reverifyBatch`), flags risky surfaces (money-path / auth /
migration via `git show --name-only`), and writes
`runs/<ts>/definition-of-done-<key>.md`. It's **idempotent**: `batchKey` is an
8-char SHA-1 over the sorted `slug@runId` set, *excluding* the gate's own
dod/meta slugs (`DOD_SLUG_RE`, `definitionOfDone.cjs:21–48`), so re-draining the
same set is a single fs-stat no-op via `reportExists`.

### 8e. The external watchdog (survives Electron being dead)

`scripts/scheduler-watchdog.cjs`, installed as a **systemd user timer**
(`OnUnitActiveSec=2min`) or a **cron `*/3 * * * *`** fallback
(`install-scheduler-watchdog.sh`). Each tick reads the heartbeat file:

- **App alive** (heartbeat < 3 min old → `DEFAULT_MAX_AGE_MS = 180_000`): exit 0
  without touching `queue.json` — never race the app's mutate lock.
- **App dead/stale**: run `reconcileQueueOffline()` (the same orphan-reaping logic,
  but from outside Electron) and `sweep()` — which scans recently active project
  cwds for open `feedback/*.md` files and emits self-contained auto-PRDs into
  `prds/` for the next app boot to pick up (`watchdogHelpers.cjs:486–525`).

A `flock -n /tmp/sm-scheduler-watchdog.lock` ensures overlapping ticks skip
(`scheduler-watchdog.sh:21–31`).

---

## 9. Every knob and button

| Where | Action | Wire channel |
|---|---|---|
| Queue · policy bar | Start-jobs mode | `schedule:set-config` |
| Queue · policy bar | Concurrency cap (1–20) | `schedule:set-config` |
| Queue · policy bar | Utilization threshold (0–100) | `schedule:set-config` |
| Queue · policy bar | **Fire next batch now** | `schedule:force-tick` |
| Queue · policy bar | **Refresh** (re-scan prds/) | `schedule:rescan` |
| Queue · header | Clear completed | *(renderer-only hide)* |
| Queue · header | Clear queue (archives PRDs) | `schedule:clear-queue` |
| Queue · row | Reset to pending | `schedule:reset-job` |
| Queue · row | View log | `schedule:read-log` |
| Queue · footer / empty | Open prds/ folder | `schedule:open-folder` |
| WindowStrip / pause | Resume | `schedule:resume` |
| PRDs | Save PRD | `schedule:write-prd` |
| PRDs | New / list | `schedule:list-prds` |
| PRDs | Archive selected | `schedule:archive-prd` |
| PRDs | Retag (group/estimate) | `schedule:retag-prd` |
| History | Load history | `schedule:get-history` |
| Queue · health | Lint queue | `schedule:lint-queue` |
| Supervisor panel | Read probe log | `supervisor:get-log` |

**The queue linter** (`queueOps.cjs:51–83`) is what catches the two real
stuck-job incidents documented in `PRD_AUTHORING.md`. It flags, per PRD:

- `unbounded-until` (`^\s*until\s+`) — **error**
- `while-true` (`^\s*while\s+(true|:)`) — **error**
- `unbounded-seq` (`for … in $(seq 1 N)` with **N ≥ 500**) — **error**
- missing `--no-verify` guard / `no-gpg-sign` — **warn**
- missing/invalid `title`, `cwd`, `estimateMinutes` frontmatter — **error/warn**

---

## 10. The full IPC surface

The renderer never uses raw `schedule:` strings — it calls the
`window.api.schedule.*` bridge, whose wire channels are declared in
`src/preload/index.cjs:184–208`:

**Command handlers** (`ipcMain.handle`, `scheduler.cjs:2008–2235`):
`schedule:state`, `:health`, `:force-tick`, `:set-config`, `:reset-job`,
`:run-now`, `:resume`, `:rescan`, `:clear-queue`, `:open-folder`, `:read-prd`,
`:read-log`, `:write-prd`, `:list-prds`, `:get-history`.

**From other modules:** `schedule:lint-queue`, `schedule:archive-prd`,
`schedule:retag-prd` (`queueOps.cjs:375–392`); `supervisor:tick-now`,
`supervisor:get-log` (`supervisor.cjs:487–495`).

**Broadcast (main → renderer):** the single channel **`schedule:state`**
(`scheduler.cjs:737`).

---

## 11. Constants cheat-sheet

| Constant | Value | Source |
|---|---|---|
| `POLL_INTERVAL_MS` | 10 min | `schedulerConfig.cjs:7` |
| `USAGE_REFRESH_INTERVAL_MS` | 15 s | `schedulerConfig.cjs:11` |
| `MAX_JOB_DURATION_MS` | 4 h | `schedulerConfig.cjs:17` |
| `SUPERVISOR_INTERVAL_MS` | 15 min | `schedulerConfig.cjs:18` |
| `SUPERVISOR_PROBE_STALE_MS` | 10 min | `schedulerConfig.cjs:19` |
| Default `concurrencyCap` | **3** (env `SM_SCHEDULER_MAX_CONCURRENCY`) | `scheduler.cjs:253` |
| Default `firePolicy` | `when-available` | `scheduler.cjs:258` |
| Default `utilizationThreshold` | 90% | `scheduler.cjs` DEFAULT_CONFIG |
| `IDLE_OUTPUT_KILL_MS` | 20 min | `scheduler.cjs:92` |
| `POST_RESULT_GRACE_MS` / `_KILL_MS` | 90 s / 30 s | `scheduler.cjs:81–82` |
| `MIN_FREE_MB_PER_JOB` | 2500 MB | `scheduler.cjs:234` |
| `RESERVED_HOST_MB` | 3000 MB | `scheduler.cjs:241` |
| `OOM_SCORE_ADJ_JOB` | 500 | `scheduler.cjs:249` |
| `ORPHAN_REQUEUE_CAP` | 5 | `reaperHelpers.cjs:71` |
| Probe cost ceiling | `--max-budget-usd 0.10` | `supervisor.cjs:216` |
| Job model | `--model sonnet` | `scheduler.cjs:1057–1064` |
| Probe model | `--model claude-opus-4-7` | `supervisor.cjs:212` |
| Watchdog cadence | systemd 2 min / cron `*/3` | `install-scheduler-watchdog.sh` |
| Watchdog staleness | 180 s (3 missed heartbeats) | `watchdogHelpers.cjs:23` |
| Kill-switches | `SM_SUPERVISOR_DISABLE`, `SM_DOD_DISABLE`, `SM_AUTOFIX_DISABLE`, `SM_WATCHDOG_DRYRUN` | various |

---

*Generated in the `/explain-to-me` style: real file:line references and real
constants only. If you change the scheduler, re-probe and update this doc so it
never drifts from the code.*

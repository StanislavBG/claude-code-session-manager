# Scheduler operations standards — monitoring & troubleshooting

Runbook for anyone (human or watchdog agent) checking "is the scheduler stuck?" Written
2026-08-02 after a live incident: PRD `926-epic-prds-tab-include-archived` sat at
`status: "running"` in `scheduler/state/queue.json` for nearly an hour after its
`claude -p` process had already exited cleanly (exit 0), its code review passed, and its
commit (`291aad6`) had already landed on `main`.

## The core diagnostic: queue.json status is not ground truth

`queue.json`'s `status` field is written by the scheduler's completion handler. The
handler can fail partway through: run artifacts (see below) get written, but the
`status: "completed"` transition doesn't. When that happens, the row is permanently
stuck at `"running"` until the app restarts (boot reconciliation only reaps orphans
whose PID is dead AND the app itself restarted — a live app with a desynced row doesn't
self-heal).

**Ground truth for "did this job actually finish?" is the run's artifact directory**,
not the queue row:

```
~/.claude/session-manager/scheduled-plans/runs/<runId>/<slug>.meta.json      # exitCode, finishedAt
~/.claude/session-manager/scheduled-plans/runs/<runId>/<slug>.verdicts.json  # review verdict
~/.claude/session-manager/scheduled-plans/runs/<runId>/<slug>.log           # full stream-json transcript
```

`runId` is the job's `runId` field in `queue.json` (also the run folder's timestamp).
If `<slug>.meta.json` exists with a non-null `exitCode`, the process is done —
regardless of what `queue.json.status` says.

### Fast triage checklist

1. `queue.json` → find jobs with `status: "running"`. Note `runtime.pid` and `runId`.
2. `ps -p <runtime.pid>` — is the process actually alive?
   - **Dead PID + desynced status** → completion handler didn't finish its write. Check
     the run's `.meta.json` for the real outcome (see above) before touching anything.
   - **Alive PID** → genuinely in-flight. Check `ps -o etime` against the PRD's
     `estimateMinutes` — significantly over estimate is worth a look at the live log
     tail, but is not automatically "stuck" (long PRDs happen).
3. Cross-check with the admin API (works even without shell access to the box):
   `scheduler_list_jobs` (MCP tool, wraps the loopback admin server) mirrors
   `queue.json` — same caveat applies, it is not more authoritative than the file.

### Why one stuck row can freeze the whole project's queue

`src/main/lib/schedulerBatch.cjs`'s `pickForProject()` enforces **one `parallelGroup` in
flight per project at a time** — by design, so multi-PRD chains execute in the intended
order. It treats any job with `status: "running"` in `queue.json` as occupying that
group, whether or not it is a real live process:

```js
for (const j of projectJobs) {
  if (j.status === 'running' && !runningSlugsInProject.has(j.slug)) {
    activeGroups.add(j.parallelGroup ?? 99);
  }
}
```

So a single desynced `"running"` row doesn't just look wrong in the UI — it **blocks
every later-numbered pending PRD in that project**, even ones with no `dependsOn`
relationship to it and even when the global concurrency cap (`3`) has free slots. This
is the mechanism behind "the scheduler looks stuck on one item and nothing else is
running" — check this class of bug first before assuming a hung process.

## What NOT to do

- **Do not call `scheduler_reset_job` on a row whose run artifacts show a clean exit.**
  Reset re-queues the PRD as `pending` and re-runs it from scratch — for an already-
  shipped, already-committed PRD this duplicates real work (cost + wall-clock) and can
  produce a conflicting second commit on top of the first. Reset is for genuinely hung
  or crashed jobs only, confirmed via the PID-liveness check above.
- **Do not hand-edit `scheduler/state/queue.json` outside the app's write path.** It's
  an OWNERS namespace (`scheduler` is the sole writer, per `opsOwnership.cjs`) —
  external edits race the live app and can corrupt the file the next time it writes.
  If a row needs correcting, that's a scheduler.cjs code fix (make the completion
  handler's two writes atomic, or add a reconciliation pass), not a manual patch.

## Where the real fix lives

The completion-handler desync is a code bug in `src/main/scheduler.cjs` (the process-exit
path that writes `meta.json`/`verdicts.json` vs. the path that flips `queue.json` status
are not atomic). Tracked as Epic `scheduler-job-status-desyncs-from-run-completion-95fcbba3`.

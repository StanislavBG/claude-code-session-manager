# Tasks — session-manager

Per-project ledger of **Tasks**. A Task is one headless `claude -p` run made for this project
(by Session Manager under the slot cap, or imported from a direct run). Machine-local runtime
state: git-ignored except this README.

**Single writer:** `src/main/lib/tasks/taskLedger.cjs` (writer id `tasks` in
`src/main/lib/opsOwnership.cjs`). Routes, IPC and history read through its `listTasks`,
`getTask` and `readTaskUsageDays`; nothing else writes here.

## Layout

```
session-manager-operations/tasks/
  <YYYY-MM-DD>.jsonl        — summary lines, one file per local date of the Task's startedAt.
                              Event-log kinds 'task.started' | 'task.status_changed', each with
                              from/to; carries promptSha256/promptBytes and
                              outputSha256/outputBytes, NEVER the prompt or output text.
  bodies/<taskId>.json      — prompt + output text (each capped at 1 MiB, with
                              promptTruncated/outputTruncated flags), stderr tail, envelope.
                              Written atomically (util/atomicFs.cjs).
  .gitignore                — `*`, written by ensureRuntimeIgnores.
```

## Status lines and legality

- `task.started` — `from: null`, `to: 'running'`, written before the claude process spawns.
- `task.status_changed` — an end (`from: 'running'`, `to`/`status` = the outcome), or a whole
  imported Task (`from: null`, carries `importId`, `source: 'direct'`).
- Legacy `start` / `end` / `imported` lines still within retention are read as those kinds.

Every edge goes through `transitionTask(from, to)` against `TASK_LEGAL_TRANSITIONS`
(`taskLedger.cjs`): `null → running | terminal`, `running → terminal`, terminal → nothing
(terminal = `ok`, `error`, `rate_limited`, `timeout`, `spawn_failed`, `caller_gone`,
`slot_timeout`, `too_many_waiting`, `interrupted`). The end's `from` is the body's `status`.
An illegal edge (e.g. a second end) throws under vitest; in prod it is refused — no line is
written, the append resolves `null` — and a `task_transition_refused` record goes to
`~/.claude/session-manager/audit-log.jsonl`.

A `task.started` with no end reads as `running` until `startedAt + timeoutSec + 120 s` passes, then
`interrupted` — a read-side `running → interrupted` edge that also goes through the table. Malformed lines are skipped and counted (`skippedLines`), never thrown.

## Weekly consolidation Task

`pipeline: memory-consolidation` (`memoryConsolidation.cjs`) runs the maintaining-md-network Weekly consolidation
pass as `md-network-curator` (Fable, max), read-only, at most weekly per project. Its Task body holds the full
record; the owner accepts or rejects each change via Review MD network, Mode 'Weekly consolidation'.

## Retention

`tasksDays` in `~/.claude/session-manager/ops-retention.json` (`opsRetentionSettings.cjs`,
default 30). `pruneOld` deletes older day files and bodies, once per local day on the first
append.

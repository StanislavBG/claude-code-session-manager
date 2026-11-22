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
                              kind 'start' | 'end' | 'imported'; carries promptSha256/promptBytes
                              and outputSha256/outputBytes, NEVER the prompt or output text.
  bodies/<taskId>.json      — prompt + output text (each capped at 1 MiB, with
                              promptTruncated/outputTruncated flags), stderr tail, envelope.
                              Written atomically (util/atomicFs.cjs).
  .gitignore                — `*`, written by ensureRuntimeIgnores.
```

A `start` with no `end` reads as `running` until `startedAt + timeoutSec + 120 s` passes, then
`interrupted`. Malformed lines are skipped and counted (`skippedLines`), never thrown.

## Retention

`tasksDays` in `~/.claude/session-manager/ops-retention.json` (`opsRetentionSettings.cjs`,
default 30). `pruneOld` deletes older day files and bodies, once per local day on the first
append.

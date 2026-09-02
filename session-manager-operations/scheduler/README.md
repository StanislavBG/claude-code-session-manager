# Scheduler — session-manager

This folder is the per-project store for the Scheduler: PRD source files, the Epic-scoped PRD
layout, and the queue/history state shards. The Scheduler tab is a *browser* over the
TAB → EPIC → PRD hierarchy (see `CLAUDE.md`'s "Domain model" section) — it does not own new state
beyond what's described here; machine-wide bookkeeping (session slot pool, run logs, pause
policy) lives outside any project, under `~/.claude/session-manager/`.

## Storage layout

```
session-manager-operations/scheduler/
  epics/<epic-id>/prds/<NN>-<slug>.md   — PRD source, scoped to the Epic that owns it (current layout)
  epics/<epic-id>/prds-archived/         — that Epic's own completed/retired PRDs
  prds/<NN>-<slug>.md                    — RETIRED flat layout (pre-Epic-scoping PRDs)
  prds-archived/                         — sibling archive for the retired flat layout
  state/queue.json                       — this project's job rows ({ jobs: [...] })
  state/history.jsonl                    — this project's run history (append-only JSON lines)
```

Every new PRD belongs to an Epic — `resolveEpicPrdWriteDir(cwd, epicId)` in
`src/main/lib/prdLocations.cjs` is the sole write destination for new PRDs
(`epics/<epic-id>/prds/`). The flat `scheduler/prds/` directory is read-only during the
transition: on scheduler boot, `runPrdMigration()` (`scheduler.cjs`) calls
`consolidateFlatPrds(cwd)` (`lib/prdMigration.cjs`) to auto-move anything still sitting flat into
`prds-archived/` so it isn't picked up as new work but stays recoverable. Never write a new PRD
into the flat directory — mint or join an Epic first (`scripts/mint-epic.cjs`, or the
`scheduler_create_prd` MCP tool), which resolves the correct `epics/<epic-id>/prds/` path for you.

### PRD frontmatter/body contract

A PRD source file's required frontmatter, section structure, and authoring rules (parallel
groups, the finish protocol, acceptance-criteria phrasing, the "no interactive AC" rule) are
governed by `PRD_AUTHORING.md` — read
[`~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md`](file:///home/bilko/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md)
before authoring a new PRD by hand. This README does not duplicate that contract.

A PRD's `agentType` frontmatter field (who executes it — a persona name, default `dev-lead`)
drives the spawn, not just the prompt: `executeJob` (`scheduler.cjs`) resolves it via
`agentModelResolve.cjs`'s `resolvePrdPersonaForSpawn` to the persona's frontmatter-stripped,
6000-char-capped body, passed to the `claude -p` child as `--append-system-prompt`, and to the
persona's own `model` field (falling back to `sonnet` when unset or `inherit`), passed as
`--model` — `--model` is never omitted. An `agentType` that no longer resolves to a persona file
(renamed/deleted) falls back to no persona + `sonnet` and logs once via `opsErrorLog`; it never
parks or fails the job. The resolved `agentType` is recorded on the job row and returned by
`scheduler_list_jobs`/`scheduler_list_prds`, so persona routing is queryable.

### `state/queue.json`

```ts
{ jobs: Job[] }
```

Only this project's job rows — `queueStore.cjs`'s `readMerged()`/`readMergedSync()` merge every
project's shard (plus the machine-runtime file) into one in-memory state for `scheduler.cjs` to
operate on; `writeSplit()` is the inverse, splitting a merged state back out by `job.cwd`. A job
row's real fields (from a live shard, see `queue.json`'s `jobs[0]`) include: `slug`, `title`,
`cwd`, `parallelGroup`, `estimateMinutes`, `sourcePromptId`, `sourceTabId`, `epicId`, `dependsOn`,
`originSessionId`, `bodyPreview`, plus a `status` that is one of `'pending' | 'running' |
'completed' | 'failed' | 'needs_review'` and (once run) `exitCode`/`error`/`runId`.

### `state/history.jsonl`

Append-only JSON-lines run history for this project, owned by `queueHistory.cjs` (path resolved
here via `projectHistoryPath(cwd)`); one line per completed run.

## Ownership

Sole writer per `src/main/lib/opsOwnership.cjs`'s `OWNERS` table: **`scheduler`**. Every write
path — `lib/queueStore.cjs`'s `writeJsonAtomic`/`writeJsonAtomicSync`, `lib/epicMint.cjs`'s PRD-dir
creation, PRD-source writes — calls `assertOpsWrite(file, 'scheduler')` before touching disk. There
is no cross-writer delegation *into* this namespace (the one declared delegation in
`opsOwnership.cjs`'s `DELEGATIONS` table runs the other direction: `scheduler` is the delegated
writer for one file in `prompt-sessions/`, not the other way around — see that folder's README).

## What lives OUTSIDE this folder (machine-wide, not per-project)

- `~/.claude/session-manager/scheduler-machine.json` — policy/pause state, `scheduledFor`,
  `lastRunAt`. Shared across every project because pause/rate-limit is a machine-wide condition,
  not a per-project one.
- `~/.claude/session-manager/scheduled-plans/runs/` — run logs (execution artifacts of this
  machine's runner) and `PRD_AUTHORING.md`.
- The session-slot pool (`lib/sessionSlots.cjs`) — the machine-wide ≤3-concurrent-`claude -p`
  cap every scheduler job and chat run shares.

## Lifecycle

1. **Authored** — a PRD `.md` file lands in `epics/<epic-id>/prds/`, auto-minting/joining an Epic
   if the dispatch path had none (`epicMint.cjs`'s `ensureEpic`).
2. **Queued** — a corresponding row appears in `state/queue.json` with `status: 'pending'`,
   `epicId` set, `sourcePromptId` tracing back to the Epic.
3. **Run** — the scheduler dispatches it as a `claude -p` job (concurrency-capped machine-wide at
   3); the row transitions through `'running'` to a terminal status.
4. **Archived** — on success (or retirement), the source `.md` moves from `.../prds/` to the
   sibling `.../prds-archived/` (same Epic, or the flat layout's own archive for pre-migration
   PRDs) so a completed slug can't be re-fired; `state/history.jsonl` gets an append-only record
   of the run.

## Retention policy for `prds-archived/`

**Keep indefinitely.** This directory (both the top-level flat-layout archive and each Epic's own
`epics/<epic-id>/prds-archived/`) is the durable record of every PRD that has already run — the
slug-can't-be-re-fired guard depends on the file staying there, and it's the only place to read a
completed PRD's original acceptance criteria without digging through `state/history.jsonl` or git
history. There is no automatic pruning by age or count: `consolidateFlatPrds` only *moves* files
into this archive (flat → `prds-archived/`), it never deletes from it, and no other code, cron, or
scheduler tick touches these files after that. Enforcement is manual — per `OWNERS`, `scheduler`
is this namespace's sole writer, so any pruning would run through that same write path, but no
such pruning call exists today. If retention here is ever revisited (e.g. because the count grows
large enough to matter), that's a deliberate decision made in an Epic the human opened,
per `ops-maintenance-protocol.md` Pattern E/F — never a file-age/size-based deletion made
unilaterally by a sweep agent or ad hoc script. Building an automatic pruning mechanism is out of
scope here and would need its own proposed Epic.

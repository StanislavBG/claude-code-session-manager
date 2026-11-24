# Artifacts — session-manager

Per-project **Artifacts store**: files an agent makes for a human to review (videos, audio,
images, docs, data). They are copied out of the job or Epic worktree into the main checkout, so
they outlive the worktree and show in File Explorer ▸ Artifacts with no merge. Machine-local
runtime state: git-ignored except this README, and never committed.

**Single writer:** `src/main/lib/epic/artifactStore.cjs` (writer id `artifacts` in
`src/main/lib/opsOwnership.cjs`). The retention sweep (`artifactRetention.cjs`) and an Epic
purge write as the same writer.

## Layout

```
session-manager-operations/artifacts/
  <epic-id>/<name>             — an Epic's artifacts.
  <epic-id>/index.json         — that Epic's ledger.
  _tasks/<task-id>/<name>      — a Task's artifacts (a Task has no Epic).
  _tasks/<task-id>/index.json  — that Task's ledger.
```

A name is never overwritten: a collision gets a `-2`, `-3`, … suffix. `index.json` is reserved.

## Ledger (`index.json`)

```
{ "version": 1, "entries": [ { name, title, kind, size, sha256, createdAt,
    producer: { epicId, prdSlug, sessionId, taskId }, pinned? } ] }
```

- `name` — the stored file name in the owner folder; `title` — the human label.
- `kind` — `video` | `audio` | `image` | `doc` | `data` | `other`, inferred from the extension
  unless given.
- `size`, `sha256` — of the stored copy; `createdAt` — ISO time it was stored.
- `producer` — who made it: the Epic, the PRD slug (job harvest), the chat session, or the Task.
- `pinned: true` — kept by the retention sweep (see below).

## How files get in

1. **`$SM_ARTIFACTS_DIR`** — a per-run staging folder outside the repo, set for an Epic's Chat
   and Terminal views, each scheduled job, and each Task run. Whatever is written there is
   ingested when the chat turn ends or the job/Task run ends.
2. **`artifact_publish`** (MCP tool) — an Epic session copies one file from anywhere into its
   Epic folder and gets the stored path back. Refused in a scheduled job with no Epic session.
3. **Job harvest** — before a job's worktree is removed, the scheduler copies its declared
   `artifactPaths` and its `$SM_ARTIFACTS_DIR` folder into `<epic-id>/` (producer `prdSlug`).
   Plan records are excluded — [plan-records](../plan-records/README.md) owns them.

## Who reads

File Explorer ▸ Artifacts (grouped by Epic) and the `artifact_list` MCP tool. Agents read via
`artifact_list`, never from disk.

## Retention

- **Epic folders:** `artifactsDays` (default 30) after the Epic is `completed` or `archived` —
  or, for an Epic that is unknown, after its newest file's mtime — the folder is deleted. A
  folder with pinned entries keeps just those files and its ledger is rewritten to them.
- **Task folders:** each unpinned entry older than `tasksDays` is deleted; an emptied folder goes.
- **Purge:** purging an Epic removes its `<epic-id>/` folder, pinned entries included.

Settings: `src/main/lib/opsRetentionSettings.cjs`.

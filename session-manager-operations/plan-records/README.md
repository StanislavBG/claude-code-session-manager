# Plan records — session-manager

Per-run **plan records**: the validator's record of a finished plan and the ship/deploy record a
job writes when it releases or deploys. Machine-local runtime state: git-ignored except this
README, and never committed.

**Single writer:** the scheduler (writer id `scheduler` in `src/main/lib/opsOwnership.cjs`).

## Layout

```
session-manager-operations/plan-records/
  <epic-id>/<slug>.md   — one record per run; <slug> is the PRD slug that wrote it.
  .gitignore            — `*`, written by ensureRuntimeIgnores.
```

## Who writes

A job writes its record inside its own worktree, at
`<job worktree>/session-manager-operations/plan-records/<epic-id>/<slug>.md`. After each run the
scheduler copies that Epic's `*.md` files into the main checkout's `plan-records/<epic-id>/`.
Nothing else writes here, and no job commits a record.

## Who reads

Validation status on Project pages, the PLAN SETTLED digest, and architects checking a plan.

## Retention

`planRecordsDays` (default 14) after the Epic is `completed`, the scheduler deletes its
`<epic-id>/` folder. A folder whose Epic is unknown ages by its newest file's mtime.

Legacy records committed before this namespace existed stay under
`reviews/validation/<epic-id>/` as history.

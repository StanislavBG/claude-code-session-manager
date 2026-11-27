# Weekly consolidation

## Contents

- [Inputs](#inputs)
- [Read-only](#read-only)
- [Orchestrator and subagents](#orchestrator-and-subagents)
- [Change kinds](#change-kinds)
- [Keep learnings few](#keep-learnings-few)
- [Housekeeping](#housekeeping)
- [The record](#the-record)
- [Apply](#apply)
- [Steering file](#steering-file)

One out-of-band pass that curates the markdown network and the project's auto memory together, fed by the week's session transcripts. It proposes; the owner accepts one change at a time.

## Inputs

- The project's auto memory folder: `~/.claude/projects/<slug>/memory`.
- Its markdown network (the census in audit.md).
- Its own session transcripts since the previous consolidation: the project root's transcript folder plus the folders of its Epic and job worktrees. Never another project's.
- The Lessons blocks headless jobs handed over in that window.
- The optional steering file (see Steering file).

Read tool calls and tool errors, not only messages. A tool call that keeps failing is a main signal.

## Read-only

The pass changes nothing live. As the scheduled Task it has only read tools. When a human presses the macro, research and report first and change no file until accepted (SKILL.md's Rule). The memory law holds: upkeep proposes, never deletes. A removal is applied only after the owner's accept.

## Orchestrator and subagents

1. One subagent per transcript, or per small batch (about 5), returns candidate patterns. Each carries the session id(s) it was seen in.
2. The orchestrator keeps only patterns seen in at least 2 sessions. A pattern seen in fewer produces no change.

## Change kinds

Each kept pattern becomes ONE change of one kind:

- **verify:** a memory or doc line no longer true is fixed or removed.
- **organize:** duplicates are merged; a lasting fact moves from memory into the doc that owns it (placement.md).
- **enrich:** a missing lesson is added.

## Keep learnings few

- At most 5 enrich adds per run.
- Merges and removals are unlimited.
- Prefer pruning.

## Housekeeping

Always proposed, outside the cap:

- Older dated usage-reviewer statuses in memory are removed, so only the newest per report remains.
- Every memory file missing `originSessionId` or `modified` in its frontmatter metadata gets them filled. Take `originSessionId` from the transcript that wrote the file when known.

No write log, no hash, no hook.

## The record

Template:

```
# Markdown network weekly consolidation <YYYY-MM-DD>

- Transcripts read: <count>, <first date> to <last date>
- Lessons blocks consumed: <job/PRD ids, or none>
- Totals: adds N, merges N, removals N

| Id | Kind | Target file | Change | Example sessions | Count |
| --- | --- | --- | --- | --- | --- |
| c1 | verify / organize / enrich | <path> | <the change> | <id>, <id> | <N, at least 2> |
```

Every row names at least 2 session ids.

## Apply

1. The owner accepts or rejects each change. Only accepted changes are applied.
2. The architect applies them in the Epic the owner opened with the macro: memory edits inline; doc changes inline when small and provable, otherwise `/develop`.
3. Commit the record as session-manager-operations/reviews/docs/<YYYY-MM-DD>-md-network-weekly.md, following the record rules in drift-check.md.

When pressed with Mode 'Weekly consolidation', first look for the newest pending weekly Task (`task_list` with pipeline memory-consolidation, then `task_get` for its output) and walk its record. If none is pending, run the pass in the Epic.

## Steering file

Optional: session-manager-operations/md-network/steering.md. A human writes it and tracks it in git; it says what the owner thinks matters and does not. Read it as a plain file. No code reads it through `opsPath()`, so it needs no `opsOwnership.cjs` entry and no ops AGENTS.md owners row (it has no owning writer; the folder is human-authored). If code ever reads it through `opsPath()`, add the entry and the row then.

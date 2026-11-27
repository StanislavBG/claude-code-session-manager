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
- **procedure:** a new skill or small tool is proposed for a multi-step procedure that was worked out by hand (the same steps rebuilt from scratch, not run from a doc) in at least 2 sessions in the window. The proposal names the skill's path, when to use it, its steps, and the files or commands it relies on; a tool instead names its path and the README line that lists it. Before you propose one, search the project's existing skills (`.claude/skills/`, `plugins/*/skills/`), tools and docs for the same procedure. If one already covers it, propose an edit to that file as **organize** instead, never a second skill. A pattern that repeats a single step, or that only produced a lesson, stays enrich.

## Keep learnings few

- At most 5 adds per run: enrich and procedure together.
- At most 1 procedure per run. If more than one qualifies, propose the one seen in the most sessions; the rest produce no change.
- A run with no procedure rebuilt by hand in 2+ sessions proposes none.
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
| c2 | procedure | <proposed skill or tool path> | <name; when to use it; steps; files or commands it relies on; README line for a tool> | <id>, <id> | <N, at least 2> |
```

Every row names at least 2 session ids. A procedure row counts as an add in Totals.

## Apply

1. The owner accepts or rejects each change. Only accepted changes are applied.
2. The architect applies them in the Epic the owner opened with the macro: memory edits inline; doc changes inline when small and provable, otherwise `/develop`. An accepted procedure row whose path is under `.claude/` (a skill) is written from the Epic chat, never by a PRD: headless job sandboxes mount `.claude/` read-only. A tool outside `.claude/` may go through `/develop`.
3. Commit the record as session-manager-operations/reviews/docs/<YYYY-MM-DD>-md-network-weekly.md, following the record rules in drift-check.md.

When pressed with Mode 'Weekly consolidation', first look for the newest pending weekly Task (`task_list` with pipeline memory-consolidation, then `task_get` for its output) and walk its record. If none is pending, run the pass in the Epic.

## Steering file

Optional: session-manager-operations/md-network/steering.md. A human writes it and tracks it in git; it says what the owner thinks matters and does not. The app reads it through `opsPath()`; it is declared `tracked` in `GIT_CLASS` with an ops AGENTS.md row. It has no owning writer (human-authored), so it gets no `OWNERS` entry.

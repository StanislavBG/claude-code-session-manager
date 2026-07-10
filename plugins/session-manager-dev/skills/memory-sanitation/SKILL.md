---
name: memory-sanitation
description: >-
  Audit every memory in the current project's auto-memory store, fold anything now
  duplicated in an always-loaded instruction file (global CLAUDE.md, project CLAUDE.md,
  or a plugin skill's SKILL.md) into that file and delete the memory, verify and delete
  memories whose tracked PRD/incident has since landed or expired, trim memories that are
  part-stale, and leave genuinely current non-duplicated memories alone. Ends with a
  structured summary (counts + per-memory outcome) suitable for display in a UI. Use
  whenever the user says "/memory-sanitation", "clean up memory", "sanitize memory",
  "audit my memories", "combine and remove memories", or asks what should move from
  memory into system instructions. Keywords: memory, sanitation, sanitize, cleanup, audit,
  dedupe, prune, CLAUDE.md, instructions, stale memory.
---

# /memory-sanitation — audit → fold/delete/trim/keep → report

**Role:** a periodic hygiene pass over `<memory-dir>/*.md` (the auto-memory store described
in the top-level system instructions — one file per memory, indexed by `MEMORY.md`). Memory
exists to recall things NOT already guaranteed to reach the assistant another way. Once a
memory's content is baked into something always-loaded (CLAUDE.md, a skill's SKILL.md) or the
event it tracked has resolved (a PRD landed, an incident closed, a pause expired), it is dead
weight: it costs retrieval relevance and maintenance, and duplicated content risks drifting out
of sync with the authoritative copy.

**Never** delete a memory just because it's old — staleness is about resolution, not age. A
memory describing a standing architecture fact that's still true and still nowhere else stays,
no matter how old.

## Procedure

1. **Locate the memory dir** — the path in the system instructions'
   `auto memory` section (`~/.claude/projects/<encoded-cwd>/memory/`). List every `*.md` file
   except `MEMORY.md` itself.

2. **Read every memory file in full**, plus `MEMORY.md`'s index, plus the project's own
   `CLAUDE.md` (and the global `~/.claude/CLAUDE.md`) and the skill files under
   `plugins/*/skills/*/SKILL.md` if the project ships a dev-skill plugin. You need all of
   these loaded to judge duplication.

3. **Classify each memory** into exactly one bucket:
   - **DELETE — baked in.** The memory's content (a process rule, a behavioral preference, a
     standing architecture fact) is now verbatim or near-verbatim present in an always-loaded
     instruction file. Confirm with a direct text comparison, not a vibe check, before deleting.
   - **DELETE — resolved/expired.** The memory tracks a PRD, incident, or temporary state
     (a dev pause, a "queued as PRD NN" note, a "bug found, not yet fixed" note) whose tracked
     event has since concluded. Verify before deleting — don't assume from the memory's own
     text that something landed:
     - PRD status: check `~/.claude/session-manager/scheduled-plans/queue.json` (or the
       project's own scheduler queue file) for the PRD slug's `status` field, or
       `prds-archived/` for a withdrawn/archived one.
     - Code claims: `grep`/`ls` the file(s) and line(s) the memory cites — confirm the
       described function/constant/behavior still exists as described (or confirm it's gone,
       which is its own signal the memory is obsolete).
     - Git history: `git log --oneline --all | grep <PRD-or-feature-slug>` when queue.json
       doesn't resolve it.
   - **FOLD then DELETE.** The memory is a durable, project-wide rule that belongs in an
     instruction file but isn't there yet (a cross-project rule → global `~/.claude/CLAUDE.md`;
     a this-project convention → project `CLAUDE.md`'s `## Conventions`/`## Avoid`; a
     process/routing rule for a specific skill → that skill's `SKILL.md`). Write it into the
     target file first, in that file's own voice and section, then delete the memory. Two
     overlapping memories covering the same territory fold into ONE rule, not two.
   - **TRIM.** The memory mixes durable facts with dated, closed narrative (a deploy log, a
     PRD-tracking blow-by-blow, "verified live" status updates). Keep only what's still true
     and not written down elsewhere; cut the rest. Re-verify any code claim you keep (grep it).
   - **KEEP.** Genuinely current, non-duplicated, still load-bearing. Leave it — don't rewrite
     for style.

4. **Fix cross-references.** Any memory you delete or fold may be `[[wikilinked]]` from a
   surviving memory. Grep `<memory-dir>/*.md` for the deleted memory's `name:` slug and update
   the reference — point it at the new location (an instruction-file section) or drop the link
   if nothing replaces it. A dangling `[[link]]` to a file that no longer exists is a bug.

5. **Rewrite `MEMORY.md`'s index** to match exactly what's on disk after steps 3–4. Re-read the
   directory listing immediately before writing — another session or a background job may have
   added a memory mid-run (this has happened in practice); never clobber a concurrent addition
   with a stale full-file overwrite. Prefer `Edit` for point changes; only rewrite the whole
   index when you've just re-confirmed the current file list.

6. **Collision safety for instruction-file edits.** Before editing `CLAUDE.md` or any
   `SKILL.md`, `git status --short` that specific file. If it's already dirty from unrelated
   concurrent work, use small targeted `Edit`s (never a full-file `Write`) so you can't discard
   someone else's in-flight change.

7. **Report a structured summary**, both as your end-of-turn text and in a form a UI can render
   directly (a JSON object is fine when invoked programmatically — see Output shape below):
   counts per bucket, and for each memory: its name, the bucket, and a one-line reason. If
   invoked from a UI trigger (see `## UI trigger` below), keep the summary tight enough to
   render in a side panel — lead with the counts, then a short list, not full memory bodies.

## Output shape (for programmatic/UI invocations)

When this skill is invoked non-interactively (e.g. from the Memory tab's Sanitize button), end
the run by printing a single fenced JSON block as the last thing in the transcript, so the
caller can parse it without scraping prose:

```json
{
  "totalBefore": 26,
  "totalAfter": 9,
  "deleted": [{ "name": "feedback_fix_dont_ask", "reason": "baked into CLAUDE.md + develop/SKILL.md" }],
  "folded": [{ "name": "feedback_nav_microservices", "into": "CLAUDE.md ## Avoid", "reason": "merged with feedback_extend_dont_add_tabs" }],
  "trimmed": [{ "name": "web_remote_v2_mobile", "reason": "PRDs landed; cut deploy-log narrative" }],
  "kept": [{ "name": "no_schedule_self_e2e", "reason": "active, tracks open PRD" }]
}
```

Still print the normal human-readable summary too — the JSON block is additive, not a
replacement.

## UI trigger

The Memory tab (`src/renderer/components/tabs/Memory.tsx`) has (or will have, per the queued
PRD) a "Sanitize memory" button that fires this skill as a headless run and renders the JSON
summary above. When authoring or reviewing that wiring, this skill is the contract: the button
sends a prompt that invokes `/memory-sanitation`, and the tab parses the trailing JSON block
from the run's final message. Don't hand-roll a second summary shape in the renderer — parse
this skill's own output shape.

## Notes

- This is a hygiene pass, not a content-authoring pass — don't use it to write NEW memories,
  only to reconcile existing ones against instruction files and resolved state.
- Don't delete a memory solely because it's short, or solely because it's old. Staleness is
  "the thing it tracked resolved" or "it's now duplicated elsewhere" — not age or length.
- Don't run this against another project's memory store without being asked — memory dirs are
  per-project (`~/.claude/projects/<encoded-cwd>/memory/`); stay scoped to the current cwd.

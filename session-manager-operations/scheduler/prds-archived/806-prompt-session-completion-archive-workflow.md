---
title: "Mark completed" workflow: kill session, persist to session-manager-operations/, browsable archive
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

Link 5/5 (final). Add an explicit, user-driven "Mark completed" action on an open `PromptSession`
(PRD 802/803/804) — completion happens only when the USER marks it, never automatically when a
PRD in its chain lands (explicit user requirement: "marked as completed BY THE USER not after
the PRDs have simply landed"). On completion: kill the underlying pty/session process
immediately so it stops consuming resources ("archive it, it should not consume resources"),
persist the full `PromptSessionEvent` chain (PRD 802) plus its transcript to
`session-manager-operations/` on disk, remove it from the active Projects list (PRD 803), and
make it browsable read-only from history WITHOUT waking/resuming the session — the user can
review the full Prompt→PRD→Response→...→Closed history at any time as main line development
continues, and can explicitly resume/reopen it later if needed. This persisted archive is also
the read surface a future "Global Tab" (folder/big-project aggregate view) will consume — this
PRD only needs to produce a well-defined, readable-on-disk format; wiring an actual Global Tab
UI is a separate future effort, not required here.

# Acceptance criteria

- [ ] A "Mark completed" action is available on an active `PromptSession` (from its list row in
  PRD 803's Projects view and/or from within PRD 804's conversation view)
- [ ] Triggering it kills the underlying pty process for that session's `claudeSessionId`
  (reuse the existing `pty:kill` IPC path in `src/main/pty.cjs`, do not add a second kill path)
  and sets `PromptSession.status = 'completed'`, `completedAt` (PRD 802)
- [ ] The full event chain (all `PromptSessionEvent`s: prompt/prd_created/response/.../closed)
  plus the session's transcript content is written to disk under
  `session-manager-operations/prompt-sessions/<promptSessionId>.json` (or `.md` + `.json`
  sidecar — pick one, be consistent) in the project's own `cwd` — reuse this repo's existing
  atomic-write helper (`config.cjs`'s `writeJson`/`writeTextAtomic` per CLAUDE.md's "Avoid"
  section: "Re-implementing the tmp+rename atomic-write pattern") rather than a raw `fs.writeFile`
- [ ] A completed `PromptSession` is removed from the active list in PRD 803's Projects view but
  remains visible/openable from a read-only "history" affordance in that same view — opening it
  reads the persisted archive file directly and must NOT spawn a new pty or chatRunner job (no
  session wake-up)
- [ ] An explicit "Resume" action (separate from the read-only open) is available on an archived
  `PromptSession` that, if used, creates a fresh follow-on session referencing the archived one
  (do not silently reuse the killed `claudeSessionId` — it's dead; mint a new one via
  `createPromptSession`, carrying forward a reference to the archived session's id for
  traceability)
- [ ] `timeout 300 npm run typecheck` passes
- [ ] Tests cover: marking completed kills the pty and persists a correctly-shaped archive file
  under `session-manager-operations/prompt-sessions/`; opening a completed session from history
  does not create a new pty/chatRunner job; resuming creates a new independent session id while
  recording the link back to the archived one

# Implementation notes

Depends on PRDs 802 (data model), 803 (Projects list), and 804 (conversation view) — read their
actual landed diffs first, especially PRD 802's exact `PromptSession`/`PromptSessionEvent` shape
and PRD 803's list-row action-slot pattern. Read `src/main/pty.cjs`'s `kill` handling and
`src/main/config.cjs`'s `writeJson`/`writeTextAtomic` atomic-write helpers before writing any
disk I/O — do not hand-roll a second atomic-write implementation (CLAUDE.md explicitly flags this
as a recurring anti-pattern to avoid). Look at how `session-manager-operations/feedback/` and
`session-manager-operations/reviews/` are structured today (`ls
~/Projects/session-manager/session-manager-operations/`) for this project's existing convention
on organizing per-item files under `session-manager-operations/<category>/` before inventing the
`prompt-sessions/` subfolder's exact shape.

This is the final link (5/5) of the 802-806 chain. Once this lands, do a full walkthrough
end-to-end (create a PromptSession → converse → mark completed → verify process killed and
archive readable) as the chain's overall completion check — note in your own PRD completion
notes whether any of PRDs 802-805's landed behavior needed adjustment to make this integration
work, since discrepancies there are exactly what the interactive `/develop` step-8
definition-of-done gate should verify next.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- Building an actual "Global Tab" (folder/big-project aggregate) UI that consumes this archive —
  only the on-disk archive format needs to exist and be readable
- Any change to chatRunner's global concurrency cap
- Automatic/implicit completion when a PRD lands — completion is user-triggered only, always

---
title: Epics redesign 9 — Chat ⇄ Terminal mode switch over the Epic's own claude session
cwd: ~/Projects/session-manager
estimateMinutes: 25
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

An Epic IS a tagged claude session: `PromptSession.claudeSessionId` is 1:1 (CLAUDE.md domain
model, updated 2026-07-31). Give `EpicDetail` a Chat ⇄ Terminal mode toggle so the user can
iterate on the SAME session in either view without losing context — Chat = the existing
headless chatRunner path (`claude -p --resume <claudeSessionId>`), Terminal = an in-pane
xterm PTY running `claude --resume <claudeSessionId>` in the Epic's cwd. User-reported gap:
today there is no way to move back-and-forth between Chat and Terminal for one Epic; Terminal
tabs mint unrelated sessionIds and navigating away orphans the Epic's context.

# Acceptance criteria

## Core functionality

- [ ] `EpicDetail` header gets a two-state mode toggle (Chat | Terminal), active Epics only.
  Terminal mode replaces the tabs+thread+composer area of the detail pane with an xterm
  terminal attached to a PTY for the Epic — the queue pane stays; no navigation away from
  the workspace; the Epic header stays visible.
- [ ] Entering Terminal mode spawns (or reattaches to) a PTY via the existing pty IPC
  (`src/main/pty.cjs`, keyed by renderer-supplied UUID) using the Epic's `claudeSessionId`
  as the key, running `claude --resume <claudeSessionId>` with cwd = the Epic's cwd. First
  entry on an Epic whose session has never run interactively still works (`--resume` of a
  chatRunner-created session resumes its JSONL). Reuse the existing xterm component/wiring
  the Terminal tab uses (`src/renderer/components/Terminal*.tsx`) — do not fork a second
  xterm integration.
- [ ] Mutual exclusion (session handoff, the invariant): the toggle to Terminal is disabled
  with an explanatory tooltip while a chatRunner run is active or queued for this Epic
  (`useChat` running/queuedPosition flags); while Terminal mode is attached, the Chat
  composer's send path for this Epic is blocked (UI-level: composer hidden by the mode
  switch; store-level: `useChat.send` for that key refuses with a toast while the PTY is
  alive). Never two concurrent attachments to one sessionId.
- [ ] Leaving Terminal mode (toggle back to Chat) gracefully ends the PTY process (existing
  pty kill/dispose IPC), then re-enables chat; the next chat send resumes the same
  `claudeSessionId`. Switching Epics or unmounting the workspace also disposes the PTY.
- [ ] Context-continuity marker: on returning to Chat after a Terminal stint, append a
  `response`-kind event to the Epic's chain (via `appendPromptSessionEvent`, honoring the
  strict `causedByEventId` tail rule in `state/promptSessions.ts`) with text like
  "Iterated in Terminal view" so the Discussion thread records the stint. Full transcript
  backfill of interactive turns into the thread is explicitly out of scope (exchanges log
  only captures chatRunner turns) — the marker keeps the audit chain honest.

## Edge cases

- [ ] Completed (archived) Epics: toggle hidden (their claudeSessionId is dead by design —
  resuming mints a new session via `resumeArchived`, which stays the existing flow).
- [ ] PTY exit while in Terminal mode (user types /exit or process dies): pane shows an
  "exited — back to Chat" state and the toggle returns to Chat cleanly; no zombie PTY.
- [ ] App-side: the PTY claude process is interactive, NOT a `claude -p` job — it must not
  acquire from the session slot pool (`lib/sessionSlots.cjs`) and must not be counted by
  chatRunner's concurrency queue. Verify by reading both before wiring.

## Tests

- [ ] vitest jsdom tests: toggle disabled while chat run active; send blocked while PTY
  attached (mock the pty IPC); marker event appended on mode exit with correct
  causedByEventId chaining; toggle hidden for completed Epics. `timeout 300 npx vitest run
  <new files>` passes; `timeout 300 npm run typecheck` and `npm run lint:selectors` pass.

# Implementation notes

Serial after 829 (needs the mounted `EpicsWorkspace` + `EpicDetail` as landed — read them
first, plus this Epic's earlier PRDs' landed state). Key files: `src/main/pty.cjs` (PTY per
renderer UUID; check how Terminal tabs spawn `claude` with `--session-id` — mode switch uses
`--resume` instead), the Terminal tab's xterm component under `src/renderer/components/`
(reuse its attach/resize/dispose lifecycle), `src/main/chatRunner.cjs` (how runs key off
sessionId — the exclusion check reads renderer-side `useChat` state, no main-process changes
expected), `src/renderer/state/promptSessions.ts` (`appendPromptSessionEvent` strict-tail
rule). Toast channel for refusals: `useToast().show(...)` per CLAUDE.md conventions. If the
existing pty spawn hardcodes preset args (e.g. `--dangerously-skip-permissions` via
DEFAULT_PRESETS), mirror what Terminal tabs do for a normal interactive session in that cwd.

# Out of scope

- Backfilling interactive-turn transcripts into the Chat thread (marker event only).
- Any change to SessionTabs, TabBar, or the dormant-tab TerminalChat path.
- Voice, attachments, or composer changes beyond the send-block guard.
- Slot-pool accounting changes.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

---
title: Epics redesign — fix code-review findings C1 + I1-I6 (session exclusion, deep links, perf)
cwd: ~/Projects/session-manager
estimateMinutes: 22
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

An interactive code review of the just-landed Epics workspace (commits 1946c5b..af38fef)
verified 7 must-fix findings. Fix all of them. Every finding below was verified against the
code with file:line refs — read each cited site first; the fix shapes are prescribed.

# Acceptance criteria

## C1 — Epic PTY survives renderer reload → double attachment (Critical)

- [ ] `src/renderer/components/epics/EpicTerminalPane.tsx:40-43` + `state/epicTerminal.ts`:
  attachment state is in-memory only while the PTY (main, `src/main/pty.cjs:97-115`)
  survives renderer reloads. Fix: on workspace mount, reconcile — query main for live PTYs
  keyed by known Epic claudeSessionIds (add a narrow IPC if none exists, e.g. `pty:list` of
  session keys, zod-validated in ipcSchemas.cjs) and either re-adopt them into
  `epicTerminal` state (mode back to 'terminal', reattach without re-typing the command)
  or kill them. Either behavior is acceptable; silently orphaning is not. A chat send must
  never proceed while a live Epic PTY holds that sessionId.

## I1-I3 — EpicTerminalPane / EpicDetail exclusion correctness (Important)

- [ ] I1 `EpicDetail.tsx:252-254,277-285`: `onModeChange('terminal')` re-reads
  `useChat.getState().chats[epicId]` inside the handler (not the render snapshot) before
  spawning; refuse with a toast if a run is active/queued.
- [ ] I2 `EpicTerminalPane.tsx:91`: use the `transcriptExists()` check exactly as
  `state/chat.ts:441` does — `--session-id <id>` for a never-run session, `--resume <id>`
  otherwise.
- [ ] I3 `EpicTerminalPane.tsx:92`: guard command injection on reattach like
  `Terminal.tsx:224` (`if (reattached) return`) so a reattached pane never types the launch
  command into a running claude.

## I4-I6 — deep links, nav, perf (Important)

- [ ] I4 `EpicsWorkspace.tsx:67-79`: don't destructively consume
  `takePendingPromptSessionId()` before hydration can satisfy it — hold the pending id and
  retry selection after `hydrate`/`hydrateArchived` resolve (or once the id appears in the
  store), so a Scheduler→Epic deep link right after boot lands on the Epic instead of
  silently no-opping.
- [ ] I5 `App.tsx:~175-181` (`handleNewSession`): make behavior match its comment — after
  `openOrStartProject` resolves (and on cancel), route through the same deselect+openPanel
  path `navigate('terminal')` uses so the user lands on the Epics view, not a tab's chat.
  If instead the comment is wrong and landing on the tab is desired, fix the comment and
  state so in the commit message.
- [ ] I6 perf: `EpicsWorkspace.tsx:30` and `EpicDetail.tsx:177` must not subscribe to the
  whole `chats` record (re-render on every streaming token of any chat) — select the narrow
  slices needed (per-epic entries / a derived stable value). `EpicQueueControls.tsx:140`:
  stop feeding `Date.now()` into the `groups` memo deps (:174-177) — compute `nowMs` once
  per relevant change (e.g. a 30s interval state), not per render. Preserve the project's
  selector-stability rule (`npm run lint:selectors` stays green).

## Tests

- [ ] Add/extend vitest coverage for: I1 (send blocked when run starts after render), I2
  (session-id vs resume choice), I4 (deep link to not-yet-hydrated Epic selects it after
  hydration). `timeout 300 npx vitest run <files>` passes; `timeout 300 npm run typecheck`,
  `npm run lint:selectors`, and `timeout 600 npm run test:unit` all pass.

# Implementation notes

Read the review targets first: src/renderer/components/epics/EpicTerminalPane.tsx,
EpicDetail.tsx, EpicsWorkspace.tsx, EpicQueueControls.tsx, EpicComposer.tsx,
src/renderer/state/epicTerminal.ts, chat.ts (isAttached guard :283, transcriptExists :441),
src/main/pty.cjs. Minor findings M1-M7 from the same review are OPTIONAL — fix any that
fall out naturally (M6 objectURL revoke is a one-liner) but do not expand scope for them.
Domain invariant (CLAUDE.md): never two attachments to one claudeSessionId.

# Out of scope

- New features, styling changes, M-findings requiring structural work (M4 archive lazy-load,
  M5 shell dedup, M3 fetch dedup).
- Any scheduler/main-process changes beyond the optional narrow pty:list IPC for C1.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

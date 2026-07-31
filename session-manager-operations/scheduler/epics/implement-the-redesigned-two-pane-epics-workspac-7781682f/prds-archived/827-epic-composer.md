---
title: Epics redesign 4/8 — Epic-scoped composer (attachments, chat-vs-PRD routing, queue/cancel)
cwd: ~/Projects/session-manager
estimateMinutes: 18
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

Build the Epic-scoped composer as `src/renderer/components/epics/EpicComposer.tsx`, per
`session-manager-operations/design-mocks/epics/DESIGN_SPEC.md` (§"Composer") and the mock's
Composer/AttachTray/useAttachments (`session-manager-operations/design-mocks/epics/
epics-mock.jsx`). It replaces the composer inside `PromptSessionConversation.tsx` and MUST
preserve that composer's dispatch mechanism — this is the app's PRD producer, not just a chat
box.

# Acceptance criteria

## Core functionality

- [ ] Context line above the input: mono "iterating in" + status dot + Epic title +
  `EpicKindTag`; drag-over highlights the strip and shows "drop to attach".
- [ ] Message routing: a compact per-message action toggle in the composer (two options:
  "Chat" and "Dispatch as PRD"), defaulting from the Epic's `tag` (feature/bug → Dispatch as
  PRD, discussion → Chat), freely overridable per message. Chat →
  `useChat.send({ tabId: epicId, sessionId: claudeSessionId, cwd, prompt })`. Dispatch →
  `dispatchPromptSessionToPrd(epicId, cwd, text, tag)` (`state/chat.ts:568`) exactly as
  `PromptSessionConversation.tsx:130-142` routes today. The old `TagSelector` UI is replaced
  by this toggle, behavior preserved.
- [ ] Attachments: paste (⌘V) and drag-drop of files/screenshots produce chips (image
  thumbnail via `URL.createObjectURL`, filename + size, remove button) plus an "Attach"
  file-picker button. On send, attachment file paths (`File.path` is available in Electron
  renderer) are appended to the prompt text as reference lines (e.g. "Attached: /abs/path");
  pasted images without a path are saved first via the existing config write IPC under
  `<cwd>/session-manager-operations/prompt-sessions/attachments/` (this dir is inside the
  already-allowlisted prompt-sessions write boundary — see `config.cjs` validateWrite).
- [ ] Auto-growing textarea (min 58px, max 180px), Enter sends / Shift+Enter newline;
  placeholder reflects state ("Running… send to queue a follow-up in this Epic" when running).
- [ ] Running state (from `epicDisplayStatus === 'running'` or chat run flags): primary button
  reads "Queue" instead of "Send"; a red "Cancel" text-button calls
  `window.api.chat.cancel(epicId)`. Send/Queue button is disabled-toned until text or
  attachments exist. Use Tailwind tokens for the red (no hard-coded `#b8443c` — the existing
  hex in PromptSessionConversation.tsx:187-189 is the anti-pattern).

## Edge cases

- [ ] Composer state (text + attachments) clears when switching Epics.
- [ ] The selected Epic completing or its run ending while typing does not lose typed text —
  labels/buttons re-derive from live flags on next render.
- [ ] Completed Epics render no composer (parent hides it; export a `canCompose` guard or
  just document the prop contract).

## Tests

- [ ] vitest jsdom tests: routing default follows Epic tag and manual override wins; running
  state flips Send→Queue and shows Cancel; attachment chip add/remove; state clears on epic
  switch. `timeout 300 npx vitest run <new files>` passes; `timeout 300 npm run typecheck`
  and `npm run lint:selectors` pass.

# Implementation notes

Depends on PRD 826. Read `PromptSessionConversation.tsx` (submit() at ~line 130) and
`state/chat.ts` (send/cancel/queuedPosition semantics, needs-input cleared on next send at
~305-381) first. Keep `EpicComposer` presentational where possible: accept
`{ epic, snapshots, onSent? }` props; do store writes through the existing actions only. Wave
siblings run in parallel — this PRD owns only `EpicComposer.tsx` + its test; if
`epic-primitives.tsx` lacks `EpicKindTag` yet, define locally and mark with a TODO for 829's
consolidation pass.

# Out of scope

- Mic/voice dictation (state/voice.ts is SessionTab-coupled — explicitly dropped; do NOT ship
  a dead mic button).
- The New Epic card (sibling PRD), detail pane, queue pane, mounting (829).
- Any chatRunner/main-process changes.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

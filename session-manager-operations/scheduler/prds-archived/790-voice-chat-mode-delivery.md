---
title: Give voice input a Chat-mode delivery path (dormant tabs have no pty to write into)
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

src/renderer/state/voice.ts's recognized-speech handlers (onFinal ~line 619-653, armSubmit
~line 326-345) deliver text ONLY via window.api.pty.write — a live raw-terminal write. Since PRD
772 made new project tabs default to status 'dormant' (Chat view, no PTY process spawned — see
src/renderer/state/sessions.ts:22's status union), voice input on a dormant/Chat tab currently
has nowhere to write and silently does nothing. This PRD adds a second delivery path: when the
target tab's status is 'dormant', route the transcript into the Chat composer's text instead of
a pty write, and auto-submit via chat.ts's send() instead of a pty '\r' keystroke. This is a
prerequisite for a follow-up PRD that moves the mic button visually into the Chat panel — moving
the button without this would move it next to a text box it can't actually fill.

# Acceptance criteria

- [ ] src/renderer/state/chat.ts's TabChat interface gains an optional field for a pending voice
      transcript (e.g. `pendingVoiceText?: string`) plus store actions to set/clear it for a
      tabId, following the existing patch()-based mutation pattern already used elsewhere in the
      file
- [ ] src/renderer/components/TerminalChat.tsx's composer subscribes to this tab's
      pendingVoiceText and, when set, appends it (space-joined, not overwritten — mirrors how
      pty.write appends keystrokes to whatever's already typed) into the local `draft` state,
      then clears it so a second spoken segment appends rather than duplicates
- [ ] In voice.ts's onFinal (~line 619-653): before calling window.api.pty.write, look up the
      target tab's status via useSessions.getState().tabs.find(t => t.id === tabId)?.status
      (src/renderer/state/sessions.ts). When status === 'dormant': skip matchVoiceCommand
      entirely (voice commands are raw terminal control sequences — arrow keys, ctrl+c — that
      have no meaning for a plain-text chat composer; for a dormant tab, always treat the final
      transcript as literal text) and call the new setPendingVoiceText(tabId, trimmed) action
      instead of pty.write. When status is not 'dormant', behavior is unchanged (existing
      pty.write + voice-command path)
- [ ] In armSubmit (~line 326-345): when the target tab's status is 'dormant' at the moment the
      countdown fires, instead of window.api.pty.write({tabId, data: '\r'}), call
      useChat.getState().send({tabId, sessionId, cwd, prompt: <the accumulated pending text>}) —
      resolve sessionId/cwd from the tab record (useSessions.getState().tabs) — and clear
      pendingVoiceText after submit. When not dormant, behavior is unchanged (pty '\r' write)
- [ ] Unit tests in the voice store's test file (locate via `ls src/renderer/state/__tests__/voice*`)
      cover: a dormant-status tab routes onFinal's transcript to the chat store instead of
      pty.write; a running/spawning-status tab still uses pty.write (explicit regression check,
      not just omission); armSubmit's countdown calls chat.send for a dormant tab and pty '\r'
      for a live one; a matched voice command is skipped (no pty.write, no chat dispatch of
      control-sequence text) for a dormant tab
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npx vitest run <the voice store test file located above> src/renderer/state/__tests__/chat.test.ts` passes

# Implementation notes

Read first: src/renderer/state/voice.ts in full (especially onFinal ~619-653, armSubmit
~326-345, matchVoiceCommand's call site), src/renderer/state/chat.ts (TabChat interface ~63-95,
the patch() helper, the send() action signature), src/renderer/state/sessions.ts (SessionTab
status union ~line 22, tabs array shape), src/renderer/components/TerminalChat.tsx (the `draft`
local state and its useState/textarea, ~line 924-939).

Do NOT change VoiceButton.tsx's own onClick/tabId-resolution logic in this PRD, and do NOT move
VoiceButton in the UI yet — that's the next PRD in this chain, once this delivery path exists to
move it onto. This PRD is data/store plumbing only.

# Out of scope

- Moving the mic button's UI position (next PRD)
- Building Chat-mode equivalents of terminal voice commands (arrow keys, ctrl+c, etc.) — those
  are explicitly skipped for dormant tabs, not reimplemented
- Any change to live/raw-terminal voice behavior — must remain byte-identical

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

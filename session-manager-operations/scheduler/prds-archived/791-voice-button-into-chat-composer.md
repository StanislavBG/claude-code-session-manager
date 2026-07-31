---
title: Move mic button from sidebar into the Chat composer, left of the text-entry area
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Depends on PRD 790 (voice-chat-mode-delivery), which must land first — read its actual landed
diff before starting, not just its plan. Today src/renderer/components/layout/AlmanacSidebar.tsx
renders `<VoiceButton />` next to the "+ New session" button (ProjectCaption, ~line 340-343),
disconnected from the text surface it actually feeds. Now that PRD 790 makes voice input land in
the Chat composer's draft for a dormant tab, this PRD moves the button to match: remove it from
the sidebar, and render it as the leftmost element of the Chat composer row in
src/renderer/components/TerminalChat.tsx, directly beside the text-entry area whose content it
populates.

# Acceptance criteria

- [ ] src/renderer/components/layout/AlmanacSidebar.tsx: remove the
      `<div className="flex items-center rounded-md bg-bg-hi border border-line"><VoiceButton /></div>`
      block (~line 340-342) and its now-unused VoiceButton import; adjust the "New session"
      button's wrapping row so it still reads cleanly as the only control there (no leftover
      empty gap or broken flex layout — verify visually, see screenshot AC below)
- [ ] src/renderer/components/TerminalChat.tsx's composer row
      (`<div className="flex items-end gap-2">`, ~line 923) renders `<VoiceButton />` as its
      first child, before the `<textarea>` (~line 924), i.e. at the left of the text-entry area
- [ ] VoiceButton's onClick already resolves its target tab via
      useSessions.getState().activeTabId (src/renderer/components/VoiceButton.tsx ~line 44) — no
      prop-drilling is needed since the composer only renders for the currently open/active tab,
      but add a regression test asserting the button in this new location still starts recording
      against the correct tabId
- [ ] Existing sidebar tests referencing the mic button's old position (grep test files under
      src/renderer/components/layout/__tests__ for VoiceButton/mic-button) are updated rather
      than left broken; TerminalChat tests gain coverage that VoiceButton renders in the composer
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npx vitest run` for whichever test files were touched above passes

NOTE: this PRD's implementation already landed via manual recovery after an earlier run stalled
on the interactive screenshot-capture step (since removed from this AC) — commit `259842b`
("feat(voice): move mic button from sidebar into the Chat composer"). If you are re-running this
PRD, first check `git log --oneline -- src/renderer/components/TerminalChat.tsx` for that commit;
if present, the work is done — just re-verify typecheck + the test command and report success
rather than re-implementing. Do NOT add a `screenshot`/`xvfb`/GUI-driving acceptance criterion —
three prior PRDs in this session (776, 779, and this one) stalled and were SIGTERM'd on exactly
that step (see `feedback_no_interactive_ac_in_prds` memory and
`session-manager-operations/feedback/2026-07-30-exit143-after-commit-misclassified-as-failed.md`).
Visual confirmation belongs to interactive review after the PRD lands, never headless AC.

# Implementation notes

Read first: PRD 790's actual landed diff, src/renderer/components/layout/AlmanacSidebar.tsx's
ProjectCaption function (~line 269-346), src/renderer/components/TerminalChat.tsx's composer JSX
(~line 895-977), src/renderer/components/VoiceButton.tsx in full.

This PRD is a pure UI relocation — do not change VoiceButton's internal recording logic (that's
PRD 790's job, already done) or add new voice features here.

# Out of scope

- Any change to voice.ts's recording/delivery logic (PRD 790's responsibility, already landed)
- Extending voice input to other composer surfaces (next PRD in this chain)

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

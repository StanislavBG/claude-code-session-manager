---
title: Render a real diff card for Edit/Write turns in Epic Discussion
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 22
sourcePromptId: psess-msaup10i-1
dependsOn: [chat-turn-diff-data-capture]
---
# Goal

Consume the `diff` payload chat-turn-diff-data-capture adds to `ToolUseTrace` (landed by the time this PRD runs, per dependsOn) to render a real diff card in an assistant turn — a colored, collapsible view of what changed, closest real-data equivalent to the Epics design mock's TDiff card (session-manager-operations/design-mocks/epics/epic-thread-mock.jsx describes the intent: collapsible file header with +/- line counts, colored added/removed lines). This is the single biggest visual gap identified between the design mock and the real app (mock vs reality comparison, 2026-08-01): a file edit currently only shows as a generic "used N tools" chip plus the agent's own prose description, with no visual diff at all.

# Acceptance criteria

- [ ] Read the landed diff of chat-turn-diff-data-capture in src/renderer/state/chat.ts first to confirm the exact shape of the new `diff` field on ToolUseTrace before building against it.
- [ ] In src/renderer/components/ChatTranscriptTurn.tsx's assistant-turn branch, when `turn.toolUses` contains one or more entries with a `diff` payload, render a diff card ABOVE or interleaved with the existing tool-strip/markdown-body (don't remove the existing tool strip or markdown text — add to it): a collapsible header showing the file path + added/removed line counts, and when expanded, a line-by-line view with added lines tinted using the existing sage/positive token and removed lines tinted using the existing ERROR_TEXT/red token already defined in this same file (reuse ERROR_TEXT/AMBER_TEXT's contrast-checked color approach — don't introduce new unchecked colors).
- [ ] Multiple Edit/Write calls within the same turn each get their own diff card (not merged into one).
- [ ] The diff card works in BOTH the `toolStripVariant='inline'` (TerminalChat) and `'collapsible'` (EpicDetail) contexts this file already supports — don't fork a parallel Turn variant.
- [ ] No diff-card UI appears at all for a turn with no Edit/Write tool uses — verify the generic markdown-only path is completely unaffected.
- [ ] Add unit test coverage: a turn with a diff-carrying toolUse renders the diff card with the expected added/removed content; a turn without one does not render it.
- [ ] Verify visually: launch the app, trigger or reuse a real Epic turn that has file-edit tool activity, screenshot the resulting diff card, and confirm it's now clearly distinguishable from plain text — this is the core visual-fidelity claim of this PRD and must be shown, not just asserted from green tests.
- [ ] `npm run typecheck`, `node scripts/check-unstable-selectors.cjs`, and the full ChatTranscriptTurn-related test suite pass.

# Implementation notes

Design intent reference only (do not port inline styles): session-manager-operations/design-mocks/epics/epic-thread-mock.jsx's TDiff description. Reuse this file's OWN existing color tokens (ERROR_TEXT/ERROR_TINT/AMBER_TEXT/AMBER_TINT already defined at the top of ChatTranscriptTurn.tsx, contrast-checked against all three paper background shades — follow that same contrast-checking discipline for any new sage/positive color rather than picking an arbitrary green) rather than the mock's raw hex values or new arbitrary Tailwind colors.

# Out of scope

- Accept/Retry differently/Reject action buttons on the diff card (the mock's TDiff has these, but they imply a real accept/reject workflow this codebase has no backing action for today — a real Edit already landed on disk by the time this turn renders; rendering fake buttons with no effect would be worse than not having them. Flag this explicitly in your own PR notes as a known intentional scope cut, don't silently build inert buttons.)
- Plan-step and permission-gate card rendering (separate future work, not part of this PRD)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

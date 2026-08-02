---
title: Chat renders an empty "C" assistant bubble when a resumed turn leads with a non-text (thinking) block or produces empty final text
source: sigma agent (Claude Code, session 5d84e3eb) — investigating a live Chat transcript for bilko
type: bug
severity: normal
---

# What happens / what's missing

`TerminalChat` renders the assistant turn as *"the run's final message verbatim"* — `renderChatMarkdown(turn.text)` at `src/renderer/components/TerminalChat.tsx:322`. There is no guard for the case where `turn.text` is empty. When it is, the component still paints the avatar chip + an empty `bg-elev` bubble — a visible, content-less "C" balloon that reads to the user as "the agent replied with nothing."

This happened at the tail of the same incident: after the user typed "whats going on?", the agent's resumed turn opened with a `thinking` block (which Chat does not render) followed only later by visible text. At the instant the screenshot was taken the thread showed an **empty assistant bubble** under "whats going on?" — nothing rendered. The turn did eventually produce real text (a full CI-status report), but the intermediate/empty state is what the user saw and screenshotted, and it's indistinguishable from a hang.

# Evidence

- **Screenshot:** `session-manager-operations/feedback/evidence/2026-07-21-chat-empty-render-screenshot.png` — trailing empty `C` bubble beneath the "whats going on?" user message.
- **Transcript:** `~/.claude/projects/-home-bilko-Projects-sigma/186e30b2-e157-40d2-80df-fa6bf4204589.jsonl`
  - line 570 — `assistant` turn begins with a `thinking` block (not rendered by Chat) — `2026-07-21T16:03:05.413Z`
  - line 571 — first *visible* assistant text arrives — `2026-07-21T16:03:06.130Z`
  - line 575 — final report text — `2026-07-21T16:03:20.967Z`
- **Render path:** `src/renderer/components/TerminalChat.tsx:309-329` (`// assistant — render the run's final message verbatim (markdown).`). No branch handles `turn.text === ''` or a turn whose only content so far is non-text.

# Suggested direction (optional)

- When `turn.text` is empty but the turn is still `running`, render a live "thinking…" / working affordance (or reuse the existing tool-use trace strip / stream indicator) instead of an empty bubble.
- When a turn *finishes* with empty final text, either suppress the bubble entirely or show an explicit "(no textual reply — see tool activity above)" placeholder, so an empty balloon is never presented as a completed answer.

Root-cause companion filed separately: `2026-07-21-chat-background-shell-false-promise.md` (why the resume/dead-air happened in the first place).

## RESOLUTION

Shipped. `src/renderer/lib/assistantTurnPresentation.ts` extracts the branch decision as a pure
helper (`'text' | 'working' | 'placeholder' | 'suppress'`), unit-tested for all four states plus
whitespace-only text (`src/renderer/lib/__tests__/assistantTurnPresentation.test.ts`, 5 cases).
`Turn()`'s assistant branch (`src/renderer/components/TerminalChat.tsx`) now switches on it:
empty text + run still active for this turn → trace strip + pulsing "working…" affordance
(reuses the existing `animate-pulse` dot idiom already used elsewhere in this file, not a new
spinner); empty text + finished + has toolUses → trace strip + muted italic
"(no textual reply — see tool activity above)"; empty text + finished + no toolUses → bubble
suppressed entirely (returns `null`); non-empty text → unchanged existing markdown/UrlCallout/
plan render. `runActive` is derived by the caller as `running && i === turns.length - 1` (the
chat store's per-tab `running` flag from `state/chat.ts`, applied only to the last turn).
`npm run typecheck` and `npm run test:unit` both pass (873 tests, 78 files).

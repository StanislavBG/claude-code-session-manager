---
title: Auto-retry the original prompt once inline consent is granted
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msaj5sn3-8
dependsOn: [inline-consent-widget-notice-card]
---
# Goal

Close the loop on the inline-consent flow built in 899/900: once `InlineConsentTerminal`'s `onGranted` fires inside the notice card (900-inline-consent-widget-notice-card.md), let the user re-send the SAME prompt that failed with the consent denial, without retyping it, instead of leaving them to scroll up and manually resend. This is the final link in the chain: 899 built the mount, 900 wired it into the notice card and collapse-with-toast, this PRD adds the actual one-click resend.

# Acceptance criteria

- [ ] Read the actual landed code from 900-inline-consent-widget-notice-card.md first (git log/git show or current ChatTranscriptTurn.tsx) to confirm exactly what `onGranted` currently does before extending it
- [ ] The chat turn immediately preceding the consent notice turn (the user's original prompt that triggered the MCP consent denial) is identified from the existing turn list already available to ChatTranscriptTurn.tsx's caller (the transcript-rendering parent component — locate it via `git grep -n "ChatTranscriptTurn\|<Turn"` and inspect how turns are passed/mapped) — do not attempt to reconstruct the prompt text from PTY output; use the already-recorded chat turn data (same turns array the UI already renders)
- [ ] Once `onGranted` fires, render a 'Retry' button in the collapsed notice card (replacing any placeholder from 900) that calls `useChat.getState().send({ tabId, sessionId, cwd, prompt: <the identified original prompt text> })` — same call pattern the existing question-turn 'answer' buttons already use at ChatTranscriptTurn.tsx:374-376
- [ ] If the preceding user prompt cannot be confidently identified (e.g. notice is the very first turn, or the immediately-prior turn isn't a plain user prompt), do not guess — omit the Retry button and leave only the plain collapsed notice text, same as pre-900 behavior for that edge case
- [ ] The Retry button is disabled while `chatRunning` is true (same guard the question-turn buttons already use at ChatTranscriptTurn.tsx:409), preventing a double-send
- [ ] npm run typecheck passes
- [ ] Relevant component test(s) updated/added asserting: (a) Retry button appears and resends the correct prompt text when a preceding user turn exists, (b) Retry button is absent when it doesn't — run via `timeout 120 npx vitest run <the test file located above>`

# Implementation notes

Read /home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md before starting.

This PRD is deliberately scoped narrow: it only wires the resend button using data already present in the renderer (the turns array), no new IPC, no new backend. Do not attempt to also auto-detect and auto-fire the retry without a user click — the "never auto-answer the confirmation itself" principle from the original notice-card comment (ChatTranscriptTurn.tsx:429, "The confirmation itself is never auto-answered") extends here: resending the prompt is also a user-initiated action, not automatic, since a headless retry immediately after an interactive consent grant could still race the PTY's own teardown.

Out of scope: multi-consent scenarios (a run needing consent for two different MCP servers in sequence), and any change to chatRunner.cjs's detection heuristic itself (MCP_CONSENT_DENIAL_MARKERS, chatRunner.cjs:196-202) — this PRD is UI-only, reusing the existing notice/turn data model unchanged.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: Agent's final plain-text reply not surfaced in session-manager chat UI
source: bilko (observed live in a burrow session, via session-manager chat)
type: bug
severity: high
---

# What happens / what's missing

In a burrow project session run through session-manager's chat UI, the agent was asked: "show
me what one of our new posts might look like" — a request for generated content, not code or a
tool result. The agent's turn ended with a normal plain-text/markdown reply: a ~150-word sample
post (a few paragraphs, a numbered list, no code fences, no tool calls after the content).

**That final text did not appear in the chat UI at all.** The user's exact words: "You didn't
show it, it was not visible in the session-manager chat" — and after the agent re-pasted the
same content in the very next turn, the follow-up complaint was specifically about content
being surfaced/lost: "what I ask for show, or when something is important, should be surfaced —
we are 'eating up' too much of the text."

This is not a case of the agent forgetting to answer — the underlying transcript shows the
content was genuinely emitted as the assistant's final message of that turn (the agent believed,
correctly per its own transcript, that it had answered). The loss happened somewhere between
"agent emitted final text" and "user sees it in the session-manager chat pane" — i.e. in
session-manager's own rendering/relay layer, not in generation.

Pattern that seems relevant: the turn that got dropped was a **pure-text turn** (content-only,
no tool call at the very end of the response). Earlier and later turns in the same session that
mixed tool calls with text, or that were tool-call-heavy, appear to have rendered fine and were
visible to the user without complaint.

# Evidence

I do not have session-manager's own session id, run log path, or exact renderer `file:line` for
this incident — I was operating from the burrow project side (not inside the session-manager
codebase) and can't self-diagnose which component swallowed the message. I'm filing this as an
observed-behavior report rather than guessing at a root cause, per this queue's own guidance that
a wrong attribution stalls more than an honest "don't know."

What I can state with confidence from the burrow-side transcript:
- The agent's turn ended in plain markdown text (headered content sample + closing question),
  no trailing tool call, no unusual characters/formatting beyond standard markdown (numbered
  list, bold, blockquote-style `>` lines were NOT used — plain paragraphs and a `1.`/`2.`/`3.`
  list).
- The reply was moderate length (~150 words / ~900 characters) — not multi-thousand-word, so if
  there is a length cap involved it would be a fairly low one, or the issue isn't length-based at
  all (could be a message-type/parsing/timing issue instead).
- The very next turn, when the agent re-emitted the *identical* text in response to "where is
  it", the user was able to see it fine. So rendering isn't permanently broken — something about
  the specific turn (its shape? a race with the "next" incoming message? something about how the
  turn concluded without a tool call?) caused that one turn's content to not surface.

If it would help narrow this down, I can try to reproduce again from the burrow side and capture
the exact session-manager session id / timestamp at the moment of the drop — let me know if
that's useful and I'll do a live repro pass.

# Suggested direction (optional)

Investigate whether the chat rendering path in session-manager has a message-type filter or
buffering behavior that treats "text-only, no-tool-call" final assistant messages differently
from tool-call-bearing turns — e.g. a websocket/IPC message that only flushes to the renderer
once a tool-result event fires, so a turn that ends on pure text has nothing to trigger the
flush. That would explain both symptoms: (1) plain-text-only turns disappearing, (2) the same
content rendering fine once repeated in a turn that (per the user's later framing) was clearly
"important" and got surfaced.

This is a suggestion only — I don't have visibility into session-manager's actual message
pipeline to confirm it.

# Asks

1. Reproduce a text-only (no trailing tool call) final assistant turn in the chat UI and confirm
   whether it renders. If it doesn't, find the drop point (IPC message never sent? renderer
   filters it? overwritten by a subsequent message before paint?).
2. If a repro confirms the drop, fix it so any assistant-authored final-turn content is
   guaranteed to surface — this is a trust-critical issue: a user who asks "show me X" and gets
   nothing rendered has to re-ask before finding out the agent DID answer, which defeats the
   purpose of an interactive session.
3. Acceptance test: a chat turn ending in a plain-text (non-empty, no-tool-call) assistant
   message of a few hundred words renders completely in the chat pane, every time, without
   requiring a follow-up prompt to re-surface it.

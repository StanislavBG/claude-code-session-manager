---
title: Chat mode lets the agent start a background shell that can never report back — 18 min of dead air after a false "I'll report once it lands" promise
source: sigma agent (Claude Code, session 5d84e3eb) — investigating a live Chat transcript for bilko
type: bug
severity: high
---

# What happens / what's missing

In the **Chat** tab (`TerminalChat`), whose own header states *"Chat · headless session — no process runs between commands"*, the agent was allowed to launch a `run_in_background: true` Bash shell to poll CI, then ended its turn with:

> "Polling PR #169's CI on the fix commit in the background — I'll report the full fresh status once it lands."

That promise is **structurally impossible in this mode**. Because no process runs between commands, the background shell was torn down at turn teardown. When the session next woke, the runtime injected:

```
<task-notification>
<task-id>bg2vav8b2</task-id>
<status>stopped</status>
<summary>No completion record was found for this background shell command from the
previous session. It may have been stopped (via the UI, Monitor timeout, or agent
teardown — these leave no transcript marker), or it may have been running when the
previous Claude Code process exited.</summary>
</task-notification>
```

Net effect for the user: the agent said "I'll report once it lands," then **nothing rendered for ~18 minutes** of wall-clock. The user had to manually poke the session with "whats going on?" to get any further output. The "fire-and-forget background, I'll come back to you" pattern the agent used is valid in a persistent CLI session but is a dead end in Chat mode — there is no wake-up event that will ever fire, so the turn just ends in silence.

# Evidence

- **Screenshot:** `session-manager-operations/feedback/evidence/2026-07-21-chat-empty-render-screenshot.png` — shows the "Polling… I'll report once it lands" bubble, the user's "whats going on?" reply, and a trailing empty `C` assistant bubble.
- **Transcript:** `~/.claude/projects/-home-bilko-Projects-sigma/186e30b2-e157-40d2-80df-fa6bf4204589.jsonl`
  - line 557 — `tool_use: Bash`, input `{ "command": "until gh pr checks 169 ...; do sleep 10; done; ...", "run_in_background": true }`
  - line 559 — assistant text "Polling PR #169's CI … I'll report the full fresh status once it lands." — **timestamp `2026-07-21T15:44:55.791Z`**
  - line 560 — `last-prompt` (turn ended here; no wake-up scheduled)
  - line 564 — injected `<task-notification>` `status=stopped`, "No completion record was found…" — **timestamp `2026-07-21T16:03:01.580Z`** → **≈18 min of dead air**
  - line 568 — the user's queued "whats going on?" is what finally resumed the session, not any background completion
- **Header source:** `src/renderer/components/TerminalChat.tsx:466` — literal string `Chat · headless session — no process runs between commands`.

# Suggested direction (optional)

Two complementary guards (suggestions — implementer picks the route that fits conventions):

1. **Tell the agent the truth about the mode.** Inject a Chat-mode system preamble stating that background shells / `run_in_background` / scheduled wake-ups do **not** survive between turns, so any "I'll get back to you when X finishes" plan must instead be done synchronously within the current turn (poll inline with a bounded timeout, then report), or explicitly hand back to the user with a "reply to continue" instruction. This is the root fix — the agent chose an impossible pattern because nothing told it the mode forbids it.
2. **Fail loud instead of silent.** When a Chat turn ends while a `run_in_background` shell is still live (or a wake-up was requested), surface a visible banner in the composer/thread — "⏳ background CI poll won't resume on its own in Chat — reply to check it" — rather than letting the thread sit silent until the user guesses something is wrong.

Related rendering symptom of the same incident filed separately: `2026-07-21-chat-empty-assistant-bubble.md`.

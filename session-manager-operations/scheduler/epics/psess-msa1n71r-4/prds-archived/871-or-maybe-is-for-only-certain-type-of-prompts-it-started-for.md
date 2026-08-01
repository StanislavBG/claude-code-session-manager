---
title: Or maybe is for only certain type of prompts it started for
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msa1n71r-4
tag: bug
---
# Goal

Investigated live (2026-08-01, this session): the opening-prompt automation is NOT
tag-specific and is NOT dropping sends. Verified via `session-manager-operations/prompt-sessions/transcripts/psess-*.jsonl`
that every Epic created this session (2 feature-tagged, 1 bug-tagged) recorded its
opening-prompt user-turn immediately at creation — `composeEpicIntake` →
`NewEpicCard.tsx`'s `useChat.getState().send()` has no tag branching. `ps aux` confirmed
the "stuck-looking" Epic's `claude -p --resume <id>` was still alive and actively
computing, sharing the machine-wide 3-slot pool (`lib/sessionSlots.cjs`) with this
Epic's own chat run and a concurrently-running scheduler PRD job — it was a long,
unbounded-scope prompt genuinely still in flight, not a dropped send.

Real gap: once a newly-created Epic's chat run is queued behind the 3-slot cap, or is
just long-running, there is no durable "queued" / "running" affordance visible after
navigating away from the Epic (EpicDetail / Epics list), so it reads as "never started."
Fix the UX, not the send path:

- Surface a persistent running/queued indicator on the Epics list row (not just inside
  EpicDetail's live thread) so a user can tell "in flight" apart from "nothing happened"
  without keeping the tab open.
- If genuinely queued behind the slot pool, surface that explicitly (e.g. "queued —
  waiting on a session slot") rather than an indistinguishable blank/idle state.
- Do NOT touch `composeEpicIntake`, `NewEpicCard.tsx`'s send call, or add tag-based
  branching to the send path — confirmed correct as-is.

Second gap, found in the same investigation: `chats[tabId].queue` (`src/renderer/state/chat.ts`
— the array of follow-up messages typed while a run is already busy for that Epic, pushed by
`send()` at line ~311, popped one at a time FIFO by `dequeueNext()`) is never rendered by ANY
component — grepped every renderer component, the only consumer of the word "queue" outside
chat.ts is `EpicDetail.tsx`'s `chat.queuedPosition` (a different, unrelated field — chatRunner's
own lane position, rendered as "queued · position N" around line 662). So a user who sends a
2nd/3rd message mid-run gets zero acknowledgment that it was captured at all — it silently
sits in `chat.queue` with no chip/counter/list until its own turn eventually starts. This reads
exactly like "did my message queue or is it about to dump everything at once" — it did queue,
and it is strictly serial (one ticket dispatched per completion), but nothing on screen says so.

# Acceptance criteria

- [ ] Epics list (or equivalent surface) shows a live running/queued state per Epic that
      persists independent of whether EpicDetail is currently mounted.
- [ ] A chat run queued behind the session-slot pool is visually distinguishable from one
      that already completed with no response.
- [ ] EpicDetail (or its composer) renders `chats[tabId].queue` — every ticket typed while a
      run is busy is visible as a distinct pending item (not just the currently-running turn),
      in FIFO order, so the user can see what's waiting and confirm nothing was dropped.
- [ ] timeout 300 npm run typecheck passes

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Relevant files: `src/renderer/components/epics/NewEpicCard.tsx`, `src/renderer/lib/epicIntake.ts`,
`src/renderer/state/chat.ts` (`chats[tabId].queue`, `dequeueNext()`, `window.api.chat.onQueued`/
`onRunStarted`), `src/renderer/components/epics/EpicDetail.tsx` (`chat.queuedPosition` render
around line 662 — needs a sibling render of `chat.queue`), `src/main/chatRunner.cjs`
(`pump()`/`sessionSlots`), Epics list component that currently doesn't reflect running state.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

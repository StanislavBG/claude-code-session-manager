---
title: Disclose the 30-minute chat kill ceiling to the model and report what was in flight when it fires
source: 01-Shapes-Foundation agent (bilko)
type: bug
severity: high
---

# What happens / what's missing

A Chat tab run doing a real TestFlight publish (`eas build` + `eas submit` for
`01-Shapes-Foundation`) was killed mid-flight. The only artifact the user saw was a single
red line in the Chat transcript:

```
run exceeded 30-minute wall-clock ceiling
```

Three distinct defects compound here. All are in chat mode; **the workaround of "switch that
tab to the raw terminal experience" is explicitly not acceptable to bilko** — the ask is to
make chat mode survive this, not to route around it.

## 1. The ceiling is invisible to the model, and the prompt actively steers into it

`CHAT_MODE_TRUTH_INSTRUCTION` (`src/main/chatRunner.cjs:259-270`) is prepended to every chat
prompt and instructs, verbatim:

> `If you need to poll something, do it synchronously within this turn with a bounded
> timeout, then report the actual result.`

**Lineage:** that constant is what shipped for
`2026-07-21-chat-background-shell-false-promise` (PRD 673). It correctly fixed the original
complaint — the agent no longer promises to report back from a background shell. This item is
the follow-on gap it opened, not a regression of it: having banned background polling, it
redirects the agent to synchronous polling **without stating how long synchronous polling is
allowed to take**.

The model is told to poll synchronously — but is **never told the turn's own budget**.
`KILL_CEILING_MS` (`src/main/chatRunner.cjs:303`) is 30 minutes and appears nowhere in the
prompt text. So the model reasons "poll synchronously, bounded" and picks poll windows sized
to the external job (an EAS build/submit is routinely 20-60 min), which is exactly the
behavior the ceiling then punishes. The instruction and the enforcement contradict each other.

This is not a hypothetical mis-selection — it is what happened: the run chose a bounded
synchronous poll loop, and was SIGKILLed partway through it.

## 2. The kill tells nobody what was in flight, so irreversible work got repeated

`doKill` targets the whole process group (`process.kill(-child.pid, sig)`,
`src/main/chatRunner.cjs:474-479`, enabled by `detached: true` at :459). That correctly reaps
descendants — but the emitted `chat:run:error` payload
(`src/main/chatRunner.cjs:492-497`) carries only `{ tabId, sessionId, message }`. No record of
which tool calls had completed, and no signal that external side effects may have already
landed.

Session context *does* resume correctly on the next command (`src/renderer/state/chat.ts:269`
checks the on-disk transcript) — credit where due, that part works. But resumed context is a
transcript of *intent*, not of *outcome*. The killed turn's last observation was an empty
output file, so the resumed turn could not tell whether the Apple upload had succeeded.

**Cost actually paid:** the resumed turn re-ran `eas submit` **three more times** against
App Store Connect. Each retry scheduled a real submission (`8d8e3488-…`, `4f648228-…`,
`99e4ccc5-…`, all `status: ERRORED`) before an ASC API query proved the *original* submit had
in fact succeeded — build 6 was already `VALID`, uploaded `2026-07-28T11:23:09-07:00`. Three
redundant round-trips to Apple's submission API, on an operation the workspace docs
explicitly call "expensive, slow, rate-limited."

## 3. The post-kill notification points at evidence the kill destroyed

On the next turn the harness surfaced:

> `No completion record was found for this background shell command from the previous session.
> … Check the output file for partial results before assuming it completed.`

The referenced file (`/tmp/claude-1000/<project>/<session>/tasks/b36s2o7eh.output`) no longer
existed — `find /tmp -name "b36s2o7eh.output"` returned nothing. The advice is unfollowable by
construction: the group kill plus teardown removes precisely the artifact the recovery path
names.

The notification wording is Claude Code's, not session-manager's — but the group SIGKILL that
orphans the task and strands its output file is this project's
(`src/main/chatRunner.cjs:474-479`), so the interaction belongs here.

# Evidence

All paths verified by `grep`/`sed` against the working tree as of **2026-07-28 ~5:40 PM PDT**
(re-verify before fixing; `chatRunner.cjs` is actively edited).

| Fact | Location |
|---|---|
| `const KILL_CEILING_MS = 30 * 60 * 1000; // 30 minutes` | `src/main/chatRunner.cjs:303` |
| Timer armed; message `'run exceeded 30-minute wall-clock ceiling'` | `src/main/chatRunner.cjs:491-499` |
| Timer cleared on normal settle (no leak) | `src/main/chatRunner.cjs:604`, `:620` |
| Group kill via negative pid | `src/main/chatRunner.cjs:474-479` (+ `detached: true` at `:459`) |
| Prompt text telling the model to poll synchronously, with no budget stated | `src/main/chatRunner.cjs:259-270` |
| Prompt assembled and passed as `-p` | `src/main/chatRunner.cjs:430-439` |
| Resume-vs-create decision (works correctly) | `src/renderer/state/chat.ts:269-279` |
| UI label for the surface | `src/renderer/components/TerminalChat.tsx:572` |

External-side proof the retries were redundant, from `01-Shapes-Foundation`:

```
$ source ~/.eas-secrets/env && node scripts/check-testflight.mjs 6793739641
build 6  state=VALID  uploaded=2026-07-28T11:23:09-07:00  expired=false
build 5  state=VALID  uploaded=2026-07-24T12:55:52-07:00  expired=false
```

Screenshot of the user-visible failure: `/tmp/session-manager-clipboard/clipboard-1785285289568.png`
(shows the prompt, the red ceiling line, and the user re-issuing the identical prompt).

# Suggested direction (optional)

Suggestions — the implementer may route differently.

**Ask 1 — tell the model its budget (smallest, highest value).**
Interpolate the real remaining budget into `CHAT_MODE_TRUTH_INSTRUCTION` instead of leaving it
implicit, e.g. append: *"This turn is hard-killed after N minutes of wall-clock. Size every
synchronous poll to finish inside that, and if the work cannot fit, do the part that fits,
report exactly what landed, and say what remains."* Derive N from `KILL_CEILING_MS` so the two
can't drift.
*Acceptance:* a run whose prompt requires a long poll ends with a partial report before the
ceiling rather than being SIGKILLed; unit test asserts the rendered prompt contains the same
number as `KILL_CEILING_MS`.

**Ask 2 — warn before killing.** At ~80% of the ceiling, inject a turn-visible notice
(reusing the existing `chat:run:notice` channel, `src/main/chatRunner.cjs:415-423`) telling the
model to wrap up and report state now. Kill only if it doesn't.
*Acceptance:* a run that overruns emits the warning first and ends with a normal assistant
summary; the hard kill becomes the rare fallback, not the default outcome.

**Ask 3 — make the kill message actionable.** Extend the `chat:run:error` payload with elapsed
time, the ceiling value, and the last N tool-use names seen on the stream (the parser already
classifies these — `classifyToolUse`, ~`src/main/chatRunner.cjs:520`). Render as: *"Killed after
30m. Last actions: Bash(eas submit …). External side effects may have completed — verify before
retrying."*
*Acceptance:* the transcript names the last tool call, so a resumed turn verifies before
repeating an irreversible operation.

**Ask 4 (lower priority, genuine design question) — make the ceiling configurable.** 30 min is
hardcoded. Mobile release flows (EAS build + Apple submit) legitimately exceed it. An env
override mirroring the existing `SM_CHAT_CONCURRENCY` pattern (`src/main/chatRunner.cjs:283-288`)
— e.g. `SM_CHAT_KILL_CEILING_MIN`, clamped to a sane range — would let a release tab opt into a
longer budget without weakening the default. **Flagging rather than prescribing:** raising the
ceiling trades away the runaway-run protection it exists to provide, so this is bilko's call,
not an obvious yes.

**Not asked for:** any change that resolves this by pushing the user to the raw terminal
session. Chat mode is the surface that needs to work here.

---
title: "Chat mode: disclose kill-ceiling budget to the model, warn before killing, make the kill message actionable"
cwd: ~/Projects/session-manager
parallelGroup: 812
estimateMinutes: 30
---

# Goal

A Chat tab run doing a real long-running external operation (an EAS build/submit, any bounded
synchronous poll) was SIGKILLed by `KILL_CEILING_MS` (`src/main/chatRunner.cjs:303`, 30 minutes)
mid-flight, with zero warning and a kill message that named nothing about what was in flight. Root
cause: `CHAT_MODE_TRUTH_INSTRUCTION` (`src/main/chatRunner.cjs:259-270`, shipped by PRD 673) tells
the model to "poll synchronously within this turn with a bounded timeout" but never states what
that bound actually is — so the model picks a poll window sized to the external job (which can be
20-60+ min) instead of the real 30-minute ceiling, and gets killed exactly where the instruction
steered it. Worse, the resulting `chat:run:error` payload (`chatRunner.cjs:492-497`) carries only
`{ tabId, sessionId, message }` — no record of what tool call was in flight — so the next turn
cannot tell whether an irreversible external side effect (e.g. an Apple submission) already landed,
and in the observed incident it re-ran `eas submit` three redundant times against a real,
rate-limited external API before discovering the original submit had already succeeded.

Fix the three concrete, well-specified asks from the source report (a 4th ask — making the ceiling
itself configurable per-tab — is an explicit open design question the filer flagged as "bilko's
call, not an obvious yes" and is out of scope here).

# Acceptance criteria

## Ask 1 — tell the model its real budget

- [ ] `CHAT_MODE_TRUTH_INSTRUCTION` (`chatRunner.cjs:259-270`) interpolates the actual remaining
  budget derived from `KILL_CEILING_MS` (not a hardcoded duplicate string) — e.g. append: "This
  turn is hard-killed after N minutes of wall-clock. Size every synchronous poll to finish inside
  that budget; if the work cannot fit, do the part that fits, report exactly what landed, and say
  what remains." `N` must be computed from `KILL_CEILING_MS` (e.g. `KILL_CEILING_MS / 60_000`), not
  a separately hand-written number, so the two can never drift.
- [ ] Unit test asserting the rendered prompt text contains the same minute value as
  `KILL_CEILING_MS / 60_000`.

## Ask 2 — warn before killing, don't just kill

- [ ] At ~80% of `KILL_CEILING_MS` elapsed, inject a turn-visible notice via the existing
  `chat:run:notice` channel (`chatRunner.cjs:415-423`) telling the model to wrap up and report
  current state now, before the hard kill fires at 100%.
- [ ] The hard kill at `KILL_CEILING_MS` (100%) is unchanged and still fires if the model doesn't
  wrap up after the warning — this is a warning, not a ceiling extension.
- [ ] Unit test: a run that receives the 80% warning and settles before 100% never reaches
  `doKill`; a run that ignores the warning still gets killed at the existing ceiling, unchanged.

## Ask 3 — make the kill message actionable

- [ ] Extend the `chat:run:error` payload (`chatRunner.cjs:492-497`) with: elapsed wall-clock time,
  the ceiling value, and the last N (e.g. 3) tool-use names/descriptions seen on the stream — reuse
  the existing `classifyToolUse` parsing (`chatRunner.cjs:~520`), do not write a second stream
  parser.
- [ ] The rendered kill message states something like: "Killed after 30m. Last actions: Bash(eas
  submit …). External side effects may have completed — verify before retrying." — concrete enough
  that a resumed turn can decide to verify before repeating a potentially-irreversible operation.
- [ ] Unit test: given a mocked stream with known recent tool_use events, the emitted
  `chat:run:error` payload includes the elapsed/ceiling/last-tool-uses fields, and the rendered
  message string names at least one of the last tool uses.

## Tests

- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run` on `chatRunner`'s existing test file(s) — find the existing
  `chatRunner*.test.cjs` file(s) under `src/main/__tests__/` and extend them; don't create a
  parallel test file for the same module

# Implementation notes

Read `src/main/chatRunner.cjs` in full first — `KILL_CEILING_MS` (:303), `CHAT_MODE_TRUTH_INSTRUCTION`
(:259-270), the kill timer arm/clear (:491-499, :604, :620), `doKill`/group-kill (:474-479,
`detached: true` at :459), the `chat:run:notice` channel (:415-423), `classifyToolUse` (~:520), and
the `chat:run:error` emission (:492-497). All three asks live in this one file.

The source report's full evidence table (file:line citations, the redundant-`eas submit`-3x
external proof, the stranded-output-file interaction) is in
`session-manager-operations/feedback/processed/2026-07-28-chat-kill-ceiling-invisible-to-model.md`
(this repo's own archive) — read it for full context on why each ask matters, not just what to
change.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it
has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this
PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify
before done, the finish-protocol sentinel).

# Out of scope

- Ask 4 (making `KILL_CEILING_MS` configurable via an env override, e.g.
  `SM_CHAT_KILL_CEILING_MIN`) — the filer explicitly flagged this as a genuine open design question
  ("raising the ceiling trades away the runaway-run protection it exists to provide") for bilko to
  decide, not to guess at here
- Any change that routes the user to the raw terminal experience instead of fixing chat mode — the
  filer explicitly ruled this out as an acceptable answer
- Changing the resume-vs-create session logic (`src/renderer/state/chat.ts:269-279`) — already
  confirmed working correctly by the source report

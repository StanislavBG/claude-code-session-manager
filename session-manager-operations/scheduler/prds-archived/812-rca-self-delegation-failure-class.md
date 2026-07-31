---
title: "RCA classifier: add a deterministic SELF_QUEUE failure class for self-delegation/fire-and-wait runs"
cwd: ~/Projects/session-manager
parallelGroup: 812
estimateMinutes: 20
---

# Goal

`classifyFailure()` in `src/main/lib/rcaFeedbackHook.cjs:120-148` deterministically buckets a
`needs_review` job's log tail into one of `STUCK_LOOP` / `POST_AC_OVERRUN` / `UNCOMMITTED` /
`NO_SENTINEL` / `TRANSCRIPT_ERRORS` / `UNKNOWN`. A distinct, now-recurring failure shape falls into
generic buckets today even though `standards.md`'s Execution-discipline section already names and
prevention-hints it under one rule ("You ARE the executor — never re-queue or self-schedule"): a
headless run either (a) invokes the `Skill` tool with `session-manager-dev:develop` or
`session-manager-dev:process-feedback` from inside its own execution, or (b) launches a
long-running command as a background task and then calls `ScheduleWakeup` to "check back later,"
ending its turn — in both cases the process exits with no next turn to resume it, so the work never
lands. Four confirmed instances this pass alone:
- `766-chat-needs-input-reply-in-context` (variant a — `Skill(session-manager-dev:develop)`,
  classified `no_verdict_sentinel`)
- `805-conversation-links-reuse-browser-and-editor` (variant a — same pattern)
- `771-run-screen-top-bar-safe-area-buffer` (variant b — backgrounded `eas-cli build` +
  `ScheduleWakeup(600s)`, misclassified `stuck-loop`/`transcript_errors` by the deterministic
  matcher because the PRD's own AC text happened to contain the word "sleep")
- plus the earlier-documented PRD 460 (variant a) and PRD 479 (variant b) incidents

The cause and the fix are already fully known and don't require an Opus investigation to name —
`scheduler.cjs:1805-1807`'s investigation-prompt guidance already tells the Opus investigator to
"recognize this as a self-delegation failure" when it sees variant (a); nothing today does the
equivalent deterministic recognition for either variant before the costlier LLM investigation step.

Add a `SELF_QUEUE` class to the deterministic classifier, covering both variants, so the auto-filed
RCA immediately carries the precise, already-known prevention hint instead of a generic or
(for variant b) actively misleading classification.

# Acceptance criteria

- [ ] New `FAILURE_CLASSES.SELF_QUEUE = 'self-queue'` in `src/main/lib/rcaFeedbackHook.cjs`
- [ ] `classifyFailure()` checks the log tail for this pattern BEFORE the `STUCK_LOOP` check (variant
  b below can otherwise false-match `STUCK_LOOP_RE` when the PRD's own AC text contains a word like
  "sleep" or "poll" — exactly what happened in the `771` instance cited above):
  - **Variant a (self-delegation):** literal substring `"Launching skill: session-manager-dev:develop"`
    or `"Launching skill: session-manager-dev:process-feedback"` (the exact tool-result text observed
    when the `Skill` tool fires — grep either cited feedback file's raw JSONL for
    `"Launching skill:"` to confirm before matching)
  - **Variant b (fire-and-wait):** the literal tool name `"ScheduleWakeup"` appearing as a
    `tool_use`/`name` value anywhere in the tail (grep the `771` RCA file's raw JSONL for
    `"ScheduleWakeup"` to confirm the exact shape) — this is deliberately name-only (not paired with
    "background", since `run_in_background` and `ScheduleWakeup` calls can be far apart in the
    transcript and the tail window is bounded); a false positive here is acceptably rare since no
    legitimate finish-protocol path calls `ScheduleWakeup`
- [ ] New `PREVENTION_HINTS[FAILURE_CLASSES.SELF_QUEUE]` covering both variants, quoting the
  standards.md rule directly: something equivalent to "This run either invoked /develop or
  /process-feedback from inside its own headless execution, or backgrounded a long-running command
  and called ScheduleWakeup to check back later — both are the 'you ARE the executor — never
  re-queue or self-schedule' anti-pattern. A headless PRD run must perform its own acceptance
  criteria directly and has no next turn to resume it (standards.md → Execution discipline)."
- [ ] Add a test proving the `STUCK_LOOP`/`POST_AC_OVERRUN` reordering above does not change any
  existing fixture's classification when no `SELF_QUEUE` marker is present
- [ ] Extend `src/main/__tests__/rcaFeedbackHook.test.cjs` with: a log-tail fixture containing the
  `"Launching skill: session-manager-dev:develop"` marker classifies as `SELF_QUEUE`; a
  `process-feedback` variant does the same; a fixture containing a `ScheduleWakeup` tool_use
  classifies as `SELF_QUEUE` even when the same tail also contains the word "sleep" (regression test
  for the `771` misclassification); an existing `NO_SENTINEL`/`STUCK_LOOP` fixture (if one exists)
  still classifies correctly when no `SELF_QUEUE` marker is present
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run src/main/__tests__/rcaFeedbackHook.test.cjs` passes

# Implementation notes

Read `src/main/lib/rcaFeedbackHook.cjs:66-148` (the `FAILURE_CLASSES`/`PREVENTION_HINTS`/
`classifyFailure` block) and `src/main/__tests__/rcaFeedbackHook.test.cjs` for the existing test
shape to extend — follow its fixture pattern exactly, don't invent a new test style.

For the exact marker text, grep these three feedback files (already in this repo's
`session-manager-operations/feedback/processed/` after this triage pass) for the literal JSON:
`2026-07-29-rca-766-chat-needs-input-reply-in-context-20260729T171.md` and
`2026-07-31-rca-805-conversation-links-reuse-browser-and-editor-20260731T043.md` both contain a
`"content":"Launching skill: session-manager-dev:develop"` tool_result line (variant a);
`2026-07-30-rca-771-run-screen-top-bar-safe-area-buffer-20260730T221.md`'s "Investigation analysis"
section documents the `ScheduleWakeup` call for variant b — its raw run log
(`~/.claude/session-manager/scheduled-plans/runs/2026-07-30T22-14-54-348Z/771-run-screen-top-bar-safe-area-buffer.log`,
if still on disk) has the actual `tool_use` JSON to confirm the exact field shape; if that log has
since been pruned, match on the plain string `"ScheduleWakeup"` in the tail, which is sufficient
given `ScheduleWakeup` is a real tool name that appears verbatim in its `tool_use` block regardless
of exact JSON structure. Match with a plain string/regex test over the tail (same technique
`classifyFailure` already uses for `STUCK_LOOP_RE`/`AC_CHECKBOX_RE` — no JSON parsing needed).

This does not change `scheduler.cjs`'s investigation-spawning logic (`buildInvestigationPrompt`,
`spawnInvestigation`) — the Opus investigation still runs and still authors the fix-PRD; this PRD
only sharpens the deterministic RCA doc's own "Likely failure class" section that gets written
before any investigation happens.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it
has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this
PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify
before done, the finish-protocol sentinel).

# Out of scope

- Changing `scheduler.cjs`'s Opus investigation prompt or spawn logic
- Any change to how/whether an auto-fix PRD gets generated for a `SELF_QUEUE` instance — the
  existing auto-fix pipeline already produces strongly-worded fix PRDs for this class (see
  `766-fix-chat-needs-input-reply-in-context.md` / `805-fix-conversation-links-reuse-browser-and-editor.md`
  in this repo's own `session-manager-operations/scheduler/prds/`) — leave that mechanism as-is
- Blocking or intercepting the `Skill` tool call itself at the harness level — out of scope for this
  repo, this PRD only improves post-hoc classification

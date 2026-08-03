---
title: Stop the Epic context digest from making a PRD executor answer the conversation instead of doing the PRD
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
---
# Goal

PRD 972's executor produced no code at all. Its final result text was a verbatim recap of the AUTHORING architect's conversation ("Three PRDs already authored and queued on this Epic: 974… 975… 976… Tracking these plus 972 to completion now") — it answered the Epic's discussion rather than implementing the PRD in front of it, then exited 0 after 5 turns and 34 seconds. Its meta.json shows `contextDigestApplied: true`. The Epic context digest injected by `lib/epicContextDigest.cjs` is drowning out the PRD's own instructions, turning an implementation job into a status-report job. Make the PRD the unambiguous task and the digest clearly subordinate background.

# Acceptance criteria

- [ ] Read the failing prompt first: reconstruct what was actually sent for slug 972-notify-epic-prd-path-and-epicid-fallback from `~/.claude/session-manager/scheduled-plans/runs/2026-08-03T03-44-58-361Z/972-*.log` (the JSONL contains the init event and the turns) and record, in the completion report, where the digest sits relative to the PRD body and how much of the prompt it occupies.
- [ ] The composed executor prompt puts the PRD's own Goal / Acceptance Criteria / Implementation notes FIRST, and any Epic context digest AFTER it, explicitly fenced and labelled as background that must not be treated as the task — e.g. a header stating the digest is prior conversation for context only and that the executor's deliverable is the PRD above.
- [ ] The digest is bounded: assert a hard character cap in `lib/epicContextDigest.cjs` (or its caller) so the digest can never exceed a defined fraction of the prompt. State the chosen cap and its rationale in a code comment. Verify against the real digest size measured in AC #1 rather than picking a number blind.
- [ ] The prompt ends with the PRD's own task restated as the final instruction — recency matters, and a digest that ends the prompt is what invites a conversational reply.
- [ ] New unit test over the prompt-composition function: given a PRD body and an Epic digest, the returned prompt has the PRD body before the digest, contains the digest's background-only framing header, and ends with the PRD's task restatement.
- [ ] New unit test: a digest longer than the cap is truncated to the cap and marked as truncated, and the PRD body is never truncated to make room for it.
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass.

# Implementation notes

Main-process only. Read the appended standards file first.

EVIDENCE — verify before relying on it:
- `~/.claude/session-manager/scheduled-plans/runs/2026-08-03T03-44-58-361Z/972-*.meta.json` has `"contextDigestApplied": true`.
- The same run's final `{"type":"result"}` JSONL event has `"num_turns":5`, `"duration_ms":32447`, `"terminal_reason":"completed"`, `"subtype":"success"`, and a `result` string that is a project-status recap about PRDs 974/975/976 — not an implementation report. No Edit/Write tool calls landed.

Key files/lines:
- `src/main/lib/epicContextDigest.cjs` — `buildContextDigest`, the digest builder.
- `src/main/scheduler.cjs:90` — the import; `:2158-2164` — where `contextDigestApplied` is set and the digest is folded into the prompt. That composition site is the primary thing to restructure.
- `src/main/scheduler.cjs`'s `FINISH_PROTOCOL` (exported at :4601) — the finish-protocol text the executor is supposed to follow. Part of why this run failed is that it never reached the protocol at all (hence `no_verdict_sentinel`); making the PRD task terminal in the prompt should make reaching it far more likely.

Why the digest exists at all: an executor benefits from knowing why its PRD was written. The fix is ordering, framing, and bounding — NOT deleting the digest. Do not remove the feature.

Related: PRD 983 (`verdict-downgrade-must-stick`) fixes the detection side — that a no-op run got recorded green. This PRD fixes the cause side — why the run was a no-op. They are independent and both wanted; do not merge them or assume the other has landed.

# Out of scope

- Removing the Epic context digest feature
- Changing runVerify.cjs or the commit guard (that is PRD 983)
- Re-implementing PRD 972's notify fix (separate PRD)
- Changing which model executors run with

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

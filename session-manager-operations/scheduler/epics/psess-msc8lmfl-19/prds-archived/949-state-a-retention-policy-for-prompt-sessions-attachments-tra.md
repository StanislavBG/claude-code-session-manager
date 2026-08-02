---
title: State a retention policy for prompt-sessions/ (attachments, transcripts, archived Epic JSON)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: psess-msc8lmfl-19
---
# Goal

session-manager-operations/prompt-sessions/ is 43M — by far the largest namespace under session-manager-operations/, dwarfing scheduler/ (3.0M) and feedback/ (2.9M) combined. Unlike those two (which PRD 948 already gave an explicit "keep indefinitely, no auto-prune" retention policy per ops-maintenance-protocol.md Pattern E), prompt-sessions/ has no stated retention policy anywhere: not in its own README.md, not in CLAUDE.md, not in code. It holds three growing, unbounded categories: attachments/ (pasted images, 4.8M/26 files), transcripts/ (JSONL session logs, 664K/57 files), and 50 top-level archived Epic JSON files. Nothing currently prunes any of these. Decide and document an explicit policy the same way PRD 948 did, rather than leaving this the one namespace with no answer to "how long do we keep this."

# Acceptance criteria

- [ ] Read session-manager-operations/prompt-sessions/README.md and CLAUDE.md's prompt-sessions bullets for current documented lifecycle (archived Epics are already described as archived-not-erased; this PRD is about how LONG, not about changing that mechanism)
- [ ] session-manager-operations/prompt-sessions/README.md states an explicit retention policy for: (a) archived Epic JSON files at the top level, (b) attachments/, (c) transcripts/ — each can have a different answer (e.g. 'keep indefinitely' like PRD 948's namespaces, or a time-boxed rule) but each must have SOME explicit answer instead of silence
- [ ] If a time-boxed/pruning policy is chosen for any category, implementing the actual pruning mechanism is OUT OF SCOPE for this PRD (docs-only, same as PRD 948) — note any chosen pruning rule as a follow-up needing its own proposed Epic, per ops-maintenance-protocol.md's rule against unilateral file-age/size-based deletion
- [ ] npm run typecheck passes (should be a no-op since this PRD is expected to be docs-only)

# Implementation notes

Relevant files: session-manager-operations/prompt-sessions/README.md, CLAUDE.md's prompt-sessions/Epic-lifecycle bullets, session-manager-operations/architecture/ops-maintenance-protocol.md Pattern E (the original finding this generalizes), and PRD 948 (session-manager-operations/scheduler/epics/psess-msc8lmfl-19/prds-archived/948-state-a-retention-policy-for-feedback-archived-and-scheduler.md) as the precedent to follow for tone/structure. This is docs-only — no code changes expected.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

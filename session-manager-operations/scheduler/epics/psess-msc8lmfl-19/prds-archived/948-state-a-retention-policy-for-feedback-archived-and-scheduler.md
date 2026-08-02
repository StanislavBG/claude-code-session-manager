---
title: State a retention policy for feedback/archived and scheduler/prds-archived
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msc8lmfl-19
---
# Goal

The ops-sweep skill (scripts/ops-sweep.cjs), run against this project's own operations folder, flagged Pattern E from ops-maintenance-protocol.md as still open: session-manager-operations/feedback/archived-2026-08-02/ (71 files) and session-manager-operations/scheduler/prds-archived/ (179 files) both hold completed-work archives with no stated retention policy in their README — no answer anywhere to "how long do we keep this, and who/what prunes it." Left unaddressed, both will grow forever.

# Acceptance criteria

- [ ] session-manager-operations/feedback/README.md states an explicit retention policy for archived-2026-08-02/ (e.g. keep indefinitely as historical record, or a time-boxed prune rule) and who/what enforces it
- [ ] session-manager-operations/scheduler/README.md states an explicit retention policy for prds-archived/ and who/what enforces it
- [ ] If a policy decides pruning should happen automatically, that's out of scope for this PRD (docs-only) — note it as a follow-up rather than implementing a pruning mechanism
- [ ] npm run typecheck passes (should be a no-op since this PRD is docs-only)

# Implementation notes

This is a docs-only PRD. Relevant files: session-manager-operations/feedback/README.md, session-manager-operations/scheduler/README.md, session-manager-operations/architecture/ops-maintenance-protocol.md Pattern E (the original finding). No code changes expected — the retention policy is a documented decision, not a new pruning feature.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

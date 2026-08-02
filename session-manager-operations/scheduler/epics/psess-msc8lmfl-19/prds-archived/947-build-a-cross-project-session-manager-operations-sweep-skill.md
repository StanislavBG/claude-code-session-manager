---
title: Build a cross-project session-manager-operations sweep skill implementing the ops-maintenance protocol
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 60
sourcePromptId: psess-msc8lmfl-19
dependsOn: [945-resolve-feedback-namespace-retired-in-one-claude-md-sentence, 946-ops-folder-hygiene-audit-legacy-scheduler-prds-backlog-and-o]
---
# Goal

session-manager-operations/architecture/ops-maintenance-protocol.md was authored this session by manually auditing this project's own operations folder against its source-of-truth hierarchy (code OWNERS table > CLAUDE.md > namespace READMEs > on-disk content), finding real drift (see Patterns A-E in that doc) using nothing but grep/Read/manual cross-referencing. Build the automated version: a new skill that runs the same protocol against ANY project's session-manager-operations/ folder, including projects with a different OWNERS vocabulary or no CLAUDE.md at all (Pattern F in the protocol doc is the generalization spec).

# Acceptance criteria

- [ ] Read session-manager-operations/architecture/ops-maintenance-protocol.md in full, especially Pattern F, before starting
- [ ] New skill (e.g. plugins/session-manager-dev/skills/ops-sweep/) that, given a target project cwd, reads that project's own CLAUDE.md (if present) and each session-manager-operations/<namespace>/README.md
- [ ] Diffs declared-vs-actual namespace ownership: does every top-level folder appear in either an OWNERS table or an explicit non-OWNERS doc list
- [ ] Flags contradictions between doc layers (the kind found this session: one doc says a namespace is retired, another says it's still owned)
- [ ] Flags namespaces with archived/processed content but no stated retention policy
- [ ] The skill's output routes every finding through THAT target project's own propose-epic mechanism (or, if the user explicitly says PRDs-on-this-session as this run did, prompts for that) — it must never delete or migrate files directly itself
- [ ] Runnable against a single project via manual invocation (a scheduled/cron sweep across active project cwds is an explicit stretch goal, not required for this PRD)
- [ ] npm run typecheck passes

# Implementation notes

Depends on PRDs 945 and 946 landing first so the sweep skill's own worked examples (feedback/ resolution, prds/ backlog classification) are settled facts, not open questions, by the time it's built. Read session-manager-operations/architecture/ops-maintenance-protocol.md fully — it's the spec. Existing skill shape to mirror: plugins/session-manager-dev/skills/propose-epic/SKILL.md (thin, single-purpose, calls a script). scripts/lib/watchdogHelpers.cjs's activeProjectCwds() pattern is the reusable piece if the stretch goal (cross-project scheduled sweep) is attempted.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

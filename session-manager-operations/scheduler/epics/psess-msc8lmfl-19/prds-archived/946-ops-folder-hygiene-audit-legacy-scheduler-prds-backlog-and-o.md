---
title: Ops-folder hygiene: audit legacy scheduler/prds/ backlog and orphaned prompt-sessions top-level JSON
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: psess-msc8lmfl-19
---
# Goal

Two open questions from session-manager-operations/architecture/ops-maintenance-protocol.md (Patterns C and D) need investigation before any deletion or migration is safe. Pattern C: CLAUDE.md claims the flat scheduler/prds/ layout is "RETIRED and auto-consolidated into prds-archived/ at boot," but scheduler/prds/ top-level still holds 73 files against 179 in prds-archived/ — determine whether boot consolidation is actually running/complete, or whether these are legitimately in-flight PRDs. Pattern D: 29 of 46 top-level prompt-sessions/*.json files have no matching scheduler/epics/<id>/ directory — most are probably Epics that never authored a PRD (harmless), but any with real PRD-dispatch history and a missing epics/ dir would indicate actual data loss and must never be deleted.

# Acceptance criteria

- [ ] Read session-manager-operations/architecture/ops-maintenance-protocol.md Patterns C and D before starting
- [ ] Cross-reference scheduler/prds/'s 73 top-level files against scheduler/state/ queue+history to classify each as: legitimately in-flight, or stuck legacy debt that boot consolidation is failing to migrate
- [ ] Write a script (or one-off analysis, documented in the run's report) that checks each of the 29 orphaned prompt-sessions/*.json files' own event chain for PRD-dispatch events, to separate 'never-started Epic, safe to note for a future retention policy' from 'had PRD history but its scheduler/epics/ dir is missing — real data loss, escalate, do not touch'
- [ ] Produce a written findings report (e.g. as a new file under session-manager-operations/architecture/ or session-manager-operations/reviews/) covering both patterns
- [ ] Only items unambiguously classified as safe (per the ops-maintenance-protocol.md source-of-truth rule: at least two of code/CLAUDE.md/README must agree) may actually be migrated/archived this PRD; everything ambiguous is reported, not deleted
- [ ] npm run typecheck passes if any script/source files were added

# Implementation notes

Relevant files: session-manager-operations/scheduler/prds/ (73 top-level files), session-manager-operations/scheduler/prds-archived/ (179 files), session-manager-operations/scheduler/state/queue.json + history shards, session-manager-operations/prompt-sessions/active-index.json (events keyed by epic id), session-manager-operations/scheduler/epics/ (35 directories), session-manager-operations/architecture/ops-maintenance-protocol.md Patterns C+D for the exact methodology already scoped out. Boot consolidation logic likely lives in scheduler.cjs or lib/prdLocations.cjs — check there for why 73 files weren't migrated.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

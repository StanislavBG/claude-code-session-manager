---
title: Resolve feedback/ namespace: retired in one CLAUDE.md sentence, still live in OWNERS/code/README
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 30
sourcePromptId: psess-msc8lmfl-19
---
# Goal

CLAUDE.md contradicts itself about session-manager-operations/feedback/: one bullet says it's "gone" (per the proposed-Epic migration), but the OWNERS bullet two paragraphs earlier still lists feedback → feedback as a live owner. Code confirms the split is real: config.cjs:139-146 still grants an active write path to session-manager-operations/feedback/ with a comment claiming rcaFeedbackHook.cjs uses it, and rcaFeedbackHook.cjs's own header says it no longer writes there (it files proposed Epics instead). feedback/README.md still instructs filing via the now-nonexistent /process-feedback skill, and 72 files sit on disk under the old convention. Decide the namespace's real status and make code, CLAUDE.md, and the README agree.

# Acceptance criteria

- [ ] Read session-manager-operations/architecture/ops-maintenance-protocol.md Pattern A for full context before starting
- [ ] Decide: (a) fully retire feedback/ — remove the OWNERS entry in opsOwnership.cjs and the write grant in config.cjs, archive the 72 existing files to a dated location, rewrite feedback/README.md to point at /propose-epic, or (b) keep it as a deliberate manual-only human inbox distinct from the RCA-hook path — rewrite feedback/README.md and the config.cjs comment to state that rcaFeedbackHook.cjs no longer writes there
- [ ] CLAUDE.md's two contradictory bullets (the OWNERS-table 'feedback → feedback' listing vs. the 'is gone' sentence) are edited to say the same thing, whichever option is chosen
- [ ] npm run typecheck passes if any .cjs/.ts files were touched

# Implementation notes

Relevant files: CLAUDE.md (both the OWNERS-table bullet and the "status: 'proposed' is the human gate" bullet), src/main/lib/opsOwnership.cjs (feedback → feedback entry), src/main/config.cjs:139-146 (write grant + comment), src/main/lib/rcaFeedbackHook.cjs (already-correct header comment describing current behavior — do not change its logic, only cross-reference it), session-manager-operations/feedback/README.md, session-manager-operations/architecture/ops-maintenance-protocol.md Pattern A (the audit that found this).

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

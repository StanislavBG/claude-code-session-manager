---
title: "Dispact as PRD" should really never be auto-selected and
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msa1saea-8
sourceTabId: psess-msa1n71r-4
---
# Goal

"Dispact as PRD" should really never be auto-selected and be explicit user command, I've gotten tricked that wy a few times 871 is example of it

# Acceptance criteria

- [ ] Implement the request described in Goal.
- [ ] timeout 300 npm run typecheck passes

# Implementation notes

Target project: /home/bilko/Projects/session-manager

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

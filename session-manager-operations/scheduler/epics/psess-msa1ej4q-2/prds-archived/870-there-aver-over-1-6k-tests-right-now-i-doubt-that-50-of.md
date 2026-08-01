---
title: There aver over 1.6k tests right now. I doubt that 50% of
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msa1ej4q-2
tag: feature
---
# Goal

There aver over 1.6k tests right now. I doubt that 50% of them are adding any value to the project. Look and opportunistically simplify

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

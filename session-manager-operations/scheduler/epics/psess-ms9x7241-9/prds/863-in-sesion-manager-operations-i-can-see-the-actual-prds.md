---
title: In sesion-manager-operations, I can see the actual PRDs,
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-ms9x7241-9
sourceTabId: epic-scheduler-integration-audit-follow-ups-sour-bf812a26
---
# Goal

In sesion-manager-operations, I can see the actual PRDs, but I;m not able to see the actual SESSION "prompts" from me and "responses" from the agent fully; This is used to then rebuild the context of the chat evertything is persistet so that it can used as grounding

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

---
title: I'm confused by the questions, we need to make sure that
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msa2be8f-1
tag: bug
---
# Goal

I'm confused by the questions, we need to make sure that only EPICS going forward from clear human intent working with the delop skill writ the PRDs I don't think there is any change to that a session authers works against scheduler MCP/API to submit new work and gives the session id, when work is done scheduler using the session id notifies the session so that the session can validate the work and/or modify as needed until the user review; So we need to make sure that no EPICs are automatically created and that the /develop can only be invovled from Epics

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

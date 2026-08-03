---
title: Document Agent-persona-as-session-defaults rule; scope effort/other settings as follow-up
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msckxplj-24
dependsOn: [agent-model-default-chat]
---
# Goal

Once agent-model-default-terminal and agent-model-default-chat land, CLAUDE.md's domain-model section is stale in two places: the "New Epic creation is two independent selections" bullet still says agentType "does not change which claude CLI process spawns", and the "Settings is substrate, not per-Epic curation" bullet (added for this same Epic) doesn't yet name the one exception. Update both, and explicitly scope what did NOT ship: effortLevel/fastMode/alwaysThinkingEnabled and the rest of Settings' "Model & Reasoning" group remain substrate-only (no --effort or equivalent CLI flag exists in this codebase today) — document that as a known gap for a future PRD once a CLI mechanism is confirmed, so the docs never overclaim "Agent controls all session settings."

# Acceptance criteria

- [ ] CLAUDE.md's 'agentType is optional and display-only beyond that: it does not change which claude CLI process spawns' sentence is corrected to state agentType now also sets the launched process's --model default (both Terminal and Chat views), pointing at src/main/lib/agentModelResolve.cjs
- [ ] The 'Settings (System/Project/Local scopes) is substrate, not per-Epic curation' bullet gains one sentence naming model as the one field carved out per-Epic by these two PRDs, and stating effortLevel/fastMode/alwaysThinkingEnabled/etc. remain substrate-only pending a confirmed CLI mechanism
- [ ] No source code changes in this PRD — docs only
- [ ] npm run typecheck passes (sanity check nothing else regressed)

# Implementation notes

Pure documentation PRD. Read the two CLAUDE.md bullets in full before editing so the new sentences fit the existing voice/density of that section rather than restating it. Read session-manager-operations/scheduler/PRD_AUTHORING.md conventions before implementing.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

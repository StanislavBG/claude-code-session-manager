---
title: Agent persona model flows into Epic's Terminal-view claude launch
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: psess-msckxplj-24
---
# Goal

Today `agentType` (the Agent Library persona chosen for an Epic) is purely a prompt-framing line — it never changes which `claude` process actually spawns (CLAUDE.md: "agentType is optional and display-only beyond that"). AgentPersona already carries a `model` frontmatter field (parsed in src/main/agentLibrary.cjs) but nothing reads it at Epic-launch time. Make the persona's `model` field become the real `--model` default for that one Epic's Terminal-view claude launch, establishing Agent-as-session-defaults as a real mechanism (per-Epic), not just framing text.

# Acceptance criteria

- [ ] lib/presets.ts's SessionPreset command builders (claudeDangerous, claudeSafe) accept an optional `model` field in their ctx and, when present, append a shell-quoted `--model <value>` to the rendered command
- [ ] The Epic launch path (EpicApprovalBar.tsx / EpicComposer.tsx / wherever the Epic's Terminal command is actually rendered/typed at Approve-and-start or New-Epic auto-start — trace via renderCommand/claudeDangerous/claudeSafe call sites) resolves the Epic's agentType persona via the existing agent-listing API (window.api.agents.listPersonas(), same call NewEpicCard already makes) and passes persona.model into ctx when it is set and not equal to 'inherit'
- [ ] When agentType is unset, or the persona has no model field, or model === 'inherit', the rendered command is byte-identical to current behavior (no --model flag)
- [ ] New/extended unit tests in lib/__tests__ cover: persona with explicit model appends --model; persona with inherit/absent model does not; no agentType does not
- [ ] npm run typecheck and npm run test:unit pass

# Implementation notes

Read CLAUDE.md's domain-model bullets on Agent/Tag and 'Settings is substrate, not per-Epic curation' before starting — this PRD is the first concrete exception to 'agentType is display-only'. Do not write to any settings.json (User/Project/Local) as part of this — the model flag is purely part of the one command string typed for this one Epic's launch, never persisted substrate. Do not touch the persona's `model` field's existing native Claude-Code meaning (Task-tool subagent model selection) — we are only adding a second consumer of the same field, which is safe since it's currently inert for top-level Epic launch. Read session-manager-operations/scheduler/PRD_AUTHORING.md conventions and this project's engineering standards file before implementing.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

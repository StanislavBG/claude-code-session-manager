---
title: Agent persona model flows into Epic's Chat-view (chatRunner) runs
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: psess-msckxplj-24
dependsOn: [agent-model-default-terminal]
---
# Goal

src/main/chatRunner.cjs hardcodes '--model', 'sonnet' (around line 528, comment "pinned per claude -p model pinning rule") for every headless Chat-view run, regardless of which Agent persona the Epic was created with. Chat and Terminal are documented as two VIEWS over the same one Epic session (CLAUDE.md), so they must agree on which model that Epic launches with. Extract the persona-model resolver built in PRD agent-model-default-terminal into a shared module and use it here too, so a Chat-view run of an Epic uses the same persona-derived model its Terminal view would.

# Acceptance criteria

- [ ] The model-resolution logic from agent-model-default-terminal is extracted into a shared module (e.g. src/main/lib/agentModelResolve.cjs) usable from both the renderer preset-command path and chatRunner.cjs, rather than duplicated
- [ ] chatRunner.cjs resolves the run's Epic (via its agentType, looked up the same way as the Terminal path) and passes that persona's explicit model as the --model flag value when set and not 'inherit'
- [ ] When resolution fails, or the Epic has no agentType, or the persona has no model/model is 'inherit', chatRunner falls back to the existing hardcoded 'sonnet' — --model is NEVER omitted (this preserves CLAUDE.md's 'Automation model pinning' rule: every claude -p call must pin --model explicitly)
- [ ] New test in chatRunner's test suite: an Epic with an agentType whose persona has model: opus results in spawned args containing ['--model','opus'] instead of the literal 'sonnet'; an Epic with no agentType or inherit still gets 'sonnet'
- [ ] npm run typecheck and npm run test:unit pass

# Implementation notes

Depends on agent-model-default-terminal landing first so the shared resolver module already exists — import and reuse it rather than re-deriving persona lookup logic. Keep the fallback to 'sonnet' hardcoded and explicit (never delete it) — the global CLAUDE.md rule is specifically about never leaving --model unpinned/inherited by the CLI's own default, and that must hold in every branch of this resolver. Read session-manager-operations/scheduler/PRD_AUTHORING.md and the engineering standards file before implementing.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: Default New Epic card's Agent selection to Architect instead of the empty placeholder
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msckxplj-24
---
# Goal

NewEpicCard.tsx's agentName state (line ~109) initializes to '' (empty string), which renders as an unselected 'Default' placeholder in the Agent column — no persona is actually chosen unless the user clicks one. Per this Epic's decision, Architect is the intended default Actor for a new Epic's whole conversation (its own persona description: "The primary Actor for an Epic's whole interactive conversation"). Make the New Epic card pre-select the 'architect' persona by default, so a new Epic opens already framed by Architect (and inherits its model: opus, set in this same Epic) unless the user explicitly picks a different Agent.

# Acceptance criteria

- [ ] NewEpicCard.tsx's initial agentName state resolves to 'architect' when an 'architect' persona exists in window.api.agents.listPersonas() results, instead of ''
- [ ] If no persona literally named 'architect' exists (e.g. a machine where it was renamed/deleted), fall back gracefully to the current '' / Default placeholder behavior — do not crash or show a broken selection
- [ ] The pre-selected Architect chip is visually indistinguishable from a user manually clicking it (same selectedAgent derivation at line ~151, same downstream framing-line composition via composeEpicIntake) — no special-cased code path for the default vs. a manual pick
- [ ] A user can still switch to 'Default' (no agent) or any other persona before submitting, exactly as today — this only changes the initial selection, not the available choices
- [ ] Existing NewEpicCard tests updated; a new test asserts a fresh mount pre-selects 'architect' when present in the mocked persona list
- [ ] npm run typecheck && npm run test:unit pass

# Implementation notes

Small, self-contained change — only the initial state derivation, not the selection mechanism itself. Resolve the default once the async listPersonas() call resolves (agents state), not synchronously at useState init (the list isn't available yet at mount). Read this Epic's prior PRDs (959-964) for context on why Agent now carries real session defaults (model, per agent-model-default-terminal) — defaulting to Architect means new Epics also default to opus unless the user picks otherwise, which is the intended combined effect. Read session-manager-operations/scheduler/PRD_AUTHORING.md and the engineering standards file before implementing.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

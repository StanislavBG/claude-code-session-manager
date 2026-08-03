---
title: Surface this Epic's Agent + resolved model inside EpicDetail — session config belongs in EPICS, not Home/Configure
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 30
sourcePromptId: psess-msckxplj-24
dependsOn: [agent-model-default-terminal]
---
# Goal

EPICS is this app's Session Home — every session-specific fact must be readable from inside the Epic itself, never only from a Home/Configure-face catalog tab. Today EpicDetail.tsx's header (line ~516-619) shows the Epic's Tag (EpicKindTag) and title/goal, but nothing for its Agent (agentType) or the model that Agent's persona resolves to for this Epic's actual claude launch (once agent-model-default-terminal lands). A user currently has no way to answer "which Agent / which model is THIS Epic running with" without leaving Epics and cross-referencing Agent Library. Add a compact Agent+model readout to EpicDetail's header, symmetric with the existing EpicKindTag, so this session-specific fact lives where the session lives.

# Acceptance criteria

- [ ] EpicDetail.tsx's header renders a small chip/tag next to (or beside) EpicKindTag showing the Epic's agentType persona name when set (fall back to nothing / 'Default' when unset, matching NewEpicCard's existing default-persona convention)
- [ ] When the resolved persona has an explicit model (not 'inherit'/absent), the chip also shows that model (reuse lib/prettyModel.ts for display formatting — do not reintroduce a local model-name-shortening copy)
- [ ] The chip is read-only display in EpicDetail — it is NOT an editor; it does not let the user change the Epic's agent/model mid-session (an Epic's agent/tag are fixed for its session lifetime per CLAUDE.md's Epic-lifecycle rule), it only answers 'what is this Epic actually running as'
- [ ] Clicking the chip navigates to Agent Library filtered/scrolled to that persona (read-only jump-to-definition), not an inline edit — editing still only happens in Agent Library per PRD agent-model-nav-consolidation
- [ ] Works for Epics with no agentType (pre-dates this feature or created via the scripted 'build' Epic path) without crashing or showing a broken chip
- [ ] Unit test coverage in EpicDetail's existing test suite for: persona set with explicit model, persona set with inherit/no model, no agentType at all
- [ ] npm run typecheck && npm run test:unit pass

# Implementation notes

This is a read-only display addition to EpicDetail's existing header, not a new nav destination or a new editor — keep it small (one chip), matching the visual weight of EpicKindTag it sits beside. Depends on agent-model-default-terminal (959) landing first so there is a real resolved model to show; if that PRD hasn't landed yet when this one runs, coordinate/branch off its resolver module (src/main/lib/agentModelResolve.cjs) rather than re-deriving persona lookup. Read this Epic's full PRD chain (959-963) and CLAUDE.md's domain-model section before implementing — this PRD is the 'read it back inside Epics' half of that chain's Agent+Tag/Settings rule. Read session-manager-operations/scheduler/PRD_AUTHORING.md and the engineering standards file first.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

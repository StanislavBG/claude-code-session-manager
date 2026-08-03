---
title: Move Model & Reasoning settings group from Settings tab into Agent Library persona editor
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: psess-msckxplj-24
dependsOn: [agent-model-docs-and-scope]
---
# Goal

Settings' "Model & Reasoning" group (lib/settingsGroups.ts's 'model' group: model, availableModels, modelOverrides, effortLevel, fastMode, fastModePerSessionOptIn, alwaysThinkingEnabled) is the one Settings group that is genuinely per-Agent-curatable, now that PRDs agent-model-default-terminal/-chat/-docs-and-scope have wired the persona's `model` field into an Epic's actual launch. Move editing of the WIRED subset into AgentLibrary.tsx's persona detail editor (where the user already edits that persona's description/tools/tags) and remove that group from Settings.tsx's default view, so the left-nav Settings tab no longer implies it controls per-session model behavior. The rest of Settings (Essentials' language/outputStyle/permissions, Git & Commits, Memory & Plans, Interface, Updates & Cleanup, Telemetry, App Prefs) is untouched — those remain legitimate machine/project substrate, the same category as the already-separate Permissions/Hooks/MCP Servers/Skills tabs, and Settings stays a real left-nav destination for them.

# Acceptance criteria

- [ ] AgentLibrary.tsx's persona detail editor surfaces the `model` field prominently as 'this persona's default model for its Epics' (it may already have a raw model field — verify and upgrade its presentation rather than duplicating)
- [ ] Do NOT add editor UI in AgentLibrary.tsx for effortLevel/fastMode/fastModePerSessionOptIn/alwaysThinkingEnabled/availableModels/modelOverrides — agent-model-docs-and-scope documented these as still substrate-only with no confirmed per-Epic CLI mechanism; adding controls for them would be dead UI
- [ ] lib/settingsGroups.ts's 'model' SettingGroup is removed from SETTINGS_GROUPS' primary (non-advanced) listing so Settings.tsx's default view no longer presents a curated Model & Reasoning card; the raw settings.json keys remain editable via Settings' existing raw/advanced JSON view for machine-wide fallback defaults (never fully hidden, just demoted out of the curated groups)
- [ ] navGroups.ts's 'settings' entry hint is reviewed and corrected if it implies model/reasoning control
- [ ] CLAUDE.md's Settings-substrate bullet gets a final one-sentence update: Model & Reasoning is now edited from Agent Library, not Settings
- [ ] Existing Settings.tsx and AgentLibrary.tsx unit tests updated for the moved group; npm run typecheck && npm run test:unit pass

# Implementation notes

This is a UI-relocation PRD, not a new mechanism — the model-resolution mechanism itself must already exist from agent-model-default-terminal/-chat before this PRD's editor move means anything. Read those three PRDs' outcomes first. Keep Settings' raw/advanced JSON editor as the escape hatch for the underlying settings.json keys (availableModels, modelOverrides, etc.) — this PRD narrows Settings' CURATED surface, it does not remove file-level access to those keys. Read session-manager-operations/scheduler/PRD_AUTHORING.md and the engineering standards file before implementing.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

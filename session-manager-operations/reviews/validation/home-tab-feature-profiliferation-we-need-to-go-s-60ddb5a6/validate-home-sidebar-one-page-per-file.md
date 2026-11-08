# Validation: Home sidebar one page per file

Base `1bc1ccf6` (from PRD notes) .. HEAD `85ef8e86`: 264 commits, 401 files. PRD files found in prds-archived/ (2702 under a timestamped subfolder; 2697/2704 each also have a `-fix-` PRD).

Gates re-run on HEAD (foreground): `npm run typecheck` exit 0; `npm run lint` exit 0 (page-stewards clean, e2e budget 18/19); `npm run lint:docs` exit 0; **full `npm run test:unit`: 952 files / 9052 passed, 1 skipped, exit 0** (first run, no re-run needed). Scoped vitest files were all covered by the full run. CLAUDE.md is 11,987 chars (budget 12,000).

## settings-page-tabs-permissions-hooks-raw — VERIFIED
- Settings.tsx:90,146-151 view = general/permissions/hooks/raw via ViewTabs; no tree view.
- Hooks.tsx:235 `HooksEventsEditor`, Permissions.tsx:128 `PermissionsRulesEditor` exported; 0 EffectiveTree refs in both.
- settingsGroups.ts:36 `OWNED_KEYS`, used at :239/:251 to hide owned keys in General.
- Settings.tabs.test.tsx exists; passes in full suite.

## extensions-page-skills-mcp-plugins — VERIFIED
- Extensions.tsx:17-35 tabs skills/mcp/plugins; SourceChips at :48 etc.; Add… opens libraries (Extensions.tsx:64).
- McpServers.tsx:680-697,285 project gating via `claudeConfig.patch` (disabledMcpjsonServers, enableAllProjectMcpServers).
- Extensions.test.tsx exists and passes.

## agents-page-personas-and-read-only-tags — VERIFIED
- TagLibrary.tsx: 0 `savePersona` references. AgentLibrary.tsx:169 ViewTabs; "Action button" hint absent.
- AgentLibrary.tsx:817 SourceChip uses the real `${selected.cwd}/.claude/agents/<name>.md`.
- AgentLibrary.tabs.test.tsx + TagLibrary.test.tsx pass.

## app-settings-page — VERIFIED
- AppSettings.tsx:6-12,78,120-126 mounts VoiceModal(page), TerminalAppearanceCard, SettingsTelemetry, SettingsRemote, SettingsUpdates, SettingsOpsRetention, DataModel.
- SettingsAppPrefs.tsx deleted; Settings.tsx has no telemetry/remote/app views (grep clean).
- AppSettings.test.tsx passes. (SourceChip path set not individually enumerated; spot-checked only.)

## dashboard-display-only — VERIFIED
- Home.tsx has no TerminalAppearanceCard/DataModelCard; slots shown as "N of M slots busy" text from useSessionSlots (Home.tsx:289-306), no range input/setter.
- screenComponents.tsx:96 renders `<Home onNavigate=…/>` only. Home's props are `HomeProps` with onNavigate only.

## nav-registry-home-14-to-8 — VERIFIED
- navGroups.ts home items: overview, projects, history, system-prompt, settings, extensions, agent-library, app-settings (exactly 8).
- navKey.ts has none of permissions/hooks/skills/plugins/mcp/tag-library/voice/data-model.
- .claude/agents has page-extensions.md and page-app-settings.md; retired page-* files gone; lint:page-stewards clean.
- delegationReadiness.cjs:338,545 now name "Extensions › Plugins", "Settings › Hooks".

## home-config-pages-user-scope-only — VERIFIED
- grep of ScopeSwitcher/manuallyTouchedRef/prevNavFaceRef in Settings, Permissions, Hooks, Skills, McpServers: no hits.
- Extensions.tsx:58-59 passes `scope="user"`.

## project-face-claude-config-page — VERIFIED
- screenComponents.tsx:22,111 `memory` → ProjectClaudeConfig. ProjectClaudeConfig.tsx uses useConfig loadText/saveText (:103-119, no force), SettingsEpicIsolation with epic-worktree-config.json path (:61), SourceChips. Test exists, passes.

## claude-md-insert-preset-inline — VERIFIED
- SystemPrompt.tsx:9,137 `InsertPresetMenu` (Library.tsx:620) using CATALOG_PROMPT_PRESETS and `findUnmanagedConflicts` lock (Library.tsx:625), disabled when conflicts; SourceChip at SystemPrompt.tsx:141. Tests pass.

## delete-retired-config-surfaces — VERIFIED
- `grep -rl` over src for ViewSwitcher, PluginsViewTabs, GlobalControlsSection, EffectiveTree: no files. EffectiveCards.tsx remains (not in scope). SessionManagerConfig.tsx has no Global Controls cards (only a prose comment at :64). Component tests pass in full suite.
- Run-report items (deleted-test list) are not re-derivable from the tree; not checked.

## docs-home-one-page-per-file — VERIFIED
- lint:docs exit 0. domain-model.md:59-63 Tags tab read-only; code-map.md:11 names `lib/claudeConfig.cjs` as the one writer.
- Not checked line-by-line: every architecture/manual chapter for retired page names (lint passes; no sweep run).

## Findings
### Critical
none.
### Important
none.
### Minor
- `src/renderer/components/screenComponents.tsx:42-44` — `ScreenRenderCtx` still declares `onNewSession`/`onOpenVoice`/`onOpenScheduler`, still threaded from App.tsx:723 and Workbench.tsx:96,324. PRD 2700 asked for them removed from "Home's props and screenComponents' call" (met); the ctx plumbing is now unused by Home and may be dead.
- `ProjectClaudeConfig`/`AppSettings` SourceChip path lists were spot-checked, not enumerated per the PRD's full list.
- Review skills (/code-review, /security-review) were not run separately; combined diff (401 files) self-reviewed via gates and greps only. No secrets/path-traversal concerns seen in the touched config-write paths (key-scoped `claudeConfig.patch`).

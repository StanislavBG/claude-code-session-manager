repo: StanislavBG/claude-code-session-manager
branch: main
path: src/renderer

## Last sync
date: 2026-11-21T20:05:00Z
### Updated in this project
- Final: Workbench Claude config for projects and Home (~/.claude), same components
- Home sidebar's CLAUDE.md / Settings / Extensions / Agents merged into one Claude config item
- Memory: suggestion with Apply / Edit first / Discard, plus the Edit mode editor

## Screen map
| Screen | Repo files |
|---|---|
| ConfigToday — page frame + tab strip | components/screenComponents.tsx, components/layout/SectionFrame.tsx, components/tabs/ProjectClaudeConfig.tsx, components/ui/ViewTabs.tsx, components/ui/SourceChip.tsx |
| ConfigToday — Memory | components/tabs/Memory.tsx, components/tabs/memory/explorer/MemoryExplorer.tsx, ExplorerNav.tsx, MemoryListPane.tsx, MemoryReader.tsx, LinksRail.tsx |
| ConfigToday — CLAUDE.md | components/tabs/ProjectClaudeConfig.tsx (ClaudeMdTab), components/tabs/editor/DocumentEditorPane.tsx, MarkdownToolbar.tsx, DocOutline.tsx, EditorStatusBar.tsx, components/ui/SaveBar.tsx |
| ConfigToday — Settings | components/tabs/Settings.tsx, components/tabs/SettingsEpicIsolation.tsx, components/ui/EffectiveCards.tsx, components/ui/Panel.tsx, components/layout/PageShell.tsx |
| ConfigToday — MCP | components/tabs/McpServers.tsx, components/tabs/extensions/McpServerDetail.tsx, components/tabs/extensions/ExtensionsToolbar.tsx, components/ui/Badge.tsx, components/ui/ProvenanceBadge.tsx |
| ConfigToday — Skills | components/tabs/Skills.tsx, components/tabs/extensions/SkillDetail.tsx, components/ui/Toggle.tsx, components/ui/ListDetail.tsx, lib/monacoPaperTheme.ts |
| Tokens / fonts / icons (all screens) | tailwind.config.js, src/renderer/fonts.css, src/renderer/styles.css, components/layout/AlmanacIcon.tsx |
| ConfigFolderTabs / ConfigLedger / ConfigWorkbench | redesigns built on all of the above |
| AppShell (window chrome around ConfigWorkbench) | components/TabBar.tsx, components/layout/AlmanacSidebar.tsx, components/layout/AlmanacFooter.tsx, components/ui/SlotDots.tsx |
| Claude Config Final (canvas) / ConfigWorkbench scope=global | components/tabs/SystemPrompt.tsx, components/tabs/Settings.tsx (scope user), components/tabs/Extensions.tsx, Skills.tsx, McpServers.tsx, Plugins.tsx, components/tabs/AgentLibrary.tsx, lib/navGroups.ts |
| AppShell face=home | components/TabBar.tsx (Home pill), components/layout/AlmanacSidebar.tsx (home face, NavGroupHeader), components/layout/AlmanacIcon.tsx |
| ConfigWorkbench step=read/running/verdict/done/edit/edit-fix (Memory check flow) | src/main/memoryAssist.cjs (proposeFix, runGated, FIX_POLICY), components/tabs/memory/explorer/MemoryReader.tsx, MemoryExplorer.tsx, LinksRail.tsx |

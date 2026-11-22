# Validation: Claude config wave 1

Base: dbbca0cb75483c6195967160d180cc6c4d08487a. Commits: 7a1efc0f (band), 385d8b21 (editor), 4937d9a5 (Home merge), ef5f84d0 (Project band).
PRD files: prds-archived/3298..3301.

Gates re-run in the foreground: `npm run typecheck` exit 0. `vitest run src/renderer/components/claudeConfig src/renderer/components/tabs src/renderer/lib` gave 222 files / 2057 tests passed (this covers the editor tests, ConfigBand, HomeClaudeConfig, ProjectClaudeConfig and the navGroups tests). `npm run lint`: every renderer lint step passes. The chain stops at `lint:test-smells`, which flags `src/main/lib/epic/__tests__/externalRef.test.cjs`. That file belongs to an unrelated feedback/externalRef commit (6251931c), not to any PRD here. I ran page-stewards, e2e-budget and scroll separately and all are clean. `lint:readme` was not run.

## claude-config-band — VERIFIED
- ConfigBand exports props {eyebrow,title,scopePath,tabs,activeKey,onSelect} (ConfigBand.tsx:18-36); `role="tablist"` and one `role="tab"` per entry (ConfigBand.tsx:91,99).
- The active tab renders as the raised `bg-bg` card (ConfigBand.tsx:107). Count chips are `font-mono` (:114). The attention dot is `data-testid=config-band-attention` (:121).
- No hex in any className (grep: none). Tokens only (`bg-fg`, `text-bg-hi`).
- ConfigBand.test.tsx exists (105 lines) and passes: labels/counts, click calls onSelect, aria-selected.
- The Search field and LEARN link are also rendered (:128-148). Gate green.

## doc-editor-design-chrome — VERIFIED
- DocumentEditorPane.tsx:46-47 defines the Document/Markdown segmented control, and one mode shows at a time (:10).
- Full screen overlay uses `Z.dialog` (:193). "← Exit full screen" is at :208-210. The Escape handler is at :124-128.
- EditorStatusBar.tsx:36-40 has the three save-state strings. Words and `~tokens` use chars/4 (:55). Revert and Save are `disabled={!dirty}` (:101-111).
- DocumentEditorPane.test.tsx was updated (+175 lines) and passes. Gate green.
- Minor: Save reads "Create file" in the `new` state. The PRD says "Save (Ctrl S)". This is a reasonable variant.

## home-claude-config-nav-merge — VERIFIED
- navGroups.ts has a single `claude-config` HOME entry with the specified hint. The four old rows are removed.
- HomeClaudeConfig.tsx:88-90 sets the eyebrow "CLAUDE CODE · GLOBAL", title "Claude config" and path `~/.claude`. It mounts the six tabs and takes counts from `useExtensionCounts()` and `useAgentPersonasState()`.
- `NAV_KEY_ALIASES` and `resolveNavAlias` map the four old NavKeys onto the matching tab (navGroups.ts diff). The `openPanel` hook is wired in layout.ts.
- Tests: HomeClaudeConfig.test.tsx and navGroupsClaudeConfig.test.ts pass. Gate green.
- Files touched beyond the PRD's # Files: navKey.ts, screenKeys.ts, layout.ts, learningContent.ts and the tests. These are needed for the alias wiring.

## project-claude-config-band — VERIFIED (with an Important note)
- ProjectClaudeConfig.tsx:53-58 defines exactly Memory, CLAUDE.md, Settings, MCP, Skills. The band has eyebrow "CLAUDE CODE · PROJECT" and `shortenHome(cwd)` as its path. Live counts come from a window.api reader (:164).
- The nav hint reads "This project's own files — CLAUDE.md, CLAUDE.local.md, settings, MCP, skills". The em dash is as specified.
- ProjectClaudeConfig.test.tsx:170-173 asserts Plugins/Agents are absent. Gate green.
- The old tab-header row is gone. A thin `SourceStrip` remains (ProjectClaudeConfig.tsx:362-371), still using ViewTabs (the Project/Local scope switch) and SourceChip. See Findings.

## Findings
### Critical
- none
### Important
- ProjectClaudeConfig.tsx:362-371: the AC says the "old ViewTabs/SourceChip header row is removed". ViewTabs and SourceChip still render in a source strip under the band. The tab row itself is replaced by ConfigBand, and the strip serves the scope switch and file chips. I judged this the intended outcome (the file's own doc comment calls it a "thin source strip"), but a literal reading of the AC would flag it.
- Repo `npm run lint` is red on `src/main/lib/epic/__tests__/externalRef.test.cjs` (no-assert smell). It is outside this plan and blocks the lint chain, so someone should fix it.
### Minor
- Per-PRD "Files" lists were exceeded by the alias wiring (see above). Each PRD's report was expected to say so.
- `lint:readme` was not run.

# Validation — Claude config redesign, wave 2

Base: 1bc9a8f85163cf8ba2473063b0e2eccdfd197416. PRDs live in `prds-archived/3341..3351`. The combined diff since base is wide (93 files in `src/`, other Epics included); only the PRD paths were judged.

## Gate results (re-run, foreground)
- `npm run typecheck` → exit 0 (renderer + main).
- `lint:selectors` OK (793 files), `lint:hooks` OK (410), `lint:scroll` OK, `lint:docs` OK. Full `npm run lint` not used (base-red on `externalRef.test.cjs`, another Epic).
- `npx vitest run src/renderer/components/claudeConfig src/renderer/components/tabs src/renderer/components/ui` (union of every PRD's vitest scope) → 116 files, 1083 tests, all pass.
- `/code-review` and `/security-review` were not run as separate commands; I self-reviewed instead (see Findings).

## Per PRD
- **claude-config-layout-kit — VERIFIED.** `claudeConfig/ConfigLayout.tsx:23,48,74,111,148,174,189` export all 7 primitives. `ConfigLayout.test.tsx:65-92` covers select, aria-selected, filter, primary. No raw hex in added `className` lines (diff grep clean).
- **doc-editor-changed-marks — VERIFIED.** `changedLines.ts:18,60` export `changedLines` and `changedBlocks`. `DocumentEditorPane.tsx:102,128-133` take the optional `changedFrom` and derive both. `CodeEditorPane` takes `markedLines`. `changedLines.test.ts` is present. Editor tests pass.
- **claude-md-tab-design — VERIFIED.** `ClaudeMdWorkbench.tsx` has EVERY SESSION LOADS (:195), 'Imported · editable here' (:362), the 'Loaded in every session' pill (:382) and 'Just start typing' (:412). The /init button is omitted (note :14). `SystemPrompt.tsx:65` and `ProjectClaudeConfig.tsx:224` use it. The test file exists and passes.
- **settings-tab-design — VERIFIED.** `Settings.tsx` has ConfigWorkbench (:489), 'Search N settings' (:313), the n OF m SET eyebrow (:385), Show unset / Advanced (:390-391), Raw JSON (:358), and radio rows driven by `onScopeChange` (:95-135). `ProjectClaudeConfig.tsx:256` passes scope and `onScopeChange`. `SettingsDesign.test.tsx` (184 lines) passes.
- **mcp-tab-design — VERIFIED.** `McpServers.tsx:5,539,549,711` (ConfigWorkbench, McpProjectGating kept, 'Check all N'). `McpServerDetail.tsx` has COMMAND / ENVIRONMENT / TOOLS, `+N more` (:578), 'Check again', 'Edit JSON'. Checks run on click only (:372 comment). The `McpServerDetail` overflow test exists and passes.
- **skills-tab-design — VERIFIED.** `Skills.tsx:5,680` (SKILLS FOLDER card). `SkillDetail.tsx:217` has the 'CLAUDE READS THIS TO DECIDE WHEN TO USE IT' card, and the body rejoins frontmatter byte-for-byte (:132, :251). The Enabled toggle reuses the existing `disable-model-invocation` mechanism (present at base), so no key was invented. `Skills.scenario.test.tsx:633` is the frontmatter-unchanged save test.
- **plugins-tab-design — VERIFIED.** `PluginDetail.tsx:36,258,265,275,315` have the saved line, DESCRIPTION, WHAT IT ADDS, 'Open in Skills →' and INSTALLED AT. `PluginMenu.tsx` has Reveal, Copy path, Uninstall. 'Up to date' is deliberately omitted (:10). `Plugins.enable.test.tsx` covers the toggle write.
- **agents-tab-design — VERIFIED.** `AgentLibrary.tsx:5` (ConfigWorkbench) and `TagLibrary` kept. `AgentDetail.tsx` has Duplicate, ⋯ with Delete, the DESCRIPTION card, MODEL/EFFORT/RUNS ON/TOOLS/PROJECT OVERRIDES, `DocumentEditorPane` (:404) and Revert/Save. The override test sits at `AgentLibrary.projectOverride.test.tsx` and `AgentLibrary.test.tsx:38`.
- **memory-tab-design — VERIFIED.** `MemoryListPane.tsx:62` (MEMORY FOLDER card, Scope picker, chips :40-44). `MemoryReader.tsx` has the eyebrow (:54), Read | Edit (:116-129). `LinksRail.tsx:96,140,185-195` have LINKS TO, LINKED FROM, ASK CLAUDE, 'Check against the repo'. `MemoryExplorer.shell.test.tsx:180` covers Edit switching to the editor with the file text.
- **memory-check-suggestion — VERIFIED.** `MemorySuggestionCard.tsx:39-42,94,100` have the headline, note, Edit first and Discard. `MemoryReader.tsx:100-104` have the 'Suggestion ready' and "Editing Claude's update" pills. `LinksRail.tsx:39,48,160` have CHECKED IN, Evidence and 'Started from Claude's update'. `MemoryExplorer.tsx:273,346` pass changedFrom and `lineDiff`. `reader.test.tsx:259-309` cover diff, Discard, Edit first, Apply once.
- **project-config-source-strip-removal — VERIFIED.** `ProjectClaudeConfig.tsx` has no `SourceStrip`, no `project-claude-config-source` and no `ViewTabs`. The Epic isolation strip stays (:32, :253). `mdScope`/`settingsScope` remain at :266-267 because the radio rows now use them (not unused). `ProjectClaudeConfig.test.tsx:189-235` assert the strip is absent and all five tabs mount.

## Findings
- **Critical:** none.
- **Important:** none.
- **Minor:**
  - `/code-review` and `/security-review` were not invoked; the self-review found no secrets, path-traversal or unsafe-input problems. New code only reads and writes through the existing `window.api` calls.
  - `AgentLibrary.test.tsx:38` is the only override-chip evidence I read directly. The chip assertion itself was not individually inspected, though the suite passes.
  - `Skills.scenario.test.tsx` and other test files fall outside the PRD `# Files` lists (3346 lists only Skills.tsx and SkillDetail.tsx). Acceptable under the "say why" rule; recorded here.
  - Visual match against `renders/` was not compared pixel-wise; judged by structure and strings only.

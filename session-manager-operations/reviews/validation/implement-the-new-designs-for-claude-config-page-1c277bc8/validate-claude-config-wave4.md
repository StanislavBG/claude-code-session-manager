# Validation — Claude config wave 4 (visual fixes)

Base: 6dbaebd96b89c3aec8098839dafe8c56e1a32737; HEAD at validation 04941c78. PRD files read from `prds-archived/` (3400–3413); none missing. Wave-4 commits are the `feat/fix(claude-config|editor|ui|mcp|skills|plugins|agents|memory)` commits between base and HEAD (cafddb66, aa0bc11f, 7f297156, eaabf9e2, e2ba85d1, bdd1a682, 096c36ec, 2e9d4333, 71e660cc, 71609070, f18760f7, c6bd6607, a3e880e5, faa39b13); other commits in the range (needs-you, history, transcripts, feedback) belong to other plans and were not judged.

Commands re-run (foreground): `npm run typecheck` exit 0; `npm run lint` (full) exit 0; `npx vitest run src/renderer/components src/renderer/lib` → 315 files passed, **1 failed** (see Important 1); `npx playwright test -c tests/web-ui/playwright.config.ts claude-config-shots` 1 passed, 11 PNGs written to `test-results/claude-config/`.

Review tools: `/code-review` and `/security-review` not run as skills; self-reviewed the renderer diff — no secrets, no path building from user input, no `scrollIntoView`; the new `@`-import node and masked header values only touch rendered text.

## config-band-counts — VERIFIED
- `HomeClaudeConfig.tsx:100-137` computes `claude-md` chip (`claudeMdChip`), Settings `asCount(files.settings)`, MCP `attention: mcpAttention`; shot shows "3 files", Settings "3" (home-claude-md.png).
- `ProjectClaudeConfig.test.tsx` covers 'missing', counts and both attention dots (green in isolation except Important 1's unrelated assertion); `HomeClaudeConfig.test.tsx` +81 lines.
- `ConfigBand` band height matches render 10 (visual compare). Gate: typecheck/lint 0; claudeConfig + the two tab tests green except the stale line in Important 1.

## config-toggle-and-column — VERIFIED
- `Toggle.tsx:10,22-33` track + `bg-bg-hi` thumb, `role="switch"`, `aria-checked`; label outside the track. `ConfigLayout.tsx:3,7-8,28` `w-[318px]`, cites design-mocks/claude-config. `ui/__tests__/Toggle.test.tsx` (+91). Shots: "Show unset"/"Advanced"/"Enabled" no longer clipped.

## doc-editor-toolbar-outline — VERIFIED
- home-claude-md.png: "Heading 1 ▾", B, I, </>, •List, 1.List, Quote, Link; Outline closed; THIS FILE panel gone. Tests `TiptapBody.toolbar.test.tsx` (+75), `MarkdownToolbar.test.tsx` (+91), `DocumentEditorPane.test.tsx`. editor vitest green.

## doc-editor-import-lines — VERIFIED
- `TiptapBody.tsx` custom import node (`data-sm-import`, `data-sm-import-marker`); shot shows two separate lines with orange `@`; `TiptapBody.imports.test.tsx` (+105) covers two blocks and byte-identical round trip; spec asserts two blocks.

## claude-md-workbench-polish — VERIFIED
- `grep SaveBar ClaudeMdWorkbench.tsx` empty; single footer "Saved · matches the file on disk" (home-claude-md.png); rows `rules/git.md`, `rules/writing.md`; project card "INSTRUCTIONS FILE", "Project · shared via git", "A session here loads"; missing file shows editor chrome, "Nothing tells Claude…", "Just start typing", footer "Create file Ctrl S", no /init (project-claude-md.png). Tests in `ClaudeMdWorkbench.test.tsx` green. Its stated gate (`vitest … src/renderer/components/tabs`) is now RED because of Important 1 (caused later by memory-page-polish).

## settings-row-model — VERIFIED
- `EffectiveCards.tsx`: no `Set to`/`save →` strings (grep empty); one control per row; ladder shows Default—User on Home and four scopes in project (shots); `Settings.tsx:214,263` schema reference moved into header ⋯; path chip row gone. `SettingsDesign.test.tsx` (+160), `EffectiveCards.shell.test.tsx` (+140) green. Same Important 1 caveat for the `tabs` gate.

## settings-epic-isolation-rail — VERIFIED
- `ProjectClaudeConfig.tsx:15,236` strip removed; `Settings.tsx:448` 'Epic isolation' rail entry (project only; shot shows it under Hooks); `SettingsEpicIsolation.tsx:3-5,71-73` ConfigDetailHeader + ConfigCard + Toggle. Tests in `SettingsEpicIsolation.test.tsx` green. Important 1 caveat.

## mcp-design-polish — VERIFIED
- project-mcp.png: "Auto-approve all servers" toggle in SERVER FILE card, "Approved" toggle in detail header; home-mcp.png: copy icon, footer "Saved — matches ~/.claude.json" only, playwright listed first. `McpServers.test.ts` (+94), `McpServerDetail.test.tsx` (+69) green; `grep extensions-3a src` empty.

## skills-saved-state — VERIFIED
- home-skills.png / project-skills.png: footer "Saved · matches the file on disk", Save disabled, no unsaved dot; `SkillDetail.tsx` normalisation; `Skills.scenario.test.tsx` (+128) green.

## plugins-detail-polish — VERIFIED (control omitted in harness, per DESIGN_SPEC §5.4)
- `PluginDetail.tsx` compares installed vs marketplace version via `lib/pluginMarketplaces.ts`; `PluginDetail.test.tsx` (+165) covers both states and manifest order; shot has no control because the harness has no marketplace version (allowed). `PluginMenu.tsx` cites claude-config. See Minor 3 (extra file touched).

## agents-config-card — VERIFIED
- home-agents.png: three selects MODEL/EFFORT/RUNS ON in one row, all nine tool chips filled with "All tools" note, inline override line with "+ Add override", Details row, editor directly below, Personas|Tags inside the AGENTS FOLDER card. `AgentLibrary*.test.tsx` green.

## memory-page-polish — VERIFIED (but left a failing test elsewhere, Important 1)
- `ExplorerNav.tsx` deleted; project-memory.png has no inner header or nav rail, "Clusters 0" chip, full title, no path footer. MemoryExplorer shell/nav/listPane tests green (its gate passes).

## claude-config-design-citations — VERIFIED
- `grep -rn extensions-3a src` → no hits (SectionFrame.tsx, useFileAges.ts now cite DESIGN_SPEC.md).

## claude-config-shots-assertions — VERIFIED
- Spec (+104 lines) asserts: band chips/counts (l.64-65, 249-250), one `editor-status-bar` (l.45), Outline closed, two `[data-sm-import]` blocks (l.79-84), no `Set to:` (l.53), ladder stages (l.55-57), Auto-approve (l.199), three selects + order (l.129-135), `mx-list-folder-count` (l.157), 'Create file' (l.175). Gate re-run: 1 passed.

## Wave-3 findings 1–33 vs shots (each `test-results/claude-config/*.png` against `renders/NN-*.jpg`)
Pairs: home-claude-md/10, home-settings/11, home-mcp/12, home-skills/13, home-plugins/14, home-agents/15, project-claude-md/06, project-settings/07, project-mcp/08, project-skills/09, project-memory/05. Harness chrome and sample data are not findings.

1. FIXED — "3 files" chip, Settings count "3"; MCP amber dot needs a failed/auth check result (none in harness; rule unit-tested).
2. FIXED — rows read `rules/git.md`, `rules/writing.md`.
3. FIXED — two lines, orange `@` markers.
4. FIXED — explainer, Insert preset button and age chip gone from the detail.
5. FIXED — toolbar and closed Outline match.
6. FIXED — one footer, "Saved · matches the file on disk".
7. FIXED — footer copy right on CLAUDE.md, Skills, Agents.
8. FIXED — terracotta track, white thumb, no overlap.
9. FIXED — one control per row, no Set to / save buttons / chips.
10. FIXED — Home ladder Default—User only.
11. FIXED — no path chip row or schema link; Output style shows `default` select.
12. FIXED — now the "Epic isolation" rail entry (DESIGN_SPEC §5.6, deviation).
13. FIXED — no OVERRIDING chip.
14. FIXED — copy icon; clean footer only.
15. FIXED — playwright first; attention dot depends on check state (not in harness).
16. FIXED / §5.5 deviation — Auto-approve toggle + Approved toggle. Headers card masked row not in shot (stub has no headers; sample data).
17. FIXED — toggles correct.
18. DEVIATION §5.2 — Slash commands / From plugins kept.
19. FIXED — Saved state on first load.
20. FIXED — no dot on the selected row.
21. FIXED / §5.4 deviation — control omitted without marketplace version; command order is manifest order (sample).
22. DEVIATION §5.3 — Personas|Tags now in the AGENTS FOLDER card.
23. FIXED — three compact selects.
24. FIXED — inline chip row (empty in stub; "+ Add override" shown).
25. FIXED — editor follows config card.
26. FIXED — all tools filled with "All tools" note.
27. FIXED — no inner header or rail.
28. FIXED — full title.
29. FIXED — no path footer.
30. FIXED — editor chrome, empty state, "Create file Ctrl S"; no /init per §5.1.
31. FIXED — "A session here loads".
32. FIXED — "INSTRUCTIONS FILE", "Project · shared via git".
33. FIXED — band density and 318px column match.
Still open from 1–33: none.

## Findings

### Critical
- none

### Important
1. `src/renderer/components/tabs/__tests__/ProjectClaudeConfig.test.tsx:299` still expects `mx-nav-all` (the Browse/Review/Clusters rail that memory-page-polish, commit a3e880e5, deleted). `npx vitest run src/renderer/components/tabs/__tests__/ProjectClaudeConfig.test.tsx` fails ("mounts all five tabs…": expected null not to be null; 1 failed / 16 passed). This test file is not in 3411's Files, and 3411's gate runs only MemoryExplorer tests, so it went unnoticed. The `src/renderer/components/tabs` gates of 3404, 3406 and 3410 (and 3405's `tabs` path) now exit non-zero at HEAD. Fix: assert the Clusters chip / folder card instead of `mx-nav-all`. Plan PRDs are still judged VERIFIED because each landed behaviour is proven in the tree and shots; the red test is the regression to fix next.

### Minor
1. `ProjectClaudeConfig.test.tsx:299` — same cause as Important 1 (listed once as Important).
2. Editor Document mode: bullets/numbers render black and the text column is full width; design renders orange markers and a ~720px centered column (home-claude-md vs 10, home-skills vs 13, home-agents vs 15). New, visual only.
3. Files changed outside their PRD's `# Files`: `src/renderer/lib/pluginMarketplaces.ts` (3409), `tabs/__tests__/Settings.tabs.test.tsx` and new `tabs/__tests__/_docPaneStatusBar.tsx` (3405/3404), `AgentLibrary.agentCli.test.tsx` and `AgentLibrary.modelPicker.test.tsx` (3410). Reasonable consequences, but the explanations were not in a record I could read.
4. Agents: native `<select>` chevrons and an unstyled "Personas | Tags" switch (home-agents.png) vs the design's styled selects and pill; the editor status bar sits at the bottom edge of the 1040px frame (home-agents.png).
5. MCP: the dashed "Tools appear after a check" card has no leading icon (design 08 has one); memory folder card path truncates to one line (design wraps). New, visual only.
6. `/code-review` and `/security-review` were self-reviewed here, not run as skills.

### New findings (one per line)
- N1 (Important) stale `mx-nav-all` assertion, `ProjectClaudeConfig.test.tsx:299`.
- N2 (Minor) editor list markers and column width differ from the design.
- N3 (Minor) Agents select chevrons / Personas|Tags switch unstyled.
- N4 (Minor) MCP "Tools appear after a check" icon missing; memory path truncated.
- N5 (Minor) files touched outside PRD `# Files` lists (see Minor 3).

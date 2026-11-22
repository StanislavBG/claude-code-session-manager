# Validation — Claude config wave 3

Base: 705248034a9261b05f0774d0a937a6449bd68db6 (HEAD at validation: cc90b575). PRD files read from `prds-archived/` (3366–3373); none missing.

Commands re-run (all foreground): `npm run typecheck` exit 0; `npm run lint` **full run exit 0** (explicit-any, main-ts-check, filenames, renderer-storage, test-smells, page-stewards, e2e-budget, scroll, readme all OK); `npx vitest run src/renderer` 347 files / 3309 tests passed; `npm run lint:docs` ok; `lint:page-stewards` clean; `lint:test-smells` OK; `npx playwright test -c tests/web-ui/playwright.config.ts claude-config-shots` 1 passed.

Review tools: `/code-review` and `/security-review` not run as separate agents; self-reviewed the renderer diff (no secrets, no path-building from user input, no `scrollIntoView`, store selectors return stable values). No Critical/Important issues found.

## config-search-index — VERIFIED
- `src/renderer/lib/configSearch.ts` exports `ConfigSearchTab`, `ConfigSearchItem`, `searchConfig`, `loadConfigSearchItems` (306 lines); item ids `claude-md:`, `settings:`, `mcp:`, `skills:`, `plugins:`, `agents:`, `memory:` (lines 134–294).
- `src/renderer/lib/__tests__/configSearch.test.ts` (198 lines) passes in the renderer suite (ranking, AND, blank, limit/total, order, throwing reader).
- typecheck, lint:selectors, lint:hooks exit 0 (inside `npm run lint`).

## config-search-wire — VERIFIED
- `src/renderer/state/configSearchFocus.ts` (22 lines) store with set/clear; consumed via `useConfigSearchFocus` in tabs.
- `ConfigBand.tsx` +234 lines results panel, `/` and Esc handling; `HomeClaudeConfig.tsx`, `ProjectClaudeConfig.tsx` wired; the three test files gained tests (diffstat +107/+76/+58); all green.

## config-search-select-extensions — VERIFIED
- Skills.tsx, McpServers.tsx, Plugins.tsx import `useConfigSearchFocus` (Skills:17, McpServers:24, Plugins:17); Skills/Mcp/Plugins test files each +27–31 lines (match + miss); green.

## config-search-select-docs — VERIFIED
- AgentLibrary.tsx (+20), Settings.tsx (+45, lint:scroll OK), MemoryExplorer.tsx (+27), ClaudeMdWorkbench.tsx (+45) select the item and clear; tests added in AgentLibrary, SettingsDesign, MemoryExplorer.shell, ClaudeMdWorkbench; green.

## retire-merged-page-dead-code — VERIFIED
- Deleted in diff: Extensions.tsx, ExtensionsToolbar.tsx, FolderTabs.tsx, ReferencedFilesPanel.tsx, their four tests, tests/web-ui/extensions-{shots.spec.ts,entry.tsx}. `grep -rln "/<Module>['\"]" src tests` empty for all five names.
- PluginCard.tsx / its test are not in the diff: already absent at base (no importer). screenMemoization.test.tsx updated; full renderer suite green.
- Residual `extensions-3a` citations remain (see Minor 1).

## claude-config-page-steward — VERIFIED
- `.claude/agents/page-claude-config.md` (90 lines) added; the four old stewards deleted; `scripts/check-page-stewards.cjs` no longer lists claude-config/FOLDED; `page-stewards.md` +4 lines; grep for the four retired names outside reviews/scheduler/git: no hits; lint:page-stewards and lint:docs pass.

## externalref-test-assert — VERIFIED
- `externalRef.test.cjs` +27 lines of assertions; `lint:test-smells` OK, `npm run lint` fully green, typecheck 0; no allowlist entry added.

## claude-config-shots — VERIFIED (spec gate); layout/copy mismatches listed below
- Spec passes; 11 PNGs written to `test-results/claude-config/` with the required names; spec + entry files exist (231/341 lines). Compared each PNG to `renders/NN-*.jpg`. Harness has no app chrome (tab bar, left nav, status bar) — not a finding. Counts/dates/sample items differing are ignored.

### Visual mismatches (each its own finding, Important unless noted)
1. home-claude-md: no "3 files" chip on CLAUDE.md tab; Settings tab has no count chip (design 13); MCP tab has no amber status dot.
2. home-claude-md: import rows read "git.md"/"writing.md" (design "rules/git.md", "rules/writing.md").
3. home-claude-md: `@` import lines render as one run-on line ("@~/…git.md @~/…writing.md"), design shows each on its own line with orange `@` marker.
4. home-claude-md: extra "User system prompt" explainer paragraph, "Insert preset" button and file-age chip not in design.
5. home-claude-md / home-skills / project-skills: editor toolbar differs (design: "Normal text ▾", B, I, </>, •List, 1.List, Quote, Link; built: B, I, H1–H3, bullets, `c`, </>, quote, link icon) and an always-open Outline sidebar + "THIS FILE" panel appear (design: closed, Outline is a toggle).
6. home-claude-md: editor has a duplicated footer (two status rows: "58 words · ~92 tokens" and "368 chars · ~92 tokens") with disabled Revert/Save, vs one footer with "Saved · matches the file on disk" and a Save Ctrl S button.
7. home-claude-md / skills / agents: no `CLAUDE.md •`/`SKILL.md •` filename-saved dot semantics match; footer lacks "Saved · matches the file on disk" copy (shows "Unsaved changes" in skills shots).
8. home-settings / project-settings: "Show unset" toggle knob overlaps the label text (renders "Show unset" with knob over "S"); same on Advanced knob style (black knob, no white thumb).
9. home-settings / project-settings: each row shows inline "Set to:" input + "save → User" button + SET IN USER/RESET chips + "details" link; design has a single select/text control per row and no chips/buttons.
10. home-settings: scope rail shows Default/User/Project/Local on Home; design shows only Default/User on Home.
11. home-settings / project-settings: extra path chip row ("~/.claude/settings.json · 4h ago") and "schema reference ↗" link, not in design; Output style row shows empty input instead of "default" select.
12. project-settings: an unstyled "Epic isolation" strip with a raw browser checkbox and long copy sits above the page body; absent from design.
13. project-settings: "OVERRIDING SCOPES" chip is unreadable (purple text on purple fill).
14. home-mcp / project-mcp: Copy button has no copy icon; Save/Revert buttons appear in the footer (design has only "Saved — matches …").
15. home-mcp: selected server (playwright) is listed last, design orders it first; status pill is "Not checked" (state difference — ignore) but there is no amber attention dot on the tab.
16. project-mcp: Auto-approve is a plain checkbox with an expanded APPROVED checkbox list; design is a single toggle row "Auto-approve all servers"; no "Approved" toggle in the detail header; Headers card has no masked `x-bot-id` row/Show (sample-data-adjacent, noted).
17. home-skills / project-skills: list-row toggles render with a dark knob and wrong sizing; detail "Enabled" toggle knob overlaps the label ("Enabled" clipped).
18. home-skills: extra "SLASH COMMANDS" and "FROM PLUGINS" sections below the list; not in design.
19. home-skills / project-skills: skill document body not in design shape: shows an outline panel and the "Unsaved changes" state with Save/Revert enabled on first load (design: Saved state).
20. home-skills / project-skills: list rows show an orange dot beside the toggle (unsaved marker) on the selected row.
21. home-plugins: "Up to date" chip missing in detail header; description shows "commit commands for Claude Code." (sample); command rows are sorted alphabetically, design order is /commit, /commit-push-pr, /clean_gone (sample-order, low).
22. home-agents: a "Personas | Tags" strip sits above the page (not in design).
23. home-agents: Model / Effort / Runs on rendered as chip rows with long help paragraphs, RE-CHECK button and a version row; design shows three compact selects.
24. home-agents: PROJECT OVERRIDES is a dashed card with a "Choose a project…" select; design is an inline chip row ("Self sonnet · medium ×").
25. home-agents: below Project overrides a NAME / COLOR / TAGS form follows and the agent prompt document editor (Outline/Document/Markdown + toolbar) is not visible in the 1040px frame; design shows the editor directly under the config card.
26. home-agents: TOOLS chips are all unfilled ("0 of 9 granted"); design shows the granted tools filled (Read, Grep, Glob, WebFetch, WebSearch) — sample-data-dependent, noted.
27. project-memory: an extra second page header ("CONFIGURE Memory …" with its own "Search all memories" field) and a left BROWSE/REVIEW/CLUSTERS rail appear; design has neither (only the band and the folder card).
28. project-memory: the detail title is truncated ("portfolio-action-proj…"); design shows the full name.
29. project-memory: a file-path footer bar spans the document pane; absent from design.
30. project-claude-md: empty state omits the "Draft it with /init" primary button, the editor chrome (CLAUDE.md • header, Outline/Document/Markdown, Full screen, toolbar) and the "Create file Ctrl S" button; shows an extra "Project instructions" explainer paragraph.
31. project-claude-md: right-rail copy differs: "A session here loads" list (design) vs "EVERY SESSION LOADS" with `<project>/CLAUDE.md` / `<project>/CLAUDE.local.md` entries "edited here".
32. project-claude-md: folder card header reads "FILE + ITS IMPORTS" (design "INSTRUCTIONS FILE"); row subtitle "Project · in git" (design "Project · shared via git").
33. home-claude-md / home-mcp / project-*: the band is shorter/denser and the file-card column is narrower than the design's main area (≈300px vs ≈318px on a 1592px frame) — low.

## Findings

### Critical
- none

### Important
- Visual findings 1–33 above (grouped as file-tab chrome, editor chrome, Settings row model, toggles, MCP Auto-approve, Agents config card, Memory page extras, project CLAUDE.md empty state). The gate does not assert them, so the plan's PRDs stay VERIFIED; next wave should own them.

### Minor
1. `src/renderer/components/claudeConfig/ConfigLayout.tsx:9`, `src/renderer/lib/useFileAges.ts:3`, `src/renderer/components/tabs/McpServers.tsx:43`, `src/renderer/components/tabs/plugins/PluginMenu.tsx:5`, `src/renderer/components/layout/SectionFrame.tsx:17`, `src/renderer/components/tabs/extensions/McpServerDetail.tsx:4` still cite `design-mocks/extensions-3a`; PRD 3370 asked restyled code to cite `design-mocks/claude-config`.
2. PRD 3370 lists `tabs/plugins/PluginCard.tsx` and its test for deletion but they were already gone at base; the report line naming that is not in the record.
3. `tests/web-ui/claude-config-shots.spec.ts` asserts band title, tab, eyebrow and no page error but no visual diff against `renders/`, so mismatches 1–33 pass the gate silently.
4. `npm run lint:docs` emits "link target is gitignored and absent" notes for `memory-clusters/README.md` and `ui-prefs/README.md` (pre-existing notes, not errors).
5. `/code-review` and `/security-review` were self-reviewed here, not run as skills.

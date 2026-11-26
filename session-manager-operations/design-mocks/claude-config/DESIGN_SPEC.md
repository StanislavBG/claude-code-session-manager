# Claude config (Home + Project) — implementation spec

Source: Claude Design project `85b9112c-928a-4519-934b-bc8aac6f4368` ("Claude project configs redesign"),
canvas `Claude Config Final.dc.html`, imported 2026-11-21 by Epic
`implement-the-new-designs-for-claude-config-page-1c277bc8`. Files are byte-exact copies
(the serve endpoint's injected `data-omelette-injected` tags stripped).

| File | What |
| --- | --- |
| `Claude Config Final.dc.html` | The canvas. **The decision record**: palette B ("dark band only") is the default. |
| `AppShell.dc.html` | Window chrome + sidebar around the page. Props: `face` (`project`/`home`), `tab`, `step`, `full`, `docmode`. |
| `ConfigWorkbench.dc.html` | **The page itself** (band, tabs, list/detail, Memory check flow). Read its `renderVals()` for every label. |
| `DocEditor.dc.html` | The one document editor (title bar, Document/Markdown, Outline, Full screen, status bar). |
| `config-data.js` | Sample data + `docView()` (outline, word/token counts, changed-line marking). Icon paths = `AlmanacIcon.tsx`. |
| `github.md` | Designer's screen → repo-file map. |
| `renders/NN-*.jpg` | 1910×1118 renders of every Final frame. **The visual target.** |

To re-render: serve this folder over HTTP (nested `dc-import` does not load over file://) and
screenshot `div[style*="width: 1910px; height: 1118px; border-radius: 12px"]` (26 frames; the first
8 are palette variants — ignore them).

## 1. Decisions (from the canvas text — do not re-litigate)

1. **One page, two scopes, same components.** Project tab → `Claude config` (scope = project cwd);
   Home → `Claude config` (scope = `~/.claude`, "applies to every project").
2. **Home: four sidebar items become one.** `CLAUDE.md` (system-prompt), `Settings`, `Extensions`,
   `Agents` (agent-library) merge into one `Claude config` item in the **Claude Code** nav group,
   subtitle `Your ~/.claude — CLAUDE.md, settings, MCP, skills, plugins, agents`. Home tabs:
   CLAUDE.md · Settings · MCP · Skills · Plugins · Agents.
3. **Project tabs:** Memory · CLAUDE.md · Settings · MCP · Skills. Plugins and Agents are machine-wide →
   Home only. **Memory is project-only** (Claude Code keeps one memory folder per project).
   Project nav subtitle: `This project's own files — CLAUDE.md, CLAUDE.local.md, settings, MCP, skills`.
4. **Color = palette B:** one dark left rail (`#2a221a`, `ClaudeConfigShell`: title, scope path, search, vertical tabs with count chips/attention dot, LEARN at the bottom); everything beside it is paper;
   the editor uses the app's paper code theme (`lib/monacoPaperTheme.ts`). No dark cards/chips/buttons.
5. **Every tab = file card + list on the left, detail on the right.** Code/commands sit in cards;
   each setting shows where its value comes from (source chip: User / Project / Local / Default / Not set).
6. **Every markdown file opens in the same document editor** (CLAUDE.md, SKILL.md, agent prompts,
   memory files), with a full-screen mode. One switch Document ⇄ Markdown, never side by side.
7. **Memory: check, then apply or edit.** "Check against the repo" returns ONE suggestion with its diff:
   **Apply**, **Discard**, or **Edit first** (editor opens with the change already in, touched line
   marked). The header's **Edit** opens the same editor on the file as it is.
8. Placeholder content in the mock (Home CLAUDE.md text, servers, skills, plugins, agent descriptions)
   is sample data — every list/count comes from the app's existing APIs.

## 2. Page frame (ConfigWorkbench)

- **Rail** (`ClaudeConfigShell`, dark, left, full height of main; replaces the mock's horizontal band): eyebrow
  `CLAUDE CODE · GLOBAL` (Home) / project equivalent, serif title `Claude config` + mono scope path
  (`~/.claude` or the project path), `Search all config  /` field, then the **vertical tabs**:
  icon + label + mono count chip per tab (CLAUDE.md shows `N files`; MCP shows a status dot when a
  server needs attention). Active tab = raised paper card. `LEARN` link (existing learn content) at the bottom.
- **Left column** (~300px): a **file card** (eyebrow e.g. `PLUGINS` / `AGENTS FOLDER`, count pill, mono
  path, one-line note such as `On/off is saved in settings.json › enabledPlugins`), then Filter field +
  one accent primary (`+ Add` / `+ New`), then the list (mono name, meta line, toggle where relevant;
  selected row = raised paper card).
- **Detail**: eyebrow (`PLUGIN · <marketplace> · <version> · USER SCOPE`, `AGENT · USER · <path>`),
  mono 28px name, actions right (`Enabled` switch, `Up to date`, `Duplicate`, `⋯`), then cards
  (`DESCRIPTION · <where it comes from>`, `WHAT IT ADDS`, `INSTALLED AT` + Reveal, model/effort/tools
  pickers for agents) and the doc editor for markdown bodies. Footer line: `● Saved — matches <file>`.

## 3. Document editor (DocEditor)

Title bar: file icon, mono file name, save-state dot (sage saved / honey dirty / accent new), path in
full screen; `Outline` toggle; `Document | Markdown` segmented switch; `Full screen` (full screen shows
`← Exit full screen  Esc`). Document mode = WYSIWYG (style menu `Normal text ▾`, B, I, `</>`, • List,
1. List, Quote, Link); frontmatter renders as a properties grid. Markdown mode = raw source with line
numbers + soft wrap, toolbar H1 H2 H3 **B** _I_ `code` - List 1. List > Quote [Link]. Changed lines
(Claude's suggestion) are marked in both modes (honey left rule / highlighted block). Outline panel:
headings + `THIS FILE  N lines · N words · ~N tokens in context`. Status bar: dot + `Saved · matches the
file on disk` / `Unsaved changes` / `New file · created on first save`, `N words · ~N tokens`, position
(`Ln x, Col y · Markdown` or `Document · saved as Markdown`), `Revert`, `Save  Ctrl S` (`Create file`
for new). Empty CLAUDE.md: serif prompt + `Draft it with /init` + `Just start typing`.

## 4. Code map (where each piece lands)

| Design | Repo today |
| --- | --- |
| Page frame, tab strip | `components/tabs/ProjectClaudeConfig.tsx`, `components/ui/ViewTabs.tsx`, `components/ui/SourceChip.tsx`, `components/layout/SectionFrame.tsx` |
| Home nav merge | `lib/navGroups.ts`, `components/layout/AlmanacSidebar.tsx`, `components/screenComponents.tsx` |
| CLAUDE.md | `ProjectClaudeConfig.tsx` (ClaudeMdTab), `components/tabs/SystemPrompt.tsx` (Home) |
| Doc editor | `components/tabs/editor/DocumentEditorPane.tsx`, `MarkdownToolbar.tsx`, `DocOutline.tsx`, `EditorStatusBar.tsx`, `TiptapBody.tsx` |
| Settings | `components/tabs/Settings.tsx`, `components/ui/EffectiveCards.tsx` |
| MCP / Skills / Plugins | `components/tabs/McpServers.tsx`, `Skills.tsx`, `Plugins.tsx`, `components/tabs/extensions/*` (Extensions 3a spec: `../extensions-3a/DESIGN_SPEC.md`) |
| Agents | `components/tabs/AgentLibrary.tsx` |
| Memory + check flow | `components/tabs/Memory.tsx`, `components/tabs/memory/explorer/*`, `src/main/memoryAssist.cjs` (proposeFix, runGated, FIX_POLICY) |

Tokens: reuse the extensions-3a token table (`../extensions-3a/DESIGN_SPEC.md` §6) — no raw hex in
className. The band's dark `#2a221a` = `bg-fg` with `text-bg-hi`.

## 5. Deliberate deviations (decided 2026-11-21, do not re-flag)

1. **No "Draft it with /init" button.** SINGLE-CREATOR LAW: only a human pressing New Epic starts a session, and
   no prefill entry point exists. The empty CLAUDE.md keeps the editor chrome, "Just start typing" and "Create file".
2. **Skills keeps "Slash commands" and "From plugins" list sections.** They are real files the design's sample
   lacked; they use the same row style as skills.
3. **Agents keeps the Personas | Tags switch** (TagLibrary), placed inside the AGENTS FOLDER card.
4. **Plugins shows "Up to date" / "Update available" only when the app can read the marketplace version**;
   otherwise the control is omitted.
5. **Project MCP approval** = one "Auto-approve all servers" toggle in the SERVER FILE card plus a per-server
   "Approved" toggle in the detail header (the settings keys the old gating checkboxes wrote).
6. **Epic isolation** (Session Manager's own worktree setting) is an "Epic isolation" entry in the Project
   Settings rail, not a strip above the page.
7. Sample-data differences (names, counts, dates, descriptions) are never findings.
8. **Memory list keeps its toolbar row** ("All memories N", Filter, "+ New", sort) under the chips: the same
   Filter + primary-action pattern every other tab's list column uses, so memories can still be created and sorted.
9. **Band → left rail; no page header above it on either face (owner request)** (decided 2026-11-26).

# Home ▸ Extensions 3a — implementation spec

Source: Claude Design project `0c6ed052-6c13-4aa4-be79-2fed69ad23a6` ("UI mockups for Extensions
tabs"), canvas `Extensions Tabs.dc.html` option **3a** = `ExtensionsMain.dc.html` with
`hideTitle: true`, imported 2026-11-07 by Epic `implement-the-final-3a-design-for-the-home-exten-c49a7e8c`.
Owner brief: make the 3 tabs clearly visible and follow the existing design; folder tabs (1b);
redesigned main area per tab (2a/2b/2c); drop the big "Extensions" title (3a) — the sidebar
already names the page.

| File | What |
| --- | --- |
| `extensions-3a-prototype.dc.html` | `ExtensionsMain.dc.html`, decoded verbatim. Opening it in Chromium (file://) renders 2a (title shown); 3a = the same with the `<h1>` removed (line 99) and the 8px spacer (line 100). |
| `support.js` | The design runtime. |
| `renders/NN-*.png` | 1440×900 renders of 3a. **The visual target.** `01-skills-source`, `02-skills-preview`, `03-mcp-servers`, `04-plugins`, `05-plugins-menu-open`. |

**Not product (ignore):** window tab strip (lines 18–30), sidebar (34–91), status bar (347–355),
the sample texts (skill body 160–200, fetch server data), Tweaks props `tab`/`counts`/`menu`.

## 1. Page frame (lines 93–114)

- Main padding 26/32/22. Row 1: eyebrow `CLAUDE CODE` (11px, 600, .08em, uppercase, faint) and
  right-aligned `LEARN` (11px, 600, accent, opens the page's existing learning content). **No h1.**
  8px spacer, then subtitle `Skills, MCP servers and plugins — each tab edits the real file Claude Code reads.` (14px, dim).
- **Folder tabs** (104–108): `role="tablist"`, margin-top 24, overlaps the panel by 1px
  (`-mb-px`, z above the panel). Active: h41, px20, `bg-bg-elev`, 1px accent border, 2px accent
  top, bottom border = `bg-elev` (opens into the panel band), radius 9 9 0 0, 14.5px semibold
  ink, count mono 11 semibold accent. Inactive: h38, transparent border, 14.5px medium dim,
  count mono 11 faint; hover `bg-bg-elev` + `border-line`. Counts: Skills = own skills + own
  commands (plugin items excluded), MCP = servers in `~/.claude.json` `mcpServers`, Plugins =
  installed plugins.
- **Sources** (109–111), right of the tabs, wrap allowed: per active tab
  `<mono ~path> · <age>`: Skills `~/.claude/skills`; MCP `~/.claude.json › mcpServers`; Plugins
  `~/.claude/plugins/installed_plugins.json` and `~/.claude/settings.json › enabledPlugins`.
  Age = file mtime as `just now` / `9h 31m ago` / `15d ago`; a missing file reads
  `created on first save`. Replaces today's SourceChip row.
- Panel (114): 1px `border-line`, `bg-bg`, fills the rest.

## 2. Shared panel chrome (all three tabs)

- **Toolbar band** (118–122, 215–220, 283–287): h44, `bg-bg-elev`, bottom `border-line`, gap 12,
  px12. Filter field 276×28 `bg-bg-hi` with search icon, placeholder `Filter skills and commands`
  / `Filter servers` / `Filter plugins`; summary text (faint): `<n> skills · <n> command(s) · <n> from plugins`
  / `<n> servers · <n> checked` / `<n> installed · <n> enabled`; MCP adds an outlined `Check all`;
  right-aligned **one accent primary** with a chevron menu: `+ New` / `+ Add server` / `+ Add plugin`.
- **Footer band** (205–209, 273–277) on Skills and MCP: h40 `bg-bg-elev`, sage dot +
  `Saved — matches the file on disk` / `Saved — matches ~/.claude.json` when clean; `Revert` and
  `Save` + kbd hint (`Ctrl S`, `⌘S` on macOS) greyed when clean; when dirty the existing SaveBar
  `unsaved` state and enabled buttons.
- List column 300px with a right `border-line`; section headers 11px 600 .06em uppercase faint +
  mono count; read-only groups carry a `READ-ONLY` outline badge (9.5px).

## 3. Skills (lines 116–211)

- List: `SKILLS n`; when 0, a dashed card: **No skills yet** / `A skill is a folder with a SKILL.md
  that Claude loads when a task calls for it.` / `Create a skill →` (starts New skill).
  `SLASH COMMANDS n`: cards (`bg-bg-hi`, border, radius 7): mono name `/<name>` 12.5 semibold +
  scope badge, description one line ellipsis. `FROM PLUGINS n` + READ-ONLY: one row per plugin
  `<plugin>   <n> skills · <m> commands ›`; expanding shows that plugin's items, selecting one opens
  it read-only (no Save/Revert, no Description edit).
- Detail: mono 18 semibold name + `SKILL`|`COMMAND` badge + scope badge; Source / Preview
  segmented control right. Grid `84px 1fr`: `DESCRIPTION` = editable field bound to the
  frontmatter `description`; `FILE` = mono path + `Reveal in File Explorer`.
- Editor (158–202): **light** (`bg-bg-hi`, border, radius 7 top). Source = the body only;
  frontmatter is edited through the fields and preserved verbatim on save. Preview = rendered
  markdown (serif headings, `bg-bg-elev` code blocks).

## 4. MCP Servers (lines 213–279)

- List: `IN ~/.CLAUDE.JSON n` rows (grid `8px 1fr auto`): status dot — hollow ring (not
  checked), `sage` (connected), red (failed), `honey` (needs auth); name 13; mono transport;
  line 2 = origin (`Anthropic` accent-dark / `Community` honey-dark / `Local`) · `not checked` |
  `connected · <n> tool(s)` | `failed` | `needs auth`. Selected row `bg-bg-hi` + border + semibold.
  `FROM PLUGINS n` + READ-ONLY: servers from enabled plugins, transport `plugin`, line 2
  `via the <plugin> plugin · <status>`. **A server is always selected** (first one by default).
- Detail: name 22 semibold + status pill (`● Connected` on `bg-sage/15 text-sage-dark`; failed /
  needs-auth / not-checked variants) + `checked <ago>`; row 2: provenance badge, transport badge,
  `User scope`, mono `~/.claude.json › mcpServers › <name>`. Right: `Check again`, `Edit JSON`.
  Sections: `COMMAND` (mono box `$ <command> <args…>` + `Copy`; http servers show the URL),
  `ENVIRONMENT` (KEY = value rows, values masked; empty = dashed `No variables set` + `+ Add variable`),
  `TOOLS n  from the last check` (rows: mono name 120px | description | mono `mcp__<server>__<tool>`;
  never checked = `Check this server to list its tools.`).

## 5. Plugins (lines 281–341)

- Cards (`bg-bg-hi`, border, radius 10, p 16/18, grid `36px 1fr auto`): enable switch; name 15
  semibold, mono version, provenance badge, scope; description 13; **contents chips** (h24 pill:
  mono count + label + `›`): skills / commands → Skills tab, MCP server → MCP tab; agents / hooks
  chips end in `↗` and open the Agents page / Settings ▸ Hooks. Cache path one quiet mono line.
  `⋯` menu: `Reveal in File Explorer`, `Copy path`, divider, `Uninstall <name>` (danger).
- Footnote: `Plugin contents also appear, read-only, in Skills and MCP Servers — tagged with the plugin that added them.`

## 6. Token mapping (no raw hex in className)

| Prototype | App token |
| --- | --- |
| `#f6efe1` page / panel | `bg-bg` |
| `#efe6d3` bands, active tab, segmented track | `bg-bg-elev` |
| `#fbf6ec` inputs, cards, selected rows, editor | `bg-bg-hi` |
| `#e0d3b8` borders; `#d4c4a4` dashed | `border-line`; `border-rule` |
| `#2a221a` / `#5b4a36` / `#8a7a60` | `text-fg` / `text-fg-dim` / `text-fg-faint` |
| `#9e9077`, `#b3a895` (fainter meta, line numbers) | `text-fg-faint/80`, `text-fg-faint/60` |
| `#b85c34` accent; hover `#a44f2b` | `bg-accent text-bg-hi`, `hover:bg-accent/90`; small accent text `text-accent` |
| `#6f7d52`, pill `#e5e7d4`/`#4e5a38` | `bg-sage`, `bg-sage/15 text-sage-dark` |
| ANTHROPIC / COMMUNITY badges | existing `ProvenanceBadge` tones (`accent` / `warn`) |
| `#2e5a3e` code, `#7b560e` inline code | `text-sage-dark`, `text-honey-dark` |

Fonts: keep the app's `font-sans` (Geist), `font-serif` (Newsreader), `font-mono`; the prototype's
Inter Tight / Source Serif 4 are stand-ins. The app ships one light palette; dark checks use the
web-ui spec's inverted render.

## 7. Deliberate deviations (decided, do not re-litigate)

1. **No per-server `Enabled` switch on MCP.** Claude Code has no per-server enabled field in
   `~/.claude.json` (McpServers.tsx drops a stale one on write). Not built.
2. `Edit JSON` opens today's per-server editor form (permissions, disabledTools, …) in the detail
   pane, so no existing field is lost; `Done` returns to the 3a detail.
3. `Check all` / `Check again` run a real MCP handshake (`initialize` + `tools/list`) per server
   on explicit click only — never polled, bounded by a timeout. Results live for the app run.
4. The `+ New` / `+ Add server` / `+ Add plugin` menus keep today's flows: new blank item and the
   existing catalog drawer (`HomeSessionDrawer`).
5. `Learn` opens the existing learning content for the page; the eyebrow stays (owner kept it).
6. Checks never auto-run on mount (today `claude mcp list` runs on every mount, up to 30 s); the
   list reads `not checked` until a check, and results are kept for the app run.
7. `Uninstall <name>` confirms inline in the ⋯ menu (no native `window.confirm`).

## 8. Code anchors (main @ f557303a)

- Header = `src/renderer/components/layout/SectionFrame.tsx:28-58` (eyebrow, serif h1, subtitle,
  `LearningPanel` Learn), mounted for every Home page by `screenComponents.tsx:60,121-123`. 3a hides
  the h1 **for `extensions` only** (opt-in prop); other pages keep it.
- Page body = `src/renderer/components/tabs/Extensions.tsx` (`ViewTabs` + `SourceChip` row, local tab
  state, `usePanelTabHint('extensions')`, `HomeSessionDrawer` for Add). `ViewTabs` is shared by 8
  pages — the folder tabs are a new component, not a ViewTabs change.
- `Skills.tsx` and `McpServers.tsx` are also mounted by the Project face (`ProjectClaudeConfig.tsx:240-241`,
  project scope, `<cwd>/.mcp.json`, `McpProjectGating`). The redesign applies there too and must keep
  project scope working; labels name the real file of the active scope.
- Light editor: reuse the existing paper Monaco theme `sm-paper` (`tabs/editor/CodeEditorPane.tsx:52-71`).
- Frontmatter helpers: `src/renderer/lib/skillFrontmatter.ts` (`parseSkillMeta`, `readSkillDisabled`, `setSkillDisabled`).
- Markdown preview: `src/renderer/lib/renderChatMarkdown.ts`.
- Plugin contents: computed in `Plugins.tsx` (`inspectPluginDir` ~915-955, `resolvePluginComponents`,
  plugin MCP servers ~1032-1096); `plugins.list()` → `{key,name,marketplace,version,scope,installPath,enabled}`.
- MCP: `claudeConfig.patch` writes; `mcp.status()` = `src/main/mcpStatus.cjs` (`claude mcp list`, status only, no tools).
- File age: `SourceChip.tsx` reads mtime via `config.readText(path,{maxBytes:1})`.
- Navigation: `openPanel(id, tab)` / `usePanelTabHint` (`src/renderer/state/layout.ts:172,250`).

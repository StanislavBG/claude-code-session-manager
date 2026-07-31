---
title: Plugins tab — replace bottom detail card with a drill-in plugin page (design 2a)
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Redesign the Plugins tab's detail experience: keep the Installed list exactly as it is, but clicking a plugin row now navigates to a full drill-in plugin page (replacing the list within the tab) instead of showing the small card pinned below the table. The page follows an approved mockup ("2a"): a compact one-line header, a thin metadata strip, and a left section index beside a full-height component listing — so the plugin's skills/agents get the vertical room.

# Acceptance criteria

## Core functionality

- [ ] `src/renderer/components/tabs/Plugins.tsx`: clicking a row in the Installed table sets a `selected` plugin and renders a new `PluginHomePage` component in place of the table (the old `PluginDetail` bottom card is deleted); a `← Plugins` back link (top-left) returns to the list. The Installed/Library toolbar switcher and the list view itself are unchanged.
- [ ] `PluginHomePage` header is ONE row (~44px): back link, plugin name (serif, ~22px, matching the app's display-serif used by tab titles), `v<version>` in mono dim, one-line truncated description (`overflow:hidden;text-overflow:ellipsis`), then right-aligned `ProvenanceBadge` and an `MCP` chip when `hasMcp`.
- [ ] Below the header, a thin meta strip (single ~26px row, muted background, hairline borders): `AUTHOR`, `LICENSE`, `HOMEPAGE` (clickable, opens externally via the app's existing external-link pattern), and right-aligned `PATH` in mono faint. Omit keys the manifest lacks.
- [ ] Body is a two-column grid: a ~170px left section index (`Skills <n>`, `Agents <n>`, `MCP server`, `Files` — entries with count 0 hidden or dimmed; active item highlighted, matching the LeftNav/navi tone) and a content column listing each section: numbered rows (`01`, `02`… in faint serif) with the item name in mono accent and its one-line description in dim text.
- [ ] Skills rows use REAL skill data: reuse `resolveInstalledPluginSkillsDir` + `listPluginSkills` from `src/renderer/lib/pluginSkills.ts` (already imported by Plugins.tsx) to get each skill's name + description (first sentence of the SKILL.md description frontmatter, truncated to one line). Clicking a skill row opens the existing `PluginSkillBrowser` for that skill.
- [ ] Agents section lists `agents/*.md` files with their frontmatter `name`/`description` (parse leniently; fall back to filename). No editing — read-only, same as today.

## Edge cases

- [ ] Plugin with no manifest: header shows the directory name, meta strip collapses to just PATH; no crash.
- [ ] Plugin with 0 skills and 0 agents: content column shows the existing EmptyState pattern ("no components") rather than blank space.
- [ ] Long descriptions/paths truncate with ellipsis; the page must not scroll horizontally.

## Interaction / integration

- [ ] Selection state stays local to Plugins.tsx (no new store); switching to the Library sub-tab and back resets to the list view.
- [ ] `ProvenanceBadge` and `pluginProvInput` reused as-is; no duplicate provenance logic.

## Tests

- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 600 npm run test:unit` passes

# Implementation notes

Read first: `src/renderer/components/tabs/Plugins.tsx` (current list + `PluginDetail` + `inspectPluginDir`), `src/renderer/lib/pluginSkills.ts`, `src/renderer/components/tabs/plugins/PluginSkillBrowser.tsx`.

Approved mockup ("2a") the page must match — layout summary: card background `bg` cream; one-line header row `flex items-baseline gap-14px` with back link in mono accent; meta strip `flex gap-18px` on the muted panel tone with 9px mono uppercase keys; body `grid grid-template-columns: 170px 1fr`, index column on the muted tone with hairline right border; content rows `flex baseline gap-10px, py-9px, hairline bottom border`, number in faint serif, name in `font-mono font-semibold` accent color, description `text-fg-dim text-xs`. Use the app's existing Tailwind tokens (`text-fg`, `text-fg-dim`, `text-fg-faint`, `border-line`, `bg-bg-elev`, `text-accent`) — do NOT hardcode hex values; the mockup's hexes are just those tokens' values.

Keep the whole page inside the existing `Panel` so the toolbar (Installed/Library tabs, manifest path) stays consistent. Delete `PluginDetail` and the `Kv` helper once replaced.

# Out of scope

- Any change to the Library sub-tab or `PluginsLibrary`
- Plugin editing/enable/disable actions (tab remains a read-only inspector)
- Hooks/monitors/bin deep listings — counts in the index are enough for now
- The Subagents/Usage removal chains (PRDs 781-785)

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

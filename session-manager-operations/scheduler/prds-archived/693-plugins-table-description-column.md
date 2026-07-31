---
title: Plugins tab — surface each plugin's manifest description in the table
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

Implement the design already built and browser-verified in Claude Design (project "Session
Manager", file `Plugins Table - Guided.html` —
https://claude.ai/design/p/0ca33cd3-c2fa-4644-b728-bde42292abbd?file=Plugins+Table+-+Guided.html
— built specifically against this component's real `KVTable` shape, not the generic list-row
mockup used for Skills/MCP Servers, since Plugins' actual UI is a table with columns, not a
sidebar list).

`src/renderer/components/tabs/Plugins.tsx` renders installed plugins as a `KVTable` with columns
`name / origin / version / manifest / contents / path` (`Plugins.tsx:124-168`) — no description
column, even though `row.manifest?.description` is already fetched data (used today only in the
detail panel, `PluginDetail`, line 282-283, which only renders after a row is clicked). A
first-time user scanning the table sees a name and some metadata but no indication of what a
plugin actually does until they click into it.

# Acceptance criteria

- [ ] Change the `name` column's `render` (`Plugins.tsx:125`, currently `render: (r) => r.name`)
  to render the name with `r.manifest?.description` shown as a small, muted, single-line-clamped
  subtitle directly under it when present, matching the verified `Plugins Table - Guided.html`
  mockup exactly (including its "no description in manifest" italic fallback for plugins with no
  manifest description). Widen the `name` column's fixed `width: '12rem'` if needed to give the description room without
  looking cramped — check how `KVTable` handles per-column width/wrapping first
  (`src/renderer/components/ui/KVTable.tsx`) rather than guessing.
- [ ] Do not remove the description from `PluginDetail` — it stays there too; this adds visibility
  in the table, it doesn't relocate anything.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] Add/extend a test (search `find src/renderer -iname '*plugins*spec*'` first) asserting a
  plugin row with a manifest description renders it under the name, and one without a manifest
  (or an empty description) renders the name alone with no broken layout. Run via
  `timeout 120 npx vitest run <files touched>`.

# Implementation notes

- Read `src/renderer/components/tabs/Plugins.tsx` (the `columns` array and `PluginRow`/
  `PluginManifest` interfaces, lines 15-43 and 124-168) and `KVTable.tsx` first — this is a
  column-render change, not a data-fetching change (the manifest is already loaded per row).

# Out of scope

- Do not add new columns beyond promoting the existing description into the name cell.
- Do not change the Library sub-view (`PluginsLibrary`) — Installed table only.

## Engineering standards

Before writing any code, read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

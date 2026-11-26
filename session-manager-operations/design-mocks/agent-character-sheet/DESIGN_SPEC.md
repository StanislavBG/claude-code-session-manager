# Agent Character Sheet — design spec

Source: Claude Design project `08d5d447-46a4-4e4e-989e-6ee8c6d3daca`, file `Agent Character Sheet.dc.html`
(imported 2026-11-26 into this folder with `support.js`, `AgentRoster.dc.html`, `CfgBand.dc.html`, `fonts/`).
Brief and decisions: Epic `where-are-the-tools-managed-agents-can-be-given--1d3c90be`; the backend it
builds on is that Epic's gear plan (`validate-gear-backend`).

Open the mock: serve this folder (`python3 -I -m http.server <port> --directory .`), open the `.dc.html`.
Reference PNGs (light theme, 1592×1040 page area under the app chrome) are in `renders/`.

## Where it lives

Home ▸ Claude config ▸ **Agents** tab — today `src/renderer/components/tabs/AgentLibrary.tsx` (list + detail)
and `src/renderer/components/tabs/agents/AgentDetail.tsx` (editor). The page chrome (dark band with the
CLAUDE.md / Settings / MCP / Skills / Plugins / Agents tabs) already exists and is NOT part of this build.

## Frames → code

| Frame | Render | Build | Data |
| --- | --- | --- | --- |
| 1a Roster | `renders/1a-roster.png` | Agents tab landing: header, Personas/Tags, filter, `+ New`, state filter chips (All/Undecided/Equipped/Bare/Unbound with counts), "N agents have no loadout decision" banner + `Review the N →`, sort "Needs a decision first", 4-column character cards (avatar letter in persona colour, name, class line in serif italic, MODEL + EFFORT pips, loadout badge + summary, gear chips, footer note e.g. override or failing server) | `agents.listPersonas()` (+ `loadout` from gear-loadout-states), `agents.armory()` for server status |
| 1b Sheet · workbench | `renders/1b-sheet-workbench.png` | **The chosen sheet layout.** Left 316 px list column (agents folder card, Personas/Tags, Filter, `+ New`, rows with state line); header (avatar, name, loadout badge with counts, `edited`, class line + tags, Global / In project switch, Duplicate, `…`); DESCRIPTION card; STATS (model, effort pips, runs on); GEAR (built-in chips equipped/available, "Always granted" floor chips, MCP server items with status + `Powers ›`, pack items with skills, dashed drop slots, dashed Companions slot "designed later"); PERSONALITY & GROUNDING preview + `Open editor`; right column CONSTRAINTS (sandbox environment radio cards, risk marks read-only, banned in unattended runs chips, settings.json summary + `Open Settings ›`), THIS LOADOUT APPLIES TO (Epic chat / Scheduler jobs / Tasks) + "Changes apply to new sessions"; bottom save bar (unsaved summary, Revert, Save Ctrl S) | persona + armory + environments |
| 1c paper doll, 1d ledger | `renders/1c-…`, `renders/1d-…` | **Not built**, except 1c's collapsed avatar rail (left edge of 1c), which replaces 1b's list column by default (deviation 1). | — |
| 1e Armory mid-drag | `renders/1e-armory-mid-drag.png` | Armory drawer beside the sheet: grouped items (built-ins, MCP servers, packs), search, badges; drag ghost, drop-target highlight "Release to equip"; keyboard/click Equip alternative | `agents.armory()` |
| 1f MCP powers | `renders/1f-mcp-powers.png` | Expanded MCP item: choose all or a subset of its tools | armory McpItem.tools |
| 1g Undecided first-run | `renders/1g-undecided-first-run.png` | Undecided agent: choose Bare / Unbound / pick gear | loadout states |
| 1h Project override | `renders/1h-project-override.png` | `In project ▾` mode: project picker, overridden items marked, write-on-change for project edits | overlay (gear-overlay-carries-gear) |

## Deliberate deviations (validators: do not re-flag)

1. **Sheet layout = 1b workbench, plus 1c's collapsible agent rail** (owner, 2026-11-26). The 316 px agent
   list is collapsed by default to 1c's ~64 px avatar rail with a » / « toggle (choice persisted), because the
   app's own LeftNav already takes width the mock does not show. Everything else from 1c/1d is not built.
   Revert: default the list to expanded, or drop the rail.
2. **D&D labels are always on** (serif italic secondary labels). The mock's "D&D labels tweak" toggle is not
   built — no new settings switches (owner rule). Revert: add a toggle in App settings.
3. **Dark theme** is derived from the app's existing tokens; the mock is light-only. Screenshots are compared
   against `renders/` in light; dark is checked for legibility only.
4. **Companions** render as the dashed "designed later" slot only — no behaviour.
5. Assumptions 01–06 on the mock's intro frame are accepted as written (roster = Agents landing with the
   316 px list kept in the sheet; persona body = preview card + full-screen editor; tool chips neutral, honey =
   needs a decision; Global | In project switch replaces the PROJECT OVERRIDES block; sample data from seeds).

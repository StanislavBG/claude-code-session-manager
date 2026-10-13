# Memory Explorer — implementation spec

Source: Claude Design project `935ad77c-1584-4d14-a7ce-f2d9833b7ed1`, file
`Memory Explorer Prototype.dc.html`, imported 2026-10-13 by Epic
`the-memory-page-redesign-focus-on-ui-itterate-as-eaf26945`. Feature inventory and hard
constraints: [`../memory-tab/DESIGN_BRIEF.md`](../memory-tab/DESIGN_BRIEF.md) — every feature
there must still exist after this redesign.

| File | What |
| --- | --- |
| `memory-explorer-prototype.dc.html` | The prototype, decoded verbatim. Markup = lines 9–340, behaviour = the `renderP()` method (lines 550–712). **Ignore** the `CALLOUTS` aside (lines 327–336) and the `renderV1()` method — prototype chrome, not product. |
| `support.js` | The design runtime. Opening the `.dc.html` in Chromium (file://) renders it. |
| `renders/NN-*.png` | Reference screenshots of the 1320×900 card (callouts off). **The visual target.** |

To re-render the references: open the `.dc.html` in Playwright Chromium at 1800×1000, click
"Callouts: on" to turn them off, screenshot `.dv-card`.

## 1. Layout (from the prototype, in px)

```
┌ header 16px/24px pad: CONFIGURE · Memory (serif 28) · subtitle ……… [search 300w] LEARN ┐
├ nav 232w (bg-elev) ┬ main ─────────────────────────────────────────────────────────────┤
│ scope card         │ Browse views: list 316w │ reader 1fr │ links rail 236w (bg-elev) │
│ BROWSE             │ Ask view: header / thread (max-w 820) / chips + composer          │
│ REVIEW             │ Clusters view: header / 2-column card grid, gap 16                │
│ CLUSTERS           │                                                                   │
│ SUBAGENT SCOPES    │                                                                   │
│ (index footer)     │                                                                   │
└────────────────────┴───────────────────────────────────────────────────────────────────┘
```

The page fills the tab (no outer card, no fixed 1320×900). Columns keep the widths above; the
reader takes the rest. Every pane scrolls independently (`min-h-0` + `overflow-auto`).

## 2. Token mapping (use these; no raw hex in className)

| Prototype | App token |
| --- | --- |
| `#f5f0e6` page, active nav row | `bg` |
| `#ede6d6` nav, chips, hover | `bg-elev` |
| `#f0eadd` links rail | `bg-elev` |
| `#fbf8f1` inputs, cards, popovers | `bg-hi` |
| `#d4ccb8` borders | `border-rule-structural` |
| `#e3dcc8` selected row, inner rules | `bg-muteband` (selected), `border-rule-inner` (rules) |
| `#c9bfa8` input/button border | `border-rule` |
| `#1a1612` ink; dark buttons | `text-fg`; `bg-fg text-bg` |
| `#3a342b`, `#5d5648` secondary text | `text-fg-dim`; meta/labels `text-fg-faint` |
| `#a83818` accent (LEARN, primary buttons, links, cite numbers) | `accent` (`bg-accent text-white`, `text-accent-dark` for small text) |
| `#f9e5b8` / `#6e4a0a` stale tint / text | `bg-butter/40` / `text-honey-dark`; dot `bg-honey` |
| `#f6e3dc` / `#5a1d0c` broken tint / text | `bg-accent-muted/30` / `text-accent-dark`; dot `bg-accent` |
| `#2e5a3e` green (checkmark, "DRAFT MEMORY") | `text-sage-dark` |
| `#211c17` source `<pre>` | `bg-fg text-bg-elev` |
| diff `−` row / `+` row | `bg-accent-muted/30 text-accent-dark` / `bg-sage/20 text-sage-dark` |

Fonts: the app trio, not the prototype's. Source Serif 4 → `font-serif`; Inter Tight →
`font-sans`; JetBrains Mono → `font-mono`. Sizes, weights, letter-spacing, radii and padding
follow the prototype exactly (e.g. section labels `text-[10px] tracking-[.08em] font-semibold`,
nav rows `h-7 text-[13px] rounded-[5px]`, list title `font-serif text-lg`).

Cluster dots: aggregate clusters carry no colour. Assign by cluster index from the fixed literal
list `CLUSTER_DOT_CLASSES = ['bg-accent','bg-sage-dark','bg-honey','bg-fg-dim','bg-fg-faint','bg-hive-teal','bg-butter','bg-delta-bad']`
(wraps). Unclustered = `bg-rule`.

Overlays (scope menu, LEARN popover, ⋯ menu, search palette, delete dialog) use `Z.dialog`
from `lib/zLayers.ts`, positioned inside the page. The undo bar is page-local
(`absolute bottom-[22px] left-1/2 -translate-x-1/2`, `bg-fg text-bg`), **not** the app toast.
Errors still go to the app toast (`toast.error`).

## 3. Deliberate deviations from the prototype (decided, do not re-litigate)

1. **Search shortcut is `/`, not ⌘K.** `App.tsx:514` owns ⌘K/Ctrl+K for the global palette on
   every page. The search trigger shows a `/` kbd; `/` opens the memory palette when focus is not
   in an input/textarea. Esc closes.
2. **Header subtitle** reads `Claude Code's own memory files · stored on this machine`, not
   "nothing leaves your machine" — Ask, Fix and Regenerate send text to Claude.
3. **Paid actions are labelled.** `Send` (Ask), `Fix with assistant`, and `Regenerate`/`Generate`
   (Clusters) each show a small `text-fg-faint text-[11px]` note `uses Claude` beside the button.
   None fires on mount. `remember …` in Ask is local (no call).
4. **Mark verified = touch the file** (mtime → now). No new frontmatter field (brief §6: no
   Session-Manager-only fields). It clears age-based staleness only, so the button is shown only
   when every stale reason is age-based; dead-path staleness offers Fix with assistant + Edit.
   Saving an edit also resets mtime, so "Saving marks the memory verified" stays true.
5. **Archive** moves `<name>.md` to `<memdir>/.archive/<name>.md` and removes its `MEMORY.md`
   line (Claude stops loading it). REVIEW gains an `Archived` row, rendered only when N>0;
   selecting an archived row shows a read-only reader with a `Restore` button.
6. **Delete undo** keeps the deleted file's content in memory; Undo recreates it (create + write,
   which restores the index line). Undo window 6 s, as in the prototype.
7. **"Reveal in Finder"** label is `Reveal in folder` (no per-OS chrome); uses
   `window.api.shell.open({ as: 'revealPath', path })`.
8. **Brief features the prototype omits**, placed as follows:
   - Auto memory off → full-width `bg-butter/40 text-honey-dark` banner directly under the header:
     "Auto memory is off — Claude Code is not reading or writing any of these files."
   - Index health → nav footer (bottom of nav, `mt-auto`): `MEMORY.md` label, two thin meters
     `lines N/200` and `KB N/25`; near budget tints `honey`, over budget `accent`. Dangling index
     lines show as `N index lines point at missing files` under the meters.
   - Orphans → REVIEW row `Not in index` (count / ✓) and a `NOT INDEXED` badge on list rows
     (same badge style as STALE, `bg-rule-inner text-fg-dim`). Reader banner: "Claude won't load
     this — it has no line in MEMORY.md."
   - Subagent without memory (`memoryScope === null`) → SUBAGENT SCOPES row shows `off` instead
     of a count; selecting it shows the empty state "<agent> has no persistent memory" + "Add
     `memory: project` (or user/local) to its frontmatter in the Agent Library to turn it on." No
     write controls. Memory-enabled agent with no folder yet → the prototype's empty state
     ("… has no memories yet" + `+ New memory`). Scope note under the scope card path:
     user = all projects · project = shared via git · local = this machine only.
   - Clusters exist only for the workspace scope. In a subagent scope the CLUSTERS nav group is
     hidden and the Clusters view says "Clusters are available for workspace memory."
   - Clusters never generated → Clusters view empty state "No clusters yet" + `Generate` button
     (+ `uses Claude · up to 3 min`). Running → button disabled, label `Generating…`. Failed →
     `toast.error`. Header line = `Generated <relative> from shared references and links`.
   - LEARN popover body = `learningContent.memory` (`src/renderer/components/learningContent.ts`),
     title "How memory works", `Got it` closes. Replaces the LearningPanel on this page.
   - Live sync: the memory dir stays watched (`window.api.config.watch`, as
     `MemoryStoreView.tsx:104-113` does today); external writes refresh rows and counts. A dirty
     editor is never overwritten by a refresh.
   - Voice input: the Ask composer keeps a mic button, reusing the hook `MemoryNaturalPanel.tsx`
     uses today.
9. Dropped (superseded): the Natural console's `list/show/search/forget` commands (palette +
   reader + delete cover them) and its "Send to Claude" terminal hand-off (Ask replaces it).

## 4. Data contract

### Main (additions)

`MemoryStaleEntry` gains (computed in `lib/memoryStale.cjs` `scoreMemories`, which already reads
every body):

```ts
description: string | null      // frontmatter `description:`
type: string | null             // frontmatter `type:` (top-level or under `metadata:`)
originSessionId: string | null  // frontmatter `originSessionId:` (any indent)
outLinks: string[]              // distinct [[wikilink]] targets, self excluded, in body order
danglingLinks: string[]         // outLinks with no `<target>.md` in the dir
```

New `window.api.memory` methods (all take the same `MemoryTarget`):

```ts
verify(name, target)        → MemoryMutationResult   // fs.utimes(now); content untouched
archive(name, target)       → MemoryMutationResult   // move to .archive/, drop index line
restore(name, target)       → MemoryMutationResult   // move back, re-add `- [slug](name) — description`
listArchived(target)        → { names: string[]; error: string | null }
ask(req: { question: string; target: MemoryTarget; contextName?: string })
                            → { ok: boolean; answer: string; citations: string[]; error?: string }
proposeFix(req: { name: string; target: MemoryTarget })
                            → { ok: boolean; content: string; summary: string; error?: string }
```

`ask` / `proposeFix` acquire a slot from `lib/scheduler/sessionSlots.cjs` (pattern:
`projectBrief.cjs:254-303`), call `runClaudeP` with `model: 'sonnet'` pinned, `timeoutMs:
120_000`, and parse a JSON object from the output. Citations are filtered to names that exist.
`proposeFix.content` must keep the file's frontmatter; reject output that drops it.

### Renderer model (`src/renderer/components/tabs/memory/explorer/model.ts`)

```ts
export type ExplorerScope = { kind: 'workspace' } | { kind: 'agent'; agent: MemoryAgent }
export type ExplorerView =
  | 'all' | 'ask' | 'clusters' | 'stale' | 'broken' | 'recent' | 'unindexed' | 'archived'
  | `cluster:${string}`
export type SortKey = 'recent' | 'name' | 'size'
export interface MemoryRow {
  name: string; slug: string; path: string; description: string
  bytes: number; mtimeMs: number; ageDays: number
  stale: boolean; staleReasons: string[]; ageOnlyStale: boolean; deadRefs: string[]
  broken: boolean            // deadRefs.length > 0 || danglingLinks.length > 0
  danglingLinks: string[]; outLinks: string[]; inLinks: string[]
  notIndexed: boolean        // name ∈ index.orphans
  clusterId: string | null; type: string | null; originSessionId: string | null
}
export interface ClusterInfo {
  id: string; name: string; summary: string; memberSlugs: string[]
  linkCount: number; staleCount: number; dotClass: string
}
export const CLUSTER_DOT_CLASSES: readonly string[]
export function buildRows(entries: MemoryEntry[], stale: MemoryStaleResult | null,
  agg: MemoryAggregateResult | null, now: number): MemoryRow[]
export function buildClusters(agg: MemoryAggregateResult | null, rows: MemoryRow[]): ClusterInfo[]
export function filterRows(rows: MemoryRow[], view: ExplorerView, query: string): MemoryRow[]
export function sortRows(rows: MemoryRow[], sort: SortKey): MemoryRow[]
export function navCounts(rows: MemoryRow[]): { all: number; stale: number; broken: number;
  recent: number; unindexed: number }
export function searchRows(rows: MemoryRow[], q: string, limit?: number): MemoryRow[]
export function slugFromTitle(title: string): string   // 'deploy freeze fridays' → 'deploy_freeze_fridays'
export function lineDiff(before: string, after: string): { sign: '−' | '+' | ' '; text: string }[]
```

`recent` = mtime within 7 days. `filterRows` query matches slug or description,
case-insensitive. `lineDiff` output for the Fix panel shows only changed lines.

### Hook (`explorer/useMemoryExplorer.ts`)

`useMemoryExplorer(scope: ExplorerScope, cwd: string | null)` returns
`{ loading, target, dir, autoMemoryEnabled, rows, clusters, clustersMeta: { generatedAt, running },
index, archived, agents, agentCounts, actions }` where `actions` =
`{ refresh, read(name), saveBody(name, body), create(title, body) → Promise<string | null>,
remove(name) → Promise<(() => Promise<void>) | null>, archive, restore, verify,
removeLink(name, targetSlug), regenerateClusters, ask(question, contextName?), proposeFix(name) }`.
Every failure → `toast.error(...)` and a falsy return. Clusters load the cache on mount
(`aggregate(workspace, false, cwd)`); only `regenerateClusters` passes `refresh: true`.

## 5. Components (all under `src/renderer/components/tabs/memory/explorer/`)

| File | Renders (prototype lines) |
| --- | --- |
| `ExplorerNav.tsx` | scope card + menu (36–54), BROWSE/REVIEW/CLUSTERS/SUBAGENT SCOPES groups (55–78), index footer (§3.8) |
| `MemoryListPane.tsx` | list column: title/count/+ New (85–88), filter + sort cycle (89–92), rows with dot/badges/meta (95–104), empty states (105–111) |
| `MemoryReader.tsx` | reader header + Read/Source + Edit + ⋯ menu (119–142), stale/fix/broken banners (144–165), body + source (167–190), path footer (191) |
| `MemoryEditorPane.tsx` | edit + new mode (194–208), "No memory selected" (210–212) |
| `LinksRail.tsx` | LINKS TO / LINKED FROM / Ask about this memory (215–227) |
| `AskView.tsx` | Ask view (232–269) |
| `ClustersView.tsx` | Clusters view (271–288) |
| `SearchPalette.tsx` | `/` palette (293–305) |
| `DeleteMemoryDialog.tsx` | delete confirm (307–316) |
| `UndoBar.tsx` | page-local undo toast (318–324) |
| `MemoryExplorer.tsx` | header (18–33), auto-memory banner, grid, view switching, overlays, keyboard |

Reader body: rendered with `marked` (already a dependency; see `lib/renderChatMarkdown.ts`),
frontmatter stripped; `**Why:**` / `**How to apply:**` paragraphs keep the prototype's
`WHY` / `HOW TO APPLY` heading look via scoped CSS on `strong` at paragraph start, or by a
pre-pass that turns those two labels into `h4`. Description = the lead serif paragraph.
`type · <type>` chip only when `type` is set; `session <first 8>` chip only when
`originSessionId` is set.

## 6. Verification

`npm run preview:memory` (added by the harness PRD) renders `MemoryExplorer` in Chromium with a
fixture `window.api` built from the prototype's 26 memories, and writes screenshots named like
`renders/` into a temp dir. Parity = same layout, spacing, hierarchy and states as the matching
`renders/*.png`, allowing only the font-family and token-colour differences in §2.

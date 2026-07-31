---
title: Settings Guided view — group-map rail, promoted summaries, authored description fallbacks
cwd: ~/Projects/session-manager
estimateMinutes: 28
---

# Goal

Implement the design already built and browser-verified in Claude Design (project "Session
Manager", file `Settings - Guided.html` —
https://claude.ai/design/p/0ca33cd3-c2fa-4644-b728-bde42292abbd?file=Settings+-+Guided.html).

`src/renderer/components/ui/EffectiveCards.tsx` renders the Settings tab's "Guided" view over
`settingsGroups.ts`'s ~14 themed groups (~61 keys total). Two real gaps, confirmed by reading the
component: (1) group boundaries are visually subtle — each group header is a thin `border-b`
with a small `text-sm` title and a faint `text-xs` summary (`EffectiveCards.tsx:149-168`), easy
for adjacent groups to blend together with no persistent way to jump between them; (2) per-setting
descriptions (`EffectiveCards.tsx:265-269`, `info?.description`) only render when the bundled
schemastore schema (`src/renderer/data/claude-settings-schema.json`) happens to have one — many
keys have none, showing no explanation at all.

# Acceptance criteria

- [ ] Add a persistent **group-map rail** to the Guided view (left of the group cards, matching
  the verified mockup): one entry per `SETTINGS_GROUPS` entry (`settingsGroups.ts`) showing an
  icon, the group title, and a "N/total set" count; clicking scrolls/jumps to that group's card.
  Choose reasonable icons per group from this project's existing `AlmanacIcon`/icon set (search
  for the icon component used elsewhere in this file's tree — reuse existing icon names, don't
  invent new asset files) — exact icon choice is a judgment call, not specified per-group here.
- [ ] Each group's header (currently `EffectiveCards.tsx`'s section-header block, ~lines 149-168)
  becomes a clearly bordered/shadowed card (per the verified mockup) with the group's `summary`
  (from `settingsGroups.ts`) promoted to visible body text (not the current faint caption
  styling) — every group visually distinct from its neighbors, not a thin divider.
- [ ] Add an **authored fallback description map** for keys the bundled schema doesn't describe.
  Add a small new file (e.g. `src/renderer/lib/settingsDescriptionFallbacks.ts`) — a
  `Record<string, string>` keyed by settings.json key name, covering (at minimum) every key
  currently missing a schemastore `description` (identify these by cross-referencing
  `settingsSchema()`'s resolved info against `SETTINGS_GROUPS`'s full key list — the missing set
  is small, on the order of 10-15 keys, evident when you diff them). Write one accurate,
  concise sentence per key describing what it actually does (base this on the key's real
  behavior in Claude Code, not a guess — check for other in-repo references to the key, e.g. in
  `claude-settings-schema.json` neighboring keys, docs, or code that reads the setting).
- [ ] In `EffectiveCards.tsx`'s `SettingCard` (~lines 182-302), when `info?.description` is empty
  AND a fallback exists in the new map, render the fallback with a quiet visual marker
  distinguishing it as in-app-authored rather than upstream-official (e.g. a dotted underline +
  `title` tooltip noting the source — matching the verified mockup's treatment) — never present
  fallback text as if it were official schema copy.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] Add/extend unit tests (search `find src/renderer -iname '*effectivecards*spec*' -o -iname
  '*settingsgroups*spec*'` first) covering: the group-rail renders one entry per
  `SETTINGS_GROUPS` group with a correct set-count; a key with no schema description but a
  fallback entry renders the fallback with the "authored" marker; a key with a real schema
  description is unaffected (renders that text, no marker). Run via
  `timeout 120 npx vitest run <files touched>`.

# Implementation notes

- Read `src/renderer/components/ui/EffectiveCards.tsx` and `src/renderer/lib/settingsGroups.ts`
  in full first — this PRD adds to existing, working components; it doesn't restructure the
  override/drift/reset mechanics (`onOverride`, `collectDriftScopes`, `canReset`, etc.), which
  stay exactly as they are.
- The verified Claude Design mockup (link above) shows the exact visual proportions, spacing,
  and the group-rail interaction to match — reference it for layout decisions rather than
  guessing.
- `settingsSchema()` (`src/renderer/lib/settingsSchema.ts`) wraps the bundled
  `claude-settings-schema.json` via `buildSchemaResolver` — read `schemaLookup.ts`'s resolver
  shape to know how to check "does this key have a description" programmatically when building
  the fallback map, rather than eyeballing the raw JSON.

# Out of scope

- Do not change the override/drift/reset/advanced-toggle mechanics — only add the rail, promote
  summary styling, and add description fallbacks.
- Do not touch the Tree/Raw/Telemetry/Session-Manager-app-prefs views (`Settings.tsx`'s other
  `view` modes) — Guided view only.
- Do not attempt to backfill descriptions for keys that already have a real schemastore
  description — only add fallbacks for the genuinely missing ones.

## Engineering standards

Before writing any code, read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

# Config-scoped-editor tab family — review & fix pass

Scope: Settings, Permissions, Hooks, MCP Servers, Skills, Plugins, Keybindings
(the "scoped editor" and "list+detail" tab family) plus their shared
primitives (`ui/ScopeSwitcher.tsx`, `ui/SaveBar.tsx`, `ui/JsonEditor.tsx`,
`ui/ListDetail.tsx`, `ui/EffectiveCards.tsx`, `ui/EffectiveTree.tsx`,
`ui/ProvenanceBadge.tsx`), `state/config.ts`, `main/config.cjs`,
`main/pluginInstall.cjs`, `main/mcpStatus.cjs`.

## Method

Read every file in scope end-to-end before changing anything. Verified
control behavior primarily by static trace (each Save/add/remove/toggle
handler was read against its downstream `state/config.ts` and
`main/config.cjs` effects) plus a live bounded boot check: the existing
`tests/e2e/tabs-smoke.spec.ts` suite (Electron + xvfb, one test per tab
asserting zero renderer/console errors on mount) run scoped to
settings/permissions/skills/plugins/mcp/hooks/keybindings — all 7 passed
before and after the fix, including a standalone re-run of the mcp tab after
the McpServers.tsx edit.

**Why no interactive Save-button e2e run**: this sandbox's Electron test
harness (`tests/e2e/_helpers/launchApp.ts`) does not redirect `$HOME` — it
launches against the real machine's `~/.claude` config tree. Driving actual
Save/add/remove clicks through Playwright here would mutate the developer's
live Claude Code settings/hooks/MCP config, which is a hard-to-reverse,
out-of-sandbox action I'm not authorized to take unconfirmed in a headless
run. Where a bug's correctness was mechanical rather than needing live I/O
(the McpServers name-collision fix below), I extracted the logic into a
pure function and covered it with a real unit test instead.

## Bug found & fixed

### `McpServers.tsx` — `addServer()` could silently overwrite an existing server

`addServer()` generated the new server's key as
`` `server-${Object.keys(servers).length + 1}` ``. This is only unique while
servers are added in order and never deleted. Concrete repro: start with
`{server-1, server-2}`, delete `server-1` → `{server-2}` (length 1). Clicking
"+ new server" computes `server-${1+1}` = `server-2`, which already exists —
`updateServers({ ...servers, [name]: {...} })` silently clobbers the
surviving server's full config (command/args/env/etc.) with a blank stdio
stub. No warning, no dialog; the loss is only visible if the user notices
the fields blanked out after clicking Save.

**Fix**: extracted `nextServerName(servers)` (now exported from
`McpServers.tsx`) which starts at `count+1` and walks forward until it finds
a key not already present in `servers`. Wired `addServer()` to use it.
Covered with `src/renderer/components/tabs/__tests__/McpServers.test.ts`
(4 cases: empty set, simple increment, the exact post-deletion collision
repro, and walking past multiple consecutive collisions).

## Duplication found & consolidated (within this family)

`Settings.tsx`, `Permissions.tsx`, and `Hooks.tsx` each independently
reimplemented an identical block: resolve every scope's absolute path via
a `ScopeSpec`, then `useEffect` to `loadJson` + `watchFile` every resolved
path (with matching `unwatchFile` cleanup), keyed off
`JSON.stringify(scopePaths)`. Byte-for-byte identical across all three
(same `useMemo`, same effect body, same eslint-disable comment).

**Fix**: extracted `useScopedConfigFiles(spec, home, cwd)` into
`src/renderer/lib/useScopedConfigFiles.ts`. It returns the resolved
`Partial<Record<Scope, string>>` and internally owns the load+watch
lifecycle via the existing `state/config.ts` store (no new state layer —
still routes through the same `useConfig` store all three tabs already
used). `Settings.tsx`, `Permissions.tsx`, and `Hooks.tsx` now call this
hook instead of carrying their own copy; each dropped ~20 duplicate lines
and an unused `useEffect` import.

`McpServers.tsx` and `Skills.tsx` were **not** changed to use this hook —
their scope-path resolution is a single-path lookup (`pathFor` /
`scopeRoots`), not a multi-scope fan-out, so they were already the smaller,
non-duplicated shape; forcing them onto the multi-scope hook would be a net
new abstraction mismatch, not a consolidation.

## Duplication noticed but NOT touched (documented per AC)

- **`parse`/`serialize` triplication**: `Permissions.tsx` (`parsePerms`/
  `serialize`), `Hooks.tsx` (`parseFull`/`serialize`), and `McpServers.tsx`
  (`parse`/`serialize`) each hand-roll the same shape — `JSON.parse` the
  full file, pull out one top-level key (`permissions` / `hooks` /
  `mcpServers`), and a mirrored serializer that re-injects it and
  re-stringifies with `null, 2`. This is a real "N implementations of one
  concept" case per the engineering standards, and a generic
  `parseFullJsonPickKey<T>(raw, key)` helper would remove it. Left alone
  this pass because each site's error-shape (`{ perms, full, err }` vs
  `{ full, hooks, err }` vs `{ full, servers, err }`) is subtly
  different, and unifying them touches 3 already-large, review-sensitive
  files for pure refactor value with no behavior bug attached — higher risk
  than benefit within this pass's "smallest correct change" mandate.
  Worth a follow-up PRD.
- **`HookRuleEditor` type-switch drops sibling fields**: in `Hooks.tsx`,
  switching a hook rule's `type` (command/http/prompt/agent/mcp_tool) via
  `onChange({ type: e.target.value as HookType })` replaces the whole rule
  object, dropping `timeout`/`args`/`terminalSequence` even though those
  fields are valid across every type. This is a real UX rough edge (silent
  data loss on a dropdown click) but not a duplication issue and touches
  hook-editing semantics beyond a "smallest correct change" bugfix — flagged
  here rather than fixed blind, since I could not verify live in this
  sandbox (see method note above) whether losing `timeout` on a type switch
  is intentional (some hook types plausibly shouldn't carry a leftover
  timeout from a different type).

## Cross-family duplication noticed (out of scope per task — not touched)

- `ViewSwitcher` (`Library.tsx`) and the ad-hoc `PluginsViewTabs` /
  `ViewTabs` component in `Keybindings.tsx`/`Settings.tsx`/`Permissions.tsx`
  overlap in shape (a 2-3 way pill toggle) but live across the "list+detail"
  and "scoped editor" shapes with slightly different option counts/labels.
  Not consolidated — out of scope for this pass and not clearly a single
  concept (2-way installed/library toggle vs N-way named views).

## Verification

- `timeout 120 npm run typecheck` — clean, before and after all edits.
- `timeout 180 npx vitest run` scoped to files touching this family
  (`chat.test.ts`, `mcpConnectionState.test.ts` — the only existing specs
  matching the grep in the AC) plus the new `McpServers.test.ts` — all pass.
- `tests/e2e/tabs-smoke.spec.ts` scoped to settings/permissions/skills/
  plugins/mcp/hooks/keybindings under `xvfb-run` — 7/7 pass (zero renderer
  console errors on mount), re-verified for `mcp` standalone after the
  `McpServers.tsx` edit.

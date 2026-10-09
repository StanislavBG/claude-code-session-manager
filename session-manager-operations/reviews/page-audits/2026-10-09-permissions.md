# Permissions page audit — 2026-10-09

- Key: `permissions`
- Label: Permissions
- Faces: home
- Entry: `src/renderer/components/tabs/Permissions.tsx`
- Base SHA: `ed0fdd75`
- Surface counts: owned 1 · shared 60 · api 0 owned (54 shared) · tests 1

Environment note: `node scripts/page-surface.cjs permissions` fails in this worktree (`Cannot find module 'typescript'`, no `node_modules`). It was run with `NODE_PATH=/home/bilko/Projects/session-manager/node_modules`. `lint:test-smells` could not run for the same reason. The duplicates run found no cross-page duplicate in this page's owned API (the page owns no `window.api` call itself).

## Verdicts

### 1. Stateless

Verdict: PASS

Scope, view and the rule input boxes are `useState`, which is transient UI. Rules live in `useConfig.files[path].draftRaw`, a projection of the real file with a watcher refresh (`useScopedConfigFiles` -> `watchFile`). No browser storage:
`grep -n "localStorage\|sessionStorage" src/renderer/components/tabs/Permissions.tsx` -> no output.
The preset view's `current` snapshot is not watched; it is recorded as P3 finding F2.

### 2. Physical files

Verdict: FINDINGS

Reads and writes go to `~/.claude/settings.json`, `<cwd>/.claude/settings.json` and `<cwd>/.claude/settings.local.json` through `PERMISSIONS_SCOPES = SETTINGS_SCOPES` (`scopes.ts:67`). Saves keep other top-level keys. Two paths lose data: F1 (draft with invalid JSON is replaced) and F2 (Presets bypasses the store draft).

### 3. Current, not hardcoded

Verdict: FINDINGS

The effective view is live (`mergeScopes(parseScopedJson(files, scopePaths))`, `Permissions.tsx` `effective` memo). `ModeSelector` hardcodes the mode list (F3). The Presets library reads `settings.json` once and never refreshes (F2).

### 4. One API per feature

Verdict: FINDINGS

Rules, Effective and Save all go through `useScopedConfigFiles` + `useConfig`, the same path Settings and Hooks use:
`grep -n "useScopedConfigFiles\|saveJson\|setDraft" Settings.tsx Hooks.tsx Permissions.tsx` -> all three call `useScopedConfigFiles(SETTINGS_SCOPES|PERMISSIONS_SCOPES, home, cwd)`, `setDraft` and `saveJson` from `state/config.ts`.
Findings: Presets installs through a second writer (F2), the three pages share one draft per file with no conflict check (F4), and the draft read-modify-write is re-implemented per page (F5).

### 5. Clear separation and platform adherence

Verdict: FINDINGS

Face law holds: `navGroups.ts:77` declares `faces: HOME` and the page owns no `window.api` or fs call. No `process.platform` branch and no raw z-index in the file. Rule syntax is entered as free text with no validation against Claude Code's schema (F6). The page imports `PermissionsPresetsLibrary` from `Library.tsx`, a page-level file shared by six pages (F7).

### 6. Lean tests

Verdict: PASS

The page's one test file, `HooksPermissions.navface.test.tsx`, is `keep` (8 tests, 163 lines, shared with Hooks via `describe.each`). It covers only NavFace default scope and the Home-only tab. No test covers rule add/remove, Save, the Effective override or the Presets write; these gaps are the reason F1 and F2 went unnoticed. Missing coverage is not test volume, so the verdict stays PASS.

### Findings

| id | severity | principle | file + symbol | evidence | fix shape | owner page |
| --- | --- | --- | --- | --- | --- | --- |
| permissions-F1 | Critical | 2 Physical files | `src/renderer/components/tabs/Permissions.tsx` `overrideInto`, `parsePerms`, `updatePerms` | `overrideInto`: `try { current = JSON.parse(draft) } catch { current = {} }` then `setDraft(target, JSON.stringify({ ...current, permissions: nextPerms }))`. `parsePerms` returns `full: {}` on a parse error, and the Rules view still renders its inputs, so `updatePerms` -> `serialize({}, next)` writes only `permissions`. Either path turns a draft with invalid JSON (for example a hand edit in progress in Settings' raw editor) into a valid file that holds only `permissions`, and `saveJson` accepts it. All other top-level keys (hooks, env, model, ...) are lost. | behavior | permissions |
| permissions-F2 | Important | 1 Stateless, 4 One API | `src/renderer/components/tabs/Library.tsx` `PermissionsPresetsLibrary` (`apply`, `refresh`) | `apply` calls `window.api.config.readJson(path)` then `window.api.config.writeJson(path, { ...full, permissions: p.permissions })` directly, not through `useConfig`. The store's `files[~/.claude/settings.json]` is not updated until a watcher event, and `onExternalChange` uses `keepDirty = true`. A dirty Rules draft therefore survives the preset and the next Save overwrites the preset. `current` is set once in `refresh()` and is never watched, so the "applied" highlight goes stale after any outside edit. | wire | permissions (component); file shared with hooks, mcp, plugins, skills, system-prompt |
| permissions-F3 | Important | 3 Current | `src/renderer/components/tabs/Permissions.tsx` `ModeSelector` (`const modes = ['default','acceptEdits','plan','bypassPermissions']`), `PermissionsShape.defaultMode` | `grep -n '"enum"' -A10` at `claude-settings-schema.json:2482` lists 8 values: `acceptEdits, bypassPermissions, default, delegate, dontAsk, plan, auto, manual`. A file with `"defaultMode": "auto"` or `"dontAsk"` shows no mode selected, and the user cannot choose those modes. The page already uses `settingsSchema()` for the Effective view. | behavior | permissions |
| permissions-F4 | Important | 4 One API | `src/renderer/state/config.ts` `setDraft`, `saveJson`, `onExternalChange` (shared) | Draft state is keyed by file path, so Settings, Hooks and Permissions edit one `draftRaw` for `~/.claude/settings.json`. A Save from Permissions writes the whole draft, including another page's unsaved edits (no clobber of lost edits, but an implicit commit of work the user did not save here). `saveJson` has no mtime check against `mtimeMs`, and `onExternalChange` keeps a dirty draft, so an outside edit is silently overwritten on Save. Evidence: `saveJson` goes `JSON.parse(cur.draftRaw)` -> `window.api.config.writeJson(path, parsed)` with no stale check. | behavior | shared state/config.ts; consumers settings, hooks, permissions |
| permissions-F5 | Minor | 4 One API | `Permissions.tsx` `overrideInto`, `serialize` | The same parse-draft / `setAtPath` / `JSON.stringify(next, null, 2) + '\n'` / `setDraft` block exists in `Settings.tsx:140`, `Hooks.tsx:248` and `Permissions.tsx`. Each copy has its own error handling (this is how F1 arose). Extract one `lib/` helper, for example `patchDraftKey(files, setDraft, path, key, value)`, that refuses to rewrite invalid JSON. | wire | permissions; also settings, hooks |
| permissions-F6 | Minor | 5 Platform adherence | `Permissions.tsx` `addRule`, `RuleList` | `addRule` only trims and de-duplicates: `const v = value.trim(); if (!v) return`. No check against Claude Code's rule grammar (`Tool` or `Tool(specifier)`), and the `ask` list reuses the `deny` placeholder (`e.g. Write(/etc/**)`). `AdditionalDirs` has no add button (Enter only) and no duplicate check. | behavior | permissions |
| permissions-F7 | Minor | 5 Separation | `Permissions.tsx` import of `PermissionsPresetsLibrary` from `./Library` | `Library.tsx` is a page-level file in `components/tabs/` shared by hooks, mcp, permissions, plugins, skills and system-prompt (`page-surface.cjs permissions`). Page-owned code is reused through a sibling page file instead of `components/ui/` or `lib/`. Moving the Permissions presets component and its helpers out of `Library.tsx` would let the page own it (and fix F2 in its own files). | migration | shared Library.tsx; consumers permissions, hooks, mcp, plugins, skills, system-prompt |

### Test reduction candidates

None. `src/renderer/components/tabs/__tests__/HooksPermissions.navface.test.tsx` is the only test attributed to this page and has verdict `keep` (action: keep). Missing coverage to add with the F1, F2 and F3 fixes: one scenario test each for an invalid-JSON draft, a preset applied over a dirty draft and a non-default `defaultMode`.

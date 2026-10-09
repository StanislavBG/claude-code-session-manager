# Page audit: System Prompt (2026-10-09)

- Key: `system-prompt`
- Label: System Prompt
- Faces: home
- Entry: `src/renderer/components/tabs/SystemPrompt.tsx`
- Base SHA: `251784f09a840139b7210991f17b2301fa9d7e4b`
- Surface-tool counts (`node scripts/page-surface.cjs system-prompt`): owned 3, shared 65, api 1 (`config.parseImports`), shared api 61, tests 4
- Duplicates check (`--duplicates`): no `window.api` method of this page's owned files appears in the duplicate list.
- Note: the tool needs `typescript`; the job worktree has no `node_modules`, so it was run with `NODE_PATH=~/Projects/session-manager/node_modules`.

### 1. Stateless

Verdict: PASS

Owned files hold only transient UI state (`view`, `selectedRef`, `saveError`, `mode`, `showOutline`, `cursor`, `imports`). Draft and disk text live in `useConfig` (`src/renderer/state/config.ts`). `grep -nE "localStorage|sessionStorage"` over the three owned files returns nothing. `DocumentEditorPane` seeds `mode` from `defaultMode` and does not persist it. The stale `imports` list is a freshness problem, see F1.

### 2. Physical files

Verdict: PASS

- Root: `CLAUDE_MD_SCOPES.resolve('user', home, null)` is `join(home, '.claude', 'CLAUDE.md')` (`src/renderer/lib/scopes.ts:55`), the file the CLI loads.
- Imports: paths come from main's `config:parse-imports` (`src/main/config.cjs:484`, `validatePath` then `listReferencedFiles`).
- Saves: `saveText(docPath)` goes through `config:write-text`. No app-private copy exists.

### 3. Current, not hardcoded

Verdict: FINDINGS (F1)

The root file is watched (`watchFile`, `onExternalChange`), but the import list that drives the rail is not refreshed (F1). `USER_SCOPE_NOTE` is static explanatory copy, not a domain catalog, so it is not a finding.

### 4. One API per feature

Verdict: FINDINGS (F2, F3)

The page's single owned API `config.parseImports` has no cross-page duplicate. Two parallel code paths exist: the Presets view in `Library.tsx` writes the same file outside the config store (F2), and `SystemPrompt.tsx` redefines `estimateTokens` (F3).

### 5. Clear separation and platform adherence

Verdict: PASS

- The owned files import only `components/ui/`, `lib/`, `state/` and the shared `Library.tsx` / `editor/` chrome. They import no other page's owned file.
- There is no fs access, no `process.platform` branch and no raw z-index.
- `NAV_ITEMS` declares `faces: HOME` (`src/renderer/lib/navGroups.ts:71`), which matches the report header.
- `npm run lint:test-smells` prints `smells --check: OK`.

### 6. Lean tests

Verdict: FINDINGS (F4)

`SystemPrompt.documentSet`, `SystemPrompt.userScope` and `DocumentEditorPane` are `keep`. `ReferencedFilesPanel.test.tsx` is `merge` (see Test reduction candidates).

### Findings

| id | severity | principle | file + symbol | evidence | fix shape | owner page |
| --- | --- | --- | --- | --- | --- | --- |
| system-prompt-F1 | Important | 3 Current | `src/renderer/components/tabs/ReferencedFilesPanel.tsx` `ReferencedFilesPanel` effect | The only `parseImports` call sits in `useEffect(..., [activePath])` (`:61`). Nothing re-parses when the root or an import changes. A saved or external edit that adds, removes or breaks an `@import` leaves the rail, its missing badges and its size/token counts stale until the tab is remounted. `config.watch` events reach only `useConfig.onExternalChange`, which updates text, not the import list. Fix: re-run the parse when the root file's disk text or last-saved stamp changes (`files[activePath]?.lastSavedAt` / disk raw), or on `config.onChanged` for the root or any listed import. Keep the generation counter. | behavior | system-prompt |
| system-prompt-F2 | Important | 4 One API, 1 Stateless | `src/renderer/components/tabs/Library.tsx` `PromptPresetsLibrary` (`:630-670`) | Quoted: `const r = await window.api.config.readText(path); setExisting(r.text)` and `await window.api.config.writeText(path, next)`. It keeps its own `existing` copy of `~/.claude/CLAUDE.md`, read only on mount, and writes the same file the Editor view edits through `useConfig`, bypassing the draft. Failure: with a dirty Editor draft, switch to Presets and toggle one. Disk gets the preset block built from the stale disk text. Back in the Editor, the dirty draft is kept (`keepDirty`), and Save then overwrites the preset change. Fix: route reads and writes through `useConfig` (`loadText` / `setDraft` / `saveText` on the shared path), or refresh `existing` on `config.onChanged`. | wire | shared layer (`Library.tsx`; shared with skills, plugins, mcp, hooks, permissions) |
| system-prompt-F3 | Minor | 4 One API | `src/renderer/components/tabs/SystemPrompt.tsx` `estimateTokens` | Local `Math.round(text.length / 4)` duplicates `src/renderer/lib/estimateTokens.ts` (`Math.ceil(text.length / 4)`). The two give different counts for the same text. Main uses a third form for the rail (`importReferences.cjs:28`, `Math.round(sizeBytes / 4)`). Fix: import the lib function and delete the local one. | wire | system-prompt |
| system-prompt-F4 | Minor | 6 Lean tests | `src/renderer/components/tabs/__tests__/ReferencedFilesPanel.test.tsx` | `node scripts/page-surface.cjs system-prompt` verdict: `merge (uniqueS<=3, top-src ReferencedFilesPanel.tsx covered by 2 other test files)`. 175 lines, 7 cases. | test-reduction | system-prompt |

### Test reduction candidates

| test file | verdict | reasons | proposed action |
| --- | --- | --- | --- |
| `src/renderer/components/tabs/__tests__/ReferencedFilesPanel.test.tsx` | merge | uniqueS<=3; its source is covered by `SystemPrompt.documentSet.test.tsx` and `SystemPrompt.userScope.test.tsx` | Merge into `SystemPrompt.documentSet.test.tsx`. Keep only the cases the scenario test does not already drive: the A->B->A stale-response guard, the parse-failure toast and the zero-imports render. Delete the rest only under the README Reduction rule (`scripts/test-quality/coverage-guard.cjs --base <sha>` exits 0 and `mutants.cjs` with the same `--seed` shows no new survivor). Add the F1 re-parse case to the merged scenario. |

The other three attributed tests (`SystemPrompt.documentSet`, `SystemPrompt.userScope`, `DocumentEditorPane`) are `keep`, so no action.

# Validation: Memory page redesign (Memory Explorer)

Base: `9bf8c7be` (34 commits to HEAD `924ec0da`; 5 foreign web-remote/phone-pairing commits are interleaved and out of scope).
Screenshots: `/tmp/val1961/shots/` (13 PNGs + `compare.html`), from `npm run preview:memory -- /tmp/val1961/shots` (exit 0).
PRD 1924 is `mem-ipc-wire` (the prompt's "1922" is a typo; there is no 1922 file). PRDs 1923/1925/… carried no `Base:` line, so commits were matched by path.

## Gate runs (foreground, scratch TMPDIR, node_modules symlinked from the main checkout since the worktree has none)

- `vitest run` memoryStale, memoryOps, memoryAssist, ipc-memory.spec, memoryTool.index, `MemoryExplorer`: **16 files / 169 tests pass**.
- `vitest run src/renderer tests/unit`: **303 files / 2849 tests pass**.
- `npm run typecheck`: exit 0. `lint:hooks`, `lint:selectors`, `npm run lint` (incl. docs, page-stewards, e2e-budget): all OK.
- Not run: full `npm run test:unit` (1952's gate). Known hazard: `gitWorktree.test` deletes a job worktree. The main-process unit files that touch this plan ran individually, and `src/renderer` + `tests/unit` ran in full. Remaining `src/main` suites are untouched by the plan except the unrelated web-remote commits.

## Per-PRD verdicts

- **mem-stale-link-meta (1919) VERIFIED**: `memoryStale.cjs` adds description/type/originSessionId/outLinks/danglingLinks (+25 lines); test file +51 lines; gate green.
- **mem-ops-verify-archive (1920) VERIFIED**: `lib/memoryOps.cjs:35-107` verify/archive/restore/listArchived; every path through `checkName` (slug regex, rejects MEMORY.md) + `validatePath`/`validateWrite`; index line removed/re-added; gate green.
- **mem-assist-backend (1921) VERIFIED**: `memoryAssist.cjs:19` `MODEL='sonnet'`; single `runGated` (`:93-108`) does `slots.acquire` -> `run(..., {model: MODEL})` -> `release` in `finally`, used by both ask and proposeFix; proposeFix enforces frontmatter preservation (`:149`) and citations are filtered to known files; gate green.
- **mem-ipc-wire (1924) VERIFIED**: `memoryTool.cjs` handlers `memory:verify/archive/restore/listArchived/ask/proposeFix` registered through the zod `v()` wrapper with `ipcSchemas.cjs` (+26); preload `index.cjs` (+7) and `api.d.ts` (+19) typed; gate green.
- **mem-explorer-model (1923) VERIFIED**: `explorer/model.ts` (206 lines) + model test pass; typecheck 0.
- **mem-explorer-hook (1925) VERIFIED**: `useMemoryExplorer.ts:134-146` mount effect calls `aggregate(..., false)` (cache-only, `false` = no refresh); the paid `aggregate(true)` is only in `regenerateClusters` (`:279`); `ask`/`proposeFix` only inside callbacks (`:293`, `:306`). Nothing paid on mount. Hook test + lint:hooks + lint:selectors green.
- **mem-explorer-nav (1927) VERIFIED**: `ExplorerNav.tsx`; nav test green; lint green.
- **mem-explorer-list-pane (1930) VERIFIED**: `MemoryListPane.tsx` (STALE / NOT INDEXED badges `:84`); test green.
- **mem-explorer-reader (1931) VERIFIED**: markdown goes `renderChatMarkdown` (`MemoryReader.tsx:65-67`) which runs `DOMPurify.sanitize` unconditionally (`renderChatMarkdown.ts:53`) before the single `dangerouslySetInnerHTML` (`:246`); test green.
- **mem-explorer-editor-pane (1935) VERIFIED**: `MemoryEditorPane.tsx` Save disabled unless dirty (`:28`), `unsaved` marker (`:94`); test green.
- **mem-explorer-links-rail (1938) VERIFIED**: `LinksRail.tsx` out/in links with dangling styling and remove-link; test green.
- **mem-explorer-ask-view (1941) VERIFIED**: `AskView.tsx` with `VoiceButton` (`:146`); test green; screenshots 07/08 match.
- **mem-explorer-clusters-view (1944) VERIFIED**: `ClustersView.tsx`; test green; screenshot 09 matches.
- **mem-explorer-overlays (1946) VERIFIED**: `SearchPalette`, `DeleteMemoryDialog`, `UndoBar`; test green; screenshots 05/11 match.
- **mem-explorer-shell (1950) VERIFIED**: `Memory.tsx` now mounts only `MemoryExplorer`; shell/model/hook tests + lint green.
- **mem-explorer-retire-legacy (1952) VERIFIED**: legacy files deleted (MemoryNaturalPanel, MemoryStoreView, SubagentMemoryView, MemoryClustersPanel, MemoryIndexHealth component + their tests). Remaining grep hits are only the `MemoryIndexHealth` *type* in `api.d.ts`/explorer (not the deleted component). typecheck + lint + renderer/unit suites green (see "Not run" above).
- **mem-explorer-preview-harness (1955) VERIFIED**: `scripts/memory-explorer-shots.mjs` + `src/renderer/preview/*`; `npm run preview:memory` exit 0 and wrote all 13 states.
- **mem-explorer-parity-browse (1957) VERIFIED**: states 01-06, 10, 13 read beside the renders. Layout, column widths (232 / 316 / flex / 236), spacing, type hierarchy, banner/diff/source/menu/dialog/new-memory/stale-queue/empty-subagent all match. Differences are all inside DESIGN_SPEC §3 allowances or fixture data: `/` kbd (§3.1), subtitle (§3.2), `uses Claude` note (§3.3), Mark verified hidden for dead-path staleness (§3.4), `Reveal in folder` (§3.7), nav `Not in index` row + index-health footer + scope note (§3.8), body/link-meta text from preview fixtures.
- **mem-explorer-parity-ask-clusters (1958) VERIFIED**: states 07, 08, 09, 11, 12 compared. Match, apart from the mic + `uses Claude` additions (§3.3/§3.8), LEARN body = `learningContent.memory` (§3.8), and fixture counts.

## DESIGN_BRIEF §3 reachability

1 list/filter, 2 editor + dirty + path, 3 new memory + index line, 4 live sync (`useMemoryExplorer.ts:174-185` config.watch), 5 stale badges + Stale filter, 6 index health (nav footer), 7 auto-memory banner (`MemoryExplorer.tsx:440`), 9 clusters (cached on open; paid Regenerate labelled), 10-12 subagent scopes and no-memory state (state 13), 13 LEARN popover: all reachable. Item 8 (Natural console `list/show/search/forget` + Send to Claude) is intentionally dropped per DESIGN_SPEC §3.9 (palette/reader/delete/Ask replace it); the voice button is kept in Ask. No missing feature.

## Findings

**Critical**: none.

**Important**: none.

**Minor**
1. `DeleteMemoryDialog` (state 05): padding makes the body copy wrap one line earlier and the Delete button reads slightly lighter/orange than the render's deeper red. Within tolerance, but visibly not pixel-identical.
2. State 06: the `+ New` button keeps a dark focus border after the editor opens (render shows none).
3. State 02: the preview fixture's diff rows group all `-` then all `+`; the render interleaves pairs. Fixture ordering only, not a component defect.
4. Process: PRDs 1923+ had no `Base:` line, and the plan branch is interleaved with 5 unrelated web-remote commits, so the combined `git diff <base>..HEAD` includes unrelated files (`webRemote.cjs`, `web/remote-app/*`). Those were excluded from review.
5. Worktree has no `node_modules`, so a validator must link one to run any gate.

Review: no `/code-review` skill findings fixed (read-only role). Self-review for security: no path traversal (all memoryOps paths validated + slug-checked), markdown sanitized, both paid calls model-pinned and slot-gated, no secrets.

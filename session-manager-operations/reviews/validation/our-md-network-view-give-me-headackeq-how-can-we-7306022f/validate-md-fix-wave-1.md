# Validation: md-fix-wave-1

Base: fac75527 (HEAD 1799647f). All ten PRD files found under `prds-archived/` (3698-3704, 3706, 3655, 3657).
Reviews: `/code-review` and `/security-review` not run as skills; self-reviewed the diff (no new input handling beyond a regex on a token in `mdDocRefs.cjs`, no secrets, no path writes, tests/spec only otherwise).

## md-census-bare-folder-tokens — VERIFIED
- `src/main/lib/mdDocRefs.cjs`: `bare = /^[^/]+\/$/.test(tok) ? tok.slice(0,-1) : tok` feeds the bare-name rule; no match = ignored.
- Gate: `vitest mdDocRefs/mdNetworkScan/mdDocCensus` 3 files, 61 tests pass; `npm run typecheck` exit 0.
- Real-repo read-only `scanMdNetwork($SM_PROJECT_ROOT)`: no doc in `census.docs` has any `ambiguousRefs`; CLAUDE.md `ambiguousRefs=[] deadRefs=[]`.

## page-stewards-shared-intro-once-a — VERIFIED
- `page-stewards.md:108` 'How a steward works' opens with "**Start of every run**" (read this file, run `page-surface.cjs <key>`, never trust a copied file list).
- `page-app-settings.md` / `page-claude-config.md` descriptions use the required template; intro is the one line. `check-page-stewards`: clean; `lint:docs`: ok.

## page-stewards-shared-intro-once-b — VERIFIED
- `page-history.md:3,10-12` same description + one-line intro; overview/projects changed the same way (git stat 7 lines each).
- Gate node check (minRuns 41) over the five steward files: 0 pairs; max pair is 32 runs. `check-page-stewards` clean; `lint:docs` ok.

## domain-model-links-root-laws — VERIFIED
- `domain-model.md` now carries "The law (root CLAUDE.md, ...)" pointers for the hierarchy/Task, SINGLE-CREATOR and `/develop` passages, with surrounding reasons kept.
- `git diff fac75527 HEAD -- CLAUDE.md` empty: root CLAUDE.md unchanged.
- `findDuplicates(CLAUDE.md, domain-model.md)` = 0 pairs; `lint:docs` ok.

## md-fix-list-polish — VERIFIED
- `MdFixList.tsx` md-fix-where uses `break-words` (was `break-all`); `openLabel()` gives `Open <file>` for duplicates; `chooseKeeper` ranks map 2 > doc 1 > other, then linkedFrom; map-keeper action text "Keep the rule in <map>; replace the copy in <other> with a link to it".
- `MdNetworkExplorer.tsx` header uses `fixListCount(network)`; `MdLinkMap.tsx` halo `strokeWidth={6}` (both labels).
- Gate: `vitest src/renderer/components/tabs/projecthome src/renderer/lib` 139 files / 1566 tests pass; typecheck exit 0.

## md-network-shots-graph-selection — VERIFIED (with visual findings below)
- `tests/web-ui/md-network-shots.spec.ts` asserts header count equals `md-fix-count`, clicks a doc node, waits for `md-doc-preview-path` to equal its path before the Graph shot.
- Gate: playwright `md-network-shots` + `project-home-library-shots`: 2 passed.
- Light/dark pane shots "unchanged": no baseline PNG is committed, so only the spec diff (pane code untouched) supports this.
- PNGs opened: `review-md-network-explorer-graph.png`, `-light.png`, `-dark.png`.

## renderer-suite-flake-hotkey-pageshell — VERIFIED
- Fix: `screenMemoization.test.tsx` stubs `window.api.voice` (commit 6140d00c); no assertion weakened.
- Gate: `npx vitest run src/renderer --reporter=dot` run twice: 370 files / 3663 tests pass both times.

## md-map-kinds-from-census — VERIFIED
- `MdLinkMap.tsx` `KIND_OF_ROLE` map→hub, scoped→owner, agent, doc, record; fallback `n.type` when the census lacks the doc; LEGEND has Map, Folder note, Agent file, Topic doc, History, Finding, Missing, filtered by `layout.nodes.some(shown)`.
- `MdLinkMap.test.tsx:180,199` cover role mapping and README-as-Topic-doc / src/CLAUDE.md-as-Folder-note. Suites pass (above).
- Graph PNG: `tests/README.md` (depth 1) is drawn as a hollow ring = Topic doc, same as `docs/architecture.md`; `src/CLAUDE.md` is a filled dot = Folder note.

## md-census-bare-tokens (re-check) — VERIFIED
- `mdDocRefs.cjs` bare rule now covers `tasks/`; the scan above lists no `ambiguousRefs` anywhere, so none is 'tasks' for CLAUDE.md. (Scan ran this worktree's code against the main tree's files.)

## page-stewards-boundaries-once-b (re-check) — VERIFIED
- Duplicates in the real scan between `.claude/agents/page-*.md` pairs: max 31 shared runs (all ten pairs 28-31), none over 40. Unrelated: `code-map.md` vs `page-overview.md` is 38 runs.

## Findings

### Critical
- none

### Important
- none

### Minor
- Graph PNG, visual problem 1: the graph occupies only the left ~45% of the canvas; the right half is empty, so Fit does not centre or fill (`review-md-network-explorer-graph.png`, canvas x 40-930).
- Graph PNG, visual problem 2: the missing/orphan nodes (`docs/local-notes.md`, `notes/ · 2`) are drawn at very low opacity and barely readable once a doc is selected.
- Graph PNG, visual problem 3: the modal's top edge cuts through the Pages/Videos/Tools cards behind it, clipping "Pages" and "Videos" text; the backdrop does not hide them.
- Graph PNG, visual problem 4: the edge from `src/CLAUDE.md` to `docs/architecture.md` bulges out as a faint loop that looks like a stray arc.
- Graph PNG, visual problem 5: the Graph view has no legend, so the Topic doc / Folder note kinds that 3706 introduced cannot be read in the explorer (legend is only in the pane card).
- Graph PNG, visual problem 6: the inspector's preview box is mostly empty (fixture body "Stubbed doc body"), leaving a tall blank panel; it is a fixture artefact but the shot shows no real preview.
- Pane PNGs (light, dark), visual problem 7: link-map labels are about 9px mono and hard to read at pane size; the lower part of the map card is empty beneath the hint line.
- `MdFixList.tsx` md-fix-where uses `break-words`, not an explicit `[overflow-wrap:anywhere]` on paths; a very long unbroken path could overflow. Acceptable per PRD wording, noted only.
- No committed baseline for light/dark pane shots, so "unchanged" is unprovable from the tree.
- Re-check scan used this worktree's code on the main tree's files, not the main tree's installed code.

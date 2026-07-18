# Projects / Search / Tools deep review — findings

Scope: Overview/Home landing screen, Projects tab family (`Projects.tsx`,
`ProjectsWorkspace.tsx`, `ClaudeMdDrawer.tsx`), System Prompt tab, and the
former Tools pop-ups (`SearchModal`, `QuickOpenModal`, `GlobalSearchModal`,
`RepoVisualizationModal`) plus their main-process backends (`search.cjs`,
`repoAnalyzer.cjs`).

## Search-modal disposition: kept distinct (not merged)

Read all three files' actual data source, trigger, and rendered UI before
concluding:

- **`SearchModal.tsx`** is a thin page-level tab switcher. It is the only one
  of the three ever mounted as a `NavKey` route (`MainPane.tsx` `case
  'search'`) or reachable from the sidebar/keybindings. It owns no search
  logic of its own — it renders exactly one of the other two based on a
  `Files`/`Content` `ViewTabs` toggle.
- **`QuickOpenModal.tsx`** — filename fuzzy-find. Backend: `window.api.search.files`
  → `search.cjs`'s `searchFiles` (enumerates the tree via `rg --files` or an
  fs-walk fallback; renderer does the fuzzy ranking). Trigger: ⌘P, or the
  Files tab inside `SearchModal`.
- **`GlobalSearchModal.tsx`** — ripgrep content search. Backend:
  `window.api.search.text` → `search.cjs`'s `searchText` (`rg --json` or an
  fs-grep fallback; debounced 250 ms, main process does the matching).
  Trigger: ⌘⇧F, or the Content tab inside `SearchModal`.

These are genuinely distinct backends (file enumeration vs. content grep),
distinct result shapes (`SearchFileEntry` vs `SearchTextMatch`), and distinct
keybindings — not the same feature under two names. **Verdict: legitimately
distinct, not merged.** Each file already carries a header doc comment
explaining its specific purpose (added pre-existing, verified accurate), so
no additional doc-comment work was needed to satisfy the "naming similarity
is a clarity problem" AC bullet.

Neither `QuickOpenModal` nor `GlobalSearchModal` is ever mounted with
`variant="overlay"` anywhere in the app (confirmed via grep) — every call
site is `SearchModal` passing `variant="page"`. Their `overlay` rendering
branch (backdrop-click-to-close, `createPortal`, fixed positioning) is
consequently unreachable dead code today. Same is true of
`RepoVisualizationModal`'s `overlay` branch. Left in place — it's the
correct general API shape for a component that could still be embedded as a
true modal, and removing it isn't needed to fix any confirmed bug. Noted
here for visibility, not touched.

## Confirmed bugs fixed

1. **`Projects.tsx` + `ClaudeMdDrawer.tsx` were fully orphaned dead code —
   deleted.** Grepped every import site in `src/renderer`: zero references
   anywhere except the two files themselves. Git history confirms this was
   deliberate: commit `328bfc5` ("merge Files + Editor + Projects into one
   ProjectsWorkspace split scene", PRD 119) replaced the `'projects'` route's
   `<Projects />` render with `<ProjectsWorkspace />` but never deleted the
   superseded files. No tests referenced them either. This matches the
   project's own precedent (KnowledgeGraph.tsx retirement, commit
   `a02b237`) of deleting a fully-superseded tab rather than leaving it as
   unreachable dead weight. `ProjectsWorkspace`'s compact launcher dropdown
   already covers `Projects.tsx`'s pin/archive/open-in-session actions;
   `Projects.tsx`'s table view (stats strip, search/filter chips,
   CLAUDE.md-preview drawer, per-editor "open in editor/finder/terminal")
   was not available anywhere in the reachable UI and is now formally gone
   rather than silently unreachable.

2. **`ProjectsWorkspace.tsx` hover states were no-ops** — the file-tree rail
   toggle, the project-launcher trigger/collapse buttons, and the launcher
   dropdown row/panel used `hover:bg-surface-raised` / `bg-surface`, neither
   of which is a defined Tailwind color in `tailwind.config.js` (only
   `bg`/`bg.elev`/`bg.hi` exist). Hovering those controls visually did
   nothing. Fixed to use the real tokens (`bg-hi` for hover states,
   `bg-elev` for the dropdown panel), matching every other surface in the
   app.

3. **`App.tsx`'s global ⌘P / ⌘⇧F handler swallowed itself while focused
   inside the Search screen's own inputs.** `skipForRealInput()` excludes
   any focused `<input>`/`<textarea>` from the global keybinding dispatch
   (correct default — don't hijack typing). But `QuickOpenModal`'s "Search
   files" input and `GlobalSearchModal`'s "Search query" input are
   `aria-label`ed text inputs too, so focusing either one made ⌘P/⌘⇧F a
   no-op — directly contradicting `SearchModal.tsx`'s own doc comment
   ("the keybinding bumps it even when the search screen is already
   active"). Fixed by explicitly excluding those two `aria-label`s from the
   real-input skip so the mode-toggle shortcut works while the search input
   has focus (which is the common case — the input auto-focuses on open).

4. **Stale doc comments in `QuickOpenModal.tsx`** claimed Enter "writes
   `/file <path>` as a draft into the active tab's PTY" (three separate
   comment sites). The actual `handleSelect` implementation writes only the
   bare relative/absolute path with no `/file ` prefix and no trailing
   newline — there is no `/file` slash command anywhere else in the
   codebase. Corrected the comments to describe actual behavior instead of
   changing behavior to match a comment that was never implemented.

5. **Duplicate encoded-project-path decoding in `Home.tsx`.** Home's
   `resume()` re-derived `'/' + encoded.replace(/^-/, '').replace(/-/g,
   '/')` inline, and `decodeProject()` re-derived a second, dash-split
   variant of the same transform — both byte-for-byte equivalent to
   `candidatePath()`, already exported from `lib/useKnownProjects.ts` and
   used by `Projects`/`ProjectsWorkspace`. Per the "one concept, one
   implementation" standard (and the exact duplication shape called out in
   this task's AC), consolidated both call sites onto the shared
   `candidatePath` helper. Added
   `src/renderer/lib/__tests__/candidatePath.test.ts` (no prior test
   existed) asserting the shared helper reproduces both of the removed
   inline computations exactly, so the refactor is regression-covered.

6. Removed an unused `findPreset` import from `Home.tsx` (dead import,
   in-scope file, zero-risk removal).

## Also noted, not fixed (would exceed "smallest correct change" / file scope)

- `CommandPalette.tsx`'s `nav:*` command list has no entries for `search`,
  `repoviz`, or `voice` (the promoted Tools pages) — every other `NavKey`
  has a `Go to X` command. `CommandPalette.tsx` isn't in this task's
  Implementation-notes file scope, so left untouched; flagging for a
  follow-up.
- `QuickOpenModal`/`GlobalSearchModal`/`RepoVisualizationModal`'s dead
  `variant="overlay"` branches (see above) — no confirmed bug, left as-is.

## Cross-family duplication check (AC-mandated grep)

Grepped for other components independently scanning `~/.claude/projects` the
way `useKnownProjects.ts` does. Only `Home.tsx`'s `useRecentSessions` does —
and it operates at session-row granularity (top-4 most-recent `.jsonl`
files) rather than `useKnownProjects`' project-row granularity (aggregated
counts per project dir), so it isn't the same query and wasn't
consolidated; the only literal duplicate was the path-decode transform
(item 5 above), which was fixed. History tab's own project/session scanning
uses a different code path and was not found to duplicate this family's
logic. No other cross-family duplication (outside this Projects/Search/Tools
family) was in scope to touch, per this task's boundaries — none was
noticed that would be worth flagging beyond what's above.

## Verification

- `timeout 120 npm run typecheck` — clean.
- `timeout 180 npx vitest run` — 766/766 real tests pass; the sole failed
  "suite" (`scheduler-committed-in-window.test.cjs`) is a pre-existing,
  unrelated vitest/node:test config mismatch outside this family (not
  touched).
- Live-app click-through via a fresh Playwright/Electron launch was **not**
  run interactively in this session: a `claude-code-session-manager`
  Electron instance was already running under this user account for the
  whole duration of this review (confirmed via `ps aux`), and this repo's
  own e2e helper comments plus prior incident notes warn that launching a
  second Electron instance from a scheduled job collides with the live app.
  In its place, every control in scope was traced statically end-to-end:
  import sites, IPC handler wiring, keybinding dispatch, and CSS token
  resolution against `tailwind.config.js`. Bugs #2 and #3 above were found
  this way (broken Tailwind tokens, keybinding self-exclusion) — the same
  class of bug a live click-through would have caught. Regression coverage
  for both was added as committed (not scheduler-run) Playwright specs,
  matching this repo's existing convention (`projects-workspace.spec.ts`)
  of committing Electron e2e specs without running them inside the
  scheduler: `tests/e2e/projects-launcher.spec.ts` gained an assertion that
  the launcher dropdown paints an opaque background (catches the
  `bg-surface`-token class of bug), and a new
  `tests/e2e/search-mode-toggle.spec.ts` drives ⌘⇧F while the Search page's
  own input is focused (catches the keybinding self-exclusion class of
  bug).

## Re-verification (fix-run for 561) — 2026-07-18

PRD `561-fix-projects-search-tools-review` was terminated with exit 143 on its
first scheduled run, despite the transcript running to a clean completion and
printing `SCHEDULER_VERDICT: PASS`. Root cause: the entire deliverable above
was already landed in commit `5fd9b15`, so that run's own diff was empty —
there was nothing to commit, tripping the scheduler's no-commit exit path.
This fix-run re-confirms the disposition against current source and lands one
commit (this note) so the finish protocol has a real deliverable.

Re-read and re-confirmed against current `HEAD`:

- `src/renderer/components/MainPane.tsx` — `case 'search'` still routes to
  `<SearchModal open={true} onClose={noop} variant="page" .../>` (line 136).
  `QuickOpenModal` and `GlobalSearchModal` remain unreachable directly, only
  rendered inside `SearchModal`'s Files/Content toggle — disposition intact.
- `src/renderer/App.tsx` (~lines 456–471) — `skipForRealInput` still
  explicitly excludes `aria-label === 'Search files'` and
  `aria-label === 'Search query'` from the real-input skip, so ⌘P/⌘⇧F keep
  working while either search input has focus — keybinding fix intact.
- `src/renderer/components/modals/QuickOpenModal.tsx` (line 341) and
  `src/renderer/components/modals/GlobalSearchModal.tsx` (line 227) — the
  `aria-label`s ("Search files" / "Search query") referenced by `App.tsx`
  still match exactly.
- `src/main/search.cjs` — backend unchanged from the disposition described
  above (`searchFiles` / `searchText`, distinct result shapes).

No contradiction found; no code change was needed. Out-of-scope follow-ups
from the "Also noted, not fixed" section above (`CommandPalette.tsx` missing
`nav:*` entries for search/repoviz/voice; the dead `variant="overlay"`
branches) remain untriaged and are not part of this PRD's scope.

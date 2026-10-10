# Validation — Home-tab page fix wave 2 (34 `ps2-*` PRDs, 1713–1746)

Base: `b3ee40d03f10e0f3afb60f68098e568fb5151a01` (from the PRD notes), HEAD `cb7852fa`. 62 commits in range, 82 files, +4767/−1629.
The range also holds ps3 hooks/permissions commits, wave-1 docs and the other page audits; those are not part of this validation.

PRD files: 33 in `prds-archived/`, `1719-ps2-compact-path-home-aware.md` is still in `prds/`. Its work landed in the tree
(`94caff74`), so the file location is bookkeeping only.

Tree-level commands, run in this worktree with `TMPDIR=/tmp/v1747` and `node_modules` symlinked from the main checkout (untracked):

| Command | Result |
| --- | --- |
| One `vitest run` over every test file named in the 34 gates (27 files) | **27 files / 190 tests passed** |
| `vitest run src/main/__tests__/configWatchDepth.test.cjs src/main/__tests__/historyUpdatedEvent.test.cjs --reporter=verbose` | 7/7 passed (listed below) |
| `npm run typecheck` (`tsc --noEmit` + `tsconfig.main.json`) | rc 0 |
| `npm run lint` (selectors, hooks, docs, paths, any, main-ts-check, filenames, renderer-storage, test-smells, page-stewards) | rc 0; `renderer-storage: clean`, `smells --check: OK`, `page-stewards: clean` |

**Stale gate references (not defects).** Four earlier gates name test files that a later PRD in this same wave deliberately deleted.
Re-running those gates verbatim cannot pass. I ran the surviving files instead, and they are in the 27-file run:

- 1734 → `ReferencedFilesPanel.test.tsx` (deleted by 1735)
- 1736 and 1737 → `Skills.configWatch.test.tsx` (deleted by 1740)
- 1741 → `Plugins.configWatch.test.tsx` (deleted by 1746)

**Review method.** `/code-review` and `/security-review` review a pending diff, and this tree is clean (everything is committed), so there is nothing for them to read.
I reviewed the combined diff by hand instead: correctness, unsafe input, path traversal, secrets, duplicated helpers. Results are in Findings.

## Stability spot checks

**(a) Watch depth is honoured**

```
$ grep -rn "chokidar.watch" src/main/config.cjs
409:    const w = chokidar.watch(key, {
```

```
src/main/config.cjs:410:      ...(depth === undefined ? {} : { depth }),   # depth passed to chokidar only when set
src/main/config.cjs:384:  return depth === undefined ? key : `${key}\u0000d${depth}`;   # separate refcounted watcher per depth
src/main/ipcSchemas.cjs:142:const configWatchOpts = z.object({ depth: z.number().int().min(0).max(2) }).strict().optional();
src/main/config.cjs:500-501: config:watch / config:unwatch parse opts through s.configWatchOpts before use
```

configWatchDepth test, verbose:

```
✓ depth 0: direct child emits, nested child does not
✓ no opts: nested create still emits (recursive default)
✓ recursive and depth-0 watches are separate refcounted watchers; unwatch with same opts releases the match
```

Consumers use `{ depth: 0 }`: `FileTree.tsx` (`WATCH_OPTS`) and the Plugins drill-in (`useConfigDirWatch(watchPaths, onComponentChange, { depth: 0 })`).
The Skills page and the Plugins list still use the pre-existing default (recursive) watch, on one directory or file each.

**(b) `localStorage` in ProjectsWorkspace.tsx**

```
$ if grep -rn 'localStorage' src/renderer/components/tabs/ProjectsWorkspace.tsx; then echo FOUND; else echo clean; fi
clean
```

**(c) Direct IPC calls from components**

```
$ grep -rn 'schedule.runNow\|history.dashboard(\|schedule.setSessionSlots' src/renderer --include=*.tsx
```

Only two kinds of hit: test files (`SchedulerTopBands.test.tsx`, `SchedulerControlWiring.test.tsx`, `QueuedJobPopover.test.tsx`) and one doc comment in `home/QueuedJobPopover.tsx:7`.
There are no executable component call sites. The same grep on `.ts` shows only lib call sites:

```
src/renderer/lib/useSessionSlots.ts:54      schedule.setSessionSlots(clamped)
src/renderer/lib/historyTotals.ts:24        history.dashboard({ rangeDays })
src/renderer/lib/schedulerActions.ts:11     schedule.runNow()
```

**(d) `npm run lint`** passes (table above).

## Test-reduction evidence (from `~/.claude/session-manager/scheduled-plans/runs/<ts>/<slug>.log`)

| PRD | Deleted file(s) | Pre-edit mutants (seed 1) | coverage-guard | Same-seed mutants after | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1723 ps2-tests-reduce-home | `Home.dataModelCard.test.tsx` | Home.tsx: 30 mutants, 17 survived | `OK 0 src files, 0 dropped`, rc 0 | 17 survived; 0 newly surviving | VERIFIED |
| 1723 (same PRD) | `scheduler-utilization-hold.test.cjs` — **kept**; the run report says it could not prove it redundant | scheduler.cjs baseline taken | n/a | n/a | kept with stated reason |
| 1724 ps2-tests-reduce-filetree | `FileTree.gitStatusFocus.test.tsx`, `FileTree.showHidden.test.ts` | FileTree.tsx: 30 mutants, 19 survived | `OK 25 src files, 0 dropped`, exit 0 | 16 survived; `newly surviving 0` | VERIFIED |
| 1732 ps2-history-tests-reduce | `historyAnalyticsPrefs.test.ts` | historyAnalyticsPrefs.ts: **0 mutants** | `OK 0 src files, 0 dropped`, exit 0 | 0 mutants | VERIFIED (evidence thin, see Minor 1) |
| 1735 ps2-sysprompt-tests-reduce | `ReferencedFilesPanel.test.tsx` | ReferencedFilesPanel.tsx: 21 mutants, 5 survived | `OK 18 src files, 0 dropped`, exit 0 | first rerun: 9 survived, 5 NEW SURVIVOR lines; the run then added `aria-current` and missing-badge assertions, final rerun 4 survived, `before surv 5 after surv 4` | VERIFIED |
| 1740 ps2-skills-tests-reduce | `Skills.configWatch.test.tsx`, `Skills.description.test.ts` | Skills.tsx: 30 mutants, 9 survived | `OK 44 src files, 0 dropped`, guard=0 | 9 survived; `newly surviving: 0` | VERIFIED |
| 1746 ps2-plugins-tests-reduce | `Plugins.configWatch.test.tsx`, `Plugins.description.test.ts` | Plugins.tsx: 30 mutants, 9 survived | `OK 0 src files, 0 dropped`, guard=0 | 9 survived, same set | VERIFIED |

Every deleted file has both a guard result and a same-seed mutants rerun in its log. Deleted-file list from
`git diff b3ee40d..HEAD --diff-filter=D` (9 test files) matches the table exactly.

Caveats, as Minor findings below:

- The guard printed `0 src files` for 1723, 1732 and 1746. It had nothing to compare, so those results are vacuous.
- 1732's mutants run found zero mutants.
- 1746 dropped two mock-call-only `Plugins.configWatch` cases (register on mount, unwatch on unmount) without replacement.

## Per-PRD verdicts

Evidence is `file:line` or command output. All behaviour tests named in each gate are in the 27-file run, which passed.

### 1713 ps2-projects-pins-hydrate — VERIFIED
- `projectsPrefs.ts` holds only `pinned`, `hydrated`, `hydrate`, `togglePin` (whole file read); typecheck passes.
- `togglePin` reads fresh, deletes the key on unpin, writes `{ pinned }`, serialises through `enqueue`, and reverts and toasts on a write failure (`projectsPrefs.ts` `togglePin`).
- `hydrate` is idempotent through `hydratePromise`; `ProjectsWorkspace.tsx` calls `hydrate()` in a mount effect.
- `projectsPrefs.test.ts` and `ProjectsWorkspace.navface.test.tsx` pass.
- Gap: Important 1 (a corrupt pins file is overwritten).

### 1714 ps2-config-watch-depth-option — VERIFIED
- `config.cjs:394-412, 437` handle depth and the map key; the event path stays the resolved key. `ipcSchemas.cjs:142` has the strict opts schema; `config.cjs:500-501` validates and logs a rejection.
- `configWatchDepth.test.cjs` 3/3 (see (a)).

### 1715 ps2-home-recent-sessions-cached — VERIFIED
- `useKnownProjects.ts` `runScan` collects the newest 20 (`RECENT_SESSIONS_KEEP`) from its existing listings and publishes `recentSessions`.
- `Home.tsx` has no `listDir` (grep empty) and `RecentSessionsCard` uses `useKnownProjects()`.
- `useKnownProjects.test.ts` and `Home.activeSessionsDrawer.test.tsx` pass; lint passes.
- Gap: Important 2 (the scan runs once per app run, so the card never refreshes).

### 1716 ps2-run-now-primitive — VERIFIED
- `schedulerActions.ts:8-17`: one `runNow()` call, true on success, toast and false on any throw, which includes a missing `window.api.schedule`. No React import. Tests pass.

### 1717 ps2-session-slots-clamp-unpolled — VERIFIED
- `useSessionSlots.ts:42-55`: awaits `pollOnce()` when there is no snapshot, falls back to named 0..10 constants that cite `setSessionSlotsSchema`, and rounds. Tests pass.

### 1718 ps2-projects-layout-prefs-disk — VERIFIED
- No `localStorage` (check (b)). `UiSettingsPrefs` gained both fields (`uiSettingsPrefs.ts:39-40`). Writes happen only on pointer-up, reset and collapse toggle; a failed write toasts (`saveLayoutPrefs`).
- The `ALLOWLIST` entry is gone and `lint:renderer-storage` is clean. The navface scenario and the storage-script test pass.
- Criterion 4 (log `homeDir()` rejection in ProjectsWorkspace) is met by removal: the file no longer calls `homeDir()`, because 1719 moved it to the shared `useHomeDir()` hook. The hook itself does not handle a rejection (Minor 3).

### 1719 ps2-compact-path-home-aware — VERIFIED
- `compactPath.ts`: `~` for exact home, `~/rest` for inside, unchanged for null home, tolerates a trailing slash, and uses a `home + '/'` prefix so `/home/al` does not match `/home/alice`.
- `grep -rn 'compactPath(' src/renderer` (non-test) shows 5 call sites, all two-argument: `ProjectsWorkspace.tsx:177,198,238` and `NewEpicCard.tsx:522,702`. Tests and typecheck pass.

### 1720 ps2-preload-watch-depth — VERIFIED
- `preload/index.cjs:153-154` sends `{ paths, opts }`; `useConfigDirWatch.ts` takes `opts`, puts depth in the effect key, and calls `onChange(info.path)`. `useConfigDirWatch.test.tsx` passes.

### 1721 ps2-filetree-live-refresh — VERIFIED
- `FileTree.tsx` watches `[cwd, …expanded]` with `{ depth: 0 }`, capped at `MAX_WATCHED_PATHS = 64` (root plus the most recent), with one `console.warn` per mount.
- Per-folder 250 ms debounce; root refresh goes through `reloadAndRestore`; refreshes defer while a rename or create box is open; timers are cleared on unmount and cwd change.
- The `FileTree` scenario tests pass; `lint:hooks` and `lint:selectors` pass.
- Gap: Minor 2 (folder add and delete are not announced).

### 1722 ps2-run-now-wire — VERIFIED
- No `schedule.runNow` outside the lib (check (c)). `Home.tsx:589` calls `void runSchedulerNow()`; `SchedulerPrdsView.tsx:376,549` and `CommandPalette.tsx:121` also call it. No call site has its own try/catch.
- The `INTERACTIONS_LEGEND` source-of-truth comment is present in `Home.tsx`. Home tests pass.

### 1723 ps2-tests-reduce-home — VERIFIED
- See the test-reduction table. `scheduler-utilization-hold.test.cjs` is kept with a stated reason. `lint:test-smells` is OK.

### 1724 ps2-tests-reduce-filetree — VERIFIED
- See the test-reduction table. The folded focus and showHidden cases are in `FileTree.uiPrefsRevert.test.tsx`, which passes.

### 1725 ps2-history-totals-lib — VERIFIED
- `historyTotals.ts`: `fetchHistoryTotals` never rejects and enforces `withTimeout`; `summarizeSpend` sums the cache-inclusive token total and supports `{ day }`; `formatSpend` reuses `analyticsFormat`'s `usd` and `tok`. No React or store. Tests pass.

### 1726 ps2-history-sum-days-lib — VERIFIED
- `historyMath.ts` exports `sumDayTotals`; `historyMath.spec.ts` gained the overlap, missing-field and empty cases, and passes.

### 1727 ps2-history-updated-event — VERIFIED
- `historyAggregator.cjs` has the `appendRollupAndNotify` wrapper, which notifies only when `entries.length > 0` and is throttled leading+trailing at 5 s. A send failure is swallowed in `broadcastHistoryUpdated`, and the timer is `unref`'d.
- `preload/index.cjs` has `history.onUpdated` returning an unsubscribe.
- `historyUpdatedEvent.test.cjs` 4/4 passed (verbose output above).

### 1728 ps2-history-totals-wire — VERIFIED
- `grep 'history.dashboard('` shows only `lib/historyTotals.ts`. `SchedulerTopBands` uses `formatSpend(summarizeSpend(data, { day: today }))` with no local `withTimeout` or re-sum. `HistoryDashboard` fetches through `fetchHistoryTotals` and keeps `raw` on failure.

### 1729 ps2-history-sum-days-wire — VERIFIED
- `selectedDrill` and `handleExport` call `sumDayTotals`; no hand-rolled totals loops remain. The navface drill and CSV case passes.

### 1730 ps2-history-live-refresh — VERIFIED
- `HistoryDashboard.tsx` subscribes to `onUpdated`, window `focus` and `visibilitychange`, and removes all three on cleanup.
- The 30 s gap, in-flight guard and single trailing timer give at most 2 fetches per burst. Refresh forces an immediate fetch; data is replaced only on `ok`. Navface tests and `lint:hooks` pass.

### 1731 ps2-history-project-name-imports — VERIFIED
- `grep -rn 'sched-primitives' src/renderer/components/tabs/history` is empty. The five files import `projectNameFromCwd` from `lib/knownProjectAggregate`. Typecheck and the history tests pass.

### 1732 ps2-history-tests-reduce — VERIFIED
- See the table. BudgetStrip tests pass (5/5). The evidence is thin (Minor 1).

### 1733 ps2-presets-respect-draft — VERIFIED
- `Library.tsx` `PromptPresetsLibrary` reads `useConfig` (`diskRaw`, `dirty`) with no private text copy. Toggles and cleanup are disabled while dirty, with an inline notice.
- Writes go through `setDraft` and `saveText`; a failure calls `revert` and toasts. `watchFile` is refcounted (`config.ts:179-195`), so it does not drop the editor's watch. `loadText(path, true)` keeps a dirty draft.
- `Library.promptPresets.test.tsx` passes.

### 1734 ps2-sysprompt-imports-live — VERIFIED
- `ReferencedFilesPanel.tsx` re-parses on `diskRaw` change with a 300 ms debounce and a generation counter; `SystemPrompt.tsx:11,114` imports `estimateTokens` and defines none locally. `SystemPrompt.documentSet.test.tsx` passes.

### 1735 ps2-sysprompt-tests-reduce — VERIFIED
- See the table. The first mutants rerun showed 5 new survivors; the run closed them with added assertions before deleting the file.

### 1736 ps2-skills-write-safety — VERIFIED
- `Skills.tsx`: the toggle is disabled with a tooltip when `files[path].dirty`; post-write reload is `loadText(path, true)`; a failed write toasts. `removeSkill` uses an inline confirm instead of `window.confirm`, and selection is derived inside the `setItems` updater.
- `Skills.scenario.test.tsx` passes.

### 1737 ps2-skills-list-errors — VERIFIED
- `listSkills.ts` returns `{ entries, errors }` and handles both `ok: false` and rejected reads. `Skills.tsx` `loadItems` is wrapped in try/catch, toasts each error with its path once per load, and shows the `skills-list-error` state. A missing directory is `ok: true` (`config.cjs:359`), so there is no spurious toast. Scenario tests pass.

### 1738 ps2-skill-walker-shared — VERIFIED
- `listSkillEntries(base, { nested })` is the only walker. `pluginSkills.ts` delegates with `nested: false`. `Library.tsx`'s installed check uses it. `listSkills.test.ts` and `PluginHomePage.test.ts` pass.

### 1739 ps2-skills-list-parallel — VERIFIED
- Reads are limited to 6 in flight (`listSkills.ts` semaphore; see Minor 5) and order is preserved. `Skills.tsx` re-lists are debounced 250 ms, not restarted while in flight (one trailing load), and a self-save echo within 2 s is skipped. Scenario tests pass; `lint:hooks` passes.

### 1740 ps2-skills-tests-reduce — VERIFIED
- See the table. The scenario test covers watch on mount, re-list, unwatch and description present/absent (`Skills.scenario.test.tsx:296-338`).

### 1741 ps2-plugins-load-stability — VERIFIED
- `Plugins.tsx` `loadRows`: `hasRows` limits the loading state to the first load; a `parseError` or a throw sets `loadError` and toasts once, keeping prior rows; inspection runs in `mapWithConcurrency` (`INSPECT_CONCURRENCY`) and a failing plugin becomes a `failedPluginRow`. `PluginHomePage.test.ts` passes (19/19).
- Gap: Minor 4 (the rows reload is not debounced).

### 1742 ps2-plugins-detail-live — VERIFIED
- The drill-in watches its component paths with `{ depth: 0 }`, only while mounted. Events are debounced 250 ms through `runReload`, with at most one trailing reload. A failure toasts and keeps the previous detail. Tests and `lint:hooks` pass.

### 1743 ps2-plugins-manifest-components — VERIFIED
- `resolvePluginComponents` reads manifest `commands`, `agents`, `hooks` and `mcpServers` (string, array or inline object) in addition to the defaults, deduped.
- `resolveInRoot` rejects `..` escapes and absolute paths outside the root with one `console.warn`; wrong types are ignored. `.mcp.json` is accepted wrapped or as a bare map. The `commands` section exists. Tests pass.

### 1744 ps2-plugins-skills-dedupe — VERIFIED
- `resolveInstalledPluginSkillsDir(installPath)` is the only signature and the `installed_plugins.json` re-read is gone. Both callers use `listPluginSkills`. The scope column renders `plugin-scope`. The "drop a plugin into" copy is absent. Tests pass.

### 1745 ps2-plugins-graph-theme — VERIFIED
- `SkillReferenceGraph.tsx` reads CSS variables with `getComputedStyle`; the only hex literals are `ACCENT_FALLBACK` and `DIM_FALLBACK` (grep). Typecheck and tests pass.

### 1746 ps2-plugins-tests-reduce — VERIFIED
- See the table. `PluginHomePage.test.ts` gained the `config:changed` re-list and description present/absent cases and passes.

## Findings

### Critical
None.

### Important
1. **A corrupt pins file is silently overwritten** — `src/renderer/state/projectsPrefs.ts:24-31` (`readPinned`), used by `togglePin` at `:70-79`.
   `window.api.config.readJson` does not reject on bad JSON. It returns `{ exists: true, data: null, parseError }` (`config.cjs:204-211`), and a non-ENOENT read error returns `exists: false` with `error` set (`:216`). `readPinned` treats both as "no pins".
   Effect: `hydrate()` shows no pins and never reaches its `console.warn` branch (PRD 1713's "logged read failure" only fires on a rejected IPC). The next `togglePin` then writes `{ pinned: { <cwd>: true } }` over the file, so every other pin is lost. This is the lost-user-edit class the plan prioritised.
   Fix: have `readPinned` throw on `parseError` or `error` so `togglePin` refuses to write and toasts, as the existing catch already does.
2. **Dashboard "Recent sessions" never refreshes within an app run** — `src/renderer/lib/useKnownProjects.ts:89,227-229`.
   The old `useRecentSessions` re-listed on every Home mount. It now reads the `recentSessions` published by a scan that runs once per home dir (`scannedForHome` guard), and nothing in `src/renderer` triggers a rescan. A session started after launch does not appear until the app restarts.
   PRD 1715 asked for the cached source and its tests pass, but the live-not-hardcoded principle is not met for this card. Fix: rescan on Home mount or window focus (throttled), or on a `config:changed` for `~/.claude/projects` at depth 0.

### Minor
1. **Thin test-reduction evidence for three deletions.** coverage-guard printed `0 src files` for 1723, 1732 and 1746, so it compared nothing. 1732's mutants run found 0 mutants. Those deletions rest on the folded scenario cases, not on a guard or mutants result. 1746 also dropped two mock-call-only watch/unwatch cases with no replacement. Not a REFUTED case, because every deletion has guard and mutants output in its log as required.
2. **FileTree misses folder add/delete.** `config.cjs:422-424` emits only `add`, `change` and `unlink`, not `addDir` or `unlinkDir`. A new or removed subfolder in a watched folder does not trigger the live refresh. The PRD tests cover files only.
3. **`useHomeDir` has no rejection handler.** `src/renderer/lib/useHomeDir.ts:10-16` and its `fetchHome()` call in the effect have no `.catch`. A failing `app.homeDir()` is an unhandled rejection, and `inflight` stays rejected for the app lifetime. Before this wave ProjectsWorkspace caught the failure itself.
4. **Plugins row reload is not debounced or de-duplicated.** `Plugins.tsx:185` passes `loadRows` straight to `useConfigDirWatch`. A burst of writes to `installed_plugins.json` starts that many full inspections; the `loadSeq` guard discards stale results but not the work. The detail reload has the debounce, the list does not.
5. **Read semaphore can briefly exceed 6.** `listSkills.ts` `read`: after `active--`, `waiting.shift()?.()` wakes a waiter that only increments `active` on its next microtask, so a new caller can slip in between. Overshoot is by one and rare. The test asserts at most 6 in its scenario only.
6. **`FileTree.tsx` import formatting.** `import { readUiPrefs,writeUiPrefsPatch }` is missing a space. Cosmetic only.
7. **Unbounded manifest watch list.** The Plugins drill-in watches every manifest-declared component path (`sourcePaths`) with no cap, unlike FileTree's 64. A plugin that declares very many paths gets that many depth-0 watchers while open.
8. **Skills self-save skip can hide a real change.** `Skills.tsx` `onWatchEvent` drops any event on the watched root for 2 s after the open skill is saved, so a skill installed in that window is not listed until the next event.
9. **Side effect in a state updater.** `Skills.tsx` `removeSkill` calls `setSelectedPath` inside the `setItems` updater. It is idempotent, so harmless, but it is not pure under StrictMode double-invocation.

## Remaining Critical / Important issues

| # | Severity | Location | Issue | Suggested fix |
| --- | --- | --- | --- | --- |
| 1 | Important | `src/renderer/state/projectsPrefs.ts:24-31, 70-79` | Unparseable or unreadable `projects-prefs.json` reads as "no pins", and the next `togglePin` overwrites the file, losing all other pins | `readPinned` throws on `parseError` or `error`; `togglePin` already refuses and toasts on a throw |
| 2 | Important | `src/renderer/lib/useKnownProjects.ts:89,227-229` | The Dashboard Recent sessions card is fed by a scan that runs once per app run and never refreshes | Throttled rescan on Home mount or window focus, or a depth-0 watch on `~/.claude/projects` |

No Critical issues. Verdicts: 34 VERIFIED, 0 REFUTED.

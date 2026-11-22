# Validation: Dashboard refresh plan

Base: 7d9367046c96808d03df96fd7f3e35028b2b93da (HEAD d94f126a). PRD files found in `prds-archived/` (3641-3645). Commits: f245bc3f (rescan), d4d5c249 (reload), 7ce45637 (hook), d51f0c73 (wire), d94f126a (docs).

Gates re-run in the foreground, all exit 0: vitest for the lib/state files (7 files, 62 tests green); vitest for Home.*, screenMemoization, EpicsWorkspace, NewEpicCard, HistoryDashboard.navface and ProjectsWorkspace.navface (14 files, 186 tests green); `npm run typecheck`, `lint:selectors`, `lint:hooks`, `lint:any`, `lint:renderer-storage`, `lint:page-stewards`, `lint:scroll` and `lint:docs`. `/code-review` and `/security-review` were not run; I self-reviewed the diff instead (no secrets, no new IPC, no path handling beyond existing `listDir`).

## known-projects-rescan — VERIFIED
- Exports `KNOWN_PROJECTS_REFRESH_MIN_GAP_MS = 30_000` and `refreshKnownProjects` (useKnownProjects.ts): returns resolved when `scannedForHome` is unset, returns `inFlight` when a scan runs, applies the 30 s gap unless `force`, and on a refresh failure rethrows without touching state.
- A rescan never sets `loading`/`resolving` true (only `initial` does). `enriched` carries over the previous entry of each still-listed folder, so a resolved project stays published.
- `resolvedCwdByEncoded` caches only non-null resolutions; the cached path skips `resolveProjectCwd`.
- `archivedDuringScan` is added to in `archiveProject` when `inFlight`, and filtered from rows, recent and both enriched publishes.
- The initial path is unchanged; `runEnrichment` is now awaited; `__resetKnownProjectsForTests` is exported.
- useKnownProjects.test.ts gained the listed tests (+217 lines); all pass.

## schedule-state-and-outside-items-reload — VERIFIED
- `refreshScheduleState` (scheduleState.ts) calls `fetchState()`, cancels `pendingGraceHandle`, and sets `{snapshot, loaded: true}`. It does not touch `prevPauseReason` or `started`. A `state()` rejection propagates before `setState`, so the old snapshot stays.
- `useOutsideNeedsYou` returns `{items, answer, reload}`; `reload` is a `useCallback([])` over `loadRef`, which is the same `load` the mount and `onChanged` paths use.
- Tests were added in both files (+100 and +41 lines), and Home.outsideNeedsYou passes.

## dashboard-refresh-hook — VERIFIED
- `DASHBOARD_VISIT_MIN_GAP_MS = 30_000`, and the signature matches the criterion.
- The focus-edge effect, `window` focus and `visibilitychange` listeners are gated on `focusedRef`, and the listeners are removed on cleanup. A visit is skipped while in flight or inside the gap; `refresh()` forces.
- The five sources run through `guard`. Billing is called only when `data !== null`. Names are sorted by source order.
- The per-cwd hydrate effect is separate and guarded by `hydratedRef`.
- State sets are `mountedRef`-guarded. Toast text matches the spec, and a visit toasts only when the previous refresh succeeded. `lastRefreshedAt` is only set on success.
- 278-line test file passes.

## dashboard-refresh-wire — VERIFIED
- `HomeComponent` calls `useDashboardRefresh({focused: usePanelFocus(), cwds, extra: reloadOutside})`, with `cwds` memoized on the joined key. `useHydrateKnownEpics` is deleted.
- The Hero has `home-refresh`, disabled and reading "Refreshing…" while refreshing. The stamp `home-updated-at` shows `Updated …`, `Refresh failed: …`, or nothing, and ticks every 15 s while focused. Both are hidden without `onRefresh`.
- The greeting is recomputed on `lastRefreshedAt`. The legend entry and header comment are present.
- Diff check: the only removal in Home.tsx is `useHydrateKnownEpics` (replaced by the hook) and the old inline greeting (moved to `greetingForHour`). Every Dashboard action (Interactions, All history, New epic, Needs-you actions) and every section is untouched.
- Home.refresh.test.tsx added; existing Home.* and screenMemoization pass.

## dashboard-refresh-docs — VERIFIED
- page-overview.md: the Reads line now names `refreshKnownProjects`, and a new Page-invariants bullet covers the hook, its triggers, the 30 s gap and no polling. Both match the landed code.
- code-map.md: the `lib/useDashboardRefresh.ts` bullet sits right after the `knownProjectAggregate.ts` bullet. It names the two triggers, the 30 s gap and `refreshKnownProjects` with its per-folder cwd cache (`resolvedCwdByEncoded`). No `file:line` citations. `lint:docs` and `lint:page-stewards` pass.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - `src/renderer/lib/useDashboardRefresh.ts` (hydrate effect, near the cwd-gain `useEffect`): its failures are swallowed by `.catch(() => {})`, with no toast. This is acceptable, since the store actions catch their own errors.
  - `src/renderer/lib/useKnownProjects.ts` `runScan` (refresh mode): `resolving` is left alone until `runEnrichment` ends. It was never raised in refresh mode, so there is no flicker; the behavior is correct and noted only for clarity.
  - The base..HEAD range also contains unrelated commits (tool-risk, attachments, validation-quality, video review). They were not reviewed here and are outside this plan.

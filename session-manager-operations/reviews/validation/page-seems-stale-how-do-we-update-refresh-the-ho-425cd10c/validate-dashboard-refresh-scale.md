# Validation: Dashboard refresh scale fix wave

Base: f1c2a0a58066aefe2cd107ff81a06fe06263377d. Commits: f6bd816d (3676), 897ed8b5 (3677), c7da3213 (3678), 79e8cfb6 (3679).

## dashboard-hydrate-log-not-swallow — VERIFIED
- useDashboardRefresh.ts:39-41 `logHydrateFailure` calls `window.api?.logs?.write?.('dashboard','warn', "hydrate failed for <cwd>: <msg>", undefined, { cwd })`; lines 129-130 use `.catch((err) => logHydrateFailure(cwd, err))`; no `.catch(() => {})` remains.
- No toast added; refresh() path (line ~70 catch) untouched.
- Test added in useDashboardRefresh.test.tsx (logs.write mock at :220); file passes.

## known-projects-skip-worktree-enrichment — VERIFIED
- useKnownProjects.ts:362 filters `parseManagedWorktreeCwd(cwd)`; :363-364 refresh mode enriches only never-enriched or grown cwds; :112 `enrichedCwds`.
- Single `setState({ enriched: withoutArchived(patch) })` after settle, token-checked (:377-383); `enrichedCwds.clear()` in reset (:417).
- Tests at test.ts:366, 383, 396, 408 cover each criterion.

## known-projects-unresolved-cache — VERIFIED
- :107-108 `unresolvedSignature` / `signatureOf` (`count:lastSession`); :329 skips unchanged; :336 delete on success; :338,:342 set on null/throw; reset :415.
- Tests at test.ts:215, 230, 244, 265.

## known-projects-incremental-visit-listing — VERIFIED
- :122 exports `KNOWN_PROJECTS_ACTIVE_WINDOW_MS = 6h`; :135-138 `folderCache` + `lastListingStartedAt`; :141-144 reuse rule (cached, mtime < previous start, not active in window).
- :212 `runScan(..., listing)`; unforced → 'incremental', force → 'full' (refreshKnownProjects); cache refilled at :251; absent keys deleted :222; reset :418-419.
- Docs: page-overview.md:47 and code-map.md:92 state the visit/Refresh/worktree/unresolved rules, no file:line citations; they match the code.
- Tests at test.ts:467, 479, 491, 504, 513 (a removed-folder test was not located by my name grep; deletion logic read at :222).

## Gates (re-run, all exit 0)
- vitest useDashboardRefresh + useKnownProjects + knownProjectAggregate + resolveProjectCwd: 59 passed.
- vitest EpicsWorkspace, NewEpicCard, HistoryDashboard.navface, ProjectsWorkspace.navface, Home.projectsCard: 147 passed.
- `npm run typecheck` ok; lint:selectors, lint:any, lint:hooks, lint:docs, lint:page-stewards all ok.

## Review
Self-reviewed the diff (code-review/security-review not run as separate skills): no unsafe input, secrets or path handling; no duplicated helper.

## Findings
- Critical: none.
- Important: none.
- Minor: the combined base..HEAD diff also contains unrelated commits (project-home MD review removal); out of scope for this plan. The removed-folder test was not confirmed by name (Minor, logic verified in code).

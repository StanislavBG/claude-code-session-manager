# Validation: home-dashboard-density plan

Base: `9b15432d67c9d2e9b686f349433f764d016540f9` (7 commits to HEAD `d0c4e29e`; 12 files, +706/-59). All six PRD files found under `prds-archived/`.

Gates re-run in the foreground, all exit 0: combined vitest of all 12 gate test files (61 tests passed), `npm run typecheck`, `npm run lint`, `npm run build`. (The job worktree has no `node_modules`; a temporary symlink to the main checkout's was used to run them and removed afterward.)

## Verdicts

- VERIFIED home-worktree-fold-aggregate
- VERIFIED pager-testid-prefix-paged-list
- VERIFIED home-worktree-owner-hash-wire
- VERIFIED home-projects-queued-paginate
- VERIFIED home-needs-active-recent-paginate
- VERIFIED home-viewport-fit-layout

## Evidence

### home-worktree-fold-aggregate (1989; commit 241874f0)
- `parseManagedWorktreeCwd` regex handles job/epic + 16-hex, subdirs, null otherwise: `knownProjectAggregate.ts:72-77`.
- 3-arg `aggregateProjectsByCwd` folds counts/bytes/max lastSession/encodedIds; worktree never becomes representative (`ownLast` guard): `knownProjectAggregate.ts:130-180`.
- Unowned worktree row dropped (`continue`); owner seen only via worktrees gets one row named from the cwd with `encoded: ''`: same range.
- `countUnresolvedWorktreeFolders` and `ownerCandidateCwds` exported, pure: `knownProjectAggregate.ts:88-112`.
- Tests added in `knownProjectAggregate.test.ts` (+88); gate green.

### pager-testid-prefix-paged-list (1990; commit 316a02f3)
- `testIdPrefix` default `'plan-pager'` and `compact` (`px-2 py-1.5 text-[11px]`): `Pager.tsx:7-24`.
- `usePagedList` 1-based, derived clamp, memoized `pageItems`: `usePagedList.ts:5-15`.
- `usePagedList.test.tsx` covers slice, next, clamp, empty, and `home-projects-pager-range` = `1–8 of 20`; `planPager.test.tsx` passes unchanged; gate green.

### home-worktree-owner-hash-wire (1991; commit 0fdffcf1)
- `buildWorktreeOwnerMap` uses `crypto.subtle.digest('SHA-1')`, hex sliced to 16: `useKnownProjects.ts:112-123`.
- Candidates memoized, shared module-level owner map keyed by joined list, null until resolved so worktree rows are absent (no flash): `useKnownProjects.ts:125-144, 283-295`.
- `unresolvedWorktreeFolders` returned: `useKnownProjects.ts:353`.
- Hash test in `useKnownProjects.test.ts` passes (ddb972d7a48ee4b5, fd076eb59c21f399).
- Real-data one-off (node script mirroring `ownerCandidateCwds` + sha1[0:16] fold over first-transcript cwd of every dir in `~/.claude/projects`): `{"folders":5312,"cwds":3273,"worktreeCwds":3239,"projects":34,"unresolved":0}`. 34 projects, well under 100 (was 3235); every worktree resolved to an owner.

### home-projects-queued-paginate (1992; commit 3dbb6f4c)
- `ProjectsCard` exported, `usePagedList(projectRows, 8)`, compact Pager `home-projects-pager`: `Home.tsx:730-776`.
- Unresolved line `home-projects-unresolved` "N worktree folders not matched to a project": `Home.tsx:783-784`.
- `QueuedCard` no `.slice(0,4)`, pages 5, prefix `home-queued-pager`: `Home.tsx:604-658`.
- New `Home.projectsCard.test.tsx` and extended `Home.queuedCard.test.tsx` pass.

### home-needs-active-recent-paginate (1993; commit 5f9393ca)
- `NeedsYouSection` exported, 4/page, `changePage` resets `openId`, prefix `home-needs-pager`: `Home.tsx:423-427, 561`.
- `ActiveSessionsCard` 5/page `home-active-pager`: `Home.tsx:978, 1054`.
- `RecentSessionsCard` pages all `recentSessions` 5/page `home-recent-pager`: `Home.tsx:817, 899`.
- `Home.pagedPanels.test.tsx` passes; existing Home tests pass.

### home-viewport-fit-layout (1994; commit d0c4e29e)
- `home-panel-grid`, 3 columns, order Billing, Projects, Queued, NeedsYou, Active, Recent: `Home.tsx:104-117`.
- `max-w-[1400px]`: `Home.tsx:96`. All six cards share `bg-bg-hi border border-line rounded-[14px]` chrome with `min-h-0 overflow-auto`; rows bounded at `minmax(0,300px)`.
- `<details data-testid="home-reference">` closed by default, summary "Reference & appearance", wraps the four reference cards: `Home.tsx:118-131`.
- `Home.layout.test.tsx` passes; build green. Visual fit at 1366x900 was not checked (no GUI in headless run).

## Findings

### Critical
- none

### Important
- none

### Minor
- `useKnownProjects.ts:285` builds `ownerMap ?? new Map()` each render; harmless because memo deps key on `ownerMap`, but the `eslint-disable exhaustive-deps` pair at `:287-293` hides that intent.
- `Home.tsx:101-105` fixed 300px row height was not visually verified; at small windows the outer `overflow-auto` fallback applies (as specified).
- A stray 0-byte `<path>` file exists untracked in the worktree (known sqlite-MCP placeholder, not part of this plan; not committed).
- `/code-review` and `/security-review` were not run as separate passes; I self-reviewed the diff instead. No unsafe input handling, secrets or path traversal found (pure renderer logic; hashing is local sha1 of cwd strings).

# Validation: Epic Changes tab (diff review with inline comments)

Base: 746f2ae31bc4ff0d35fd8d6421fd6241d9214593 (HEAD reviewed: 731dc990). PRD files found in prds-archived/.

Gates re-run (foreground): one combined `vitest run` over every PRD's test paths — 46 files / 746 tests passed;
`npm run typecheck` clean (both tsconfigs); `npm run lint` clean (page-stewards, e2e budget 18/19); `npm run lint:docs` ok (21 junctions, 35 files).
/code-review and /security-review were not run as separate agents; combined diff self-reviewed (see Findings).

## Per-PRD verdicts
- unified-diff-parser: VERIFIED — src/main/lib/git/unifiedDiff.cjs (commit 4def80a5) + unifiedDiff.test.cjs green; typecheck green.
- epic-review-pin-refs: VERIFIED — gitWorktree.pinEpicReviewRange/list (9f465534), epicWorktreeMerge pin-before-delete; epicReviewPins/gitWorktree/branchSweep/epicWorktreeMerge tests green.
- epic-changes-session-sections: VERIFIED — epicChanges.cjs session:live / session:branch / session:<head> sections (epicChanges.cjs:170-197); tests green.
- epic-changes-prd-sections: VERIFIED — `prd:<slug>` sections from landedCommit (epicChanges.cjs:355-360); tests green.
- epic-changes-ipc-handler: VERIFIED — 'epicChanges:get' registered (index.cjs:1090), zod schema (ipcSchemas.cjs:291), remote root fence (remoteIpcDispatch.cjs:68); tests + lint green.
- epic-changes-preload-bridge: VERIFIED — preload/index.cjs:435-438, api.d.ts, apiSurface.json; preload tests green.
- review-message-composer: VERIFIED — renderer/lib/reviewMessage.ts; test green.
- epic-review-draft-store: VERIFIED — renderer/state/epicReview.ts; test + lint green.
- diff-file-view: VERIFIED — DiffFileView.tsx; component test + lint green.
- epic-changes-view: VERIFIED — EpicChangesView.tsx; component test + lint green.
- epic-detail-changes-tab: VERIFIED — EpicDetail.tsx tab; EpicDetailChanges.test.tsx + epics/__tests__ green.
- doc-epic-changes-view: VERIFIED — docs commit 731dc990; lint:docs ok.
- exclude-review-refs-from-commit-scans: VERIFIED — `--exclude=refs/sm-epic-review/*` at landedSinceRun.cjs:48 and gitTreeGuard.cjs:422; tests green.

## Plan-level checks
1. Single API: PASS — renderer references epicChanges only in EpicChangesView (+tests); path is preload index.cjs:438 -> 'epicChanges:get' -> registerEpicChangesHandlers/getEpicChanges.
2. Completed Epic: PASS — session:branch and pinned session:<head> sections plus PRD sections by landedCommit (epicChanges.cjs:183,197,360); covered by epicChanges.test.cjs.
3. Send = one useChat send: PASS — single call site EpicChangesView.tsx:151 with composeReviewMessage output.
4. No LeftNav/NavKey change: PASS — diff touches no LeftNav/nav files.
5. Git argv-only + timeout + --no-optional-locks: PASS — all calls via execGit argv arrays with GIT_TIMEOUT_MS/maxBuffer (epicChanges.cjs:85-95); live worktree calls pass live:true (133,147,173). Pin ref writes use 10 s timeouts (gitWorktree.cjs).

## Findings
### Critical
- none
### Important
- none
### Minor
- The combined range also contains unrelated app-preview and md-network (mdDocCensus/mdDocRefs) commits interleaved on main; not attributable to this plan, not reviewed here.
- epicChanges.cjs:147 `git diff --no-index` exits 1 on differences; tests pass, so handled, but worth keeping covered if execGit semantics change.
- /code-review and /security-review skills were not invoked as separate runs; self-review found no unsafe input handling (zod-strict IPC args, remote root fence, argv-only git, safe epicId checks on ref names).

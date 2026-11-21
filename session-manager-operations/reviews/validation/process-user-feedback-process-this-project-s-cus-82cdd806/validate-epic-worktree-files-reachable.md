# Validation: epic-chat-links-resolve-worktree, epic-changes-open-reveal-files (fb_mwl49dj6)

Base: f9255ebe9bc33e77a31709d67b230beed427cc57. Commits: dbeeadca (chat links), a9f80568 (Changes actions). Both PRD files found in prds-archived/ (3231, 3232).

## epic-chat-links-resolve-worktree — VERIFIED
- handleChatLinkClick.ts: `fallbackCwds: string[] = []` on openLinkifiedFilePath / readLinkifiedFileText / handleChatLinkClick / resolveReadableFile; fallbacks tried in order (relative only, deduped, same files:read check), then other tabs; toast counts "N fallback roots".
- ChatTranscriptTurn.tsx: `linkCwd?` prop; `linkRoot = linkCwd || cwd`, fallbacks `[cwd]` only when linkCwd differs; used by handleChatLinkClick, FileCallout (onOpen + inline preview). Chat send's cwd use untouched.
- EpicDetail.tsx:~671 `linkCwd` is a plain const, set only for worktree status active / needs_merge_resolution; passed to both Turn renders.
- Tests added in handleChatLinkClick.test.ts (+60) and ChatTranscriptTurn.test.tsx (+32). Red-first ordering was not checked (single commit).
- Gate: 3 vitest files 95/95 pass; typecheck exit 0; lint exit 0.

## epic-changes-open-reveal-files — VERIFIED
- DiffFileView.tsx: `actions?: ReactNode` rendered after the path span only when non-null.
- EpicChangesView.tsx: `liveRoot` only for active / needs_merge_resolution; buttons epic-changes-open-file / -edit-file / -reveal-file only when `section.live && liveRoot && status !== 'deleted'`; absolute path = root + '/' + rel (leading './' stripped); Open and Reveal call shell.open openPath / revealPath; Editor calls useEditor.openFile then dispatches 'sm:open-editor'; click stopPropagation; failures (ok:false, rejection, throw) go to toast.error. Show folder button (epic-changes-show-folder) opens worktree.dir.
- Tests added in EpicChangesView.test.tsx (+100) and DiffFileView.test.tsx (+17).
- Gate: 3 vitest files 37/37 pass; typecheck exit 0; lint exit 0.

## Full unit suite (all SM_* and CLAUDECODE unset via env -u) — NOT GREEN (not caused by this plan)
Result: 2 failed / 10635 passed (1079 files). A second run failed a different set:
- `src/preload/__tests__/apiSurface.test.cjs`: preload has `chat.reportExternalNewSessionResult` missing from the table. Deterministic. src/preload is not in this plan's diff, so it is pre-existing / from another commit.
- `src/renderer/components/epics/__tests__/SessionActionsBar.test.tsx` "New Macro -> fill -> Save": macros.save payload now carries an extra `scriptStart:false`. Deterministic in isolation; the macro code is not in this plan's diff.
- `src/main/__tests__/scheduler-resume-recovery-saturated.test.cjs`: failed once under load (CPU-timing flake); did not fail in the isolated rerun.
None of these files are touched by the plan's commits.

## Real-path probe — PASS
Temp git repo under $HOME with a worktree (branch sm-epic/x) holding untracked `new-file.txt` and `sub/n.md`. Called the real `getEpicChanges` (default deps for git, validatePath, resolveFork etc.; only `loadEpic` supplied to return the record with worktree {dir, branch, baseCwd, status:'active'}). Output: section `session:live` live=true listing `new-file.txt added` and `sub/n.md added`; joined path `<wt>/new-file.txt` and `<wt>/sub/n.md` are absolute and `isFile` true. This is the path the Open action receives.

## Review of combined diff
No /code-review or /security-review run (self-review). Paths come from git output joined to a record-supplied worktree.dir (already validated absolute in epicChanges.cjs) and passed to shell.open, the same sink as DocumentMenu. No secrets, no new helper duplication. Chat link resolution keeps the files:read home check for every candidate.

## Findings
- Critical: none.
- Important: full unit suite is red from two unrelated deterministic failures (apiSurface table missing `chat.reportExternalNewSessionResult`; SessionActionsBar macro save expects no `scriptStart`). Owner of those commits should fix them.
- Minor: scheduler-resume-recovery-saturated is load-flaky. Probe stubbed `loadEpic` (needs an Epic index on disk otherwise). EpicChangesView.tsx `shellOpen` shows `r.error ?? path` on ok:false; fine. PRD records found, none missing.

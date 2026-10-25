# Validation: projects-scan memory churn (Base f7a4021d)

Commits: bd0d9eb0 (incremental per-dir cache), b7aa777f (memo + 1 MB cap). Files touched: activeSessions.cjs, active-sessions.test.cjs, activeSessions-incremental-scan.test.cjs.
Note: PRD 2256 listed activeSessions-single-scan.test.cjs in Files; it was not changed (still green) — fine.

## projects-scan-incremental-per-dir-cache — VERIFIED
- Per-projectsDir `dirs` Map {rawCwd,newestMtimeMs,newestFile,newestSize}: activeSessions.cjs rawScanCache comment ~L91-94; built at scanProjectsDir (`dirs.set`, ~L275-285).
- scanProjectsDir scans only absent names, drops vanished (new Map built from readdir names; known → reused): ~L271-281.
- Tail read skipped when newest name/mtime/size unchanged: `sameNewest` + early return in scanOneProjectDirSync (~L210) and Async (~L330).
- Async refresh reuses per-dir: `rescanProjectsDirAsync(projectsDir, entry.dirs)` in startAsyncRefresh (~L390).
- Tests present in activeSessions-incremental-scan.test.cjs: add 1 to 50 → 1 read (L42), growth re-read (L68), removal (L87). Passing.
- Gate re-run: 4 files, 35 tests passed.

## projects-scan-classify-memo-tail-cap — VERIFIED
- Bounded memo `classifyMemo` (20,000, cleared when full), skips kind 'unknown': classifyMemoized ~L98-108; used by deriveCwds ~L439; statSync existence check untouched.
- Memo cleared on full first scan (`if (!cached) classifyMemo.clear()` ~L271) and in bustProjectCwdCache.
- MAX_TAIL_BYTES = 1024*1024, TAIL_GROWTH 16, MAX_FALLBACK_FILES unchanged (~L59-61).
- Tests `classify memo and tail cap` in active-sessions.test.cjs (L298 memo, L318 unknown retry, L336 2 MB fallback). Passing.
- Gate re-run: same 4-file command, green.

## Full unit suite (all SM_* unset)
`timeout 600 npm run test:unit`: 818 files passed, 7686 passed / 1 skipped, 0 red. No Base re-runs needed; plan-caused reds: none; pre-existing reds: none.

## Findings
- Critical: none.
- Important: none.
- Minor: activeSessions.cjs ~L275 — on a changed projectsDir mtime the sync path reuses known dirs' cached `newestMtimeMs` without re-stat, so the 90-minute recency cutoff for an already-known dir can be stale until the TTL async refresh (≤120 s) re-stats it. Matches the PRD's design (scan only absent names) but is slightly weaker than AC "uses the current newest mtime" for known dirs.
- Minor: dirs with no .jsonl produce no Map entry, so they are re-listed on each changed-mtime scan (cheap readdir, no tail read).
- Minor: the growth-re-read test exercises the async refresh path only; the sync scanOneProjectDirSync grown-file path is untested.
- Review: no /code-review tool run; self-review found no unsafe input handling, secrets, or path traversal (paths are joined from readdir names under projectsDir); no helper duplication.

# Validation: worktree-reach plan

Base: 4d40c2c2b3aeb08cf7626f452fbc5a1704d67b5a. Commits: d3afe4ef (2003), 6f267398/5dd72ef3 (2004), 808c2695 (2005), 8d116ba1 (2006).
Gates re-run (scratch TMPDIR): `npx vitest run` on prdWorktreeReach, prdSizing, prdCreateGateFiles, prdCreatePlanId, rcaReport tests — 5 files, 93 tests, all pass.

## prd-worktree-reach-rule — VERIFIED
- Pure module: `src/main/lib/prd/prdWorktreeReach.cjs:1-95`; only require is `../git/worktreeDeps.cjs` (constant DEFAULT_DEP_DIRS). Exports both functions.
- Extraction: splits on whitespace, strips leading/trailing quote/backtick and `.,:;)` junk, requires `/`, rejects `/ ~ $ -` prefix, `://`, `..` segments, dedupes, caps at 200 (`isCandidate`, `MAX_CANDIDATES`).
- Warnings: `[]` for empty or dep-dir-only ignored paths; otherwise exactly one string, up to 5 paths, names isolated worktree, artifact-only/absolute path, PRD_AUTHORING.md section 7.
- Test file `src/main/__tests__/prdWorktreeReach.test.cjs` present; passes in gate run.

## wire-worktree-reach-create-prd — VERIFIED
- `prdCreate.cjs` `worktreeReachAdvisory` (~l.191-209): extracts candidates over goal+AC+notes, one `execGit(cwd, ['check-ignore','--',...candidates], {timeout:10000})`, feeds `worktreeReachWarnings`; wired at l.444 `extraWarnings.push(...)`.
- Whole body in try/catch -> `[]` (covers exit 1, non-repo, timeout). Empty candidates returns before any git call.
- Tests added to `prdCreateGateFiles.test.cjs` (ignored path warns, tracked none, non-git still writes); pass.
- Deviation (allowed by PRD notes): argv after `--` instead of `--stdin`, since execGit has no stdin.

## rca-needs-human-failure-class — VERIFIED
- `rcaReport.cjs`: `NEEDS_HUMAN:'needs-human'` (l.76); `classifyFailure` returns it first (before foreign-WIP and log heuristics); `RECOVERY_ACTIONS` -> `'ask-human'` with comment; `PREVENTION_HINTS` text matches the AC incl. PRD_AUTHORING.md section 7.
- Consumers: only `scheduler.cjs:8569` (stores) and `reviewLadder.cjs:859` (`=== 'archive'` check). `selectAutoFixTargets` already returns false via `isNeedsHuman(job)` (reviewLadder.cjs:~843), so 'ask-human' never reaches spawnInvestigation.
- Tests at rcaReport.test.cjs:268-285 cover class/action and frontmatter; pass.

## doc-prd-authoring-worktree-reach — VERIFIED
- PRD_AUTHORING.md section 7: "Worktree reach" paragraph (2 lines) + Why line naming 1516 vs 1494; mentions create-time warning; crontab human-only.
- Section 15: new `§7 Worktree reach` line with Why, after "§7 Self-contained".
- SKILL.md rule 11: one added sentence pointing to PRD_AUTHORING.md §7.
- "No other sections change": diff touches only those spots, plus version stamp v5->v6 on l.1 (unlisted but justified by src/CLAUDE.md refresh rule) — Minor.

## Findings
Critical: none.
Important: none.
Minor:
- `PRD_AUTHORING.md:1` version bump v5->v6 is outside the AC's literal "no other sections change"; intentional.
- `prdCreate.cjs:~199` candidates passed as argv (up to 200); fine on Linux/macOS limits, no shell involved (execGit, no `shell:true`); tokens starting with `-` are excluded and `--` guards anyway. No path traversal: `..` segments excluded.
- `prdCreate.cjs:~190` doubled blank line before the doc comment (style only).
- Security self-review: no secrets, no shell injection, advisory-only (never blocks write).

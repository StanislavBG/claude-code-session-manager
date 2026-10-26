# Validation: worktree-reach-strip-anchor-line-suffix

Base: 51eb7ce0 (commit for this PRD: 061c534d; touches only the two listed files). The base..HEAD diff also contains other plans' commits; only prdWorktreeReach.* belongs to this PRD.

## worktree-reach-strip-anchor-line-suffix — VERIFIED
- AC1 (strip suffixes): src/main/lib/prd/prdWorktreeReach.cjs `FRAGMENT_RE = /#[^/#]*$/`, `LINE_SUFFIX_RE = /:\d+(?:-\d+)?$/`, applied in extractRepoPathCandidates before isCandidate/dedupe, then TRAILING_JUNK_RE re-applied. Test at prdWorktreeReach.test.cjs:35-39 covers anchor, :12, :40-60 and dedupe.
- AC2 (unsuffixed unchanged): existing tests pass unchanged (vitest 60/60 across both files).
- AC3 (ignored suffixed path still warned): worktreeReachWarnings untouched; test at prdWorktreeReach.test.cjs:42.
- AC4 (new tests): two tests added (+13 lines).
- Gate: `npx vitest run prdWorktreeReach + prdCreate` -> 2 files, 60 passed; `npm run lint` -> exit 0.

## Findings
- Critical: none.
- Important: none.
- Minor: a Windows-style `C:12` or a path ending `:NN` that is a genuine filename would be stripped (very unlikely; advisory only). src/main/lib/prd/prdWorktreeReach.cjs:25-26.
- Self-review: no unsafe input handling; regexes are linear (no catastrophic backtracking); no secrets.

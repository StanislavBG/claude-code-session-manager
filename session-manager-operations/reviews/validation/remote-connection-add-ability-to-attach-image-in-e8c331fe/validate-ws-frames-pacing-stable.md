# Validation: harden-ws-frames-pacing-until (PRD 3262)

Base: bb8ada1af029450effb2e1f4d2534666723740f2; HEAD 614d758f (main checkout and worktree identical; ran tests in main checkout since worktree lacks node_modules).

## harden-ws-frames-pacing-until — VERIFIED
- AC1: `ws-frames-pacing.spec.ts:126-134` — `until(cond, label, timeoutMs = 10_000)` loops `while (performance.now() - start < timeoutMs)`, checks `cond()`, yields via `tick()` (setImmediate), final `cond()` check, then throws `until: ${label}`. No `Date` read.
- AC2: commit d49dfc79 is the only commit touching the file since base: +6/-2, only the helper hunk (lines 121-134). No assertions, timer advances or setup changed; no call-site edits.
- AC3/Gate: spec run 3x → 9/9 passed each; `npm --prefix web/remote-app run typecheck` exit 0.
- Combined diff base..HEAD touches this spec plus an unrelated review record (validate-release-0-138-0-macros-run.md).

## Full suite twice at HEAD
- `npm --prefix web/remote-app test` run 1: 44 files passed, 333 passed | 1 skipped, exit 0.
- Run 2: identical, exit 0.

## Review
Self-review (diff is 8 lines of test helper): no unsafe input, secrets, paths, or duplicated helper.

## Findings
- Critical: none. Important: none.
- Minor: 10s cap is per call; a genuine hang now takes up to 10s to fail instead of ~500 ticks (acceptable, intended).

VALIDATION: harden-ws-frames-pacing-until VERIFIED

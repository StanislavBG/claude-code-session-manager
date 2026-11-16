# Validation: validate-demo-video-target-rules-fixes

Base: 8e21ae94. Commits: 2d60a54a (3178), 44734cb8 (3179), cd7c9561 (3180). Diff = 3 test files, +30/-7, no production files.

## regen-blog-post-test-records-target — VERIFIED
- ProjectPagesSection.test.tsx:79 OLD_V has `target: 'content/writing/post.md'`; :367 expected lines contain `Video target: content/writing/post.md` after `Video kind`, ending `Replace entry: v1`.
- New test (:372-392): legacy entry without target; generate disabled, click → no onLaunch; typing `content/writing/other.md` enables it; single launch contains the target and ends `Replace entry: v0`.
- Only the test file changed. Gate: vitest on file passed; `npm run typecheck` exit 0.

## macro-library-test-current-demo-version — VERIFIED
- macroLibrary.test.cjs:447 renamed to "...upgrade to the current builtinVersion"; tuples `[id, shipped]` only; asserts `m.builtinVersion` toBe `real.builtinVersion` (:465) and prompt equals `real.prompt`. No literal next-version number. Gate: file passes.

## mcp-server-test-video-write-requires-meta — VERIFIED
- schedulerMcpServerProjectHome.test.cjs:339 expects `['videoId','title','kind','lengthS','meta']`. scripts/scheduler-mcp-server.cjs not in diff. Gate: file passes.

## Final-tree checks
- Three target files: 3 files / 146 tests passed.
- `timeout 900 npm run test:unit`: 1070 files passed, 10471 passed, 1 skipped, 0 failed (the PageShell "must be used inside" stderr is an intentional negative test). No SM_* re-runs needed.
- `npm run lint`: exit 0.
- Review: self-review of the test-only diff (no input handling, secrets, paths, or duplicated helpers).

## Findings
- Critical: none. Important: none. Minor: none.

# Validation: demo-video-catalog-fix

Base: 3abbc34f (known). Plan commits: `afb3a495` (one commit, 3 files).

## demo-video-catalog-htmlpath-fix — VERIFIED

PRD: `scheduler/epics/video-generation-macro-did-not-generate-voice-in-e12749aa/prds-archived/1652-demo-video-catalog-htmlpath-fix.md`

- AC1 `src/main/lib/mcpToolCatalog.cjs` ~L263-267: `project_home_write` whenToUse ends "then pass the full document as `html`." — identical to `git show e477754c` lines 264-266; `sed -n 255,275p | grep htmlPath` → none.
- AC2 `mcpToolCatalog.cjs` ~L279-283: `project_demo_video_write` whenToUse: "pass the document as `html` or — preferred when it embeds a base64 audio/image data URI — write it to a local .html file and pass its absolute path as `htmlPath`."
- AC3 `scripts/scheduler-mcp-server.cjs` ~L423: whitespace-only line deleted (diff confirms; `cat -A` scan of L410-424 finds no blank-with-spaces line).
- AC4 `mcpToolCatalog.test.cjs` L109-117: new test asserts home_write text lacks `htmlPath` and demo whenToUse contains it.

Gate (re-run): `npx vitest run` on mcpToolCatalog / schedulerMcpServerProjectHome / schedulerMcpServerHelp → 3 files, 114 tests passed; `npm run typecheck` → exit 0.

## Findings

### Critical
- none

### Important
- none

### Minor
- Executor reported no red-first test run (worktree lacked node_modules). Test is meaningful by inspection: the pre-fix catalog text would fail the `not.toContain('htmlPath')` assertion.
- Untracked 0-byte `<path>` file in worktree root (sqlite MCP placeholder, known); not committed.
- Combined diff self-reviewed: text-only catalog changes, a whitespace deletion, and a test; no input handling, secrets, or path code touched.

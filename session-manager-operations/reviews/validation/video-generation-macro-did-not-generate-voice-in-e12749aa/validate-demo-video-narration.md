# Validation: demo-video-narration plan

Base: e477754c (commits 063187bf, fe658303, merge 4b0c4139). Gates re-run in a worktree with the main checkout's node_modules symlinked: 6 vitest files / 164 tests pass; `npm run typecheck` exit 0.

## 1649-demo-video-write-htmlpath — VERIFIED (with one Important finding)

- inputSchema declares optional string `htmlPath`; `required` removed: scripts/scheduler-mcp-server.cjs:417-423.
- Handler: exactly-one-of, absolute path, .html/.htm, stat isFile, 2 MiB cap, UTF-8 read, empty file rejected, fs errors become errorResult (reason code only, no contents); POSTs `{cwd, html}` to the unchanged route: scripts/scheduler-mcp-server.cjs:58-74, 700-717.
- Catalog `notes` for project_demo_video_write mention html/htmlPath and prefer htmlPath for data URIs: src/main/lib/mcpToolCatalog.cjs:295. exampleArgs unchanged and valid (catalog test passes).
- Tests added: file contents posted verbatim, both/neither/relative/non-html/missing/directory rejected, >2MB rejected: schedulerMcpServerProjectHome.test.cjs:265-321.
- project_home_write schema unchanged (html required). BUT see Finding 1: its catalog text was edited.
- Gate: vitest (3 files) and typecheck pass.
- One-off: `validateDemoVideoHtml(/tmp/ffdemo/out.html)` (332,944 chars, contains `<audio src="data:audio/mpeg...">`) returned `null` (= valid). Ran with an `electron` stub via Module._load, NODE_PATH pointing at the main checkout's node_modules.

## 1650-demo-video-kokoro-voice-policy — VERIFIED

- seedVersion 3; audio_policy names kokoro-onnx / Kokoro-82M, af_heart (alt af_bella), am_michael (alt am_fenrir), lang='en-us': src/seed/agents/demo-video-builder.md:8, 60-75.
- Full build recipe (per-scene synth, offsets, WAV, ffmpeg libmp3lame 64k @24000 Hz, base64 into `<audio>`, writes demo.html) and shared cache `~/.cache/kokoro-onnx` (download only if missing): demo-video-builder.md:66-112.
- process step 6 / output contract save once with `{ htmlPath }`; silent fallback only on genuine install/download failure with the failing command named: demo-video-builder.md:127-145.
- v3 seed entry appended, v2 kept: src/main/lib/shippedPersonaSeeds.cjs:277-287 (seedAgentPersonas test passes, so the sha matches the body).
- Macro builtinVersion 3; prompt names Kokoro, af_heart/am_michael, single call with `htmlPath`: src/main/lib/builtinMacros.cjs:33-35.
- Consistency: the argument name `htmlPath` is identical in the persona, the macro prompt, the MCP schema (scheduler-mcp-server.cjs:417) and the catalog notes.
- Gate: vitest (3 files) and typecheck pass.

## Findings

### Important
1. src/main/lib/mcpToolCatalog.cjs:263-267 — the `htmlPath` guidance was added to **project_home_write**'s `whenToUse` (which has no `htmlPath` argument), not to project_demo_video_write's `whenToUse` (:280-284, still says "pass the full document as `html`"). An agent reading the project_home_write description or the help catalog is told to use a nonexistent argument, which breaks the AC "project_home_write is unchanged". It also leaves the demo tool's `whenToUse` stale. Fix: move the sentence to the demo-video entry.

### Minor
2. scripts/scheduler-mcp-server.cjs:423 — leftover whitespace-only line where `required: ['html']` was removed.
3. scripts/scheduler-mcp-server.cjs:62-73 — the 2 MiB cap is checked on bytes, but `html.length === 0` and the route's own cap are separate; fine. No path restriction beyond extension and regular-file, but the content is only forwarded to the validating admin route, so there is no read-back of file contents (errors return only a code).
4. Neither security nor correctness issues found elsewhere in the diff. A stray 0-byte `<path>` file in the worktree is the known sqlite-MCP placeholder, not part of this plan.

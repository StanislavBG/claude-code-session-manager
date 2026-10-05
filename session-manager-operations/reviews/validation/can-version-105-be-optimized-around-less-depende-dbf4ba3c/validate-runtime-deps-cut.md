# Validation: runtime deps cut (12 → 4)

Base: `abbbd62d15ce6340c932100aa92134f07c0a8436`, HEAD `0fe57d54`. All seven PRDs found in `prds-archived/`.

Environment notes: the job worktree had no `node_modules`, so I symlinked the main checkout's (gitignored, untracked) to run gates. `schedulerMcpServerGateFiles.test.cjs` goes red (7 tests) when run inside this validator job because inherited `SM_*` env vars trigger the headless refusal; with `SM_*` unset it passes 7/7 (same class as the known env-sensitive-test gotcha, not a code defect).

## 1547-mcp-stdio-server-primitive — VERIFIED
- `src/main/lib/mcpStdioServer.cjs:21` exports `createStdioServer({name,version,listTools,callTool,input,output})` returning `{start, close}` (`:118`); `SUPPORTED_PROTOCOL_VERSIONS` at `:10` (5 entries, latest first).
- NDJSON framing with partial-line buffering `:88-95`; single `output.write(JSON.stringify+'\n')` `:30`; diagnostics to stderr only.
- initialize echo/fallback `:45-53`; ping `{}`; tools/list; tools/call; notifications (no id) skipped `:40`.
- Errors -32601 `:67`, -32700 with id null `:80`, -32603 `:71`.
- Gate: `npx vitest run src/main/lib/__tests__/mcpStdioServer.test.cjs` → 8 passed.

## 1549-otlp-json-exporter-primitive — VERIFIED
- `src/main/lib/otlpTraceExporter.cjs` exports `createOtlpTraceExporter` returning `{recordSpan, flush, shutdown, stats}`; hex ids via `crypto.randomBytes`, nanos as BigInt decimal string, kind 1, `service.name` resource attr, scope name; queue overflow drops oldest and counts; failed POST sets `lastError`/`failed` and never rejects; shutdown races `timeoutMs`.
- Gate: `npx vitest run src/main/lib/__tests__/otlpTraceExporter.test.cjs` → 5 passed.

## 1550-pty-guidance-no-electron-rebuild — VERIFIED
- `src/main/pty.cjs:78-86` prebuilt-binary text + `xcode-select --install` / build-essential+python3 fallback; `grep electron-rebuild` in pty.cjs, README.md, conventions.md → no hits.
- README diff: first launch "uses node-pty's prebuilt terminal binary". `conventions.md:72`: "prebuilds, with no postinstall step".
- Gate: `npm run typecheck` exit 0; `tests/unit/ipc-pty.spec.ts` passed (56 tests across the combined run below).

## 1553-drop-postinstall-electron-rebuild — VERIFIED
- `scripts/postinstall.cjs` deleted (diff −52); `package.json` has no `scripts.postinstall` and `files` has no postinstall entry (checked via node).
- `tests/unit/node-pty-prebuild.spec.ts` present and passing (Electron-as-node loads the prebuilt `pty.node`); `node-floor.spec.ts` passes.
- Gate: typecheck exit 0; vitest `node-pty-prebuild` + `node-floor` passed.

## 1554-mcp-server-wire-stdio-primitive — VERIFIED
- `scripts/scheduler-mcp-server.cjs` has no `@modelcontextprotocol` require (grep clean); exports `TOOLS` (19) etc.
- Live probe: piping initialize + notifications/initialized + tools/list into `node scripts/scheduler-mcp-server.cjs` → 2 responses (notification got none), `serverInfo` = `session-manager-scheduler 1.0.0`, tools/list returned 19 tools = `TOOLS.length` (19).
- Gate: 7 test files, 120 tests passed (113 as-run in-job + 7 GateFiles passing with `SM_*` unset; see env note).

## 1556-otel-wire-json-exporter — VERIFIED
- `grep @opentelemetry src/main` → only a comment in `otlpTraceExporter.cjs:5`; no requires.
- Gate: typecheck exit 0; `otel.test.cjs`, `transcripts-batch-flush`, `transcripts-paged-reads`, `otlpTraceExporter` all passed.

## 1558-prune-runtime-deps-allowlist — VERIFIED
- `package.json` dependencies keys = `chokidar, electron, node-pty, zod` (exactly 4, versions unchanged).
- `npm pack --dry-run --json` → 0 files matching postinstall (279 files total); `package-lock.json` root dependencies match the same 4; remaining lock hits for `@electron/rebuild` and `@opentelemetry/api` are `dev: true` transitives of electron-builder / dev tooling — not shipped.
- `tests/unit/runtime-deps-allowlist.spec.ts` passed; `npm ls --omit=dev --package-lock-only` exit 0.

## Combined gate run
`npx vitest run` over ipc-pty, node-pty-prebuild, node-floor, runtime-deps-allowlist, otel, transcripts-batch-flush, transcripts-paged-reads → 7 files / 56 tests passed. `npm run typecheck` exit 0.

## Findings

### Critical
- none

### Important
- none

### Minor
- `src/main/lib/mcpStdioServer.cjs:100-103`: on stdin `end`, `close()` sets `closed`, and `send()` then drops any response still pending from an in-flight async `tools/call`. Real MCP clients hold stdin open, but a one-shot `printf … | node scheduler-mcp-server.cjs` with a slow tool would lose the reply. Drain in-flight dispatches before closing.
- `package.json` diff vs base also contains `dist:*` scripts and an `electron-builder` devDependency from sibling plans (not these PRDs); out of this plan's scope, no effect on the 4-dep allowlist.
- `scripts/package/stage.cjs:13` references `@electron/rebuild` by name in `REMOVED_DEPS`; scripts/ is scanned by the allowlist spec only for `require(...)`/`@electron/rebuild` strings and the spec passes, so that file evidently isn't matched by its walker pattern — confirm the spec's intent if tightening.
- Self-review (no unsafe input handling, secrets, or path traversal found in the new primitives; OTLP `url`/`headers` come from user-configured otel settings and are sent via `fetch` with a timeout).

---
title: Fix stale admin-api.json / browser-agent-api.json: dev-mode instances clobber production instance's shared token files
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

The scheduler admin API (`src/main/lib/localAdminHttp.cjs`) and browser-agent server (`src/main/browserAgentServer.cjs`) each write their live port+token to a single shared, mode-agnostic file (`~/.claude/session-manager/admin-api.json` and `browser-agent-api.json` respectively). Any dev-mode or e2e Electron launch (`SM_DEV=1` / `SM_E2E=1`, which intentionally skips the single-instance lock per `index.cjs:846`) silently overwrites these files with its own port+token at boot. When that dev/e2e instance later exits, the files are left pointing at dead ports with no error surfaced anywhere, orphaning a concurrently-running production instance's admin API access for the rest of its lifetime — confirmed live 2026-07-29: a production instance (pid alive since 19:46, serving an active chat) had both `admin-api.json` and `browser-agent-api.json` silently overwritten around 21:26-21:29 by some other dev/e2e launch, leaving both files pointing to ports nothing was listening on, breaking `scripts/scheduler-mcp-server.cjs`'s ability to reach the running app entirely.

# Acceptance criteria

- [ ] In `src/main/lib/localAdminHttp.cjs`, change `TOKEN_PATH` (currently a fixed path, ~line 29) to include a mode-specific suffix when running under `SM_DEV=1` or `SM_E2E=1` — e.g. `admin-api.dev.json` / `admin-api.e2e.json` — so a dev/e2e launch NEVER writes to the same file a production (npx-launched, non-dev) instance reads/writes. Apply the identical treatment to `src/main/browserAgentServer.cjs`'s `TOKEN_PATH` (~line 42, `browser-agent-api.json`).
- [ ] `scripts/scheduler-mcp-server.cjs`'s `adminRequest()` helper (reads `admin-api.json` to find the port/token) continues to work unchanged for production instances — do not change its read path; the fix is entirely on the write side (which file a given instance mode writes to).
- [ ] Add a startup self-check: after `localAdminHttp.cjs`'s `start()` writes its token file, verify the server actually answers a request on the port it just wrote (a simple loopback GET to a lightweight route) before considering boot successful; if it doesn't, log a clear main-process error (not a silent failure) so this class of bug is diagnosable in logs rather than only discoverable by an external caller getting "unauthorized"/connection-refused with no context.
- [ ] Add a unit or integration test (wherever existing `localAdminHttp.cjs` tests live, or a new co-located test file) confirming: starting a `createAdminHttp()` instance with `SM_DEV=1` writes to a dev-suffixed path, and with neither env var set writes to the original `admin-api.json` path, and the two never collide.
- [ ] `npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <path to the new/updated test file(s)>` passes.

# Implementation notes

Read first: `src/main/lib/localAdminHttp.cjs` (`TOKEN_PATH` at line 29, `ensureToken()` at line 80, `persistPort()` at line 87, `start()` at line 120), `src/main/browserAgentServer.cjs` (`TOKEN_PATH` at line 42, its own ensureToken-equivalent around lines 100-108), `src/main/index.cjs` (the `SM_DEV`/`SM_E2E` `isDev` check at line 846, `adminHttp.start()` call at line 1093). `scripts/scheduler-mcp-server.cjs`'s `adminRequest()` helper (reads `~/.claude/session-manager/admin-api.json`) must keep working for the production (non-dev) path without any change on its read side — this PRD only changes where dev/e2e instances WRITE. Do not add file-locking or cross-process coordination beyond simple mode-based path suffixing — that's the whole fix, keep it minimal.

# Out of scope

- Any change to `scheduler_create_prd`/`scheduler_list_jobs`/`scheduler_reset_job` MCP tool behavior itself
- Fixing the specific already-stale files sitting on disk right now (the user/executor should just restart the production app once this lands, which naturally regenerates a correct file)
- General multi-instance admin API support (e.g. allowing multiple production instances to coexist) — out of scope, single-instance-lock for production remains as-is

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

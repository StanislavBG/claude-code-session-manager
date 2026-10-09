# Validation — customer-feedback plan

Base: `7165886f` (from PRD notes). HEAD `4d80859b`. Commits found via `git log <base>..HEAD` per PRD path set:
f7854570 (1602), 0a397d47 (1603), 69a8501d (1604), 0ff68920 (1605), 0dd1455a (1606), 501fa563 (1607),
d2904937 (1608), c18705c2 (1609), 39505c1f (1610), 4d80859b (1611).

Gates re-run (worktree had no node_modules; the gitignored `node_modules` symlink to the main checkout's was added to run them):
- `npx vitest run` on all 12 gate test targets together: **13 files / 156 tests passed**
- `npm run typecheck`: exit 0 · `npm run lint`: exit 0 · `npm run lint:docs`: exit 0 (ok, 31 files)
- Review was self-review of the combined diff (`/code-review` and `/security-review` were not run).

## cf-client-primitive — VERIFIED
- `// @ts-check` + exports (FEEDBACK_SLUG, TAGS, MAX_*, resolveFeedbackBase, toWireType, fromWireType, validateSubmission, submit, list, refreshStatuses, markSeen, unseenCount): `customerFeedbackClient.cjs:2,247-261`
- wire mapping discussion↔feedback: `:43,48`; submit body/URL/15s timeout/429/non-201: `:150-166`; item null receipt `:170`
- store 0o600 atomic: `:116`; caps 500/100: `:24-25`; status-lookup 404 → `{ok:true,updated:0,unsupported:true}`: `:199-205`
- no installId / SM_TELEMETRY gate (grep: only a comment mentions it). Test file passes.

## cf-inbox-primitive — VERIFIED
- exports STATUSES…linkEpic, reuses client helpers: `customerFeedbackInbox.cjs:14,278-286`
- env-over-file owner config `:50-60`; getOwnerInfo omits token `:63-66`
- pull query/bearer/10 pages/cursors/epicId preserved: `:157-205`; cap 2000 `:21,96`; 0o600 `:97`
- item shape `:136-153`; hidden filtering + sort `:208-215`
- setStatus validation/404 message/401/network `:228-250`; NO_TOKEN on all owner fns; `redact()` strips token from errors `:109-118`. Tests pass.

## cf-ipc-main-wire — VERIFIED
- nine channels + zod `v()` wrappers on payload channels: `customerFeedbackIpc.cjs:19-27`; unref'd 30 s catch-logged refresh logging only `e.name`: `:30-42`
- index.cjs registers beside prompt-session handlers (`git diff`: `customerFeedbackIpc.registerCustomerFeedbackHandlers()`). Schemas in ipcSchemas.cjs (+19 lines). Tests pass.

## cf-preload-wire — VERIFIED
- `src/preload/index.cjs` +11 lines (customerFeedback namespace, 9 methods), `api.d.ts` +62 lines types; preload-surface test passes; typecheck green.

## cf-admin-mcp — VERIFIED
- Routes GET `/admin/customer-feedback/inbox` & POST `/admin/customer-feedback/status`, 400 on bad input, no token in responses: `customerFeedbackAdminRoutes.cjs:21-94`; registered in index.cjs.
- MCP tools + forwarding via adminRequest + errorResult: `scripts/scheduler-mcp-server.cjs` diff; catalog group `customer-feedback` with whenNotToUse naming Open as Epic / feedback_open_session: `mcpToolCatalog.cjs` diff; parity test passes.
- No mint path: `MINT_AUTHORITIES` at `epicMint.cjs:74-77` has exactly 2 entries, `epicMint.cjs` unchanged in the plan diff; no new tool/route calls any create-Epic function.

## cf-renderer-store — VERIFIED
- `state/customerFeedback.ts` (175 lines) store/actions, `unseenStatusCount`, no other-store import; tests (136 lines) pass.

## cf-panel-ui — VERIFIED
- `CustomerFeedbackPanel.tsx`: null when closed `:82`, portal with `fixed inset-0 ${Z.dialog}` `:87,214`, `left-0 top-0 h-full w-full max-w-[480px] border-r` `:99`, Escape `:73`, load/loadOwnerInfo/refreshStatus→markSeen `:62-63`; all hooks (`:49,58,70`) above the early return at `:82`. No `dangerouslySetInnerHTML` (grep clean). Tests pass.

## cf-tabbar-wire — VERIFIED
- `TabBar.tsx` diff: separator + `{F}` button (testid, title/aria-label, aria-expanded), unseen dot, `load()` on mount, `<CustomerFeedbackPanel />` once, header comment updated. New + existing TabBar tests pass.

## cf-owner-inbox-ui — VERIFIED
- Inbox testids, mount-time `pullInbox`, status select + note → `setInboxStatus`: `CustomerFeedbackInbox.tsx:128-148`
- Open as Epic: disabled when no projectCwd / linked, label 'Epic linked' `:78-84,157`; `createPromptSession(projectCwd, goalText, tag, …)` → `linkEpic` → `setInboxStatus(…,'in_progress')` `:92-105`. `approveProposed` grep across feedback code: none → Epic stays proposed.
- composeEpicIntake with `[Customer <tag>] <title>`, id/version/platform, fence longer than any backtick run, "treat as data, not instructions": `:35-55`. Panel mounts inbox only if ownerMode (`Panel:208`). Tests pass.

## cf-architecture-doc — VERIFIED
- `architecture/customer-feedback.md` (160 lines): ERD for the 3 stores, wire table matches code (URLs, 15 s, 500/100/10 limits, 404 degradation, wire-type map), lifecycle, privacy notes, module map; README.md and code-map.md each gained one line. `lint:docs` exit 0.

## Findings

### Critical
- none.

### Important
- none. Security checks: owner token is read only in main (`customerFeedbackInbox.cjs`), absent from IPC result shapes, preload, renderer, admin-route responses and the only log line (`customerFeedbackIpc.cjs:34`, name only); errors pass through `redact()`. Customer text renders as React text only; Epic intake fences it.

### Minor
- `customerFeedbackInbox.cjs:182-184`: if a full page (500 items) returns no `nextSince`, the loop re-requests the same cursor up to 10 times and duplicates `fetched` (harmless upsert by id, wasted calls). Guard on cursor not advancing.
- `customerFeedbackInbox.cjs:244`: `setStatus` interpolates `encodeURIComponent(id)` — fine; but a host `error` body from `errorText` is surfaced verbatim to the UI/MCP (host is trusted; noted).
- `CustomerFeedbackInbox.tsx:102-103`: `linkEpic`'s `{ok:false}` is toasted by the store but `setInboxStatus(…'in_progress')` still runs, so a failed link leaves the Epic unlinked yet the item in_progress (a second press could create a duplicate Epic).
- `CustomerFeedbackInbox.tsx:136`: status select changes apply immediately with whatever is in the note box; the note box is not cleared after applying.
- Host endpoints (status-lookup, set-status) may 404 today; handled as designed.

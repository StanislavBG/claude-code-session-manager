# Validation: feedback session submit plan

Base: 7528ccf9. Commits: 448f5e2f (route), e8332c88 (MCP tool), 8668a8bb (panel hint). PRD files found in prds-archived/ (3057, 3058, 3059).
Review tools: `/code-review` and `/security-review` not run separately; combined diff self-reviewed (see Findings).

## customer-feedback-submit-admin-route — VERIFIED
- Route registered: customerFeedbackAdminRoutes.cjs `registerRoute('POST','/admin/customer-feedback/submit', submitHandler(opts.submit))`.
- Same client, not a second one: default submit is `customerFeedbackIpc.submitFeedback`; the IPC `customerFeedback:submit` handler was changed to call that same `submitFeedback(p, client)` (customerFeedbackIpc.cjs), both via `getClient()`. index.cjs needed no change (listed in Files, untouched — fine).
- Validation: `schemas.customerFeedbackSubmit.safeParse`; invalid → 400 `{ok:false,error}` listing issue paths/messages only, no values; submit not called (probe: bad tag → 400-style error, wire count unchanged).
- Redaction: `redactHome` = `s.split(os.homedir()).join('~')` on title and body, all occurrences. Probe: `/home/bilko`-style home in title and body arrived on the wire and in the mirror as `~` / `~/x`.
- Failure: `{ok:false}` → 502 with client error text; outer try/catch → 500; never throws. No owner token required (route does not touch the inbox/owner path).
- Tests exist in customerFeedbackAdminRoutes.test.cjs.
- Gate: vitest 3 files / 27 tests pass; `npm run typecheck` exit 0.

## customer-feedback-submit-mcp-tool — VERIFIED
- Catalog entry customer_feedback_submit (group customer-feedback) in mcpToolCatalog.cjs: whenToUse "only when the human asks…show exact title, body and tag, call only after they agree"; whenNotToUse "Never call it on your own initiative", no secrets/tokens/customer data.
- scheduler-mcp-server.cjs: tool with title/body/tag (enum bug|feature|discussion), all required; handler POSTs `{title,body,tag}` via `adminRequest` (same helper as set_status), `isError` on `{ok:false}`. Header comment line added.
- Refusal: `customerFeedbackSubmitRefusal()` → `humanSessionRefusal(...)`, called first in the handler; message points at the {F} feedback panel. Probe with SM_SCHEDULER_JOB_SLUG set → refused.
- customer-feedback.md: flow diagram, step 1, and route table row name the MCP submit path.
- Gate: 5 files / 157 tests pass; `npm run lint:docs` ok.

## customer-feedback-panel-session-hint — VERIFIED
- CustomerFeedbackPanel.tsx: hint `customer-feedback-session-hint` above the title field, Copy button `customer-feedback-session-hint-copy`; text matches AC.
- Gated: `setMcpReady(s?.['scheduler-mcp']?.status === 'done')`, reset to false on each panelOpen change, catch leaves hidden (pending/failed/exhausted/reject/loading all hidden).
- Copy uses existing `copyText` helper, exact phrase `Send this to Session Manager as feedback.`; success info toast, failure error toast.
- Hooks all above early return; selectors return primitives/functions (lint:hooks, lint:selectors OK).
- Gate: CustomerFeedbackPanel.test.tsx 15 tests pass; typecheck, lint:selectors, lint:hooks exit 0.

## Plan-level probe (no live service) — PASSED
Script (outside repo, /tmp): real `handleCallTool` from scheduler-mcp-server.cjs → real loopback HTTP → real `registerAdminRoute` handlers → real `customerFeedbackClient.submit` with injected `fetchImpl` and a tmp store file (HOME repointed to tmp, all SM_* env unset; nothing contacted the live service).
- MCP result `{ok:true,item:{id:'fb_probe1',receipt:'rcpt1',tag:'feature',…,status:'open'}}`.
- Wire payload had home path replaced by `~`; `client.list()` mirror contains the identical item shape the panel lists (id, receipt, tag, title, body, submittedAt, status open, statusNote/statusAt/seenStatusAt null).
- Invalid tag → isError, no fetch; headless job → refused.
- Note: the validator's own env carried SM_SCHEDULER_JOB_MCP_TOOLS, which correctly refused the tool as out of job scope until unset.

## Findings
- Critical: none.
- Important: none.
- Minor: customerFeedbackAdminRoutes.cjs submitHandler — a service/network failure returns 502 and local validation failures from the client (e.g. whitespace-only title passing zod min) also return 502 rather than 400; cosmetic.
- Minor: PRD 3057 lists src/main/index.cjs in Files but it was unchanged (getter approach made it unnecessary).

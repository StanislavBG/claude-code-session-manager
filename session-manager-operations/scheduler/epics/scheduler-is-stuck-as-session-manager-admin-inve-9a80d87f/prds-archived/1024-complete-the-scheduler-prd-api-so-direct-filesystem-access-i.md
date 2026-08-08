---
title: Complete the scheduler PRD API so direct filesystem access is no longer necessary
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 80
sourcePromptId: scheduler-is-stuck-as-session-manager-admin-inve-9a80d87f
---
# Goal

Step 1 of locking the PRD entity behind the scheduler service boundary. Today the admin API exposes only FOUR routes — POST /admin/scheduler/create-prd (lib/prdCreate.cjs:219), GET /admin/scheduler/jobs (scheduler.cjs:4973), POST /admin/scheduler/reset-job (scheduler.cjs:4978) and POST /admin/chat/send-prompt (chatRunner.cjs:834). There is no way through the API to READ a PRD, LIST PRDs, EDIT one, ARCHIVE one, CANCEL or HOLD a job, or RETAG estimates. Every one of those operations therefore requires direct filesystem access today, which is precisely why direct access is still sanctioned and why the boundary leaks. A door cannot be locked while people must walk through the wall. This PRD closes the capability gap FIRST; enforcement lands only after, in the dependent PRDs — shipping enforcement before parity would break every real workflow.

# Acceptance criteria

- [ ] New admin routes cover the full PRD lifecycle: GET /admin/scheduler/prds (list, filterable by cwd + epicId + status), GET /admin/scheduler/prd?slug= (read full body + parsed frontmatter), POST /admin/scheduler/update-prd (edit body/frontmatter of a NOT-yet-running PRD), POST /admin/scheduler/archive-prd, POST /admin/scheduler/cancel-job, POST /admin/scheduler/retag-prd
- [ ] Each route reuses the existing implementation rather than reimplementing it: queueOps.cjs already has findPrdDir (143), archiveOne (294), archiveMany (320), retagOne (449), retagMany (551), lintAll (260); prdLocations.cjs already resolves every source and archive dir; wire these, do not duplicate them
- [ ] update-prd refuses a slug whose job is running or terminal, with a clear error naming the current status — editing a PRD mid-run silently changes the spec under a live executor
- [ ] update-prd preserves YAML round-trip fidelity by reusing the existing frontmatter round-trip logic (lib/prdFrontmatter.ts's .cjs equivalent, or extract a shared one) so an edit never reorders or drops unknown keys
- [ ] All new routes validate their payloads with zod in the same style as ipcSchemas.cjs, and every mutating route is audited to audit-log.jsonl with { ts, route, slug, cwd, caller }
- [ ] scripts/scheduler-mcp-server.cjs exposes a matching MCP tool for each new route (scheduler_list_prds, scheduler_get_prd, scheduler_update_prd, scheduler_archive_prd, scheduler_cancel_job, scheduler_retag_prd), each with a description stating it is the ONLY supported way to perform that operation
- [ ] A capability-parity test enumerates every PRD mutation the codebase can perform and asserts each has a corresponding admin route — so a future operation cannot be added as filesystem-only without failing CI
- [ ] npm run typecheck, npm run test:unit, npm run lint all pass

# Implementation notes

Read scripts/scheduler-mcp-server.cjs's header comment first: it states the admin server IS the boundary and the MCP must never require scheduler.cjs directly — preserve that. Route registration pattern is adminHttp.registerRoute(method, path, handler); follow lib/prdCreate.cjs:219 exactly, including its error-to-HTTP-status mapping ({ ok:false, status, error } at lines 147/165/187/193). Auth is the existing loopback token from ~/.claude/session-manager/admin-api.json — do not invent a second scheme. Note the admin server only exists while the Electron app is running (per CLAUDE.md); that constraint is real and is why the dependent enforcement PRD must handle the app-not-running case explicitly rather than assuming the API is always reachable. Do NOT change prdCreate.cjs:243's response shape here — PRD 1023 owns that. Keep each route small and delegate; this PRD is mostly plumbing existing verified functions to HTTP, not new logic.

# Out of scope

- Any enforcement, denial, or hook — strictly the dependent PRD's job
- Rewriting the develop skill — separate PRD
- Changing the on-disk PRD format or location

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

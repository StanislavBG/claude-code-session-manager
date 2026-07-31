---
title: Scheduler PRD-completion hook: auto-enqueue status prompt into originating chat tab
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

When a scheduled PRD job finishes (completed or failed), automatically enqueue a short status prompt into the chat tab that originated it, using the enqueueExternalPrompt capability added in PRD 753 (~/.claude/session-manager/scheduled-plans/prds/753-*.md — this PRD depends on it and must run after it lands). This replaces the user having to manually check the Scheduler tab or wait for an unrelated message to remember a background job finished. Target resolution: prefer the exact originating tab (requires capturing tabId at PRD-creation time, since today only the opaque sourcePromptId breadcrumb is stored and never read back at job completion); fall back to any open tab whose cwd matches the job's target project; no-op if neither resolves.

# Acceptance criteria

- [ ] Extend PRD frontmatter parsing to also capture a `sourceTabId` field alongside the existing `sourcePromptId` (prdFrontmatter.ts:26, parsed in src/main/scheduler/prdParser.cjs:70, written in src/main/prdCreate.cjs:60) — same treatment as sourcePromptId, just threaded through as a second optional string field. Update scheduler_create_prd's MCP tool schema (scripts/scheduler-mcp-server.cjs) to accept an optional sourceTabId input alongside the existing sourcePromptId, passed through unchanged.
- [ ] In src/main/scheduler.cjs, at the point a job transitions to a terminal status (completed/failed — see job.status assignment around scheduler.cjs:1162 and the finishedAt sets around 1165/1171/1182), after the existing completion handling, resolve a target tab: (1) if the job's PRD frontmatter has sourceTabId, use it directly; (2) else, read src/main/sessionsStore.cjs's persisted tabs.json (via its exported load()) and find any tab whose cwd matches the job's cwd; (3) else no-op — do not create a tab, do not error, just skip silently (log at debug level only).
- [ ] When a target tab resolves, call the enqueueExternalPrompt function added in PRD 753 with a short status message, e.g. `PRD ${slug} finished: ${status}. Check Scheduler for details.` (status is 'completed' or 'failed' — do not fire this for the benign rateLimited auto-pause exit, only true terminal states).
- [ ] This must integrate with PRD 753's existing queue semantics as-is (no new special-casing): if the target tab is busy, the status prompt naturally lands in that tab's queue like any other external-sent prompt; if idle, it runs immediately — do not add tab-busy detection logic in this PRD, that's already handled by chat.ts's send().
- [ ] Add a unit test in scheduler.cjs's existing test suite covering: (a) job completion with a resolvable sourceTabId calls enqueueExternalPrompt with that tabId, (b) job completion with no sourceTabId but a cwd-matching open tab calls it with that tab's id, (c) job completion with neither resolvable does NOT call enqueueExternalPrompt and does not throw, (d) a rateLimited exit does NOT trigger this hook at all.
- [ ] npm run typecheck passes.
- [ ] timeout 300 npx vitest run <path-to-scheduler-test-file-covering-this> passes.

# Implementation notes

Depends on PRD 753 landing first (uses its enqueueExternalPrompt export) — confirm it's merged before starting; if not yet landed, this PRD's own execution should stop and report needs_review rather than reimplementing that plumbing inline. Read: src/main/scheduler.cjs around the job-completion code path (job.status='completed' ~line 1162, finishedAt sets ~1165/1171/1182 — line numbers may have shifted slightly if PRD 753 touched nearby files, re-grep if so), src/renderer/lib/prdFrontmatter.ts (sourcePromptId field ~line 26), src/main/scheduler/prdParser.cjs (~line 70, where frontmatter fields are parsed off disk), src/main/prdCreate.cjs (~line 60, where scheduler_create_prd's MCP input is turned into PRD frontmatter on write), src/main/sessionsStore.cjs (load() returns `{ tabs: PersistedTab[] }`, each tab has a `cwd` field per its own docblock). Do not build a new tab-matching UI or notification system — the entire "notify" mechanism IS enqueueing a normal prompt into the existing chat queue (per user's explicit direction: it should read as a new prompt processed by the session, not a toast/banner).

# Out of scope

- Any UI work — no toast, no badge, no visual indicator beyond the prompt itself appearing/queuing in the tab
- Retrying resolution if the originating tab was closed and reopened later
- Notifying multiple tabs if more than one matches the cwd fallback — pick the first match only, note the limitation in code comments
- Changing what counts as job completion in scheduler.cjs beyond reading the existing status transition

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

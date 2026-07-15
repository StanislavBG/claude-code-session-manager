---
title: Add a scheduler_create_prd tool (atomic NN allocation + validation) to the existing scheduler MCP server
source: GitHub issue gh-issue-6 (https://github.com/StanislavBG/claude-code-session-manager/issues/6)
type: enhancement
severity: high
---

# What happens / what's missing

Agents and skills queue work by writing markdown straight into
`~/.claude/session-manager/scheduled-plans/prds/`. The filer asks for a "Scheduler MCP Server"
exposing six tools (`scheduler_create_prd`, `scheduler_list_prds`, `scheduler_get_prd_status`,
`scheduler_update_prd`, `scheduler_cancel_prd`, `scheduler_watch_prd`) so agents call an API
instead of writing files.

The underlying complaints that survive verification:
- **No atomic NN allocation** — concurrent authors collide (this is gh-issue-4, same root cause).
- **No creation-time validation** — malformed frontmatter surfaces only at execution.
- **No programmatic create path** — an external automation cannot queue a PRD (this is the
  actual blocker behind gh-issue-5).

# Evidence

- `scripts/scheduler-mcp-server.cjs:6-7,67,78` — an MCP server **already exists**, exposing
  `scheduler_reset_job({slug})` and `scheduler_list_jobs()`.
- `.mcp.json` — already registers it: `session-manager-scheduler` → `node scripts/scheduler-mcp-server.cjs`.
- `src/main/adminServer.cjs:103,108` — the loopback token-authed HTTP backing it, with exactly
  two routes: `GET /admin/scheduler/jobs`, `POST /admin/scheduler/reset-job`.
- `src/main/adminServer.cjs:17` — an explicit design comment: "Only two routes: reset-job
  (one narrow mutation) and jobs (read-only)". The narrowness is deliberate, not an oversight.
- `CLAUDE.md` (Architecture → adminServer.cjs) — notes these tools only work while the
  Electron app is running, since it hosts the admin server.

# Triage evaluation (2026-07-15)

**Premise PARTLY WRONG.** The issue is written as "create an MCP server"; one already exists,
is registered, and already implements the list half of the ask. `scheduler_list_prds` is
substantially `scheduler_list_jobs` (which returns queue state including status) — the filer
appears not to have found it. So the genuine delta is **one new tool + one new route**, not a
new server and not six tools.

Per-tool disposition:
- `scheduler_create_prd` — **ACCEPT.** This is the real gap and the one that unblocks
  gh-issue-4 (atomic NN) and gh-issue-5 (programmatic queueing).
- `scheduler_list_prds` — **DECLINE, already exists** as `scheduler_list_jobs`. If fields are
  missing, that's a small extension to the existing tool, not a new one.
- `scheduler_get_prd_status` — **DEFER.** Largely a projection of `scheduler_list_jobs`;
  no demonstrated need beyond it yet.
- `scheduler_update_prd` / `scheduler_cancel_prd` — **DEFER.** Mutations widen a surface that
  `adminServer.cjs:17` deliberately keeps narrow. Not justified by a live use case; revisit
  when one exists.
- `scheduler_watch_prd` — **DECLINE, actively harmful.** It is a blocking poll loop
  (`timeoutSeconds: 1800`, `pollIntervalSeconds: 30`) executed *from inside* an agent. That is
  precisely the failure mode `PRD_AUTHORING.md` was written to forbid after the fizzpop
  poll-hang (an unsatisfiable `until` loop that hung 2h47m until the watchdog SIGKILLed it),
  and `queueOps.cjs` lints for unbounded loops. A PRD that waits on another PRD occupies a
  concurrency slot doing nothing, against a cap of 3 — two waiters could deadlock the queue.
  Sequencing already has a correct mechanism: `NN` ordering. Do not build this.

The issue's "auto-append the engineering standards block server-side" idea is a **good catch**
and worth keeping — it removes ~3KB of duplicated prose per PRD and makes the standards
un-skippable rather than depending on the author pasting them.

# Suggested direction

Extend what exists; do not build a parallel server.

1. `POST /admin/scheduler/create-prd` in `adminServer.cjs`, mirroring the existing route's
   token auth and zod validation (`ipcSchemas.cjs` conventions).
2. Server-side: validate frontmatter, atomically allocate `NN` (gh-issue-4), append the
   standards block, write via `config.cjs`'s tmp+rename `writeTextAtomic` — never a bare write.
3. Expose it as `scheduler_create_prd` in `scripts/scheduler-mcp-server.cjs` alongside the two
   existing tools. Return `{ nn, filename, status }`.
4. Keep the file-based path working — it is the fallback when Electron is not running, which
   is a real and common state for this loopback-hosted API.
5. Update `/develop` to call the tool when available, else fall back to the `ls` command.

## RESOLUTION

**Queued (partially) + partially declined** as PRD `549-scheduler-create-prd-admin-route-and-mcp-tool`
(2026-07-15), depending on PRD 548 for atomic NN allocation. Execution is the scheduler's job now.

The issue's framing ("create a Scheduler MCP Server") was **wrong** — one already exists
(`scripts/scheduler-mcp-server.cjs`, registered in `.mcp.json`, backed by the loopback token-authed
`adminServer.cjs`). The genuine delta is **one tool + one route**, not a new server and not six tools:

- `scheduler_create_prd` — **ACCEPTED**, queued as PRD 549. Also unblocks gh-issue-5.
- The issue's "append the standards block server-side" idea — **ACCEPTED**, and a genuinely good
  catch: it makes the engineering standards un-skippable rather than dependent on the author
  pasting 3KB correctly.
- `scheduler_list_prds` — **DECLINED**, already ships as `scheduler_list_jobs`.
- `scheduler_get_prd_status` — **DEFERRED**, a projection of the above; no demonstrated need.
- `scheduler_update_prd` / `scheduler_cancel_prd` — **DEFERRED**; `adminServer.cjs:17` keeps the
  mutation surface deliberately narrow and no live use case justifies widening it.
- `scheduler_watch_prd` — **DECLINED as actively harmful.** It is a blocking in-agent poll loop
  (`timeoutSeconds: 1800`, `pollIntervalSeconds: 30`) — the exact fizzpop poll-hang anti-pattern
  `PRD_AUTHORING.md` exists to forbid and `queueOps.cjs` lints for. It would occupy one of only 3
  concurrency slots doing nothing; two waiters could deadlock the queue. `NN` ordering is the
  correct sequencing mechanism and already exists.

Originating issue: gh-issue-6 — https://github.com/StanislavBG/claude-code-session-manager/issues/6

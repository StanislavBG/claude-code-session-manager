---
title: Document (and unblock) how a project's own automation queues PRDs programmatically
source: GitHub issue gh-issue-5 (https://github.com/StanislavBG/claude-code-session-manager/issues/5)
type: docs
severity: normal
---

# What happens / what's missing

The filer is building a Slack-feedback → PRD → implementation loop for the Connector Atlas
project and reports three gaps: (1) no documented home for project automation scripts, (2) no
programmatic way to trigger `/develop` / queue a PRD, (3) no explicit project↔PRD association
beyond `cwd` in `queue.json`. Their stated blocker is the single step "Queue in session-manager
scheduler". Current workaround is a cron that finds Slack feedback and then asks a human to run
`/develop` by hand.

They offer three options: (A) project-level `automation-hooks.js` modules the scheduler loads
and executes on a cron; (B) a `session-manager queue-prd` CLI/API; (C) just document the
existing pattern.

# Evidence

- `src/main/adminServer.cjs:17,103,108` — the only programmatic surface today is
  loopback+token-authed, and read-only apart from `reset-job`. Confirms complaint (2): there is
  genuinely no create path.
- `scripts/scheduler-mcp-server.cjs:6-7` — existing MCP tools are `scheduler_reset_job` and
  `scheduler_list_jobs` only. No create.
- `queue.json` per-job `cwd` — confirms complaint (3): `cwd` really is the only project tie.
- `plugins/session-manager-dev/skills/process-feedback/SKILL.md` step 0b — a
  source-sync → triage → `/develop` → queue pipeline **already exists** and, as of the commit
  landed 2026-07-14 (`feat(process-feedback): sync open GitHub issues into the feedback intake`),
  already does exactly this shape of loop for GitHub issues.

# Triage evaluation (2026-07-15)

**Mostly answerable, one part rejected, the rest folds into gh-issue-6.**

**Option A (`automation-hooks.js` — project-supplied JS the scheduler `require`s and executes
on a cron) is DECLINED on security grounds.** It inverts this project's core invariants:
`config.cjs` funnels every path through `validatePath` (allowedRoots = home), `ipcSchemas.cjs`
zod-validates IPC at the main-process boundary, and `CLAUDE.md`'s Avoid list forbids adding
`shell: true` outside the two features that legitimately need it. Loading arbitrary
project-supplied JS modules and executing them in-process, on a timer, is a strictly larger
code-execution surface than any of those guard — a compromised or careless project directory
would get main-process privileges. The hook interface also duplicates the scheduler's own job
model (interval, enabled, returns work items) for no gain.

**Option B is ACCEPTED but is not new work here** — it is exactly `scheduler_create_prd` in
gh-issue-6. Filing it twice would fork the design. Tracked there.

**Option C is ACCEPTED and is this item's real deliverable.** Two of the filer's three
questions already have answers in-repo that were simply never written down, and their
"desired flow" diagram is already implemented for a different source:

- *"Where should project automation scripts live?"* → in the project's own repo. This project
  keeps its own operations under `session-manager-operations/`; the analogous answer is that a
  project owns its adapters, and session-manager exposes an API — not that session-manager
  hosts other projects' code.
- *"Is there already a way to programmatically queue PRDs?"* → not yet; gh-issue-6 adds it.
- *"Would project-level hooks be a good addition?"* → no, per the security reasoning above; the
  supported extension point is the MCP tool, which the project's own cron/script calls.

Their Slack use case then becomes: their cron (living in their repo) searches Slack, calls
`scheduler_create_prd`, done. Which is `/process-feedback`'s step-0b pattern with a Slack
adapter instead of a GitHub one — worth naming explicitly in the docs as the reference shape.

# Suggested direction

Documentation only, gated behind gh-issue-6 landing (so the doc describes a real tool):
1. Add a "Queueing PRDs from external automation" section to `PRD_AUTHORING.md` covering the
   `scheduler_create_prd` MCP tool, the Electron-must-be-running caveat, and the file-based
   fallback.
2. State the ownership boundary explicitly: projects own their source adapters; session-manager
   exposes the queueing API. Record why in-process hooks were declined so it isn't re-proposed.
3. Cite `/process-feedback`'s GitHub sync as the worked reference implementation.

## RESOLUTION

**Partially declined + queued as docs**: PRD `550-document-external-prd-queueing-pattern`
(2026-07-15), sequenced after PRD 549 so it documents a tool that actually exists.

- **Option A (project-supplied `automation-hooks.js` executed in-process on a timer) — DECLINED
  on security grounds.** It inverts this project's core invariants: `validatePath` on every path
  (`config.cjs`), zod-validated IPC at the main-process boundary (`ipcSchemas.cjs`), and the
  Avoid-list ban on `shell: true`. Loading arbitrary project JS with main-process privileges is a
  strictly larger code-execution surface than any of those guard. The decline and its reasoning go
  into `PRD_AUTHORING.md` (PRD 550) so it isn't re-proposed.
- **Option B (programmatic queueing) — ACCEPTED, but not re-filed here**: it *is*
  `scheduler_create_prd`, tracked as PRD 549 under gh-issue-6. Filing it twice would fork the design.
- **Option C (document the pattern) — ACCEPTED** and is this item's deliverable (PRD 550).

Two of the filer's three questions had in-repo answers that were simply never written down, and
their "desired flow" diagram is **already implemented** for a different source — `/process-feedback`'s
step-0b GitHub-issue sync (landed 2026-07-14) is the worked reference for source → triage → queue.
Their Slack case is that same shape with a different adapter, which their own repo owns.

Originating issue: gh-issue-5 — https://github.com/StanislavBG/claude-code-session-manager/issues/5

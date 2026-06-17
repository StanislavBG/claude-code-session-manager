---
name: project-status
model: opus
description: >-
  GLOBAL FRAMEWORK for one operational status rollup of the project in the
  current working directory — defines the contract (what a status report must
  contain, in what order, on which model) and DELEGATES the project-specific
  measurement to that project's own `project-status-local` skill. Use whenever
  the user asks "what's the project status", "/project-status", "how is this
  project doing", "are the jobs healthy", or wants a one-shot status rollup for
  the repo they're in. Keywords: project status, KPI, north-star, crons, jobs,
  last run, health, rollup, ops.
---

# project-status — global framework

This is the **global framework**, not an implementation. It owns the *contract*
(what a status rollup must contain, the order, the presentation, the model
expectation) and **delegates** the project-specific *how* to the project's own
`project-status-local` skill.

> **Two skills, no name collision (by design).**
> `project-status` (this, global) = the framework/expectations.
> `project-status-local` (per project) = the implementation.
> They have **different names on purpose** — a project must NOT ship a second
> skill also named `project-status`, because a same-name skill silently shadows
> this one and drops everything it defines (that is exactly how the model
> fallback got lost once). Each project ships exactly one `project-status-local`.

## What to do when invoked

First decide **scope**: one project (the current repo) or several (the user named
multiple repos, said "all my projects", or wants a cross-project board).

### Single project (the cwd)

1. **Delegate if a local exists.** If a `project-status-local` skill is available
   in the current project (it appears in the available-skills list), **invoke it**
   (Skill tool, `skill: project-status-local`). It owns the specifics — which KPI
   command to run, which crons are this project's, which health entrypoint to
   call. Present its output; if it omits an element of the contract below, fill
   the gap or note it.
2. **Otherwise run the generic fallback inline** (the flow at the bottom) and, at
   the end, **offer to scaffold a `project-status-local`** for this repo so the
   next run is project-aware.

Do not re-implement a project's specifics here — that belongs in its
`project-status-local`.

### Multiple projects (parallel fan-out)

The whole point of the framework/`-local` split: the per-project work is
**independent**, so run it **concurrently** — one project's KPI/crons/health
never depends on another's.

1. **Resolve the project list.** Use the repos the user named; for "all", or to
   discover them, enumerate every repo that ships a local skill:
   ```bash
   for d in ~/Projects/*/.claude/skills/project-status-local/SKILL.md; do
     [ -f "$d" ] && echo "${d%/.claude/skills/project-status-local/SKILL.md}"
   done
   ```
2. **Fan out one agent per project — in a SINGLE message with multiple `Agent`
   tool calls** so they run in parallel (sequential calls would defeat the
   purpose). Each agent (`subagent_type: general-purpose`) gets a prompt like:
   > `cd <ABS_REPO_PATH>`. Produce this repo's status rollup by executing its
   > own `project-status-local`: **read** `.claude/skills/project-status-local/SKILL.md`
   > and run its steps (they are deterministic — a `brief.py`/analyzer call, a
   > `crontab -l | grep` for its crons, its `scripts/health.sh`). If the repo has
   > no `project-status-local`, follow the generic contract (KPI→chores→health)
   > using its `CLAUDE.md` + crontab + health entrypoint. Return a **compact**
   > rollup (≤12 lines): the project name, the 7d North-Star line (KPI vs
   > benchmark → alpha), the health color, and the single worst ❌/⚠️ chore.
   Let each agent **inherit the model** (omit `model`) — it just runs the repo's
   commands; this framework's `model: opus` governs *this* turn.
3. **Aggregate** the returned rollups into one board: a lead table
   (Project · 7d KPI · Health · Worst signal), RED/❌ projects first, then each
   project's detail block beneath. Note any agent that failed to produce a rollup
   (missing repo, broken local) rather than dropping it silently.

Why agents, not the Skill tool, for the others: skill availability is bound to
the launch repo, so `project-status-local` is only directly invokable for the
**current** project. For other repos the agent reproduces the local by reading +
running it (it is deterministic bash), which works from any cwd.

## The contract (what every report must satisfy)

Order — **1. North-Star KPI (last 7d) → 2. Chores (crons) → 3. Logs & usage
patterns → 4. Health verdict.** Lead with the KPI line and the single worst
❌/⚠️ chore or health signal; detail after. Keep it tight; relay engine/analyzer
output rather than re-deriving numbers by hand.

A status check is an **audit**, not just a liveness ping — it reads the project's
*operational logs* (are the runs clean or throwing?) and its *usage/consumption
patterns* (who consumes the product's outputs, how often, which surfaces are hot
vs dead) alongside the KPI and crons. The KPI says "is the output valuable," the
logs+usage say "is the machine actually being used, and is it healthy under that
use." Both dimensions belong in every report.

- **KPI (the intro):** the metric the project's `CLAUDE.md` mission statement
  names as optimized (a `## North-Star KPI` / `## Objective` section, usually
  linking a definition doc or a measurement command). Measure it over a trailing
  7-day window with the project's own command; state it with the
  benchmark/target the section defines. If `CLAUDE.md` declares no KPI, say so
  plainly (it belongs in the mission statement) and use a git/activity summary
  for the intro — never invent a metric.
- **Chores:** only THIS project's cron jobs (match by repo name / absolute path),
  each with last-run time, recent result, and an error count, in a table:
  Job · Schedule · Purpose · Last run · Errors · Last result. Staleness: newest
  log line older than ~2× cadence ⇒ ⚠️ overdue; an installed cron with an
  empty/missing log ⇒ ❌ (often a Vixie-cron `TZ=` inline-prefix drop — fix with a
  standalone `TZ=` line). Market-hours-only jobs stale overnight is expected.
- **Logs & usage patterns:** two sub-parts, both delegated to the `-local` for
  *where the data lives*, but expected in every report:
  - **Logs** — scan the recent operational logs for error/warning rates,
    tracebacks, timeouts, and silent-stall signatures (a job that "ran ok" but
    did no work). Surface counts + the worst recent line, not just last-exit.
  - **Usage / consumption** — how the project's *outputs* are actually consumed:
    per-endpoint/-tool invocation counts, the consumer/tenant breakdown, and
    hot-vs-cold surfaces over a trailing window. This answers "is what we built
    being used, and by whom" — the dimension a KPI alone misses. The `-local`
    names the source (a usage/metering store, an access log, or a proxy like a
    panel/history table); if no usage source exists yet, say so and recommend
    standing one up rather than inventing numbers.
- **Health verdict:** run the project's own health entrypoint (first hit wins:
  `scripts/health.sh` · `.claude/health.sh` · `bin/health.sh` · a `health`
  Make/just target) and relay its GREEN/YELLOW/RED rollup. A non-zero exit for
  YELLOW/RED is expected, not a skill failure; only a crash is.

## After the audit — route findings, then improve (the loop)

A status check shouldn't dead-end at a report. Once the four dimensions are in,
**act on what the audit surfaced** — this is what makes `/project-status` a
self-contained *bootstrap → evaluate → improve* loop, usable even on a brand-new
project.

**First, work the inbox — triage before generating new work.** Right after the
audit, clear the inbound queue via **`/process-feedback`**: it evaluates any
pending feedback (cross-project asks others filed to us, plus the prior cycle's
`/optimize-kpi` item) and routes each — ours-do-it → `/develop`, theirs →
`/my-feedback`, decline-with-reason. Don't generate new levers on top of an
unprocessed backlog. (If the inbox is empty, say so and move on.)

Then route **this audit's own findings**, by ownership:

1. **A finding that belongs to another project** (an upstream/downstream service
   in the stack — e.g. the data source is stale, a contract drifted): do NOT
   reach across the boundary. File it with **`/my-feedback <project>`** into that
   project's intake, and note it in the report. (Same rule as everywhere: service
   boundaries outrank convenience.)
2. **A finding that belongs to THIS project** (a real bug, a missing guard, an
   enhancement the audit revealed — a cold sold-surface, a recurring error in the
   logs, a usage gap): queue it as a scheduled PRD via **`/develop`** — never
   implement it inline here. Record the queued PRD id in the report.
3. **Nothing actionable** — just report.

Then, the improvement gate: **if and only if the full health verdict is GREEN**
(every check passing — not degraded, not down) **and** the KPI/crons are clean,
invoke **`/optimize-kpi`** to drive the next North-Star improvement. The green gate
is load-bearing: optimizing the KPI on a broken or degraded base is wasted
motion — *fix health first* (via routes 1/2 above), and let a later run, once
green, trigger the optimizer. State explicitly in the report whether the gate
opened (green → optimize queued) or stayed shut (degraded/down → health findings
routed first).

This sequence — audit → route findings (my-feedback / develop) → optimize-when-green
— is enough to bootstrap, evaluate, and continuously improve a project from a
single `/project-status` invocation. The `-local` owns the *specifics* of each
step; this framework owns the *loop*.

## Model expectation (every local must mirror this)

This framework runs on **`model: opus`** (Opus 4.8) — a status check is reasoning
work that should run on the strongest model. **Every `project-status-local` MUST
carry the same single-value `model: opus` frontmatter line**, so a direct
`/project-status-local` invocation runs on Opus too. A local that omits it loses
the override and runs on whatever the session model happens to be.

> **Syntax matters — this is a real, documented field.** Skill frontmatter
> `model:` takes a **single** value (the same aliases as `/model`: `opus`,
> `sonnet`, `haiku`, `fable`, or a full id like `claude-opus-4-8`). It does NOT
> accept a comma-separated fallback chain — `model: opus,sonnet` is an invalid
> value and silently fails to apply (the skill then runs on the session model,
> not Opus). Graceful failover to Sonnet is configured **at the session level**,
> not per-skill, via `fallbackModel` in settings:
> `"fallbackModel": ["opus", "sonnet"]` in `~/.claude/settings.json`. Per the
> Claude Code docs, a skill's `model:` override applies for the rest of the
> current turn and reverts to the session model on the next prompt.

## Scaffolding a new `project-status-local` — establish the framework with the user

When a project has none, **do not silently guess the implementation.** The whole
point of the framework/`-local` split is that every project's report covers the
**same four dimensions** (KPI · chores · logs+usage · health) — so the parent's job
on a missing `-local` is to *establish those expectations with the user*, then
write a complete local. Run a short **Q&A** (use `AskUserQuestion`, batching the
gaps you couldn't auto-detect) to pin down each contract dimension:

1. **Probe first, ask only the gaps.** Read `CLAUDE.md` (KPI section?), the
   crontab (this repo's jobs + their log paths?), the repo for a health entrypoint
   (`scripts/health.sh` etc.), and for a usage source (a metering/access-log store,
   or a proxy table). Auto-fill what you can find.
2. **Ask the user to confirm/supply the rest**, one question per unresolved
   dimension:
   - **KPI** — what is this project's North-Star metric + the command that measures
     it over 7d? (If `CLAUDE.md` has no `## North-Star KPI` section, offer to add
     one — the KPI belongs in the mission statement, not only the skill.)
   - **Chores** — which crons are this project's, and where do their logs live?
   - **Logs & usage** — which logs carry the operational signal, and **what is the
     usage/consumption source** (a metering store / access log / proxy)? If none
     exists, flag it and offer to stand one up — a project with no usage telemetry
     can't answer "is what we built being used."
   - **Health** — the health entrypoint + how to read its verdict.
3. **Write the local** `<repo>/.claude/skills/project-status-local/SKILL.md` with
   frontmatter `name: project-status-local`, `model: opus` (single value — see the
   syntax note above; `fallbackModel` owns failover), a project-specific
   `description`, and a body implementing **all four** contract dimensions against
   the answers — so the next `/project-status` here is project-aware and consistent
   with every other project's report.

This Q&A is the deliberate "pain" that makes cross-project reports comparable:
each `-local` is the *same contract*, filled with that project's specifics.

## Generic fallback flow (no local present)

Run inline only when the project ships no `project-status-local`:

1. **Current time:** `date '+%Y-%m-%d %H:%M %Z'` (for staleness judgment).
2. **KPI:** read `./CLAUDE.md`, find the North-Star section, run its measurement
   command over 7 days, and state the headline. No KPI section ⇒ say so + git
   summary.
3. **Chores:** `crontab -l | grep -F "$(basename "$PWD")" | grep -v '^\s*#'`
   (widen/narrow if the cron path differs from the dir name); for each job
   `ls -la <log>` + `tail -n 8 <log>` + an `ERROR|Traceback|failed|exception`
   count; render the chores table.
4. **Logs & usage:** scan recent logs for error/warning rates + silent stalls;
   look for a usage/consumption source (a metering store, an access log, or a
   request/history table) and summarize per-surface invocation + consumer
   patterns over a trailing window. If none exists, say so and recommend standing
   one up — don't invent usage numbers.
5. **Health:** run the project's health entrypoint and relay the rollup; if none
   exists, infer from KPI + chores and offer to create `scripts/health.sh`.
6. Lead with the 7d KPI line and the worst chore/health/usage signal. Then offer
   to scaffold a `project-status-local` (Q&A above) so the next run is consistent.

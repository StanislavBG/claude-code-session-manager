---
name: local-project-health
description: >-
  Run the CURRENT project's own definition of "health" and report one rollup.
  Each project defines health differently (a trading bot tracks circuit-breakers
  + benchmark alpha; a web app tracks uptime + error rate), so this skill runs
  the project-supplied health entrypoint rather than imposing a generic check.
  Use whenever the user asks "is this project healthy?", "/local-project-health",
  "system health", "is everything running / green", or wants a one-shot status
  rollup for the repo they're in. Keywords: health, status, healthcheck, is it
  up, are we green, rollup, system health, project health.
---

# Local project health

Report a single health verdict for the project in the current working directory
by running **that project's own** health definition. Health is project-specific
by design — do not invent generic checks.

## Procedure

1. **Find the project's health entrypoint**, checking these paths in order
   (first hit wins):
   - `scripts/health.sh`
   - `.claude/health.sh`
   - `bin/health.sh`
   - `Makefile` / `justfile` target named `health`

2. **If an entrypoint exists**, run it from the repo root and relay its output:
   - `bash scripts/health.sh` (or the path found / `make health` / `just health`).
   - These scripts are designed to print a human rollup and exit 0/1/2
     (GREEN/YELLOW-or-UNKNOWN/RED). Show the user the rollup verbatim, then add a
     one-line plain-English verdict leading with the overall color and the worst
     layer (e.g. "🟡 YELLOW — performance is the drag: −3 pts vs SPY").
   - If the script persists a structured artifact (e.g.
     `data/system_health.json`), mention where it landed.
   - If it exits non-zero, that is expected for YELLOW/RED — it is NOT a skill
     failure. Only treat a *crash* (missing interpreter, traceback, unbound var)
     as a failure to debug.

3. **If NO entrypoint exists**, do not guess at health with ad-hoc commands.
   Instead:
   - Read `CLAUDE.md`, `README*`, and skim the repo to infer what "health" means
     for THIS project (what it monitors, what would constitute degraded/broken).
   - Propose a concrete `scripts/health.sh` that collapses those project-specific
     layers into one GREEN/YELLOW/RED rollup (terminal output + a persisted
     `*.json` artifact), reusing the project's existing CLIs/artifacts rather
     than re-deriving thresholds.
   - Offer to create it. Once created, it becomes the convention this skill runs
     on every future invocation.

## Notes

- The contract is the **convention path**, not a shared implementation: every
  project owns its own `scripts/health.sh`. This skill is just the launcher +
  interpreter of the result.
- Keep the relayed summary tight: overall color first, then the offending
  layer(s), then where the full report is. Lead with the answer.

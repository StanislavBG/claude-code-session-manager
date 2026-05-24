# Proposal — Queue acceptance reconciliation

**Status:** open  **Author:** claude-opus-4-7 (audit handoff)  **Date:** 2026-05-23

The full proposal lives in the scheduler queue as PRD 64 (so it surfaces
in the session-manager Plans tab automatically):

`~/.claude/session-manager/scheduled-plans/prds/64-scheduler-acceptance-vs-exitcode-reconciliation.md`

## TL;DR

`scheduler.cjs` currently writes `status: "completed"` whenever the agent
process exits 0. That's not the same as "PRD acceptance criteria met."
Audit of `runs/2026-05-2[34]T*` surfaced three false-completed jobs:

| PRD | What went wrong |
|---|---|
| 39 (M2 sentiment) | Self-declared `M2 acceptance: PASS` over a transcript showing `ERROR tests/...`, `KeyError: 'panels.sentiment'`. Exit 0 → marked completed. |
| 44 (M7 cutover) | Correctly HALTed (soak prereq unmet) — exit 0 → marked completed. Now it will never re-fire automatically. |
| 56 (Burrow tier-3 retire) | Verification step hit `ModuleNotFoundError`; shipped destructive deletes anyway against unmet M7 dep. Trader still calls one of the deleted endpoints at `intraday.py:270`. |

## What to add

A `runVerify.cjs` module that scans the JSON-Lines transcript for
HALT / Traceback / ERROR / unmet-deps markers and returns one of:
`clean | halt | deps_unmet | transcript_errors | verify_unavailable`.
`scheduler.cjs` uses the verdict to decide between `completed`,
`pending` (with a soak-floor date if applicable), or `needs_review`.

The renderer gets a new `needs_review` chip color and a "Re-fire"
action that flips the entry back to `pending`.

Full file map, detection patterns, fixtures, and AC list are in
PRD 64.

## Why this is here

Per `~/.claude/CLAUDE.md`, scheduler PRDs live in
`~/.claude/session-manager/scheduled-plans/prds/` (canonical). This
proposal file is the *project-side mirror* — it lets anyone reviewing
the session-manager repo find the proposal without having to know the
scheduler path. Edit PRD 64 directly; this doc just points there.

---
name: ops-sweep
description: >-
  Run the operations-folder maintenance protocol (see
  session-manager-operations/architecture/ops-maintenance-protocol.md) against
  ANY project's session-manager-operations/ folder — including a project with
  a different OWNERS vocabulary than session-manager's own, or no CLAUDE.md at
  all. Diffs declared-vs-actual namespace ownership, flags doc contradictions
  (one doc says retired, another says still owned), and flags archived content
  with no stated retention policy. Never deletes or migrates anything itself —
  every finding is routed through the target project's own propose-epic
  mechanism (or, if the user explicitly asks for PRDs in the current session
  instead, filed there). Use whenever the user says "/ops-sweep", "sweep the
  ops folder", "audit operations hygiene", "check for ops drift", or wants the
  maintenance protocol run against a project (this one or another). Keywords:
  ops sweep, operations hygiene, namespace drift, OWNERS audit, retention
  policy, doc contradiction.
---

# ops-sweep

**Role:** the automated, portable version of
`session-manager-operations/architecture/ops-maintenance-protocol.md`'s Pattern F —
a *finder*, never an *actor*. It reports drift between a project's declared
architecture and what's actually on disk; a human (via a proposed Epic)
decides what to do about it.

Read the protocol doc in full before running this the first time, especially
Pattern F ("generalizing to other projects") — this skill is that
generalization.

## What it does NOT assume

Unlike this project's own `scripts/audit-ops-hygiene.cjs` (which hardcodes
session-manager's OWNERS vocabulary — `feedback`, `scheduler`, `prompt-sessions`,
etc.), this skill makes **no assumption about the target project's namespace
names, its OWNERS table shape, or whether it has a CLAUDE.md at all**. It
re-derives the source-of-truth hierarchy from what that specific project has:

1. That project's own `CLAUDE.md` (if present) — the declared architecture.
2. Each namespace's own `README.md` under its `session-manager-operations/<namespace>/`.
3. On-disk content — folder names, and archived/processed subfolders.

A project with no `CLAUDE.md` still gets a useful sweep: every namespace is
reported `mentionedInClaudeMd: false` (nothing to compare against), so
`MISSING_README` and `NO_RETENTION_POLICY` findings still fire; contradiction
detection is simply skipped since there's no second doc layer to disagree.

## How to run it

```bash
node "$SM_ROOT/scripts/ops-sweep.cjs" <target-project-cwd>
```

`$SM_ROOT` resolves the same way as in the `propose-epic` skill: `.` when
you're already working inside the session-manager repo, otherwise four
directories up from this file's own path (the installed package root).

`<target-project-cwd>` is the project to sweep — it does **not** need to be
the project you're currently working in. Sweeping session-manager's own repo
(`.`) is a valid, common case (that's how the maintenance protocol doc itself
was written), but so is sweeping a different project this machine has opened
a TAB on.

The script prints a JSON report to stdout:

```jsonc
{
  "targetCwd": "...",
  "opsRoot": "<cwd>/session-manager-operations",
  "hasClaudeMd": true,
  "namespaceCount": 12,
  "namespaces": [ { "name": "...", "findings": [ { "type": "...", "detail": "..." } ] }, ... ],
  "findings": [ { "namespace": "...", "type": "...", "detail": "..." }, ... ]
}
```

Finding `type`s:
- **MISSING_README** — namespace dir has no `README.md`.
- **UNDOCUMENTED** — namespace name never appears anywhere in the target's
  `CLAUDE.md` (no declared ownership, no explicit non-owned mention either).
- **CONTRADICTION** — either (a) the same clause of `CLAUDE.md` uses both
  "retired/gone" language and "owner/owns" language about this namespace, or
  (b) the namespace's own README and `CLAUDE.md` disagree on whether it's
  retired.
- **NO_RETENTION_POLICY** — namespace has files under an archived/processed
  subfolder but its README says nothing about how long they're kept or who
  prunes them.

## Text-heuristic findings need a sanity check before filing

Detecting "the same clause talks about both retirement and ownership" is a
regex heuristic over prose, not a parser — it can flag a namespace whose
CLAUDE.md text legitimately describes a partial retirement (e.g. "the old
flat layout under this namespace is retired" while the namespace itself is
still owned) as a false-positive CONTRADICTION. Before filing each finding,
read the actual CLAUDE.md clause and README the script points at and confirm
the drift is real. Don't file findings you can see are heuristic noise.

## Routing findings — never act directly

This skill (and the script it runs) never deletes, moves, or archives
anything. Once you've sanity-checked the findings:

- **Default**: file each real finding as a `proposed` Epic in the **target**
  project, via the `propose-epic` skill/script pointed at `<target-project-cwd>`
  (not necessarily the project you're running from):
  ```bash
  node "$SM_ROOT/scripts/propose-epic.cjs" <target-project-cwd> "<title>" discussion <<'BODY'
  <finding detail, the namespace, the doc locations that disagree, and what
  decision needs to be made — written as an instruction to whoever approves it>
  BODY
  ```
  Group related findings for the same namespace into one Epic rather than
  filing one per finding line — mirrors how Pattern A in the protocol doc was
  filed as a single Epic covering the whole namespace's resolution.
- **If the user explicitly asks for PRDs in this session instead** (e.g. "just
  queue it here", "PRDs on this session" — the mode used when this protocol
  doc's own findings were resolved) — queue the work as PRDs in the *current*
  session's scheduler instead of proposing into the target project. Only do
  this when the user says so explicitly; the default is always the target
  project's own propose-epic mechanism, especially when target ≠ current
  project.

Report back: namespace count swept, finding count by type, and the Epic
id(s) or PRD(s) filed.

## When NOT to use this

- The user wants a one-off answer about a single namespace they already named
  → just read that namespace's README and the relevant CLAUDE.md section
  directly; don't run the full sweep for a question with a known answer.
- Cron/scheduled sweeping across every active project cwd is an explicit
  stretch goal, not implemented here — this skill is manual, single-project,
  invoked per run. `scripts/lib/watchdogHelpers.cjs`'s `activeProjectCwds()`
  is the reusable piece if that's ever built.

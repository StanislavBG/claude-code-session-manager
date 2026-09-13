# 2026-08-02 — ops-maintenance-protocol run log

Frozen narrative of the first run of the
[operations-folder maintenance protocol](../architecture/ops-maintenance-protocol.md) against
session-manager's own `session-manager-operations/` folder. The durable rules this run exercised
(source-of-truth hierarchy, two-of-three rule, per-pattern detection rules) live in that doc, not
here — this is a point-in-time record of what was found and what was (and wasn't) done about it.

## Pattern A resolution — `feedback/` retired-in-docs, live-in-code

`feedback/` was declared retired in CLAUDE.md's "status: 'proposed' is the human gate" bullet
("The retired machinery — `session-manager-operations/feedback/`... is gone") while the same
CLAUDE.md's OWNERS bullet two paragraphs earlier still listed `feedback → feedback` as a current
owner — CLAUDE.md contradicted itself. Code confirmed the retirement was real but incomplete: the
feedback RCA hook no longer wrote there (it filed proposed Epics instead), yet `config.cjs` still
granted write access to the feedback namespace with a comment claiming the hook used it, and
`opsOwnership.cjs` still listed it as an owned namespace. `feedback/README.md` still instructed
readers to file via a since-removed skill. Three layers, three different stories, 72 files
(2.9 MB) sitting on disk as a result.

**Decision**: full retirement. The `feedback` `OWNERS` entry and its `config.cjs` write grant were
removed; the 69 historical files were archived to
`session-manager-operations/feedback/archived-2026-08-02/`; `feedback/README.md` was rewritten to
point readers at `/propose-epic`; CLAUDE.md's two contradictory bullets were reconciled. Zero open
(un-triaged) items were on disk at decision time, confirming the folder had no live manual-inbox
usage independent of the now-retired processing pass.

## Pattern C narrative — legacy flat `scheduler/prds/`

CLAUDE.md stated the flat `scheduler/prds/` layout was "RETIRED and auto-consolidated into
`prds-archived/` at boot." On disk at the time, `scheduler/prds/` (top-level) still held 73 files
and `scheduler/prds-archived/` held 179 — the claimed boot-time consolidation looked either not
running, not covering every file, or the 73 remaining files were legitimately still in flight.
Resolved a few hours later: re-checked, the flat dir held 0 `.md` files — the 73 files were
legitimately in-flight PRDs mid-drain, not stuck debt. Full findings:
[`2026-08-02-ops-protocol-patterns-c-d-findings.md`](2026-08-02-ops-protocol-patterns-c-d-findings.md).

## Pattern D narrative — orphaned top-level session/epic JSON

`prompt-sessions/`'s 46 top-level archived `*.json` files were cross-referenced against
`scheduler/epics/`'s 35 directories: 29 had no matching `scheduler/epics/<id>/` directory. Scripted
the PRD-dispatch-event check (`scripts/audit-ops-hygiene.cjs`): 0 real data-loss candidates found —
every orphan was either a never-started Epic or a dispatched PRD that landed under a
differently-named auto-minted epic dir. Full findings:
[`2026-08-02-ops-protocol-patterns-c-d-findings.md`](2026-08-02-ops-protocol-patterns-c-d-findings.md).

## Pattern G narrative (the `feedback/processed/` example)

At the time, `feedback/processed/` held 70 files dated 2026-06-10 through 2026-07-12 with no
expressed retention window anywhere (README, CLAUDE.md, or code) — the concrete example that
motivated Pattern G ("time-boxed archival with no retention policy", then lettered E) in the
protocol doc. Sibling folders in the same state: `prompt-sessions/` archived epics (42 MB at the
time) and `scheduler/prds-archived/` (3.2 MB at the time).

## What this session did NOT do

No files were deleted or migrated this session — every finding above (Pattern A, C, D) was routed
to a proposed Epic instead of acted on directly, per the source-of-truth rule: two-of-three doc
layers must agree before a destructive action is "safe," and none of A/C/D cleared that bar without
further investigation. Pattern B (doc-only, CLAUDE.md enumeration) was low-risk enough to fix
directly — see the CLAUDE.md diff in the commit that landed this run.

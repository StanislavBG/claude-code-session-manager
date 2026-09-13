# Ops-maintenance-protocol Patterns C & D — investigation findings

Follow-up to [`ops-maintenance-protocol.md`](ops-maintenance-protocol.md)'s open Pattern C and
Pattern D, filed the same day (2026-08-02) as its own hygiene Epic. Investigation only — no
files were deleted or migrated. Re-runnable via `node scripts/audit-ops-hygiene.cjs [cwd]`
(read-only; prints the same two verdicts this doc reports).

## Pattern C — legacy flat `scheduler/prds/` layout

**Original observation** (protocol doc, earlier the same day): `scheduler/prds/` top-level held
73 `.md` files against 179 in `prds-archived/`, despite CLAUDE.md claiming the flat layout is
"RETIRED and auto-consolidated into `prds-archived/` at boot."

**Current state** (this investigation): `scheduler/prds/` top-level holds **0** `.md` files
(only the NN-allocator dotfiles `.max-allocated-group` / `.reserved-*`, which are expected to
stay — `consolidateFlatPrds` explicitly skips dotfiles). `prds-archived/` still holds 179.

**Root cause, from reading the code** (`src/main/lib/prdMigration.cjs`,
`src/main/scheduler.cjs`):

- `resolvePrdWriteDir` (the flat-dir path) is explicitly commented "remains read-only during the
  transition — new PRDs always belong to an Epic." New PRDs are never written to the flat dir.
- The 73 files were **pre-existing PRDs from before the epic-scoping transition**, most already
  referenced by live `queue.json` jobs — i.e. legitimately in-flight/queued work, exactly the
  alternative the protocol doc already flagged as possible ("the 73 remaining files are
  legitimately still in flight... not yet archived because not yet completed").
- Two independent archival paths exist: `consolidateFlatPrds` (bulk, boot-time, moves every
  remaining flat `.md` regardless of completion status) and `archiveCompletedPrd` (per-job, fires
  when an individual PRD's queue job completes, called from normal `executeJob` flow).
- Evidence the drain was **per-job, not bulk**: `prds-archived/` file mtimes cluster in groups of
  at most 8 sharing the same second (`stat --format='%Y %n' *.md | sort | uniq -c`), never
  anything close to 73 — a single `consolidateFlatPrds` bulk-rename of 73 files would produce one
  large cluster. The pattern instead matches steady, individual `archiveCompletedPrd` calls as
  each queued job finished over the following hours.

**Verdict**: Pattern C is **resolved**, and was never actually "stuck legacy debt" — it was a
transient snapshot of in-flight PRDs mid-drain, caught between the protocol doc's write and this
investigation a few hours later. The "RETIRED and auto-consolidated" claim in CLAUDE.md holds:
the flat dir is not a write target for new work, and whatever legitimately lands there (pre-
existing queued jobs) drains via normal completion. No code change, no migration needed.
`ops-maintenance-protocol.md`'s "Action: investigate before touching" is satisfied — nothing to
touch.

## Pattern D — orphaned top-level `prompt-sessions/*.json`

**Original observation**: 29 of 46 top-level archived Epic JSON files had no matching
`scheduler/epics/<id>/` directory.

**Current state**: 34 of 48 top-level files are orphaned by the same id-match test (counts moved
because both folders are live and being written by concurrent Epics as this investigation ran).

**Method** (`scripts/audit-ops-hygiene.cjs`, `auditPatternD`): for every orphaned file, inspect
its own `events` array for a `kind: "prd_created"` entry. If none exist, the Epic never dispatched
a PRD — safe, expected (discussion-tag Epics, abandoned proposals, `/builder` runs that never
authored a PRD). If one or more exist, don't stop at "no dir with this id" — a dispatched PRD
auto-mints its **own** epic dir via `epicMint.cjs`, whose slug is derived from the PRD title, not
the originating prompt-session id, so an id-based directory lookup alone cannot distinguish
"moved to a different name" from "actually lost." The script instead greps every `.md` under
`scheduler/` for a `sourcePromptId: <this epic id>` frontmatter line — the one field that survives
the rename.

**Results**:
- **33 never-started** — no `prd_created` event. Confirmed harmless; candidates for a future
  retention policy (Pattern E's open question), not touched.
- **1 accounted-for-elsewhere** — `psess-msalhl8p-23` has one `prd_created` event
  (`906-interactivelly-implement-the-following-the-tab-uner-the`). Its PRD file was found at
  `scheduler/epics/interactivelly-implement-the-following-the-tab-u-ecca3468/prds-archived/906-...md`,
  frontmatter `sourcePromptId: psess-msalhl8p-23` confirmed by direct read. Not data loss — just
  the expected id/slug mismatch between a prompt-session and its auto-minted epic.
- **0 data-loss candidates** — no orphaned file with PRD-dispatch history and no matching PRD
  file anywhere on disk.

**Verdict**: Pattern D is **resolved** for the current snapshot — zero real data loss found. All
34 orphans are accounted for. Per the source-of-truth rule (two-of-three doc layers must agree
before treating anything as safe to act on), the 33 never-started files are a *reporting* finding
only: CLAUDE.md and code agree they're harmless, but there is still no README-documented
retention policy for `prompt-sessions/` archived files (Pattern E), so none were archived/deleted
this session — only classified.

## What this session did NOT do

No files were deleted, archived, or migrated. Both patterns turned out to be transient-snapshot
artifacts of a live, continuously-running scheduler rather than actual bugs or data loss —
confirmed by re-running the check against current disk state, not just re-reading the original
snapshot's numbers. `scripts/audit-ops-hygiene.cjs` is left in the repo so this check can be
re-run cheaply (by a human, or eventually Pattern F's sweep agent) without re-deriving the method.

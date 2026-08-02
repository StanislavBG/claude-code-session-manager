# Retired — use `/propose-epic` instead

This folder was the intake queue for improvement requests, bug reports, and enhancement ideas for
**claude-code-session-manager**, processed via a now-retired `/process-feedback` triage pass.

**As of 2026-08-02 this folder is fully retired.** It is no longer an `OWNERS` namespace
(`src/main/lib/opsOwnership.cjs`) and has no write grant in `config.cjs`. Nothing writes here any
more — `lib/rcaFeedbackHook.cjs` (the scheduler's auto-RCA producer) files **proposed Epics**
instead, gated behind a human pressing **Approve & start**; see `CLAUDE.md`'s
"`status: 'proposed'` is the human gate" section.

If you want work done on this project — a bug report, an enhancement idea, a cross-project
request — use `/propose-epic` (`session-manager-dev:propose-epic` skill). It replaces this folder:
the proposal IS the work item, already carrying its own session and PRD directory, and nothing
runs or is spent until a human approves it.

The 69 historical items this folder accumulated (2026-06-10 through 2026-07-31, all already
triaged and dispositioned) are preserved for reference in `archived-2026-08-02/` — the original
`processed/` and `evidence/` directories plus the final `README.md` (with its full status log and
"Lessons for submitters" history) as `archived-2026-08-02/README-2026-08-02.md`.

See `session-manager-operations/architecture/ops-maintenance-protocol.md` Pattern A for the audit
that found this folder's retirement status contradicted across code/CLAUDE.md/README, and the
decision (full retirement) that resolved it.

## Retention policy for `archived-2026-08-02/`

**Keep indefinitely.** This is the sole historical record of the 71 feedback items dispositioned
before this folder's retirement (2026-06-10 through 2026-07-31) — nothing else preserves that
triage/status log. There is no automatic pruning: no code, cron, or skill deletes files here
(this folder is not an `OWNERS` namespace, so `assertOpsWrite` doesn't cover it either — see
`CLAUDE.md`'s "No general OWNERS namespace" bullet). Enforcement is manual: pruning or moving
this archive would be a deliberate human decision made via a proposed Epic (`/propose-epic`), not
an automatic process — see `ops-maintenance-protocol.md` Pattern E/F, which requires a
documented, agreed-upon rule before any file-age/size-based deletion and never lets a sweep agent
delete directly. No pruning mechanism exists today; building one is out of scope for this note
and would need its own proposed Epic.

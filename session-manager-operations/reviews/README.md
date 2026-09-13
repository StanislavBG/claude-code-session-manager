# reviews/

A **frozen findings archive**. Every file here is a point-in-time survey written during a
review pass, not a living spec. **Not an OWNERS namespace** — no code path writes here,
no `assertOpsWrite` guard applies.

**Retention: keep indefinitely.** These are an audit trail; several are cited by archived
PRDs as the record of what was found and fixed. Do not delete or "clean up" a finding
just because its subject has since changed or been removed — see below.

## Provenance

- `config-tabs-findings.md`, `frame-chrome-findings.md`, `history-usage-findings.md`,
  `memory-webremote-findings.md`, `projects-search-tools-findings.md`,
  `scheduler-findings.md`, `terminal-browser-editor-findings.md` —
  the 2026-07-18 per-tab-family review-and-fix pass. Each landed in the same commit series
  as the fix it describes (`git log -- session-manager-operations/reviews/<file>` shows the
  paired `fix(...)` commit).
- `chatrunner-concurrency-reconciliation.md` — a 2026-07-24 re-verification pass.
- `2026-09-13-file-org-audit-findings.md` — a dated, one-off structural audit of
  `session-manager-operations/` and the doc set (this file is an artifact of that audit).
- `2026-08-02-ops-protocol-patterns-c-d-findings.md` — moved from `../architecture/` (was
  `ops-maintenance-protocol-patterns-c-d-findings.md`), the Pattern C/D investigation for
  `ops-maintenance-protocol.md`.
- `2026-08-02-ops-maintenance-protocol-run-log.md` — split out of
  `../architecture/ops-maintenance-protocol.md`, the frozen 2026-08-02 first-run narrative
  (concrete counts, dates, what was and wasn't touched) for that doc's durable rules.
- `2026-07-30-global-settings-inventory.md` — moved from `../architecture/`
  (`global-settings-inventory.md`), a frozen point-in-time global-settings inventory.
- `2026-09-12-agent-layer-consumers.md` — moved from `../architecture/`
  (`agent-layer-consumers.md`), the external-consumer survey for the AGENT LAYER partition.
- `2026-08-07-heap-snapshot-validation.md` — the dated mechanism-validation lab report split
  out of `../architecture/heap-snapshot-diagnostics.md`.

## The rule this namespace exists to enforce

A **point-in-time survey** (a review, an audit, a "state of X as of date Y") belongs here,
with the date in the filename. It never belongs in `../architecture/` — that folder is for
docs that stay current and get edited in place, not for frozen snapshots. If you're about
to write a dated findings doc, it goes in this folder.

## Known staleness

Most reviewed subjects — the Browser tab, Web Remote (desktop half), and the
Search/QuickOpen modals — have since been deleted from the codebase. Their findings docs
are not wrong, they're **history**: a record of what was found and fixed at the time, for
a surface that has since been removed from the codebase. Don't "fix" a stale reference in one of these files; the
staleness is the point.

# session-manager-operations/ — scoped context

Part of the **OPERATIONS STATE** partition — see
[`architecture/project-partition.md`](architecture/project-partition.md).

## What's here

14 namespaces, no top-level files. Ownership rules: [domain-model.md#single-writer-law](architecture/domain-model.md#single-writer-law), enforced by `src/main/lib/opsOwnership.cjs`.

- **Owned** (in `OWNERS`, app-owned runtime state): `prompt-sessions` →
  epics · `scheduler` → scheduler · `project-brief` → project-home ·
  `logs` → logs · `memory-clusters` →
  memory-clusters · `ui-prefs` → ui-prefs · `tasks` → tasks · `project-pages` → project-home
  (admin render route only; a Builder Epic's own authoring stays ungoverned
  — see [`project-pages/README.md`](project-pages/README.md)).
- **Deliberately NOT owned** (skill-authored docs/artifacts, no write
  hazard): `architecture`, `design-mocks`, `HUMAN_LEARN`, `manual`,
  `reviews`. `feedback` **retired** (2026-08-02).
- **Any new top-level folder must land in the table below or in `OWNERS`
  in the same PR** — `scripts/ops-sweep.cjs` flags an unlisted namespace
  as `UNDOCUMENTED`.

The bare root has no owner — `opsOwnership.cjs` refuses a write there.

Epic lifecycle is specified exactly once, at
[`prompt-sessions/README.md#lifecycle`](prompt-sessions/README.md#lifecycle)
— not restated here.

| Namespace | Governance | Purpose | Retention | README |
| --- | --- | --- | --- | --- |
| `architecture` | not owned | reference docs root CLAUDE.md links to | keep | none |
| `design-mocks` | not owned | design mock artifacts, incl. project-pages component library | keep | [link](design-mocks/README.md) |
| `feedback` | retired 2026-08-02 | former feedback intake, superseded by New Epic | n/a — retired | none |
| `HUMAN_LEARN` | not owned | human-readable knowledge-base pages | keep | [link](HUMAN_LEARN/README.md) |
| `logs` | OWNERS → logs | per-tab JSONL error log | append-only, unpruned | [link](logs/README.md) |
| `manual` | not owned | authoring source for the free Field Manual | keep | [link](manual/README.md), [2.0.0](manual/RELEASE-2.0.0.md) |
| `memory-clusters` | OWNERS → memory-clusters | per-project memory-cluster cache | regenerated on demand | [link](memory-clusters/README.md) |
| `project-brief` | OWNERS → project-home | synthesized per-project Brief | keep | [link](project-brief/README.md) |
| `project-pages` | OWNERS → project-home (render route only) | generated static Project Page artifacts | regenerated on demand | [link](project-pages/README.md) |
| `prompt-sessions` | OWNERS → epics | durable Epic (PromptSession) store | keep | [link](prompt-sessions/README.md) |
| `reviews` | not owned | frozen audit-trail review docs, incl. `validation/<epic-id>/` plan records committed by validator jobs | keep | [link](reviews/README.md) |
| `scheduler` | OWNERS → scheduler | PRD sources + queue/history state | keep | [link](scheduler/README.md) |
| `tasks` | OWNERS → tasks | runtime Task ledger (headless `claude -p` runs) | `tasksDays`, opsRetentionSettings (default 30d) | [link](tasks/README.md) |
| `ui-prefs` | OWNERS → ui-prefs | per-project UI state | keep | [link](ui-prefs/README.md) |

## Who consumes this

This app's main process (owned namespaces, via `opsPath()`) and skills/humans
authoring the unowned ones directly with Write. Each namespace's README is
the storage-layout contract; this table only says who owns it.

## What must NOT be assumed

- Owned-namespace writes and ops-path building: see [domain-model.md#single-writer-law](architecture/domain-model.md#single-writer-law), enforced by `src/main/lib/opsOwnership.cjs`.
- Do not link out with a `file://` URL — it only resolves on one machine.

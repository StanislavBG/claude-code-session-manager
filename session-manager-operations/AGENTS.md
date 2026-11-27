# session-manager-operations/ — scoped context

Part of the **OPERATIONS STATE** partition — see
[`architecture/project-partition.md`](architecture/project-partition.md).

## What's here

21 namespaces, no top-level files. [Single-writer law](architecture/domain-model.md#single-writer-law), enforced by `src/main/lib/opsOwnership.cjs`.

- **Owned** (app state): each `OWNERS →` row; `project-pages` = admin render route only
  ([README](project-pages/README.md)). `not owned` rows are skill-authored, no write hazard.
- **A new top-level folder joins this table in the same PR** — `scripts/ops-sweep.cjs` flags it `UNDOCUMENTED` otherwise.

Bare root: writes refused. Retention exception: human-only purge (`lib/epic/epicPurge.cjs`).

Epic lifecycle: [`prompt-sessions/README.md#lifecycle`](prompt-sessions/README.md#lifecycle) only.

| Namespace | Governance | Git | Purpose | Retention | README |
| --- | --- | --- | --- | --- | --- |
| `agents` | OWNERS → agents | runtime | write-once AgentSnapshots `snapshots/<id>.json` | keep forever | none |
| `architecture` | not owned | tracked | reference docs | keep | none |
| `artifacts` | OWNERS → artifacts | runtime | review files `<epic-id>/` | `artifactsDays` after Epic completes | [link](artifacts/README.md) |
| `design-mocks` | not owned | tracked | design mock artifacts | keep | [link](design-mocks/README.md) |
| `events` | OWNERS → event-log | runtime | per-Epic event log `<epic-id>/events.jsonl` | keep forever | none |
| `feedback` | retired 2026-08-02 | project's own | retired; never touched (project's own) | n/a | none |
| `feedback-inbox` | OWNERS → feedback-inbox | runtime | per-project website feedback inbox | `feedbackInboxDays`, resolved/wontfix (default 90d) | none |
| `HUMAN_LEARN` | not owned | tracked | knowledge-base pages | keep | [link](HUMAN_LEARN/README.md) |
| `logs` | OWNERS → logs | runtime | per-tab JSONL error log | append-only, unpruned | [link](logs/README.md) |
| `manual` | not owned | tracked | free Field Manual source | keep | [link](manual/README.md), [2.0.0](manual/RELEASE-2.0.0.md) |
| `md-network` | not owned | tracked | human `steering.md`; read-only for code | keep | — |
| `memory-clusters` | OWNERS → memory-clusters | runtime | memory-cluster cache | regenerated on demand | [link](memory-clusters/README.md) |
| `plan-records` | OWNERS → scheduler | runtime | validator + ship/deploy records, `<epic-id>/<slug>.md` | `planRecordsDays` after Epic completes (default 14d) | [link](plan-records/README.md) |
| `project-brief` | OWNERS → project-home | tracked | synthesized per-project Brief | keep | [link](project-brief/README.md) |
| `project-pages` | OWNERS → project-home (render route only) | tracked | Project Home library | regenerated on demand | [link](project-pages/README.md) |
| `prompt-sessions` | OWNERS → epics | runtime | Epic (PromptSession) store | keep | [link](prompt-sessions/README.md) |
| `reviews` | not owned | tracked | frozen review docs; `validation/<epic-id>/` = legacy plan records | keep | [link](reviews/README.md) |
| `scheduler` | OWNERS → scheduler | runtime | PRD sources + queue/history state | keep | [link](scheduler/README.md) |
| `tasks` | OWNERS → tasks | runtime | runtime Task ledger | `tasksDays` (default 30d) | [link](tasks/README.md) |
| `ui-prefs` | OWNERS → ui-prefs | runtime | per-project UI state | keep | [link](ui-prefs/README.md) |
| `webhooks` | OWNERS → webhooks | runtime | loopback webhook subscriptions (0600, HMAC secrets) | until removed | none |

Git: runtime = machine-local, never committed, self-ignored by its own `*` .gitignore; tracked = the project's authored output, committed like docs, never ignored by Session Manager.

## Who consumes this

Main process (owned, via `opsPath()`); skills/humans (unowned). Each README is the layout contract.

## What must NOT be assumed

- Do not link out with a `file://` URL — it only resolves on one machine.

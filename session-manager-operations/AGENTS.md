# session-manager-operations/ — scoped context

Part of the **OPERATIONS STATE** partition — see
[`architecture/project-partition.md`](architecture/project-partition.md).

## What's here

18 namespaces, no top-level files. Ownership rules: [domain-model.md#single-writer-law](architecture/domain-model.md#single-writer-law), enforced by `src/main/lib/opsOwnership.cjs`.

- **Owned** (in `OWNERS`, app-owned state): each `OWNERS →` row below;
  `project-pages` covers the admin render route only (a Builder Epic's own
  authoring stays ungoverned — see [`project-pages/README.md`](project-pages/README.md)).
- **Deliberately NOT owned** (skill-authored docs/artifacts, no write
  hazard): `architecture`, `design-mocks`, `HUMAN_LEARN`, `manual`,
  `reviews`. `feedback` **retired** (2026-08-02).
- **A new top-level folder lands in the table below or `OWNERS` in the
  same PR** — `scripts/ops-sweep.cjs` flags it `UNDOCUMENTED` otherwise.

The bare root has no owner — `opsOwnership.cjs` refuses a write there.

**Purge exception to every retention below:** a human-only purge (`src/main/lib/epic/epicPurge.cjs`,
purge IPC handler only, refused while a job runs) deletes one Epic's files in `prompt-sessions`,
`scheduler`, `plan-records`, `events`, `agents` (unreferenced snapshot), its CLI JSONL and run logs,
each as that namespace's owner, then writes one content-free `epic_purged` audit record. Keep-forever stays the default.

Epic lifecycle is specified exactly once, at
[`prompt-sessions/README.md#lifecycle`](prompt-sessions/README.md#lifecycle)
— not restated here.

| Namespace | Governance | Purpose | Retention | README |
| --- | --- | --- | --- | --- |
| `agents` | OWNERS → agents | write-once AgentSnapshots `snapshots/<id>.json`; runtime, self-ignored | keep forever | none |
| `architecture` | not owned | reference docs | keep | none |
| `design-mocks` | not owned | design mock artifacts | keep | [link](design-mocks/README.md) |
| `events` | OWNERS → event-log | per-Epic event log `<epic-id>/events.jsonl`; runtime, self-ignored | keep forever | none |
| `feedback` | retired 2026-08-02 | former intake | n/a | none |
| `HUMAN_LEARN` | not owned | human-readable knowledge-base pages | keep | [link](HUMAN_LEARN/README.md) |
| `logs` | OWNERS → logs | per-tab JSONL error log | append-only, unpruned | [link](logs/README.md) |
| `manual` | not owned | authoring source for the free Field Manual | keep | [link](manual/README.md), [2.0.0](manual/RELEASE-2.0.0.md) |
| `memory-clusters` | OWNERS → memory-clusters | per-project memory-cluster cache | regenerated on demand | [link](memory-clusters/README.md) |
| `plan-records` | OWNERS → scheduler | validator + ship/deploy records, `<epic-id>/<slug>.md` | `planRecordsDays` after Epic completes (default 14d) | [link](plan-records/README.md) |
| `project-brief` | OWNERS → project-home | synthesized per-project Brief | keep | [link](project-brief/README.md) |
| `project-pages` | OWNERS → project-home (render route only) | generated static Project Page artifacts | regenerated on demand | [link](project-pages/README.md) |
| `prompt-sessions` | OWNERS → epics | durable Epic (PromptSession) store | keep | [link](prompt-sessions/README.md) |
| `reviews` | not owned | frozen review docs; `validation/<epic-id>/` = legacy plan records | keep | [link](reviews/README.md) |
| `scheduler` | OWNERS → scheduler | PRD sources + queue/history state | keep | [link](scheduler/README.md) |
| `tasks` | OWNERS → tasks | runtime Task ledger (headless `claude -p` runs) | `tasksDays`, opsRetentionSettings (default 30d) | [link](tasks/README.md) |
| `ui-prefs` | OWNERS → ui-prefs | per-project UI state | keep | [link](ui-prefs/README.md) |
| `webhooks` | OWNERS → webhooks | loopback-only webhook subscriptions `subscriptions.json` (0600, holds HMAC secrets); runtime, self-ignored | until removed | none |

## Who consumes this

The main process (owned namespaces, via `opsPath()`); skills/humans write
the unowned ones. Each README is the layout contract; the table says who owns it.

## What must NOT be assumed

- Owned-namespace writes and ops-path building: see [domain-model.md#single-writer-law](architecture/domain-model.md#single-writer-law), enforced by `src/main/lib/opsOwnership.cjs`.
- Do not link out with a `file://` URL — it only resolves on one machine.

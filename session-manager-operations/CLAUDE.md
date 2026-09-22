# session-manager-operations/ — scoped context

Part of the **OPERATIONS STATE** partition — see
[`architecture/project-partition.md`](architecture/project-partition.md).

## What's here

14 namespaces, no top-level files. Governance is the **SINGLE-WRITER LAW**
(`src/main/lib/opsOwnership.cjs`): every namespace has exactly ONE owning
writer; everyone else reads. Fail-closed — an undeclared writer throws.
Adding a namespace or writer is a deliberate edit to that file. Build ops
paths only via its `opsPath()`.

- **Owned** (in `OWNERS`, app-owned runtime state): `prompt-sessions` →
  epics · `scheduler` → scheduler · `project-brief` → project-home ·
  `logs` → logs · `bilko-host` → bilko-host · `memory-clusters` →
  memory-clusters · `ui-prefs` → ui-prefs · `project-pages` → project-home
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
| `architecture` | not owned | reference docs root CLAUDE.md links to | keep indefinitely | none |
| `bilko-host` | OWNERS → bilko-host | dist/ bundle prep + publish-state for bilko.run | keep indefinitely | [link](bilko-host/README.md) |
| `design-mocks` | not owned | design mock artifacts, incl. project-pages component library | keep indefinitely | none (nested per-bundle) |
| `feedback` | retired 2026-08-02 | former feedback intake, superseded by New Epic | n/a — retired | [link](feedback/README.md) |
| `HUMAN_LEARN` | not owned | human-readable knowledge-base pages | keep indefinitely | none |
| `logs` | OWNERS → logs | per-tab JSONL error log | append-only, unpruned | [link](logs/README.md) |
| `manual` | not owned | authoring source for the paid Field Manual | keep indefinitely | [link](manual/README.md) |
| `memory-clusters` | OWNERS → memory-clusters | per-project memory-cluster cache | regenerated on demand | [link](memory-clusters/README.md) |
| `project-brief` | OWNERS → project-home | synthesized per-project Brief | keep indefinitely | [link](project-brief/README.md) |
| `project-pages` | OWNERS → project-home (render route only) | generated static Project Page artifacts | regenerated on demand | [link](project-pages/README.md) |
| `prompt-sessions` | OWNERS → epics | durable Epic (PromptSession) store | keep indefinitely | [link](prompt-sessions/README.md) |
| `reviews` | not owned | frozen audit-trail review docs, incl. `validation/<epic-id>/` plan records committed by validator jobs | keep indefinitely | none |
| `scheduler` | OWNERS → scheduler | PRD sources + queue/history state | keep indefinitely | [link](scheduler/README.md) |
| `ui-prefs` | OWNERS → ui-prefs | per-project UI state | keep indefinitely | [link](ui-prefs/README.md) |

## Who consumes this

This app's main process (owned namespaces, via `opsPath()`) and skills/humans
authoring the unowned ones directly with Write. Each namespace's README is
the storage-layout contract; this table only says who owns it.

## What must NOT be assumed

- Do not write into an owned namespace from outside its declared owner —
  `assertOpsWrite` throws fail-closed.
- Do not build an ops-root path by string concatenation — use
  `opsPath()`/`resolveOpsRoot()`.
- Do not link out with a `file://` URL — it only resolves on one machine.

# architecture/ — index

Deliberately **NOT-owned** OPERATIONS STATE namespace: no `OWNERS` entry in `src/main/lib/opsOwnership.cjs`;
authored by skills and agents with plain file operations. Root `CLAUDE.md` holds the one-line laws; the
rationale lives here.

Classes: **LAW-RATIONALE** (linked from root `CLAUDE.md`) · **REFERENCE** (subsystem detail) · **RUNBOOK**
(procedure to follow). `runtime-read` = the app reads the file live, so moving or renaming it breaks a feature.

| doc | covers (one phrase) | class |
| --- | --- | --- |
| [domain-model.md](domain-model.md) | TAB / EPIC / PRD laws, single-writer, mint authority | LAW-RATIONALE |
| [code-map.md](code-map.md) | load-bearing main + renderer files, data flow | LAW-RATIONALE |
| [conventions.md](conventions.md) | conventions + the incident behind each Avoid entry | LAW-RATIONALE |
| [bilko-run-marketing.md](bilko-run-marketing.md) | product page, Stripe checkout, npm listing | LAW-RATIONALE |
| [build-target.md](build-target.md) | build/publish target semantics | LAW-RATIONALE |
| [ops-maintenance-protocol.md](ops-maintenance-protocol.md) | ops-folder drift sweeps | LAW-RATIONALE |
| [project-partition.md](project-partition.md) | the repo's four partitions, path by path | LAW-RATIONALE |
| [host-boundary.md](host-boundary.md) | host-vs-ours boundary and routing rule | LAW-RATIONALE |
| [scheduler-operations.md](scheduler-operations.md) | dispatch, recovery ladder, diagnosis table | LAW-RATIONALE |
| [telemetry.md](telemetry.md) | anonymous telemetry data model and dedup | LAW-RATIONALE |
| [application-menu.md](application-menu.md) | Electron application menu structure | REFERENCE |
| [bilko-host-integration.md](bilko-host-integration.md) | Host-on-Bilko.run tab spec — `runtime-read` via `src/renderer/lib/agentTagDefs.ts` | REFERENCE |
| [heap-snapshot-diagnostics.md](heap-snapshot-diagnostics.md) | renderer heap-snapshot procedure | RUNBOOK |
| [build-target.json](build-target.json) | **live runtime config** read by `src/main/lib/buildTarget.cjs`, `.claude/agents/builder.md` and the builder plugin skill — never move it | — |

## Generated copy

`project-pages-pipeline.md` (`runtime-read`, served via `src/main/lib/projectHomeAdminRoutes.cjs`) is copied
byte-for-byte to `src/main/templates/` by `web/project-pages/assets.cjs` (`npm run build:project-pages-assets`)
and drift-gated by `web/project-pages/publish-gate.cjs` in `prepublishOnly`. Never hand-edit the copy, never
dedupe the pair. (Not yet present in this folder at the time of writing — add its table row when it lands.)

## Rules

1. Dated findings and surveys go to `../reviews/` with the date in the filename.
2. Cite module paths and identifiers, never `file:line` into `src/`.
3. Links are relative to this folder.

# src/ — scoped context

Part of the **DESKTOP HARNESS** partition, except `main/{bilkoHost,bilkoHostCore,projectPages}.cjs`
(**WEB PRESENCE**) — see
[`project-partition.md`](../session-manager-operations/architecture/project-partition.md).

## What's here

- `main/` — Electron main process. Entry modules (`index.cjs`, `scheduler.cjs`, …), `lib/`
  (shared helpers, schemas, guard shims), `scheduler/prdParser.cjs`, `templates/`, `__tests__/`.
- `preload/` — `api.d.ts` is the hand-maintained IPC contract. `main/lib/agentPersonaSchema.cjs`,
  `main/lib/scheduleJobSchema.cjs` and `main/ipcSchemas.cjs` (zod) mirror it by interface
  NAME (`ScheduleJob`, `AgentPersonaSaveInput`, …) — cite names, never line numbers.
- `renderer/` — React app; has its own [`CLAUDE.md`](renderer/CLAUDE.md) (may not exist yet).
- `seed/agents/` — the three personas `main/seedAgentPersonas.cjs` copies to `~/.claude/agents`.
- `../bin/cli.cjs` — the npx launcher.

Per-file rationale:
[`code-map.md`](../session-manager-operations/architecture/code-map.md).

## Who consumes this

The Electron app (main + preload + renderer) and the npm tarball. `seed/agents` reaches user
machines on first boot; `templates/PRD_AUTHORING.md` is seeded into consuming projects.

## What must NOT be assumed

- **`main/templates/` provenance.** `PRD_AUTHORING.md` is hand-edited and version-seeded by its
  line-1 stamp (`<!-- PRD_AUTHORING.md vN -->`) — bump it when content changes, or seeded copies
  never refresh. `project-pages-default-home.html` is hand-maintained.
  (Only `PRD_AUTHORING.md` is present today.)
- **CommonJS only** in `main/` and `preload/` (`.cjs`); no ES modules there.
- **`src/main` never requires from `scripts/`** — tooling depends on the app, not the reverse.
- **Tests in `main/**/__tests__/*.test.cjs` are hand-registered** in `vitest.config.ts`; an
  unlisted file silently never runs. See [`tests/README.md`](../tests/README.md).
- Changing `api.d.ts` means updating the mirroring zod schema by hand; nothing generates it.
- **Main typecheck ratchet**: `tsconfig.main.json` type-checks only its explicit `include` allowlist (files also start with `// @ts-check`, enforced by npm run lint:main-ts-check; `checkJs` is off so transitive requires are not dragged in) — to add a file, list it in `include`, add `// @ts-check`, get `npm run typecheck` green with JSDoc types (no `any`/`@ts-ignore`).

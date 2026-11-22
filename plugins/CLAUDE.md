# plugins/ — scoped context

Part of the **AGENT LAYER** partition — see
[`project-partition.md`](../session-manager-operations/architecture/project-partition.md).

## What's here

`session-manager-dev/skills/` — 4 skills (`builder`, `develop`, `maintaining-md-network`, `send-feedback`); keep in sync with `project-partition.md` and
`seedDevPlugin.cjs`'s header count.

`packs/<id>/` — context packs (plugin + `sm-pack.json` + optional `laws.md`), loaded per session by `--plugin-dir`, not the marketplace; read by `src/main/lib/packs/packCatalog.cjs`.

Two manifests: root [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)
declares the one plugin (`source: "./plugins/session-manager-dev"`); the plugin's own
[`session-manager-dev/.claude-plugin/plugin.json`](session-manager-dev/.claude-plugin/plugin.json)
carries the `description` shown in the marketplace UI — list only shipped skills.
Bumping a plugin's `plugin.json` version requires bumping its entry in `.claude-plugin/marketplace.json` in the same PRD.

`src/main/seedDevPlugin.cjs` is the first-boot offline installer — installs this plugin from its
bundled marketplace (no network) on a fresh machine, then marks
`~/.claude/session-manager/.dev-plugin-seeded`.
Claude Code loads it in place from the registered marketplace's source folder (the app's package root), never the `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` snapshots: skill edits ship with app updates; a `plugin.json` bump only refreshes the shown version.

**`skills/develop/standards.md` is a frozen absolute-path contract.** Every scheduler PRD in
every consuming repo points its headless executor at it by resolved absolute path, baked
in at authoring time — including PRDs already archived in OTHER repos. Renaming or moving it
breaks them all, undetectably from here.

**Path literals inside shipped skills.** A skill runs in OTHER repos, so a
session-manager-internal path (`src/main/...`, `src/renderer/...`, bare `scripts/...`) inside one
is a portability defect unless `$SM_ROOT`-qualified (`$SM_ROOT` = installed
package root, e.g. `node "$SM_ROOT/scripts/<x>.cjs"`) or removed. `builder/manual.md` is session-manager-specific on
purpose and runs only when `session-manager-operations/manual/manual.json` exists.

## Who consumes this

**Other repos**, not (only) this one. A project installs `claude-code-session-manager` from npm,
or references its skills/hooks directly.
Editing a skill here changes behavior in every consuming repo. See
[`../session-manager-operations/reviews/2026-09-12-agent-layer-consumers.md`](../session-manager-operations/reviews/2026-09-12-agent-layer-consumers.md)
for live consumers.

## What must NOT be assumed

- Treat every skill edit here as a cross-repo API change.
- Do not vendor `scripts/hooks/guard-*.cjs` into a skill/repo — adopt **by reference** via the
  stable shim (`src/main/lib/guardShims.cjs`) at `~/.claude/session-manager/hooks/guard-*.cjs`,
  never this repo's own absolute path or a copy.
- Do not confuse this with `.claude/` at the repo root — this repo's own unshipped local dev
  config. `.claude/agents/*.md` are per-project OVERLAYS that win over
  `~/.claude/agents/*.md` (Claude Code's own precedence, per `src/main/agentLibrary.cjs`);
  `src/seed/agents/` is the shipped source for the personas
  `src/main/seedAgentPersonas.cjs` copies into `~/.claude/agents/` (its `PERSONAS` list);
  `builder` has no seed source — the generic `~/.claude/agents/builder.md` is machine-local
  and this repo's `.claude/agents/builder.md` overlays it. Tracked under `.claude/`:
  `settings.json` (guard hooks), `agents/builder.md`, and the `agents/page-*.md` stewards.
- The scheduler MCP server (`session-manager-scheduler`) is registered at USER scope in
  `~/.claude.json`, not in this repo.
- A skill may run headless via a scheduled PRD in another project — don't rely on
  interactive-session-only features; check `/develop`'s scheduler flow first.

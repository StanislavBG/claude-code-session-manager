# plugins/ — scoped context

Part of the **AGENT LAYER** partition — see
[`project-partition.md`](../session-manager-operations/architecture/project-partition.md).

## What's here

`session-manager-dev/skills/` — 15 skills (`blog-for-project-feature`, `builder`, `develop`,
`discover-features`, `explain-to-me`, `find-opportunity`, `issue-address`,
`local-project-health`, `memory-sanitation`, `ops-sweep`, `project-status`, `pr-review-sweep`,
`pr-signal`, `requesting-code-review`, `send-feedback`) — verified against `ls
plugins/session-manager-dev/skills` 2026-09-13; keep in sync with `project-partition.md` and
`seedDevPlugin.cjs`'s header count.

Two manifests: root [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)
declares the one plugin (`source: "./plugins/session-manager-dev"`); the plugin's own
[`session-manager-dev/.claude-plugin/plugin.json`](session-manager-dev/.claude-plugin/plugin.json)
carries the `description` shown in the marketplace UI — list only shipped skills.

`src/main/seedDevPlugin.cjs` is the first-boot offline installer — installs this plugin from its
bundled marketplace (no GitHub/registry call) as a default on a fresh machine, then marks
`~/.claude/session-manager/.dev-plugin-seeded`.

**`skills/develop/standards.md` is a frozen absolute-path contract.** Every scheduler PRD, in
every consuming repo, points its headless executor at it by resolved absolute path, baked
in at authoring time — including PRDs already archived in OTHER repos. Renaming or moving it
breaks them all, undetectably from here.

**Path literals inside shipped skills.** A skill runs in OTHER repos, so a
session-manager-internal path (`src/main/...`, `src/renderer/...`, bare `scripts/...`) inside one
is a portability defect unless `$SM_ROOT`-qualified (see `ops-sweep/SKILL.md`'s resolution) or
removed. Current offenders, not precedent: `memory-sanitation/SKILL.md`, `builder/SKILL.md` +
`builder/0-diff/SKILL.md`, `develop/SKILL.md`, `develop/standards.md`, `ops-sweep/SKILL.md`.

## Who consumes this

**Other repos**, not (only) this one. A project installs `claude-code-session-manager` from npm,
or references its skills/hooks directly, for the same dev workflow session-manager uses on itself.
Editing a skill here changes behavior in every consuming repo. See
[`../session-manager-operations/reviews/2026-09-12-agent-layer-consumers.md`](../session-manager-operations/reviews/2026-09-12-agent-layer-consumers.md)
for live sibling consumers.

## What must NOT be assumed

- Treat every skill edit here as a cross-repo API change, not a local-only one.
- Do not vendor `scripts/hooks/guard-*.cjs` into a skill/repo — adopt **by reference** via the
  stable shim (`src/main/lib/guardShims.cjs`) at `~/.claude/session-manager/hooks/guard-*.cjs`,
  never this repo's own absolute path or a copy.
- Do not confuse this with `.claude/` at the repo root — this repo's own unshipped local dev
  config. `.claude/agents/*.md` are per-project OVERLAYS that win over
  `~/.claude/agents/*.md` (Claude Code's own precedence, per `src/main/agentLibrary.cjs`);
  `src/seed/agents/` is the shipped source for exactly the three personas
  `src/main/seedAgentPersonas.cjs` copies into `~/.claude/agents/` on first boot (`architect`,
  `dev-lead`, `project-home-builder`); `builder` and `bilko-host-publisher` have no seed source
  and exist only as this repo's overlays. Tracked on purpose: `.claude/settings.json` (guard
  hooks) plus the `builder.md`/`project-home-builder.md` overlays (auditable edits) —
  `bilko-host-publisher.md` is untracked despite being in use; nothing else under `.claude/` is.
- `.mcp.json` at the repo root registers only `bilko-host` — the scheduler MCP server
  (`session-manager-scheduler`) is registered at USER scope in `~/.claude.json`, not here.
- A skill may run headless via a scheduled PRD in another project — don't rely on
  interactive-session-only features; check `/develop`'s scheduler flow first.

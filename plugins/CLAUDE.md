# plugins/ — scoped context

Part of the **AGENT LAYER** partition — see
[`project-partition.md`](../session-manager-operations/architecture/project-partition.md).

## What's here

`session-manager-dev/skills/` — 15 skills (`blog-for-project-feature`, `builder`, `develop`,
`discover-features`, `explain-to-me`, `find-opportunity`, `issue-address`,
`local-project-health`, `memory-sanitation`, `ops-sweep`, `project-status`, `pr-review-sweep`,
`pr-signal`, `requesting-code-review`, `send-feedback`). This is the `session-manager-dev`
Claude Code plugin, shipped in `package.json`'s `files` array and registered via
`.claude-plugin/`.

## Who consumes this

**Other repos**, not (only) this one. A project installs `claude-code-session-manager` from
npm, or references this repo's skills/hooks directly, to get the same dev workflow (PRD
authoring, scheduler, code review chains) that session-manager itself uses to develop
session-manager. Editing a skill here changes behavior in every consuming repo the next time
it updates, not just this one. See
[`../session-manager-operations/reviews/2026-09-12-agent-layer-consumers.md`](../session-manager-operations/reviews/2026-09-12-agent-layer-consumers.md)
for which sibling repos are live consumers today.

## What must NOT be assumed

- Do not assume a skill change here only affects this repo — treat every edit as a
  cross-repo API change.
- Do not vendor a copy of `scripts/hooks/guard-*.cjs` into a skill or another repo. Those hooks
  are adopted **by reference** via a stable shim (`src/main/lib/guardShims.cjs`) at
  `~/.claude/session-manager/hooks/guard-*.cjs` — never this repo's own absolute path (see root
  `CLAUDE.md`'s Scheduler section) — and never copy the guard scripts themselves.
- Do not confuse this with `.claude/` at the repo root — that is this repo's *own* local dev
  config for developing session-manager itself, not part of what ships to other projects.
- Do not assume a skill here can rely on interactive-session-only features when it may run
  headless via a scheduled PRD in another project — check whether the skill is meant to run
  inside `/develop`'s scheduler flow before adding an interactive-only dependency.

---
title: Add "build" Epic tag + per-project build-target config schema
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msase2q4-1
---
# Goal

Extend the Epic intent-tag union from `'feature' | 'bug' | 'discussion'` to include `'build'`, and introduce a per-project "build target" config file that names the known publish destination for `build`-tagged Epics (npm today, extensible later). This is the foundation PRD other Builder-feature PRDs in this Epic depend on — it does NOT add any UI, just the type/schema plumbing and the config file + a reader helper.

# Acceptance criteria

- [ ] `'build'` added to the tag union in all 3 known sites: `src/renderer/lib/prdFrontmatter.ts:36`, `src/renderer/state/promptSessions.ts:50` (both `'feature' | 'bug' | 'discussion'` → add `| 'build'`), and `src/main/ipcSchemas.cjs:316` (`z.enum(['feature','bug','discussion'])` → add `'build'`)
- [ ] `grep -rn "'feature' | 'bug' | 'discussion'\|feature.*bug.*discussion" src/renderer/` also turns up `src/renderer/lib/ticketDisplay.ts` and `src/renderer/lib/epicQueueControls.ts` — read both, and add 'build' wherever they branch on the tag union (display label, icon/color mapping, etc.) so a build-tagged Epic renders correctly everywhere a feature/bug/discussion Epic already does, not just in the type
- [ ] New file `session-manager-operations/architecture/build-target.json` created in THIS repo (session-manager) as the worked example/schema instance, per CLAUDE.md's documented carve-out that `architecture/` is a skill-authored doc folder, not an OWNERS-governed runtime-write namespace — do not route this write through config.cjs's writeJson/opsOwnership machinery. Shape: `{ "registry": "npm", "packageName": "claude-code-session-manager", "versionBumpPolicy": "conventional-commits", "gates": ["typecheck", "test:unit"] }`
- [ ] New reader helper `src/main/lib/buildTarget.cjs` exporting `resolveBuildTarget(cwd)`: reads `<cwd>/session-manager-operations/architecture/build-target.json` if present; if absent, attempts auto-discovery — read `<cwd>/package.json`, and if it has a non-empty `name` and is not `"private": true`, return `{ registry: 'npm', packageName: <name>, versionBumpPolicy: 'conventional-commits', gates: [], discovered: true }`; otherwise return `null`. Pure function, no npm-registry network call inside it (that stays the caller's job) — this only reads local files.
- [ ] Unit test `src/main/lib/__tests__/buildTarget.test.cjs` (or `.spec.cjs` matching this repo's existing naming — check an existing `src/main/lib/__tests__/*.cjs` file for the convention first) covering: explicit config file present → returned verbatim; no config file but package.json has name + not private → auto-discovered result; no config file and package.json is private or missing → null
- [ ] `timeout 120 npx vitest run src/main/lib/__tests__/buildTarget.test.cjs` passes
- [ ] `timeout 300 npm run typecheck` passes

# Implementation notes

This repo's own commits are the reference example for `versionBumpPolicy: 'conventional-commits'` — recent history includes `fix(scope): ...`, `feat(scope): ...`, `docs(scope): ...`, `chore(scope): ...` prefixes, consistent with fix→patch, feat→minor pattern. Don't build the bump-decision logic itself in this PRD — that's the Builder skill PRD's job; this PRD only needs the config to be readable. Follow this repo's existing `src/main/lib/*.cjs` module style (see `src/main/lib/prdLocations.cjs` or `src/main/lib/sessionSlots.cjs` for the plain-CJS-module, no-class convention already used here). Do not wire this into any IPC handler yet — that happens in the PRDs that need it (Epic Queue button PRD, agent-docs-refresh PRD).

# Out of scope

- Any UI (Agent Library, Tag Library, Epic Queue button) — separate PRDs in this same Epic
- Registries other than npm
- Auto-bump/publish execution logic — that's the Builder skill package PRD
- Wiring buildTarget.cjs into any renderer-facing IPC call

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: Agent Library — new Home-tab nav page listing available agent personas
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: psess-msase2q4-1
---
# Goal

Add a new "Agent Library" read-only nav page reachable from the Home-Tab's left sidebar, listing every available agent persona: the global definitions in `~/.claude/agents/*.md` (name, description, tools, frontmatter), and for each currently-open project TAB, whether that project has a local overlay of the same name at `<tab-cwd>/.claude/agents/<name>.md` (which per Claude Code's own precedence rules overrides the global definition when both exist). This makes the two-layer agent system (global default + per-project overlay) visible in the app for the first time — today it's file-system-only with no UI.

# Acceptance criteria

- [ ] New `NavKey` literal `'agent-library'` added to the union in `src/renderer/components/LeftNav.tsx` (follow the file's own instructions in its header comment: append the literal, add it to `SCREEN_KEYS` in `src/renderer/lib/screenKeys.ts`, then handle it in `src/renderer/components/screenComponents.tsx`'s `renderScreenComponent` switch)
- [ ] New entry added to `NAV_ITEMS` in `src/renderer/lib/navGroups.ts`: `{ key: 'agent-library', group: 'Configure', label: 'Agent Library', icon: <pick an existing AlmanacIconName that reads as 'agent/persona' — inspect `src/renderer/components/layout/AlmanacIcon.tsx` for the available icon set, reuse one rather than adding a new icon glyph unless truly none fit>, hint: 'Agent personas available to this machine, and which projects override them', faces: HOME }` (HOME-only: this is cross-project/global data, not per-project)
- [ ] New component `src/renderer/components/tabs/AgentLibrary.tsx` follows the canonical list+detail shape already established by `src/renderer/components/tabs/Skills.tsx` (per this repo's own CLAUDE.md: 'components/tabs/Skills.tsx — canonical list+detail shape. Other list tabs (Hooks, McpServers, Plugins) follow it.') — read Skills.tsx first and mirror its list/detail/data-fetch pattern rather than inventing a new one
- [ ] New main-process IPC handler (in `src/main/index.cjs`, alongside the existing `app:*` handlers) e.g. `agents:list-personas`: globs `~/.claude/agents/*.md`, parses each file's YAML frontmatter (name/description/tools) using whatever frontmatter-parsing utility this repo already uses elsewhere for skills/PRDs (check `src/main/scheduler/prdParser.cjs` or similar before adding a new YAML parser dependency), and for each currently-open TAB (read from wherever the renderer/main process already tracks open tab cwds — check `sessionsStore.cjs`), stats `<tab-cwd>/.claude/agents/<name>.md` for each global agent name to report an `overridingProjects: string[]` list per agent
- [ ] Corresponding preload bridge method added in `src/preload/index.cjs` + its type in `src/preload/api.d.ts`, following the existing pattern for a similar read-only list call (e.g. how `app:home-self-check` or a Skills-tab IPC call is bridged)
- [ ] Renders correctly with the `builder` agent already present (both the global `~/.claude/agents/builder.md` and this repo's own `.claude/agents/builder.md` overlay exist right now — this is a real, live test case: Agent Library should show `builder` with session-manager listed under `overridingProjects`)
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run` targeted at any new test file for this component/IPC passes (add a minimal test following this repo's existing `.navface.test.tsx` or component-test convention — check an existing tab's `__tests__/` folder for the pattern)

# Implementation notes

Read `src/renderer/components/tabs/Skills.tsx` AND `src/renderer/lib/navGroups.ts` AND `src/renderer/components/LeftNav.tsx`'s header comment before starting — the exact 3-step "adding a NavKey" process is documented there verbatim. `~/.claude/session-manager/agent-memory/<agentId>.json` (see `src/main/ipcSchemas.cjs` around the `AGENT_MEMORY_*` schemas, ~line 490) is a related but distinct existing feature (per-subagent memory) — do not conflate; this PRD is read-only persona listing, not memory. This is a v1 read-only viewer — no editing, no create/delete.

# Out of scope

- Editing or creating agent .md files from the UI
- Per-agent memory display (separate existing feature, agentMemory.cjs)
- Per-project (non-Home) view of this data — HOME face only for v1

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: "Nav face: tag Memory as project-only (workspace scope), note subagent-scope Home gap"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 12
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Tag the 'memory' nav destination (`src/renderer/components/tabs/Memory.tsx` ~lines 30-42, 63-66,
115-116) as project-only in the two-face registry landed by `leftnav-two-face-framework`, since
its primary "Workspace" scope is cwd-keyed (`~/.claude/projects/<encoded-cwd>/memory/`). Memory
also has a "Subagent" scope which is agentId-keyed and global — this PRD does NOT build a
Home-face surface for it (that is deliberately left as a follow-up, noted in Out of scope); it
only ensures the tab behaves correctly when only reachable via Project face.

# Acceptance criteria

- [ ] Confirm/add `faces: ['project']` for the `memory` key in `src/renderer/lib/navGroups.ts`
      NAV_ITEMS
- [ ] New/updated unit test asserts `getNavItemsForFace('home')` excludes `memory` and
      `getNavItemsForFace('project')` includes it
- [ ] Grep Memory.tsx to confirm its "Workspace" scope gracefully handles a resolvable
      `activeTab.cwd` (guaranteed by Project face) — no crash-guard code needed if it already
      requires a cwd to render
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the updated test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts / faces field / getNavItemsForFace — read
current state of navGroups.ts first. Do not build a Home-face "Subagent" memory browser in this
PRD — that is out of scope, tracked as a follow-up idea only.

# Out of scope

- A Home-face surface for the global "Subagent" memory scope (follow-up idea, not built here)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

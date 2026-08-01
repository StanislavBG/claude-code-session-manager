---
title: "Nav face: Scheduler both-face with home=all-projects, project=this-project default"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Wire the Scheduler tab's existing `'project' | 'all'` scope state
(`src/renderer/components/tabs/Scheduler.tsx` ~lines 86-90, 177-192) to default from the NavFace
landed by `leftnav-two-face-framework`: `'all'` when reached via Home face, `'project'` (active
tab's cwd) when reached via Project face — without removing the user's existing manual toggle,
and without overriding a manual choice on every re-render.

# Acceptance criteria

- [ ] Confirm/add `faces: ['home','project']` for the `scheduler` key in
      `src/renderer/lib/navGroups.ts` NAV_ITEMS
- [ ] Scheduler.tsx computes navFace via `deriveNavFace` and, only on an actual face transition
      (not on every render), sets its existing project/all scope state to the corresponding
      default if the user has not manually changed it since the last transition
- [ ] A manual scope toggle by the user survives re-renders at the same navFace
- [ ] New unit test: mount at navFace='home' -> scope defaults 'all'; navFace flips to 'project'
      with a cwd -> scope becomes 'project'; manual override is not reset by a same-face
      re-render
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the new/updated Scheduler test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts. Reuse the exact same
auto-default-unless-manually-touched pattern as sibling PRDs 875-nav-face-epics-terminal and
879-nav-face-history — do not invent a different mechanism; a ref flag set inside the existing
scope-change handler is sufficient. Do not touch scheduleState.ts's global job/history data
model, only Scheduler.tsx's default-scope derivation.

# Out of scope

- scheduleState.ts data-model changes

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

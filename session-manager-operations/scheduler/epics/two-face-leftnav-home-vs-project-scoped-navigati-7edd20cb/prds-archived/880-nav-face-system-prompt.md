---
title: "Nav face: System Prompt both-face, default scope flips user<->project"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Make the System Prompt tab (`src/renderer/components/tabs/SystemPrompt.tsx`, dual-scope via
`CLAUDE_MD_SCOPES` in `src/renderer/lib/scopes.ts` ~lines 42-51) default its existing scope
switcher to `'user'` when reached via Home face and `'project'` (falling back to `'user'` if no
active-tab cwd) when reached via Project face, using the NavFace landed by
`leftnav-two-face-framework`. The scope switcher itself is unchanged — this only changes the
initial/default value and re-applies it on an actual face transition, never overriding a manual
choice made since the last transition.

# Acceptance criteria

- [ ] Confirm/add `faces: ['home','project']` for the `system-prompt` key in
      `src/renderer/lib/navGroups.ts` NAV_ITEMS
- [ ] SystemPrompt.tsx computes navFace via `deriveNavFace` (using `useLayout()`'s
      focusedPanelId and `useSessions()`'s active-tab presence) and, only on an actual face
      transition with no manual scope change since, sets scope to `'user'` (home) or `'project'`
      (project face, if `activeTab?.cwd` resolves; else stays `'user'`)
- [ ] A manual scope-switcher change by the user survives re-renders at the same navFace
- [ ] New unit test: mount at navFace='home' -> scope defaults 'user'; navFace flips to
      'project' with a cwd -> scope becomes 'project'; navFace flips to 'project' with no cwd ->
      scope stays 'user'; manual override survives a same-face re-render
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the new/updated SystemPrompt test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts. This is one of six near-identical
dual-scope PRDs in this epic (system-prompt, skills, mcp, hooks, permissions, settings) — use
the same auto-default-unless-manually-touched pattern in each (a ref flag set inside the
existing scope-change handler), but implement and test this PRD independently; do not assume the
others have landed yet. Read `src/renderer/lib/scopes.ts`'s `CLAUDE_MD_SCOPES` and its
`resolve(scope, home, cwd)` before changing anything.

# Out of scope

- Changing the ScopeSwitcher UI component itself or the CLAUDE_MD_SCOPES resolve() signature

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

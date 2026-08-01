---
title: "Nav face: Settings both-face, default scope flips user<->project"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Make the Settings tab (`src/renderer/components/tabs/Settings.tsx` ~lines 23-33, dual-scope
`'user' | 'project' | 'local'` via `SETTINGS_SCOPES` in `src/renderer/lib/scopes.ts` ~lines
42-49) default its existing scope switcher to `'user'` when reached via Home face and
`'project'` (falling back to `'user'` if no active-tab cwd) when reached via Project face, using
the NavFace landed by `leftnav-two-face-framework`. The scope switcher itself is unchanged —
this only changes the initial/default value and re-applies it on an actual face transition,
never overriding a manual choice made since the last transition.

# Acceptance criteria

- [ ] Confirm/add `faces: ['home','project']` for the `settings` key in
      `src/renderer/lib/navGroups.ts` NAV_ITEMS
- [ ] Settings.tsx computes navFace via `deriveNavFace` and, only on an actual face transition
      with no manual scope change since, sets scope to `'user'` (home) or `'project'` (project
      face, if `activeTab?.cwd` resolves; else stays `'user'`)
- [ ] A manual scope-switcher change by the user survives re-renders at the same navFace
- [ ] New unit test: mount at navFace='home' -> scope defaults 'user'; navFace flips to
      'project' with a cwd -> scope becomes 'project'; navFace flips to 'project' with no cwd ->
      scope stays 'user'; manual override survives a same-face re-render
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the new/updated Settings test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts. One of six near-identical dual-scope PRDs
in this epic — use the same auto-default-unless-manually-touched pattern, but implement and test
this PRD independently. Settings.tsx's monaco jsonDefaults + schemastore.org validation is
untouched by this PRD — do not add hand-rolled zod validation per this repo's convention.

# Out of scope

- Changing the ScopeSwitcher UI component itself or settings.json monaco validation

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

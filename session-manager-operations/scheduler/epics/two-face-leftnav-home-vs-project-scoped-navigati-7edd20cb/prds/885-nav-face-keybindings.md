---
title: "Nav face: tag Keybindings as home-only"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 8
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
dependsOn: [leftnav-two-face-framework]
---
# Goal

Confirm the 'keybindings' nav destination (`src/renderer/components/tabs/Keybindings.tsx`,
global-only — `~/.claude/keybindings.json`, no project scope in `KEYBINDINGS_SCOPES`) is tagged
home-only in the two-face registry landed by `leftnav-two-face-framework`, and add a regression
test. No component change is expected.

# Acceptance criteria

- [ ] Confirm `faces: ['home']` for the `keybindings` key in `src/renderer/lib/navGroups.ts`
      NAV_ITEMS (added by leftnav-two-face-framework; add if missing)
- [ ] New/updated unit test asserts `getNavItemsForFace('project')` excludes `keybindings` and
      `getNavItemsForFace('home')` includes it
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the updated test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts / faces field / getNavItemsForFace — read
current state of navGroups.ts first. `src/renderer/lib/scopes.ts`'s `KEYBINDINGS_SCOPES`
(~line 69) already has no project scope entry — confirm this PRD doesn't need to touch
scopes.ts at all.

# Out of scope

- Any change to KEYBINDINGS_SCOPES or Keybindings.tsx behavior

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

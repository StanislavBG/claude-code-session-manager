---
title: "Nav face: tag Web Remote as home-only"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 10
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Confirm the 'remote' nav destination (`src/renderer/components/tabs/WebRemote.tsx`, machine-level
pairing/device state, no cwd reference) is tagged home-only in the two-face registry landed by
`leftnav-two-face-framework`, and add a regression test. No component change is expected.

# Acceptance criteria

- [ ] Confirm `faces: ['home']` for the `remote` key in `src/renderer/lib/navGroups.ts`
      NAV_ITEMS (added by leftnav-two-face-framework; add if missing)
- [ ] Grep WebRemote.tsx for any activeTab/cwd reference; if none exists, no code change needed
      beyond the tag; if one is found and would crash with no active project tab, add a guard as
      the only additional change
- [ ] New/updated unit test asserts `getNavItemsForFace('project')` excludes `remote` and
      `getNavItemsForFace('home')` includes it
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the updated test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts / faces field / getNavItemsForFace — read
current state of navGroups.ts first. This is a small verification PRD; do not add new Web Remote
features.

# Out of scope

- New Web Remote features

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

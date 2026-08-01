---
title: "Nav face: tag Voice as home-only"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 8
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Confirm the 'voice' nav destination (`src/renderer/components/layout/VoiceModal.tsx`, rendered
`variant="page"`, device/mic settings, machine-level) is tagged home-only in the two-face
registry landed by `leftnav-two-face-framework`, and add a regression test. No component change
is expected.

# Acceptance criteria

- [ ] Confirm `faces: ['home']` for the `voice` key in `src/renderer/lib/navGroups.ts`
      NAV_ITEMS (added by leftnav-two-face-framework; add if missing)
- [ ] Grep VoiceModal.tsx's `variant="page"` render path for any activeTab/cwd reference; if
      none exists, no code change needed beyond the tag
- [ ] New/updated unit test asserts `getNavItemsForFace('project')` excludes `voice` and
      `getNavItemsForFace('home')` includes it
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the updated test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts / faces field / getNavItemsForFace — read
current state of navGroups.ts first. Do not touch VoiceModal's modal-variant rendering path,
only the `variant="page"` full-screen path used as a nav destination.

# Out of scope

- Voice feature changes beyond the face tag

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

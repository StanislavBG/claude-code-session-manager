---
title: "Nav face: tag Session-Manager Config as home-only (anchor for new global controls)"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 12
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Confirm the 'sm-config' nav destination
(`src/renderer/components/tabs/SessionManagerConfig.tsx`, explicitly global/machine-level by
design per its own header comment) is tagged home-only in the two-face registry landed by
`leftnav-two-face-framework`, and add a regression test. This PRD is a small verification pass;
it deliberately does NOT add new UI — sibling PRDs 894-home-global-controls-dashboard and
895-home-global-behavior-settings (in this same epic) build new content inside this tab and
depend on this PRD being done first so its face-tagging and layout anchor points are stable.

# Acceptance criteria

- [ ] Confirm `faces: ['home']` for the `sm-config` key in `src/renderer/lib/navGroups.ts`
      NAV_ITEMS (added by leftnav-two-face-framework; add if missing)
- [ ] New/updated unit test asserts `getNavItemsForFace('project')` excludes `sm-config` and
      `getNavItemsForFace('home')` includes it
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the updated test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts / faces field / getNavItemsForFace — read
current state of navGroups.ts first. Do not add any new sections to SessionManagerConfig.tsx in
this PRD — that is explicitly deferred to sibling PRDs 894 and 895 so this tagging PRD stays
small and unblocks them quickly.

# Out of scope

- New Global Controls dashboard content (894-home-global-controls-dashboard)
- New global behavior preference toggles (895-home-global-behavior-settings)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: Build button: right-click / advanced-options opens Chat discussion instead of auto-firing
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msase2q4-1
---
# Goal

The Epic Queue's "Build" toolbar button (`BuildButton` in `src/renderer/components/epics/EpicQueue.tsx`, added by PRD 921) currently has exactly one behavior on click: create a fresh `build`-tagged Epic and immediately auto-send the fixed `BUILD_GOAL_TEXT` prompt through `useChat().send()`, running headlessly with no human review. Add a second entry point — right-click on the Build button, or a small adjacent "advanced options" affordance — that creates the same fresh `build`-tagged Epic but does NOT auto-send the prompt: instead it opens straight into that Epic's Chat view (Chat and Terminal are two views over one Epic session per this project's domain model, so this is a legitimate discussion surface, not a hack) with the composer pre-filled with the same `BUILD_GOAL_TEXT` text, editable, unsent — letting the user discuss/adjust before running anything. Both paths mint a genuinely fresh Epic/session either way (the "fresh agent" requirement from the original Build button PRD is unaffected); the only difference is whether the opening prompt auto-fires or waits in the composer for a human to send or edit it.

# Acceptance criteria

- [ ] `BuildButton` (`EpicQueue.tsx`, currently defined ~line 42) gains a right-click (`onContextMenu`, `e.preventDefault()`) handler that runs a new `handleAdvanced` path instead of the existing `handleClick`'s auto-send behavior
- [ ] A small visible secondary trigger (e.g. a caret/chevron button immediately to the right of the existing 'Build' button, matching the visual weight of the existing `RowMenuButton` trigger at `EpicQueue.tsx:409`) also reaches the same advanced path — right-click alone is not discoverable enough on its own, per this repo's own existing pattern of pairing a menu trigger button with right-click where applicable
- [ ] `handleAdvanced` performs the same Epic-creation sequence as `handleClick` (`composeEpicIntake({ title: '', goal: BUILD_GOAL_TEXT, tag: 'build' })`, `createPromptSession(activeTabCwd, goalText, 'build', 'proposed')`, `approveProposed(session.id)`, then `onSelect(session.id)`) but SKIPS the `useChat.getState().send(...)` call — the Epic is created and selected/opened, landing the user in its Chat view with an empty or unsent composer
- [ ] The composer for a freshly-created, not-yet-sent Epic is pre-filled with `BUILD_GOAL_TEXT` as EDITABLE draft text (not sent) — find the actual chat composer component (check how `EpicComposer.tsx` or the Chat panel's input state works, e.g. a `draftText` prop/store field) and wire the pre-fill through whatever mechanism it already uses for restoring/seeding composer text, rather than inventing a new one
- [ ] Both the quick-fire (left-click) and advanced (right-click / caret) paths are covered by tests in `src/renderer/components/epics/__tests__/EpicQueue.test.tsx` (created by PRD 921, extend it): quick path still auto-sends via `useChat().send`; advanced path creates+selects the Epic and does NOT call `useChat().send`, and the composer/draft state ends up containing `BUILD_GOAL_TEXT`
- [ ] Tooltip/title text distinguishes the two triggers so a user hovering either one understands the difference (e.g. the caret's title reads something like 'Discuss before running' vs. the main button's existing 'Start a fresh Epic that checks git vs the published package and publishes if there's anything new')
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run src/renderer/components/epics/__tests__/EpicQueue.test.tsx` passes

# Implementation notes

Read the current `BuildButton` implementation in full first (`EpicQueue.tsx`, the `handleClick` function and its surrounding component) — this PRD adds a sibling path, not a rewrite. Also read `RowMenu`/`MenuItem`/`RowMenuButton` (`EpicQueue.tsx:139` onward) for the exact visual/interaction pattern this repo already uses for anchor-positioned dropdowns and secondary trigger buttons — reuse that component rather than building a new menu primitive; a right-click context menu with one item ("Discuss first") anchored at the click point, or reusing `RowMenu` anchored to the caret button, are both reasonable — pick whichever requires less new code given `RowMenu`'s actual props (it takes `anchor: HTMLElement`, so for a right-click-at-cursor variant either extend it to accept a point anchor or just call the advanced path directly with no menu at all, since there's only one advanced action right now — don't over-build a whole menu for a single option). Check `EpicComposer.tsx` and `state/chat.ts` for how draft/unsent composer text is currently represented before adding a new field.

# Out of scope

- Multiple advanced options beyond 'discuss first' — this PRD is exactly one alternative path, not a general options menu
- Changing the quick-fire (left-click) behavior at all
- Any change to the /builder skill itself or the agent files

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

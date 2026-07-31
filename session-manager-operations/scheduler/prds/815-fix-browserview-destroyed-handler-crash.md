---
title: Fix browserView.cjs destroyed-handler crash on quit
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

`src/main/browserView.cjs`'s webContents `'destroyed'` handler (around line 226-232)
dereferences `view.webContents.id` INSIDE the callback, after `view.webContents` may
already be undefined, causing `Cannot read properties of undefined (reading 'id')`
on every app quit with an open Browser view (confirmed in real crash logs — see
`session-manager-operations/feedback/processed/2026-07-30-rca-v0390-blank-screen-unstable-selector-185.md`,
follow-up item 4). Fix by capturing the id at creation time, before it can go stale.

# Acceptance criteria

- [ ] Capture `const wcId = view.webContents.id` immediately when the view/webContents
      is created (before `view.webContents.once('destroyed', ...)` is registered), and
      use `wcId` instead of `view.webContents.id` everywhere inside the destroyed-handler
      body.
- [ ] The destroyed-handler callback body no longer reads any `view.webContents.*`
      property — only the pre-captured `wcId`.
- [ ] Add or extend a unit test (check `src/main/__tests__` for existing browserView
      coverage) that simulates the `'destroyed'` event firing after `view.webContents`
      is undefined/null, asserting the handler does not throw.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <the browserView test file>` passes.

# Implementation notes

File: `src/main/browserView.cjs`. Search for
`browserViewContentsIds.add(view.webContents.id)` (around line 226) and the
`view.webContents.once('destroyed', ...)` registration right after it (lines ~230-232),
plus a second cleanup site around line 274-275 that also reads `view.webContents.id`
directly — check whether that second site also needs the captured variable or is
called synchronously before webContents can be destroyed (read the surrounding
function to confirm). Pattern:
```js
const wcId = view.webContents.id
browserViewContentsIds.add(wcId)
contentsIdToViewId.set(wcId, viewId)
view.webContents.once('destroyed', () => {
  browserViewContentsIds.delete(wcId)
  contentsIdToViewId.delete(wcId)
})
```

# Out of scope

- Any other browserView.cjs refactoring beyond this specific crash fix.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that
apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded
commands, verify before done, the finish-protocol sentinel).

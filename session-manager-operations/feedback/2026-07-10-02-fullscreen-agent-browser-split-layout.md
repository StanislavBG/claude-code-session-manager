---
title: Add a full-screen mode with agent transcript (left) + Browser tab (right) side by side
source: bilko (via sigma project, /my-feedback)
type: enhancement
severity: normal
---

# What happens / what's missing

Today `MainPane` renders exactly one screen at a time — see the comment in
`src/renderer/components/tabs/Browser.tsx:34-36`:

```
// Stable across nav-state broadcasts (loading/title updates re-create the
// `tabs` array reference on every event) — only changes on tab
// open/close/reorder, which is what show/hide + bounds-sync should react to.
```

and the file's own header comment: *"MainPane renders exactly one screen at a
time (see project convention: keybindings only wired while the owning nav tab
is mounted)."* There is no split layout that shows an agent's live transcript
(`AgentView`, per `src/renderer/components/layout/SectionFrame.tsx:9`, "the
pane (Terminal + AgentView do the same)") next to the **Browser** tab
(`src/renderer/components/tabs/Browser.tsx`) at the same time, and no
full-screen toggle for that combined view. `grep -rn "[Ff]ullscreen"
src/renderer` returns nothing in this codebase today — the concept doesn't
exist yet in the renderer.

This matters because the whole point of the Browser tab's `ActionBar`
("Hand this page to the agent →", `src/renderer/components/tabs/browser/ActionBar.tsx:20`)
is a live agent+browser workflow — watching the agent drive the browser and
react in real time is far more useful side by side than tabbing between two
full-width single-pane screens.

# Evidence

- Reference screenshot (mockup of the desired layout, not a session-manager
  capture — a sibling AI coding tool's UI, provided as the layout target):
  `/tmp/session-manager-clipboard/clipboard-1783743772911.png`. It shows:
  - **Left pane**: agent chat/transcript (conversation "Checkout shipping
    step", a running task list, a command input at the bottom).
  - **Right pane**: browser preview (tabbed address bar, page content).
  - **Top strip above each pane**: window/action controls — on the left pane:
    hamburger menu, a device/preview icon, the conversation title, then
    share/export, terminal, edit, and play icons on the right edge of that
    strip; on the right pane: browser tabs, then a tab-list icon, overflow
    menu, native fullscreen toggle, and close.
- Current single-pane constraint: `src/renderer/components/tabs/Browser.tsx:1-16`
  (file header doc-comment) and the "exactly one screen at a time" convention
  cited above.
- No existing fullscreen affordance: confirmed via
  `grep -rn "[Ff]ullscreen" src/renderer` (no matches) and
  `grep -rn "split.*pane\|SplitPane\|two-pane" src/renderer` (no matches
  outside unrelated settings-schema/Subagents text).

# Suggested direction (optional)

1. **New split layout mode** for a session's screen: agent transcript
   (`AgentView`/`SectionFrame`-based pane) on the **left**, the **Browser**
   tab's webview column on the **right** — likely a new top-level layout
   component that composes the existing `AgentView` and `Browser` components
   side by side rather than `MainPane`'s current one-screen-at-a-time switch.
2. **A full-screen toggle button** for this split view. When toggled, expand
   the split to fill the whole window (hide `LeftNav`/other chrome), keeping
   the left-agent/right-browser arrangement.
3. **Action buttons around the agent pane's top edge in full-screen mode** —
   per the screenshot, the row of action icons (share/export, terminal, edit,
   run) that normally sits in a title bar should stay anchored above the
   agent pane specifically (not floating over the whole window), so they
   remain reachable without leaving full-screen.

Mechanism/placement is the implementer's call — e.g. a new `SplitAgentBrowser`
component, or extending `MainPane` with a session-level "split" view state
or maybe as a tab of its own, next to `AgentView`
similar to how `mode` already drives the Browser tab's own sub-views
(`src/renderer/state/browser.ts`).

**Acceptance:** from a session with an active agent + an open Browser tab, the
user can enter a full-screen split view (agent left, browser right); a visible
button toggles it on/off; while full-screen, the agent pane's action buttons
(share/export, terminal, edit, run — whichever subset already exists elsewhere
in this app's chrome) are anchored at the top of the agent pane, not lost.

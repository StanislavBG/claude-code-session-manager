# Application menu

Vocabulary used below and in code comments:

- **Application menu** — the OS-level menu bar Electron attaches to the
  window via `Menu.setApplicationMenu`. There is exactly one, built once in
  `src/main/index.cjs` before `createWindow()`.
- **Menu** — one top-level entry in the application menu (a `submenu`
  container). Today: `Session Manager`, `Dev`, `Edit`.
- **Menu item** — one row inside a menu's `submenu` array. Two kinds (see
  below).
- **Accelerator** — the keyboard shortcut string Electron attaches to a menu
  item (`CmdOrCtrl+N`, `F12`, ...). Fires the item's action even when the
  menu itself is closed.
- **Context menu** — the separate right-click menu built in
  `src/main/index.cjs:395-399`. Not part of the application menu; not covered
  by the rules below.

## Role items vs click items

Every menu item is one of two kinds:

- **Role item** — `{ role: 'quit' }`, `{ role: 'undo' }`, etc. Electron
  supplies the behavior and, unless overridden, the label — which is
  OS-provided and localized. The Edit menu's six items (`undo`, `redo`,
  `cut`, `copy`, `paste`, `selectAll`) are role items with **no explicit
  `label:`**, deliberately, so they keep Electron's native wording in every
  locale.
- **Click item** — `{ label, accelerator, click }`. The app supplies both
  the label and the behavior. Every item in the `Session Manager` and `Dev`
  menus is a click item (except `Quit`, which is a role item with an
  explicit `label:` override, and the conditional heap-snapshot item, which
  is a click item).

## Current inventory

| Menu | Label | Accelerator | Kind | What it does | Wiring |
|---|---|---|---|---|---|
| Session Manager | Open / Start Project… | CmdOrCtrl+N | click | Opens the OS folder picker and opens/activates a project tab for the chosen folder | `src/main/index.cjs` click handler → `mainWindow.webContents.send('app:new-session')` → `src/preload/index.cjs` `onNewSession` → `src/renderer/App.tsx` `onNewSession` handler → `createPickedSession()` (`src/renderer/lib/createPickedSession.ts`) |
| Session Manager | Restart Session Manager App | CmdOrCtrl+Shift+R | click | Relaunches the whole Electron app | `src/main/index.cjs` click handler → `rebootApp()` (main process, same file) |
| Session Manager | Restart Terminal in Active Tab | CmdOrCtrl+Shift+S | click | Kills the active tab's PTY and respawns a fresh `claude` session in the same cwd | `src/main/index.cjs` click handler → `mainWindow.webContents.send('app:reboot-session')` → `src/preload/index.cjs` `onRebootSession` → `src/renderer/App.tsx` `onRebootSession` handler → `useSessions.getState().restartTab(activeTabId)` (toasts instead if no active tab) |
| Session Manager | Quit Session Manager | CmdOrCtrl+Q | role (`quit`) | Quits the app | Electron-native |
| Dev | Toggle Developer Tools | F12 | role (`toggleDevTools`) | Opens/closes Chromium DevTools on the main window | Electron-native |
| Dev | Reload App Window | CmdOrCtrl+R | role (`reload`) | Reloads the renderer (`dist/index.html` or the dev server URL) | Electron-native |
| Dev | Take Heap Snapshot (renderer) | none | click, conditional (`SM_HEAP_SNAPSHOT=1` only) | Captures a `.heapsnapshot` of the renderer process | `src/main/heapSnapshot.cjs` `buildMenuItem()` — see `heap-snapshot-diagnostics.md` |
| Edit | Undo / Redo / Cut / Copy / Paste / Select All | OS default | role | Standard text-editing commands, native to whichever input has focus | Electron-native |

## Rules

1. **One application menu, main-process only, no per-OS branches.** The
   `template` array in `src/main/index.cjs` is the sole definition. Nothing
   branches on `process.platform` — this matches the project's "no per-OS UI
   chrome" rule (see root `CLAUDE.md`).
2. **The menu is built once, before `createWindow()`, and never rebuilt.**
   No item is dynamically enabled/disabled or relabeled based on app state.
   A menu that reshuffles itself is worse than one with a occasional no-op.
3. **The menu is a shortcut to an in-app affordance, never the only door.**
   Every click item reaches functionality also triggerable from inside the
   app (the sidebar's "Open / Start Project" button, a tab's own restart
   control, etc.) — the menu never gates a capability behind itself alone.
4. **Items are always enabled and must be safe no-ops.** Because the menu
   can't be state-aware (rule 2), every click handler must handle "nothing
   to act on" gracefully — surfaced to the user (a toast), never a silent
   no-op and never a crash.
5. **IPC channels are named `app:<verb>-<noun>`.** E.g. `app:new-session`,
   `app:reboot-session`, `app:reboot-app`. Channel names are part of the
   preload/App.tsx contract and are not renamed when a label changes.
6. **Labels say what the item actually does, using the domain-model
   nouns** (`CLAUDE.md`'s TAB / EPIC / SESSION vocabulary) — not what it was
   called when it was written. "Session" in the current domain model names a
   tagged Epic; a menu item that opens a project TAB or restarts a TAB's PTY
   must say "Project" or "Terminal", not "Session", to avoid implying it
   touches an Epic.
7. **Role items never get an explicit `label:`** unless the app is
   deliberately overriding OS behavior (as `Quit` does, to append "Session
   Manager"). Adding a label to a plain role item strips OS localization for
   no benefit.
8. **No new menu items or menus without an explicit human decision.** The
   menu is small on purpose; each addition is a permanent piece of UI
   surface every user sees on every launch.
9. **Every accelerator's binding is load-bearing — treat it as part of the
   item's identity.** Changing what an accelerator triggers, or removing one,
   is a behavior change, not a label change, and needs the same scrutiny as
   any other functional change.

## Why "New Session" and "Reboot Session" were renamed

Under the current domain model (`CLAUDE.md`), "Session" is the user-facing
name for an **Epic** — a tagged `claude` session opened through the app. But
the old "New Session" menu item opened a project **TAB** (a Terminal tab
anchored to a cwd, not an Epic), and "Reboot Session" restarted a tab's
**PTY**. That was three different referents behind one word: Epic, TAB, and
PTY. Since **TAB = file location = Main Project** in this app's domain
model, the picker item now takes the project noun ("Open / Start Project…",
matching the sidebar button that runs the same `createPickedSession()`) and
the PTY item takes the terminal noun ("Restart Terminal in Active Tab").

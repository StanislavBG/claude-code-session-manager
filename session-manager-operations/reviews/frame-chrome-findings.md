# Frame/chrome review — findings

Scope: AlmanacSidebar, AlmanacFooter, AlmanacIcon, SectionFrame, CommandPalette,
VoiceModal, TourOverlay, MainPane routing, LeftNav's `NavKey`, tour/voice/teams
state. Reviewed every file in scope, exercised the real Electron app under
`xvfb-run` (built `dist/`, launched via Playwright's `_electron`), and grepped
for cross-family duplication.

## Bugs found and fixed

1. **CommandPalette: 13 of ~33 commands were dead no-ops.** `App.tsx`'s
   `onCommand` handler only dispatched `cmd.id.startsWith('nav:')` — every
   other `emitOnly` command (`new-tab-pick`, `new-tab-here`, `close-tab`,
   `restart-session`, `broadcast`, `watchers`, `copy-cwd`, `copy-transcript`,
   `open-transcript`, `scheduler-lint`, `add-allow-rule`, `test-fire-hook`,
   `devtools`, `reload-window`) silently did nothing when clicked, despite
   CommandPalette.tsx's own header comment documenting exactly what the
   parent was supposed to do with each. No git history shows this dispatch
   ever existing in `App.tsx` — it looks like the wiring was never finished
   when the palette was built.
   - **Fixed**: wired `new-tab-pick`, `new-tab-here`, `close-tab`,
     `restart-session`, `broadcast`, `watchers`, `copy-cwd`,
     `copy-transcript`, `open-transcript`, and `reload-window` in
     `App.tsx`'s `onCommand`, using existing session-store actions / IPC
     (`window.api.clipboard.writeText`, `window.api.transcripts.pathFor`,
     `window.api.shell.open`).
   - **Not fixed (documented, cross-family)**: `scheduler-lint`,
     `add-allow-rule`, `test-fire-hook` need dialog-open state owned by the
     Scheduler / Permissions / Hooks tabs respectively (out of this PRD's
     scope — those tabs belong to other family-review PRDs). `devtools` has
     no renderer-exposed IPC to toggle DevTools (only an Electron menu role
     bound to F12); adding one means touching `src/main/index.cjs`, outside
     this frame/chrome family. Both are real product gaps, worth a follow-up
     PRD in their own family.
   - Regression test added: `tests/e2e/command-palette-emit-only.spec.ts`
     (`close-tab`, `new-tab-here`).

2. **CommandPalette's nav section was missing 3 of the 21 real NavKeys.**
   `voice`, `repoviz`, `search` (the "Tools" group, promoted from modals in
   v0.13.1) had NavKeys and sidebar rows but no `nav:*` command, contradicting
   the file's own comment ("NavKey values from AlmanacSidebar.tsx — keep in
   sync when tabs are added/removed"). **Fixed**: added `nav:voice`,
   `nav:repoviz`, `nav:search`.

3. **TourOverlay: 2 of 8 steps pointed at dead selectors.** The Almanac
   redesign (commit `2e23789`) removed the `tour-scheduler` and
   `tour-mainpane-actions` DOM nodes but never updated `TOUR_STEPS` in
   `TourOverlay.tsx`. Both steps silently degraded to a centered,
   spotlight-less tooltip (the documented fallback path handled the crash,
   but the user-facing tour was visibly broken — "highlight this element"
   text with no highlight).
   - **Fixed** `tour-scheduler`: added the testid back to the actual
     Scheduler row in `AlmanacSidebar.tsx`'s `NavRow` (conditional on
     `item.key === 'scheduler'`), restoring the spotlight.
   - **Fixed** `mainpane-actions`: the underlying MainPane restart/broadcast/
     watcher buttons this step described no longer exist as visible UI at
     all (confirmed via grep — `restart-session`/`broadcast`/`watchers` are
     now CommandPalette-only actions, see finding 4). Retargeted the step to
     a centered tooltip pointing users at ⌘K/Ctrl+K instead of a dead
     selector.
   - Regression test added: `tests/e2e/tour-overlay-targets.spec.ts`.

4. **TourOverlay's own doc comment promised a command-palette re-run path
   (`tour:start`) that didn't exist.** `CommandPalette.tsx` had no `tour:*`
   command at all. **Fixed**: added `{ id: 'tour:start', label: 'Restart
   guided tour', section: 'config', run: () => useTour.getState().start() }`.
   Verified end-to-end (opens the palette, runs it, tour overlay appears).

## Duplication found and consolidated (within this family)

5. **Model-name shortening duplicated three times.** `lib/prettyModel.ts`
   already exists with a doc comment stating it *unified* two prior drifting
   copies ("AppStatusBar pill and TeamsCard chip") — but `AlmanacSidebar.tsx`
   had reintroduced a third, independently-drifting `shortModel()` (no
   `[1m]` context-suffix support, separate regex per family) in its
   `SidebarFooter`. **Fixed**: `AlmanacSidebar.tsx` now imports and uses
   `prettyModel`; the local `shortModel` is deleted.

6. **Git-branch lookup duplicated between AlmanacSidebar and AlmanacFooter.**
   Both display the active tab's branch. `AlmanacSidebar`'s `ProjectCaption`
   had a `useBranch` hook with a 30s TTL cache + cancellation; `AlmanacFooter`
   had an independent, uncached inline `useEffect` calling the same
   `window.api.app.gitBranch` on every cwd change. **Fixed**: extracted the
   cached hook to `src/renderer/lib/useBranch.ts` and both components now
   import it — single source of truth, one cache shared across the frame.

## Full NavKey routing sweep (AC requirement)

Booted the built app under `xvfb-run`, clicked every AlmanacSidebar row
(after fixes above), and asserted zero console/page errors per screen:

| NavKey | Label | Result |
|---|---|---|
| overview | Home | clean |
| terminal | Terminal | clean |
| browser | Browser | clean |
| projects | File Explorer | clean |
| subagents | Subagents | clean |
| scheduler | Scheduler | clean |
| history | History | clean |
| usage | Usage | clean |
| skills | Skills | clean |
| plugins | Plugins | clean |
| mcp | MCP Servers | clean |
| hooks | Hooks | clean |
| keybindings | Keybindings | clean |
| memory | Memory | clean |
| system-prompt | System Prompt | clean |
| permissions | Permissions | clean |
| settings | Settings | clean |
| remote | Remote | clean |
| voice | Voice | clean |
| repoviz | Repo Viz | clean |
| search | Search | clean |

`editor` has no sidebar row by design (launched contextually from the Files
sidebar / terminal file links, per `LeftNav.tsx`'s own comment) — confirmed
it's reachable via `sm:open-editor` and renders in `MainPane.renderScreen`
without a nav item, as documented; not a bug.

## AppStatusBar pills / CommandPalette suppression (AC requirement)

`AppStatusBar.tsx` **does not exist** — see documentation-drift section
below; the actual footer is `AlmanacFooter.tsx`. Exercised its real pills:

- Connected/offline dot → navigates to Settings. Matches its own inline
  doc comment. Verified via e2e.
- 5h-window pill → navigates to Usage. Verified via e2e.
- Scheduler-paused pill (conditionally rendered) → navigates to Scheduler.
  Code-reviewed only (requires a paused-scheduler fixture to trigger; not
  exercised live in this pass).

CommandPalette:
- Cmd-K opens/closes; fuzzy subsequence filter confirmed (`go to usage` →
  `nav:usage` surfaces).
- Suppression inside real text inputs (Monaco editor in Settings) confirmed
  working via e2e — Ctrl+K does not open the palette while the editor has
  focus.
- The SearchModal's own query inputs are *intentionally* excluded from
  suppression (documented in `App.tsx`'s `skipForRealInput` comment — so
  ⌘P/⌘⇧F can still bump Files↔Content mode while Search is already open).
  Confirmed this is by design, not a bug, after initially mis-testing it.

VoiceModal: opens via `nav:voice` (now also via CommandPalette, finding 2),
renders correctly, no console errors.

TourOverlay: exercised end-to-end after fixes (finding 3, 4) — all 8 steps
now resolve to a real spotlighted target or an intentional centered step.

## Documentation drift (per AC — not fixed, CLAUDE.md not edited)

- **`AppStatusBar.tsx` does not exist.** CLAUDE.md's Architecture section
  describes it as "global model / effort / team / voice / 5h-usage chip
  strip. Pills navigate to Settings / Voice / Usage on click." The actual
  component is `src/renderer/components/layout/AlmanacFooter.tsx`, and it's
  materially different: no model, effort, team, or voice pills at all — just
  connected-dot, 5h-usage, scheduler-paused (conditional), active tab +
  branch, last-activity, todos, and app version. The team pill CLAUDE.md
  describes lives only in `components/ui/TeamsCard.tsx` now, not in any
  footer/status-bar chrome. This reads like `AppStatusBar` was renamed/
  redesigned into `AlmanacFooter` during the Almanac re-skin and the
  Architecture doc was never updated.
- **`AgentView.tsx` and `SchedulerDock.tsx` do not exist.** CLAUDE.md's
  "Renderer" section lists `components/tabs/agent/SchedulerDock.tsx` — the
  directory `src/renderer/components/tabs/agent/` doesn't exist at all.
  Grepped the full source tree; zero hits for either filename. Per this
  PRD's explicit instructions: not building the missing component, not
  editing CLAUDE.md — flagging for a separate CLAUDE.md refresh pass.

## Cross-family duplication noticed, not touched (out of scope)

- `MainPane.tsx`'s `PAGE_META` eyebrow field ('Workspace' / 'Configure' /
  'Tools') parallels `AlmanacSidebar.tsx`'s `WORKSPACE`/`CONFIGURE`/`TOOLS`
  group names — not true logic duplication (different data: nav label vs.
  page header), but the group taxonomy is asserted in two independent
  literal arrays with no shared enum. Low risk (rename drift would just
  produce a mismatched eyebrow, not a crash); not touched since consolidating
  it means either building a shared taxonomy module or importing tab-owning
  files into MainPane, both bigger than a chrome-only fix.
- CommandPalette's hint labels (`Ctrl+W`, `Ctrl+Shift+R`, `Ctrl+Shift+B`,
  `Ctrl+Shift+W`) don't correspond to any renderer-level global keyboard
  listener in `App.tsx` — only Cmd-K, Cmd-P, Cmd-Shift-F, Escape, and Alt+1-5
  are bound. These may be intended as pure documentation of a *possible*
  future binding, or leftover from before the palette became the only
  invocation path; not clearly a "bug" (nothing crashes, the actions work
  via the palette itself) so left as a documentation-only finding.

## Unit test coverage (AC requirement)

`grep -rl "AlmanacSidebar\|AppStatusBar\|CommandPalette\|TourOverlay\|SectionFrame" src/renderer/**/__tests__`
returned **no matches** — none of these frame/chrome components have unit
test coverage. Per the AC, not authoring a broad new suite beyond what's
needed to cover the bugs fixed above; added targeted e2e regression tests
instead (`tests/e2e/command-palette-emit-only.spec.ts`,
`tests/e2e/tour-overlay-targets.spec.ts`) since the bugs found were all
integration-level (App.tsx wiring, DOM selector drift) rather than pure-logic
bugs a unit test would catch.

## Gates

- `npm run typecheck` — clean, both before and after every change.
- `npm run build` — clean.
- Full NavKey sweep + CommandPalette + VoiceModal + TourOverlay exercised
  live against the built app under `xvfb-run` — zero console/page errors.

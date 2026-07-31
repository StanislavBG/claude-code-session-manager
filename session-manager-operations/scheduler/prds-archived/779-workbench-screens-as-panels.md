---
title: "Workbench 2/5: every screen is a registered panel (single-visible routing)"
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

Second link of the Workbench chain (depends on PRD 778's landed state: `Workbench.tsx` + `layout.ts` store with registry and `openPanel`/`focusPanel`, MainPane hosted in one dock panel). Break MainPane's screen switch into per-screen dockview panels: every `NavKey` screen registers as a panel, and all navigation entry points route through `openPanel`/`focusPanel` instead of `setActiveNav` swapping MainPane's content. Layout still shows ONE visible screen at a time (default layout = one main group; opening a screen replaces/focuses within the group) — side-by-side arrives in link 3 after focus scoping. This preserves today's UX and the entire e2e suite while making the panel model real.

# Acceptance criteria

## Core functionality

- [ ] Every member of `SCREEN_KEYS` (App.tsx:44-71) is registered in layout.ts's panel registry, each rendering the same component MainPane renders for that key today (extract MainPane's switch into a `screenComponents` map the registry consumes)
- [ ] `AlmanacSidebar` item click, `navigate()` (App.tsx:90-94), the `sm:navigate` / `sm:open-editor` window-event listeners (App.tsx:104-114), and the pure-tab-switch auto-nav (`isPureSwitch` → terminal, App.tsx:130-140) ALL route through `openPanel`/`focusPanel`
- [ ] CommandPalette `nav:*` command ids (CommandPalette.tsx:164+) are preserved verbatim and resolve to `openPanel` — the e2e helper navigates via `button[data-cmd-id="nav:..."]` (tests/e2e/_helpers/launchApp.ts:66-82) and must keep working

## Interaction / integration

- [ ] TerminalStage remains the singleton always-mounted layer; the Terminal *screen panel* shows/hides it exactly as MainPane.tsx:208-223 does today (visible when the terminal panel is the active one)
- [ ] Non-terminal screens keep today's unmount-on-switch behavior (MainPane.tsx:217-223 `{active !== 'terminal' && ...}` semantics): with single-visible layout, at most one non-terminal screen is mounted at any time — do NOT keep background panels mounted in this link (that is link 3's job, gated on focus scoping)
- [ ] BroadcastBar / WatchersPopover gating on the terminal screen (MainPane.tsx:190,199 + App.tsx:158-170 toggles forcing `setActiveNav('terminal')`) still works — rewire the forced nav to `openPanel('terminal')`
- [ ] AlmanacSidebar active-item highlight and AlmanacFooter active-tab chip reflect the focused panel (footer reads sessions.activeTabId — unchanged; sidebar highlight follows layout store's focused panel id)

## Tests

- [ ] Unit test: panel registry covers every `SCREEN_KEYS` member (import both and assert set equality) and every `nav:*` id in CommandPalette resolves to a registered panel id
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npx vitest run src/renderer/state/__tests__/layout.test.ts` passes
- [ ] `timeout 900 npx playwright test tests/e2e/cycle2-coverage.spec.ts` passes under xvfb (`xvfb-run` per repo convention) — this spec walks all nav destinations

# Implementation notes

Depends on PRD 778 (workbench foundation). Read its landed code first: `src/renderer/components/workbench/Workbench.tsx`, `src/renderer/state/layout.ts` — build on the registry/openPanel API it added; if 778 adjusted names, follow its actual landed state, not this description.

Read next: `src/renderer/components/MainPane.tsx` in full (the switch you are decomposing; keep its props flowing to each screen), `src/renderer/App.tsx:44-170` (SCREEN_KEYS, navigate(), event listeners, isPureSwitch, broadcast/watchers toggles), `src/renderer/components/CommandPalette.tsx:164+` (nav:* ids), `tests/e2e/_helpers/launchApp.ts:66-82` (how e2e navigates — your compatibility contract).

Keep MainPane.tsx as a thin shell or dissolve it — either is fine, but the `screenComponents` map must be the single source of truth consumed by the registry (no duplicated switch). Dockview single-group behavior: use one group and `addPanel`-or-`focus` semantics so opening a screen when it's already open focuses instead of duplicating; closing the last panel must immediately reopen the default ('terminal' or 'home') rather than leaving an empty grid (persistence and empty-grid watermark are link 5).

Do NOT render DockviewReact under vitest (jsdom lacks ResizeObserver) — unit tests target the registry/store only.

# Out of scope

- Multiple simultaneously visible panels, drag-to-split, floating panels (link 3)
- Window-level keyboard focus scoping (link 3)
- xterm refit / live-surface hardening (link 4)
- Layout persistence (link 5)
- TerminalChat.tsx internals (PRDs 773-777 own it)
- Tour overlay retargeting — sidebar chrome is unchanged so TOUR_STEPS targets survive; do not touch TourOverlay

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

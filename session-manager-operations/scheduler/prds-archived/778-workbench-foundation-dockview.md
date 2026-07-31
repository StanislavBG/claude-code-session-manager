---
title: "Workbench 1/5: dockview foundation — MainPane inside one dock panel"
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

First link of the Workbench chain: adopt the dockview docking library as Session Manager's panel system. Add the dependency, create `src/renderer/components/workbench/Workbench.tsx` hosting a DockviewReact, a `src/renderer/state/layout.ts` zustand store (panel registry + default layout definition + `openPanel`/`focusPanel` API), and a dockview theme mapped to the app's Tailwind tokens. `App.tsx` renders the existing MainPane inside a single dockview panel — the app looks and behaves exactly as today, but the shell now runs inside the workbench.

# Acceptance criteria

- [ ] `dockview-react` (NOT the framework-agnostic `dockview-core`) added to package.json and used; compatible with React 18.3 + Vite 6
- [ ] New `src/renderer/state/layout.ts` zustand store: panel registry (id → { title, component key }), `DEFAULT_LAYOUT` definition containing exactly one panel (`'main'`), and `openPanel(id)`/`focusPanel(id)` actions (no-ops beyond focusing while only one panel exists — the API surface is what link 2 builds on). Store follows the islands convention: no imports from other stores
- [ ] New `src/renderer/components/workbench/Workbench.tsx` renders DockviewReact with the registry; App.tsx's shell area (currently `<MainPane .../>` at App.tsx:669) renders `<Workbench>` whose single `'main'` panel hosts MainPane with identical props; AlmanacSidebar, TabBar, AlmanacFooter, RecordingStatus, modals stay OUTSIDE the workbench as fixed chrome, byte-for-byte where possible
- [ ] TerminalStage singleton invariant preserved: MainPane's always-mounted `<TerminalStage>` layer (MainPane.tsx:208-223) is not remounted or duplicated — mounting/unmounting the workbench must not orphan PTYs
- [ ] Dockview theme: a workbench.css (or Tailwind layer) maps dockview's CSS custom properties to the app's existing tokens (`bg`/`fg`/`line`/`accent` from tailwind.config.js + styles.css) for BOTH light and dark; no hardcoded dockview default palette visible
- [ ] `--simple` mode (App.tsx early-return of SimpleShell) is untouched and never mounts the workbench
- [ ] Unit tests (vitest) for layout.ts: DEFAULT_LAYOUT shape, registry lookup, openPanel/focusPanel state transitions. CONSTRAINT: do NOT render DockviewReact under vitest — jsdom lacks ResizeObserver; test the store/registry only
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 600 npm run build` passes
- [ ] `timeout 300 npx vitest run src/renderer/state/__tests__/layout.test.ts` passes

# Implementation notes

Read first: `src/renderer/App.tsx:640-700` (shell composition: AlmanacSidebar at 664, MainPane at 669, AlmanacFooter at 682; note the splitView early-return branch at ~640-650 and the SimpleShell early-return at ~638 — leave BOTH untouched), `src/renderer/components/MainPane.tsx` (esp. 208-223: TerminalStage is an always-mounted absolutely-positioned layer because unmounting it orphans the PTY — 'session already exists'), `tailwind.config.js` + `src/renderer/styles.css` (token names), `src/renderer/state/sessions.ts` (store style/conventions to mirror).

Facts that save you debugging: the CSP in `src/main/index.cjs:949-971` already allows `style-src 'self' 'unsafe-inline'` — dockview's bundled CSS and inline geometry styles work as-is; do NOT touch the CSP. Import dockview's core CSS in the renderer entry and override its theme via CSS custom properties (dockview exposes `--dv-*` vars) in a dedicated stylesheet next to Workbench.tsx.

This is link 1 of a 5-PRD chain (screens-as-panels, focus-scope+multi-visible, live-surface hardening, layout persistence follow). Keep the panel registry generic — link 2 will register every SCREEN_KEY as a panel. Do not implement per-screen panels, persistence, or any drag-out behavior here.

Repo conventions: no CommonJS in renderer; typecheck must pass before commit; tests run via vitest (this repo does not use node --test).

# Out of scope

- Per-screen panels (link 2)
- Multiple visible panels / focus scoping (link 3)
- xterm/live-surface hardening (link 4)
- Layout persistence to disk — no localStorage keys, no config file (link 5)
- Making AlmanacSidebar/AlmanacFooter/TabBar dockable panels — chrome stays fixed this whole phase
- Touching TerminalChat.tsx (PRDs 773-777 are actively rewriting it)
- Removing the splitView/SplitAgentBrowser branch (phase 2)

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

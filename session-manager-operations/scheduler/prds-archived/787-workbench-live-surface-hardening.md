---
title: "Workbench 4/5 (PRD 787): live-surface hardening — xterm, z-order, recording relayout"
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Fourth link of the Workbench chain (depends on PRD 780's landed state: focus-scoped panels, multiple visible panels with drag-to-split). Harden the live surfaces against panel geometry changes: xterm must survive dockview DOM moves and zero-size states, the RecordingStatus banner's layout shift must trigger a workbench relayout, and the app's z-order contract must hold above dockview's drag overlays.

# Acceptance criteria

## Core functionality

- [ ] xterm keep-alive across DOM moves: dragging/re-docking the Terminal panel does not kill or respawn the PTY and does not produce 'session already exists' — TerminalStage stays the singleton layer; the terminal refits (FitAddon) after any dockview-driven geometry change (group resize, split, drop), not just window resize
- [ ] Zero-size guard: `Terminal.tsx:236`'s ResizeObserver fit call is guarded against 0×0 containers (window minimize, panel collapsed mid-drag) — no xterm exceptions in console when minimizing/restoring
- [ ] Note: after PRD 772, dormant tabs render TerminalChat (no xterm) — all xterm ACs above are conditional on a live (non-dormant) session; the dormant/Chat panel needs no fit wiring

## Interaction / integration

- [ ] RecordingStatus relayout: toggling recording shifts the whole tree 28px (`pt-7`, App.tsx:653); the workbench must re-layout and live terminals refit on that toggle (dockview caches pixel geometry — trigger its layout() on the recording state change)
- [ ] Z-order contract pinned and asserted: RecordingStatus z-[60] > Toast z-[55] > Modal z-50 remain ABOVE dockview's drag ghosts, floating groups, and popups; set dockview's overlay z-indexes below 50 in workbench.css and document the ladder in a comment there
- [ ] Privacy invariant (CLAUDE.md): RecordingStatus is mounted whenever isRecording === true — unchanged and verified by existing tests/code path; a dockview drag overlay must never cover it

## Tests

- [ ] Unit test for the zero-size fit guard (extract the guard into a testable helper if needed)
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npm run test:unit` passes

NOTE: do NOT add a `playwright test ... under xvfb` acceptance criterion here. Two prior links in
this chain (776, 779) stalled and were SIGTERM'd (exit 143) on exactly that step — a headless
`claude -p` executor spawning `xvfb-run`/Playwright hits a tool-use rejection and hangs until the
scheduler kills it, even though the underlying command works fine when run outside that harness.
This is a known, documented anti-pattern (see the `feedback_no_interactive_ac_in_prds` memory and
`session-manager-operations/feedback/2026-07-30-exit143-after-commit-misclassified-as-failed.md`).
The "open Terminal, open a second screen, assert no 'session already exists'" check described
above should be covered by a unit/component test against the fit-guard/singleton logic instead of
a live e2e run; note in the completion report that manual/interactive e2e confirmation is
recommended, don't make it headless AC.

# Implementation notes

Depends on PRD 780. Read its landed state first.

Read next: `src/renderer/components/Terminal.tsx:230-240` (ResizeObserver + fit), `src/renderer/components/TerminalStage.tsx` (all session tabs mounted, only activeTabId visible), `src/renderer/App.tsx:653` (pt-7 recording shift), `src/renderer/components/RecordingStatus.tsx`, the workbench.css theme file from PRD 778 (z-index ladder lives here).

Dockview API: the DockviewReact api object exposes `layout()`/dimension events; wire the recording toggle → `api.layout()` (or equivalent) in Workbench.tsx via a store subscription to the voice store's isRecording (subscribe in the component, not store-to-store — islands convention).

FitAddon already refits on window resize; the gap is panel-level geometry changes. Dockview panel api exposes `onDidDimensionsChange` per panel — the Terminal screen panel should forward those to the same fit path the window listener uses.

# Out of scope

- Browser WebContentsView bounds-sync (phase-2 PRD)
- Mount-budget/lazy-hydrate for heavy screens (only if profiling shows need — phase 2)
- Layout persistence (link 5)
- TerminalChat.tsx internals

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

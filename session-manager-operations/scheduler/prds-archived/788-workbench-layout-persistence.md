---
title: "Workbench 5/5: single-layout persistence via main-process store + reset command"
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Final link of the Workbench chain (depends on PRD 787's landed state: hardened multi-panel workbench). Persist the ONE system layout: serialize dockview's layout JSON through a dedicated main-process store (mirroring `src/main/sessionsStore.cjs`), hydrate on boot, add a "Reset layout" command to the CommandPalette, and retire the legacy scattered localStorage layout keys. No named presets, no multiple layouts — the user's resizes/splits simply survive restart, and reset returns to the system default.

# Acceptance criteria

## Core functionality

- [ ] New `src/main/layoutStore.cjs` following the `sessionsStore.cjs` pattern: load/save IPC handlers registered in index.cjs, zod-validated payload in `ipcSchemas.cjs`, atomic write via config.cjs's `writeJson` to `~/.claude/session-manager/workbench-layout.json` — do NOT route a raw renderer `config:write-json` at an arbitrary path
- [ ] BLOCKER (from code review of commits 7c4836f/2d6f1ef): panel `params` must be serializable BEFORE any `api.toJSON()` call. Workbench.tsx currently passes a live React element as `params.node` (`addPanel({ params: { node: screenNode(...) } })`); DockviewPanel.toJSON() copies `_params` verbatim into the serialized layout, and a React element's Fiber backref makes JSON.stringify throw on circular structure — and a fromJSON restore would hand the panel a dead deserialized husk. Refactor first: params carry only the panel id (a string); the panel component resolves the screen node at render time from the registry. Then implement serialization.
- [ ] Workbench serializes layout on change (debounced ~500ms, mirroring hydrateSessions' debounced autosave pattern in sessions.ts:304-325) and hydrates the saved layout on boot before first paint of the workbench
- [ ] "Reset layout" CommandPalette command restores DEFAULT_LAYOUT, persists it, and re-renders without an app restart
- [ ] Legacy localStorage keys retired: AlmanacSidebar's WIDTH_KEY / SIDEBAR_COLLAPSED_KEY (AlmanacSidebar.tsx:59-176) keep working ONLY if the sidebar is still fixed chrome outside the dock (it is, this phase) — leave sidebar keys alone, but remove any layout-related localStorage introduced during links 1-4 in favor of the store

## Edge cases

- [ ] Corrupt/unparseable workbench-layout.json → fall back to DEFAULT_LAYOUT, log a warning, do not crash or toast-spam
- [ ] A persisted layout referencing a panel id no longer in the registry (future rename) → drop the unknown panel, keep the rest, fall back to DEFAULT_LAYOUT only if nothing valid remains
- [ ] Never persist a zero-panel layout: serializer refuses to save an empty grid (the close-last-reopens-default behavior from PRD 780 makes this near-impossible; the guard makes it impossible)
- [ ] `--simple` mode never loads or saves the layout store

## Tests

- [ ] Unit tests: round-trip serialize→hydrate of a two-group layout; corrupt-JSON fallback; unknown-panel-id pruning; zero-panel refusal
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npm run test:unit` passes

NOTE: do NOT add a `playwright test ... under xvfb` acceptance criterion here. Two prior links in
this chain (776, 779) stalled and were SIGTERM'd (exit 143) on exactly that step — a headless
`claude -p` executor spawning `xvfb-run`/Playwright hits a tool-use rejection and hangs until the
scheduler kills it, even though the underlying command works fine when run outside that harness.
This is a known, documented anti-pattern (see the `feedback_no_interactive_ac_in_prds` memory and
`session-manager-operations/feedback/2026-07-30-exit143-after-commit-misclassified-as-failed.md`).
Note in the completion report that manual/interactive e2e confirmation of layout persistence is
recommended, don't make it headless AC.

# Implementation notes

Depends on PRD 787. Read its landed state first.

Read next: `src/main/sessionsStore.cjs` (the exact pattern to mirror: load/save handlers, atomic write, shape validation), `src/main/ipcSchemas.cjs` (zod at the IPC boundary — add layout schemas here), `src/main/config.cjs` (`writeJson` — reuse, never re-implement tmp+rename), `src/preload/api.ts` (expose layout load/save alongside sessions), `src/renderer/state/sessions.ts:304-325` (debounced autosave to copy), dockview's `api.toJSON()`/`api.fromJSON()` docs/types in node_modules.

Validation shape: don't zod-validate dockview's full internal JSON deeply — validate the envelope (version int + panels list of known ids + opaque dockview blob) so dockview upgrades don't brick saved layouts; the unknown-panel pruning operates on the envelope's panel list before calling fromJSON.

# Out of scope

- Named/multiple layout presets, per-project layouts, import/export
- Making the sidebar/footer dockable (their localStorage keys stay)
- Migrating ProjectsWorkspace's internal splitter (`sm.projects.splitPct`) — separate consolidation PRD in phase 2
- Any settings-surface UI for layout options

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

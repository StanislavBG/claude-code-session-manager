---
title: Plugins drill-in page — fix 5 Important code-review findings from PRD 786
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

Code review of commit 09d2b84 (Plugins drill-in page, PRD 786) found 5 Important issues, all in `src/renderer/components/tabs/Plugins.tsx`. Fix them, plus a handful of cheap minors from the same review. No redesign — the 2a layout stays exactly as is.

# Acceptance criteria

## Core functionality (the 5 Important findings)

- [ ] Clicking a different skill while `PluginSkillBrowser` is open switches it: pass `key={browsingSkill.id}` at the mount site (`Plugins.tsx` ~467-471) or make selection a controlled prop of `PluginSkillBrowser` — either is fine, pick one.
- [ ] Loading state: while the drill-in's async effect is in flight, the content column shows a loading indicator (reuse the existing `EmptyState` pattern with a "scanning…" title, matching the list view's `scanning plugins…`), NOT the four disabled zero-count sections + "no components".
- [ ] The async effect (`Plugins.tsx` ~306-358) is wrapped in try/catch; on error, surface via `useToast().show('error', …)` (repo convention: Toast is the user-facing error channel) and leave a non-broken empty state.
- [ ] Hooks, monitors, and LSP are represented in the drill-in: add index entries (counts from the already-loaded `PluginRow.hooks`/`monitors`/`hasLsp`) so a hooks-only or monitors-only plugin no longer renders as "no components". Read-only counts/rows are enough — no new file parsing beyond what `inspectPluginDir` already provides.
- [ ] Homepage click: check the `{ ok, error }` result of `window.api.shell.open` and toast the error when `ok === false` instead of `void`-discarding it.

## Edge cases / minors (same review, cheap)

- [ ] Agent-file reads parallelized with `Promise.all` (replaces the sequential `for await` at ~320-325).
- [ ] "Files" index label renamed to "Bin" (it lists `${row.path}/bin` only).
- [ ] `ContentRow` no longer nests `<div>` inside `<span>`; back button and index buttons get `type="button"`.
- [ ] Dead code deleted: `formatElapsedClock` in `src/renderer/lib/formatTime.ts` (~line 81, zero callers) and the unreferenced `orchestrator`, `race`, `background`, `tasks`, `plans` icon cases in `AlmanacIcon.tsx` — verify zero references with grep before each deletion; keep any that has a surviving caller.
- [ ] Stale docs: `learningContent.ts` ~line 260 reworded to match the meta strip (author/license/homepage + path); CLAUDE.md's "Design primitive extraction" bullet no longer cites the deleted `ToolChip` as its example.

## Tests

- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 600 npm run test:unit` passes

# Implementation notes

Read first: `src/renderer/components/tabs/Plugins.tsx` (post-09d2b84 state — line numbers above are from that commit), `src/renderer/components/tabs/plugins/PluginSkillBrowser.tsx` (`initialSelectedId` read only in a `useState` initializer at line ~18 — that's why finding 1 happens), `src/renderer/state/toast.ts` + `components/ui/Toast.tsx` for the error-channel convention, `src/main/index.cjs` ~700-705 for the shell.open `{ ok, error }` shape.

The review confirmed the five deletion commits (46930cb..01bd438) clean — do NOT touch anything outside the files listed above.

# Out of scope

- Any layout/visual change to the 2a design
- New parsing of hooks/monitors file contents (counts already exist on PluginRow)
- The Library sub-tab

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

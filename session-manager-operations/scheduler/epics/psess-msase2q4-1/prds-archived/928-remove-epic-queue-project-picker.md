---
title: Remove redundant Project-Picker above the Epic Queue
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msase2q4-1
---
# Goal

`EpicsWorkspace.tsx` renders a "PROJECT / All projects" `<select>` (lines ~257-270) whenever it's mounted with no `cwd` prop — its own header comment says this is meant for `TerminalStage.tsx`'s "always-on singleton mount ... whenever no SessionTab is active." But the Epics nav item itself (`src/renderer/lib/navGroups.ts`, `key: 'terminal', label: 'Epics'`) is already `faces: PROJECT`-only (`faces: PROJECT` not `BOTH`/`HOME`) — the Epics screen is unreachable from the Home face at all, so a user can never actually be looking at the Epic Queue without already having a project TAB selected. The "All projects" project-filter branch of this dual-mode component is therefore dead weight causing visible, confusing clutter (a picker offering "all projects" above a queue that can never actually show more than one project's Epics through normal navigation). Remove it.

# Acceptance criteria

- [ ] Before deleting anything: confirm `TerminalStage.tsx`'s `<EpicsWorkspace />` (no-cwd) mount is genuinely unreachable while a project TAB is selected — trace how `Workbench.tsx`/`MainPane`/whatever renders `TerminalStage` decides when to show it, and confirm it's only ever the 'no tab at all' empty-state screen, not something that can appear WHILE a Project-face nav is active. If it turns out `TerminalStage`'s singleton mount genuinely can render with the Epics screen selected but zero tabs open (a legitimate empty-app-state), that changes the fix: it may need to just always resolve to a real cwd-scoped view or an empty-state message instead of an 'All projects' picker, rather than nothing at all — report which case it actually is before changing behavior
- [ ] The `{cwd === undefined && (...)}` project-filter `<select>` block in `EpicsWorkspace.tsx` (~lines 248-270, `data-testid="epics-project-filter"`) is removed from the rendered UI for the case verified above
- [ ] `projectFilter`/`handleProjectFilterChange`/`knownCwds`/NavFace-driven-default state and logic that ONLY existed to support this dropdown (read the full component first to confirm what's dropdown-only vs. still used elsewhere, e.g. by `EpicQueueControls`) is removed too — don't leave dead state/handlers behind after removing their only UI trigger
- [ ] If `TerminalStage`'s no-cwd mount is confirmed still reachable as a genuine empty-app-state (no tabs open at all), replace the picker with a simple message/empty-state directing the user to open a project tab, rather than leaving that mount path broken or blank
- [ ] Existing tests in `src/renderer/components/__tests__/EpicsWorkspace.test.tsx` that reference `epics-project-filter` / the no-cwd mount's project-filter behavior are updated to match the new behavior (removed or rewritten, not left asserting on deleted UI)
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run src/renderer/components/__tests__/EpicsWorkspace.test.tsx` passes

# Implementation notes

Read `EpicsWorkspace.tsx` in full (both call sites' comments at the top of the file explain the two mount modes) and `navGroups.ts`'s `NAV_ITEMS` entry for `key: 'terminal'` to confirm the `faces: PROJECT` claim this PRD is based on before touching anything — if that entry has changed since this PRD was written, re-verify the reachability claim from scratch rather than trusting this PRD's premise blindly. `Terminal.tsx:278`'s `<EpicsWorkspace cwd={cwd} />` mount (the real, reachable, per-tab path) is NOT in scope for this PRD — that one already scopes correctly and has no picker.

# Out of scope

- Changing how TerminalStage decides when to mount at all
- Any change to the per-tab EpicsWorkspace mount (Terminal.tsx:278) — it already works correctly
- Adding a NEW project-switching mechanism elsewhere — this PRD only removes the redundant one, it doesn't need to replace it with something else unless the reachability investigation in AC #1 finds a genuine empty-state gap

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

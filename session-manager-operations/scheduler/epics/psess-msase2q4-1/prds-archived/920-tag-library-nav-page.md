---
title: Tag Library — new Home-tab nav page listing Epic intent tags
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msase2q4-1
dependsOn: [build-tag-and-target-config]
---
# Goal

Add a new "Tag Library" read-only nav page reachable from the Home-Tab's left sidebar, listing the Epic intent-tag taxonomy (`feature`, `bug`, `discussion`, and the new `build` tag added by the `build-tag-and-target-config` PRD in this same Epic) with each tag's meaning and its `/develop`-eagerness default, per this project's own CLAUDE.md: "feature/bug treat PRD decomposition as the expected next step, discussion keeps /develop available but never assumed." This is the first place that taxonomy becomes visible/documented in the app UI instead of only living in CLAUDE.md prose and scattered type unions.

# Acceptance criteria

- [ ] New shared source-of-truth file `src/renderer/lib/tagLibrary.ts` exporting a typed array/record describing each tag: `{ tag: 'feature'|'bug'|'discussion'|'build', label: string, description: string, developEagerness: 'expected-default' | 'available-not-assumed' }` — `feature` and `bug` get `'expected-default'`, `discussion` gets `'available-not-assumed'`, `build` gets `'expected-default'` (a build Epic's whole point is to run the Builder skill)
- [ ] New `NavKey` literal `'tag-library'` added via the same 3-step process documented in `src/renderer/components/LeftNav.tsx`'s header comment (append literal → `src/renderer/lib/screenKeys.ts` → `screenComponents.tsx` switch)
- [ ] New entry in `NAV_ITEMS` (`src/renderer/lib/navGroups.ts`): `{ key: 'tag-library', group: 'Configure', label: 'Tag Library', icon: <reuse an existing AlmanacIconName that reads as tag/label>, hint: 'Epic intent tags and their /develop behavior', faces: HOME }`
- [ ] New component `src/renderer/components/tabs/TagLibrary.tsx`, reading from `tagLibrary.ts` (not hardcoding the list again — single source of truth), following the same list/detail visual shape as `Skills.tsx` for consistency with the sibling Agent Library page from the `agent-library-nav-page` PRD in this Epic
- [ ] `src/renderer/lib/ticketDisplay.ts` and `src/renderer/lib/epicQueueControls.ts` (wherever they currently hold their own tag→label/color mapping, per the `build-tag-and-target-config` PRD's findings) are refactored to import from `tagLibrary.ts` instead of duplicating the tag list — single source of truth, not two copies that can drift
- [ ] `timeout 300 npm run typecheck` passes

# Implementation notes

This PRD depends on `build-tag-and-target-config` having already added `'build'` to the tag unions in `prdFrontmatter.ts`, `promptSessions.ts`, `ipcSchemas.cjs`, `ticketDisplay.ts`, and `epicQueueControls.ts` — read that PRD's actual landed diff (`git log` for its commit, or the PRD file at `session-manager-operations/scheduler/epics/psess-msase2q4-1/prds/917-build-tag-and-target-config.md`) to confirm exactly which files it touched before assuming this list is complete. Quote CLAUDE.md's "Domain model (TAB / EPIC)" section verbatim for the tag descriptions rather than paraphrasing loosely — it's the authoritative wording for feature/bug/discussion.

# Out of scope

- Editing tag behavior from the UI — read-only viewer for v1
- Changing an existing Epic's tag from this page — that's the row-menu rename/edit flow, a different feature

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

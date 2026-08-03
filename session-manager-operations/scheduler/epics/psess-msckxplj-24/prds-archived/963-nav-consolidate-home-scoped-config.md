---
title: Consolidate substrate config tabs onto Home face only — no Project-face Settings duplication
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: psess-msckxplj-24
dependsOn: [agent-model-nav-consolidation]
---
# Goal

System Prompt, Skills, MCP Servers, Hooks, Permissions, and Settings (lib/navGroups.ts NAV_ITEMS) are all System/Project/Local settings.json-or-sibling-file editors — legitimately Machine/Project-wide substrate, never per-Epic (established earlier in this Epic). All six currently have `faces: BOTH`, duplicating them onto the Project face's left-nav even though Plugins/Keybindings/Remote/Agent Library/Tag Library — the same category of machine-wide config — are already `faces: HOME` only. Home's left-nav exists precisely so Project-face navigation doesn't need its own separate Settings-shaped entries; consolidate these six onto Home only, matching the existing precedent, without breaking Project-scope editing (which resolves via the active tab's cwd, independent of navFace — see lib/navFace.ts's documented navFace/activeTabId separation).

# Acceptance criteria

- [ ] navGroups.ts's NAV_ITEMS entries for system-prompt, skills, mcp, hooks, permissions, and settings all change from `faces: BOTH` to `faces: HOME`; memory and bilko-host are left untouched (PROJECT) since they are not settings.json-scope editors
- [ ] A regression test confirms each moved tab, when opened while navFace === 'home' with a project tab still active (activeTabId set, non-null cwd), still offers and correctly resolves Project scope via its ScopeSwitcher — proving the face move does not remove access to project-scope settings
- [ ] Any direct-navigation path that could still land a user on one of these six NavKeys while navFace is 'project' (e.g. CommandPalette, deep-link, or a stale panel focus call) is checked; if such a path exists, either route it through the same home-face assertion these items now expect, or document why leaving it project-scoped is intentional
- [ ] Settings.tsx (and any sibling tab — Permissions/Hooks/Mcp/Skills/SystemPrompt — with the same navFace-transition-based scope-default effect, e.g. Settings.tsx's manuallyTouchedRef/prevNavFaceRef block) is reviewed: if navFace can no longer be 'project' while that screen renders, simplify or remove the now-dead 'project face defaults to project scope' branch; if it can still occur, leave it and add a one-line comment explaining the surviving path
- [ ] Existing tests asserting these six keys' face membership (e.g. navGroupsHome.test.ts, AlmanacSidebar tests) are updated to match the new HOME-only assignment
- [ ] npm run typecheck && npm run test:unit pass

# Implementation notes

Sequenced after agent-model-nav-consolidation (962) since both touch navGroups.ts and Settings.tsx — land 962 first, then rebase this on top rather than editing in parallel. This is purely a `faces` reassignment plus dead-code cleanup, not a rewrite of any tab's content — don't restructure Settings.tsx/Permissions.tsx/etc. beyond what's needed for the navFace-effect review. Read CLAUDE.md's 'Settings is substrate, not per-Epic curation' bullet and this Epic's prior PRDs (959-962) for the established rule before implementing. Read session-manager-operations/scheduler/PRD_AUTHORING.md and the engineering standards file first.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

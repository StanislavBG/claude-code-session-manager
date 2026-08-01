---
title: Tab activation lands on the Epic-centric surface — retire the legacy chat right rail
cwd: ~/Projects/session-manager
estimateMinutes: 22
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

Independent v0.40.0 audit: any path that ACTIVATES a SessionTab (TabBar click at
TabBar.tsx:51 → App.tsx:~115 openPanel('terminal'), pure tab switch, Open raw session) still
renders the LEGACY dormant-tab chat surface with the right rail — TerminalChat mounts
ChatSessionRail (TerminalChat.tsx:721) + QueueTicketPanel/TicketDetailView (:680,:691). This
is the pre-redesign "Epics page" users reach by muscle memory. Retire it: a DORMANT tab's
content becomes the EpicsWorkspace scoped to that tab's project; a RUNNING tab keeps its live
PTY terminal view unchanged.

# Acceptance criteria

- [ ] Activating a dormant SessionTab renders EpicsWorkspace (with that tab's cwd's Epics
  visible; preselect the most recently active Epic of that cwd when one exists) instead of
  TerminalChat. Running-PTY tabs are untouched (Terminal.tsx live branch).
- [ ] ChatSessionRail, QueueTicketPanel, and TicketDetailView are no longer reachable from
  any surface; delete them (and their tests) unless another live consumer exists — grep
  first; TerminalChat.tsx itself may shrink or be deleted if nothing else needs it. Preserve
  the exports other modules still import (openPrdSlug, openPromptSession, TagSelector) by
  moving them to a small module (e.g. src/renderer/lib/epicNav.ts) and updating importers.
- [ ] Deep links and the chat:run dormant-tab path (chatRunner) keep working — the Epic
  composer is now the only prompt entry for dormant work; verify chat.ts's send paths have
  no remaining dependency on the removed components.
- [ ] Rewrite/replace affected tests (QueueTicketPanel.test.tsx etc.) against the new
  behavior — replaced, not dropped.

# Implementation notes

Read first: TerminalStage.tsx (activeTab branch), Terminal.tsx:~265 (dormant → TerminalChat),
TabBar.tsx:51, App.tsx navigate/deselect (af38fef), EpicsWorkspace props. Reuse the existing
sm:select-prompt-session deep-link path for preselection rather than new plumbing. Keep the
change surgical: dormant-tab content swap + dead-code removal, no TabBar redesign.

# Out of scope

- Any change to live PTY terminal behavior or tab lifecycle (wake/sleep).
- New features beyond the swap.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— every rule is mandatory, especially Execution discipline (bounded commands, verify before
done). All renderer PRDs: `timeout 300 npm run typecheck` + `npm run lint:selectors` +
targeted `timeout 300 npx vitest run <files>` must pass; add/extend vitest coverage for your
change.

---
title: Epic detail header shows the project git branch (mock's branch line)
cwd: ~/Projects/session-manager
estimateMinutes: 8
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
dependsOn: [842-retire-legacy-tab-chat-rail]
---

# Goal

The mock's detail header shows a mono branch line; v0.40.0 replaced it with only a
ProjectTag. Add the Epic cwd's current git branch next to the ProjectTag using the existing
src/renderer/lib/useBranch.ts (already used by AlmanacFooter) — mono, muted, prefixed with
the branch glyph like the mock.

# Acceptance criteria

- [ ] EpicDetail header (EpicDetail.tsx:~306) renders the branch for the Epic's cwd via
  useBranch; hidden cleanly when unavailable. Test covers shown/hidden branches.

# Implementation notes

useBranch takes a cwd — verify its signature before wiring; no new IPC.

# Out of scope

- Per-Epic branches (no data model for that).

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— every rule is mandatory, especially Execution discipline (bounded commands, verify before
done). All renderer PRDs: `timeout 300 npm run typecheck` + `npm run lint:selectors` +
targeted `timeout 300 npx vitest run <files>` must pass; add/extend vitest coverage for your
change.

---
title: Epics queue visual polish — header order, single 352px border, PRD line counts, icons
cwd: ~/Projects/session-manager
estimateMinutes: 12
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
dependsOn: [842-retire-legacy-tab-chat-rail]
---

# Goal

Close the remaining audited pixel deviations: (1) queue header block order — the mock puts
the EPIC QUEUE label + New Epic button ABOVE search/chips; shipped renders it below
(EpicQueue.tsx:248-258); (2) double-nested 352px border-r containers
(EpicQueueControls.tsx:243 + EpicQueue.tsx:247) produce a doubled hairline — one container
owns width+border; (3) PRD cards show a line count (read from the PRD file list metadata or
a cheap count via existing listPrds fields — if no source exists, read the file length via
the existing schedule.readPrd IPC lazily on card render, cached); (4) attachment chips use
the app icon set (AlmanacIcon/SMIcon equivalents) instead of emoji (attachments.tsx).

# Acceptance criteria

- [ ] Header order matches the mock; exactly one 352px border-r container; PRD cards show
  "<N> lines" when resolvable; no emoji in epics/ components. Existing tests updated.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— every rule is mandatory, especially Execution discipline (bounded commands, verify before
done). All renderer PRDs: `timeout 300 npm run typecheck` + `npm run lint:selectors` +
targeted `timeout 300 npx vitest run <files>` must pass; add/extend vitest coverage for your
change.

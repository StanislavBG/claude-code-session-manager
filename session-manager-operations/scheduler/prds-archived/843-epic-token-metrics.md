---
title: Token metric for Epics — derive, show in queue row + detail meta, restore sorts
cwd: ~/Projects/session-manager
estimateMinutes: 18
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
dependsOn: [842-retire-legacy-tab-chat-rail]
---

# Goal

The mock shows a tokens metric on queue rows, the detail meta row, and as a sort option;
v0.40.0 dropped it for lack of a data source. Add real token accounting: sum usage from the
Epic's transcript (the ~/.claude/projects/<encodedCwd>/<claudeSessionId>.jsonl usage events —
see how src/renderer/state/live.ts:~287-305 accumulates usage for live tabs, and
src/main/transcripts.cjs classification) exposed via a cheap main-process IPC that returns
{inputTokens, outputTokens} per sessionId (cached by file mtime), then surface it.

# Acceptance criteria

- [ ] New IPC (zod-validated) transcripts:usageFor(cwd, sessionId[]) → per-session token
  totals, mtime-cached in main; preload + api.d.ts typed.
- [ ] epicDerive.ts epicStats gains tokens (formatted k/M like the mock, e.g. 1.2M);
  EpicQueue row meta and EpicDetail meta row display it when available (omit when null).
- [ ] Sort options include "tokens" and "turns" (EpicQueueControls.tsx:45-49), replacing
  nothing — "PRD count" stays.
- [ ] Batched fetch at workspace level (one IPC call for visible Epics, refreshed on epic
  change/interval ≥30s) — no per-row IPC, no fresh-value zustand selectors.

# Implementation notes

Read live.ts usage accumulation + transcripts.cjs before writing the reader; reuse its JSONL
line classification, do not re-parse ad hoc. Formatting helper: one shared fn (check
lib/formatTime.ts siblings for conventions).

# Out of scope

- Cost/spend figures; History-tab analytics.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— every rule is mandatory, especially Execution discipline (bounded commands, verify before
done). All renderer PRDs: `timeout 300 npm run typecheck` + `npm run lint:selectors` +
targeted `timeout 300 npx vitest run <files>` must pass; add/extend vitest coverage for your
change.

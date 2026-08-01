---
title: Harden active-index.json write path in epicMint.cjs and fix stale key comment in EpicDetail
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
---

# Goal

Three low-severity correctness/maintenance gaps found in an integration audit of the Epic/Scheduler boundary:

1. src/main/lib/epicMint.cjs's ensureEpic and appendPrdCreatedEvent (~line 125-142) do a read-modify-write on active-index.json with no path-serialization lock, unlike the sibling implementation in src/main/promptSessionEvents.cjs (~line 47-61, which uses pendingWritesByPath/withPathLock) — currently safe by accident because no `await` sits between the read and write today, but a latent race if either function ever becomes async or gains a genuinely concurrent caller.
2. src/renderer/components/epics/EpicDetail.tsx's live-turn bubble (~line 583-595) uses a static React key ("epic-live-turn"/"epic-live-queued") while its comment claims it's "keyed by epicId" — harmless today (only one EpicDetail mounts at a time) but misleading if this component is ever reused in a multi-pane layout.
3. src/renderer/state/promptSessions.ts's mergeAppendedEvent and hydrate() merge path sort events by `Date.parse(e.at)` wall-clock timestamp rather than the causal `causedByEventId` FK chain — low risk today (single machine, same clock) but doesn't match the system's own "chain not tree" integrity model per epicMint.cjs's event-append comments, and could misorder the Discussion timeline under clock skew or same-millisecond ties between an optimistic renderer append and a broadcasted main-process append.

# Acceptance criteria

- [ ] epicMint.cjs's ensureEpic and appendPrdCreatedEvent use the same withPathLock/pendingWritesByPath serialization pattern as promptSessionEvents.cjs for their active-index.json read-modify-write, so the two files no longer diverge on this pattern
- [ ] EpicDetail.tsx's live-turn key is either scoped by epicId (e.g. `epic-live-turn-${epicId}`) or the misleading comment is corrected to state it is intentionally static because only one EpicDetail is ever mounted
- [ ] promptSessions.ts's event merge/sort in mergeAppendedEvent and hydrate() breaks ties (equal or unparseable `at` timestamps) using causedByEventId chain order rather than relying solely on wall-clock string comparison, OR if a full topological sort is out of scope, add a code comment explaining the accepted risk and why
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 600 npm run test:unit` passes.

# Implementation notes

Read src/main/promptSessionEvents.cjs ~line 47-61 for the existing withPathLock pattern to mirror in epicMint.cjs. Read EpicDetail.tsx ~line 225-230 (store composition — already verified correct, do not touch) and ~583-595 (the key in question). Read promptSessions.ts's mergeAppendedEvent and hydrate() merge/sort logic.

This PRD bundles three small, independent, low-risk fixes in related files — keep each change minimal and scoped.

# Out of scope

- Do not change PRD-write success-path behavior in scheduler.cjs
- Do not attempt a full topological/causal sort rewrite of the event timeline if it would be a large refactor — a documented tie-break heuristic or explicit comment is an acceptable outcome for the sort item

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

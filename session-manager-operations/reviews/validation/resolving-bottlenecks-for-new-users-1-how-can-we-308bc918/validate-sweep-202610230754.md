# Validation sweep 202610230754

Base: cf79f7d9. Gates re-run in the job worktree: the eight PRD spec files (8 files, 68 tests, all pass), `npm run typecheck` (exit 0), `lint:hooks` OK, `lint:selectors` OK.
Combined diff (50 files) was self-reviewed; `/code-review` was not run as a separate pass.

## seed-dev-plugin-repair-stale-marketplace — VERIFIED
- `marketplaceIsStale` at src/main/seedDevPlugin.cjs:95; repair gate at :164-165 (`marker.done && !deliberatelyDisabled && stale`).
- Deliberate disable (`enabledPlugins[...] === false`) at :105. Healthy install returns early at :165.
- The four named tests exist and pass in the gate run.

## boot-seeders-run-serially — VERIFIED
- src/main/lib/runSeeders.cjs: awaits each step in order, logs `[seed] <name> failed: <message>`.
- src/main/index.cjs:1458-1461: dev-plugin, agent-personas, scheduler-mcp in that order, not awaited.
- tests/unit/runSeeders.spec.ts has both named tests; they pass. Typecheck is green.

## voice-model-lazy-load — VERIFIED
- src/renderer/App.tsx has no initModel/preloadModel call (only a comment at :243).
- src/renderer/state/voice.ts: `ensureModelReady` at :500, called on record start at :621; `MODEL_IDLE_RELEASE_MS = 30*60*1000` at :456.
- The three named tests exist and pass. lint:hooks and lint:selectors are OK.
- RecordingStatus was not touched. I did not re-read the z-ladder mount.

## model-info-history-tail-read — VERIFIED
- src/main/lib/claude/effectiveModelInfo.cjs:140-142 uses `readHistoryFileTailSync` (maxRows 500, maxBytes 1 MB), exported from queueHistory.cjs:297,512.
- The tail-read tests pass. The 20 MB fixture and malformed-file cases were not read line by line.

## epic-chat-state-eviction — VERIFIED
- src/renderer/state/chat.ts:431-445 has dropEpicChat, touchEpicChat and evictIdleChats (max 8). Called at :1294-1295.
- src/renderer/state/promptSessions.ts:851 calls `useChat.getState().dropEpicChat`; `MAX_EVENTS_PER_EPIC = 500` at :190.
- chat.eviction.test.ts covers delete, 9th-Epic eviction, in-flight exemption, keep-visible and the events cap. All pass; lint:selectors is OK.

## heartbeat-memory-fields — VERIFIED
- src/main/scheduler.cjs:722 `memoryFields()`, spread before `entry` at :736, so the caller's keys win.
- Test 'heartbeat line carries memory fields' at scheduler-heartbeat-payload.test.cjs:38 passes.

## audit-log-streaming-rollover — VERIFIED
- src/main/lib/telemetry/auditLog.cjs: `renameSync` at :119, stream `pipeline` into an append-mode write stream at :79, `MAX_LIVE_BYTES = 32 MB` at :59, leftover pending files retried.
- Tests at auditLog.test.cjs:93, :108 and :121 pass.

## session-slots-ceiling-32 — VERIFIED
- sessionSlots.cjs:34-36 gives MIN 0, MAX 32, DEFAULT 5.
- sessionSlots.test.cjs asserts setCap(32) persists, setCap(33) throws, env 40 clamps to 32, and snapshot max is 32 (:36-42, :69-71, :102).
- schedulerConfig.cjs:21 reads sessionSlots.MAX_SLOTS, so it follows the new ceiling.

## Findings
- Critical: none.
- Important: none.
- Minor: the full `test:unit` suite was not run, only the scoped gates. Other specs that pin the old ceiling of 10 would not show up here. Renderer slot editors are the sibling PRD slot-editors-use-snapshot-max.

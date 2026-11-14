# Validation: telemetry trustworthy plan

Base: 62e7b144 (from PRD notes). Commits listed via `git log 62e7b144..HEAD`. Gates re-run in the foreground:
`npx vitest run` over src/main/lib/telemetry/__tests__/ plus the pty, chatRunner, crashDiagnostics and prdAgentType specs: 14 files, 94 tests, all passed.
`npm run typecheck`: exit 0. `grep -rn telemetryBacklog src` and the doc: clean.
`/code-review` and `/security-review` were not run as separate commands. I self-reviewed the diff instead (see Findings).

## telemetry-optout-immediate (3067) — VERIFIED
- `applySettings(cfg)` is at telemetryClient.cjs:804 and exported at :876. `telemetryConsent.cjs:30` calls it with the saved config.
- Flush re-checks `isEnabled` per channel, per batch and per install record (telemetryClient.cjs ~734, 740, 760). An opt-out mid-flush stops sends.
- telemetryClient-optout.test.cjs covers off and on, and passed. telemetryConsent.test.cjs also passed.

## retire-telemetry-backlog-main (3068) — VERIFIED
- telemetryBacklog.cjs and its test are deleted (diff stat). `grep telemetryBacklog src` is clean.
- The `bootDrain` block is removed from index.cjs (~l.496). `telemetry:status` returns plain `telemetryClient.status()` (telemetryIpc.cjs:41).
- `removeLegacyWatermarks` (telemetryBoot.cjs:~37) is best-effort and never throws. It is called at the end of bootSequence and tested in telemetryBoot.test.cjs.

## retire-telemetry-backlog-ui (3069) — VERIFIED
- SettingsTelemetry.tsx drops 7 lines. api.d.ts has no `backlog` (grep over api.d.ts, SettingsTelemetry.tsx, index.cjs and telemetryIpc.cjs is empty).
- TelemetryNotice.tsx:40-42 now names the machine profile, usage counts (launches, sessions, Epics, scheduler jobs), and error reports with messages and stack traces (file paths removed). "Never collected" is kept. Typecheck is green.

## telemetry-seeds-after-seeding (3070) — VERIFIED
- `lastSeedsReported` is in DEFAULTS, `isValid` and `normalize` (telemetrySettings.cjs:13, 44, 72, 86).
- `reportSeedsIfChanged` (telemetryBoot.cjs:~137) persists only when `accepted`. index.cjs ~1590 hooks it with `bootSeedingPromise.then(fn, fn)`, wrapped in try/catch and `.catch`.
- telemetryMachineSeeds.test.cjs covers changed, unchanged and rejected, and passed.

## telemetry-delivery-order-ts-4xx (3071) — VERIFIED
- `ts: Date.now()` is in the `track()` wire (telemetryClient.cjs:~484). Channel order is `['error','install','log','event']` (:~731).
- 429, 0 and 5xx return 'backoff' and stop the flush. 401/403 set `disabledForProcess`. Any other 4xx drops only that batch via `rejectRecords`, which increments `rejectedCount`, exposed in `status()`. The flush continues.
- telemetryClient-delivery.test.cjs passed.

## telemetry-chat-session-open (3072) — VERIFIED
- `trackSessionOpen({surface})` maps values outside `terminal|chat` to null (telemetryCounters.cjs:~28-34). pty.cjs:303 passes 'terminal'.
- chatRunner.cjs ~837 fires once, guarded by `!resumeFlag` and `sessionOpenTracked`. The new chatRunner-session-open-telemetry test, the pty test and the counters test passed.

## crash-cause-in-name-os-restart (3073) — VERIFIED
- `classifyUncleanShutdown` returns 'os-restart' when `bootUptimeSec < lastSampleAgeSec`. The check sits after memory-pressure and before unknown (crashTelemetry.cjs:~62).
- crashDiagnostics.cjs passes `os.uptime()` and the sample age, and uses the name `unclean-shutdown:${likelyCause}`. The longest cause, `compositor-disconnect`, gives a short name. Both specs passed.

## prd-agenttype-warn-once (3074) — VERIFIED
- prdAgentType.cjs now keys the dedupe by agentType alone. `isArchivedPrd` (`deps.archived` or a `/prds-archived/` path) returns early. prdAgentType.test.cjs passed.

## telemetry-doc-refresh (3075) — VERIFIED
- telemetry.md has "The three local stores" (l.24) and a retirement section (l.16-22). Its event `ts`, channel-order and 4xx-quarantine bullets are at ~l.272-275. "The five usage counters" is at l.301 and lists prd.create and the session.open surface.
- The stale app.launch audit paragraph is gone. The doc is 324 lines against 368 before. No `telemetryBacklog` string remains.

## Findings

### Critical
- none

### Important
- none

### Minor
- Not every acceptance criterion could be checked from a test. `crashDiagnostics` and `index.cjs` wiring were checked by reading the code only (index.cjs ~1590). No real-boot probe was run.
- The plan's commits also include extra files outside these PRDs (listPrdsSingleFlight, mainWindow null-safe listeners). They belong to the sibling crash-fix plan, which has its own record. They were not reviewed here.
- telemetryBoot.cjs:~118 vs ~137: bootSequence's own upsert does not record `lastSeedsReported`. On a boot where it reports, `reportSeedsIfChanged` will send a second install upsert once per version bump. This is cosmetic and bounded.
- The telemetry.md retirement section mentions `telemetry-watermarks.json`. This is intended context, not a stale reference.
- Self-review found no secrets, path traversal or unsafe input handling. `removeLegacyWatermarks` builds a fixed path under homedir.

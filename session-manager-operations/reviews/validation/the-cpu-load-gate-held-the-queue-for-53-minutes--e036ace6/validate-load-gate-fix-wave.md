# Validation: load gate fix wave (PRDs 2508-2512)

Base: 2871a039224ea897cb8242e007576e4fb40ef0a3. HEAD: 3e7d2797. PRD files found under `prds-archived/` (2508 to 2512). Commits by PRD (matched by the PRD's `# Files`): 152bc0a3 (2508), 0d7c1df1 (2509), d74882df (2510), 0c9c07b5 (2511), 3e7d2797 (2512). Diff stat: 13 files, +543/-97. Self-review only (no separate /code-review run); no unsafe input, secret, path or duplicated-helper issue found. The only shell-outs are the existing `ps` call in `topCpuConsumers`.

## cpu-sample-iowait-not-busy: VERIFIED
- parseProcStat returns `{busy: total-idle-iowait, iowait: nums[4], total}`, nice stays in busy: cpuSample.cjs:37-54.
- Non-linux readCpuTimes returns `iowait: 0`: cpuSample.cjs:77.
- sample() returns `{busyFraction, iowaitFraction, windowMs}`; iowait clamped 0..1 and a backwards iowait delta gives 0 without voiding the sample (the null rule uses only dTotal and dBusy): cpuSample.cjs:126-133.
- `cpuIowait` in evaluate results (loadGate.cjs:227, null on win32 at :173) and in `ScheduleLoadGate` (api.d.ts:1030).
- Header no longer says "nothing calls it"; the parseProcStat comment states the iowait reason: cpuSample.cjs:3-11, 28-31.
- Tests: cpuSample.test.cjs, loadGate.test.cjs and scheduler-load-gate-tick.test.cjs: 3 files, 64 tests pass.
- Gate: that vitest run plus `npm run typecheck` exit 0.

## health-and-heartbeat-name-the-hold: VERIFIED
- `lastTickFromHeartbeat` is pure, both null when the heartbeat or dispatch is missing, and exported: health.cjs:91-96, 1427.
- `scheduler_queue` spreads it from the same `heartbeat`: health.cjs:998. The loadRatio comment says raw, no CPU sample, read beside lastTickReason: health.cjs:999-1002.
- Tests for full, null and no-dispatch heartbeats, and the two load-deferred heartbeat cases, are in health-tick-liveness.test.cjs and scheduler-heartbeat-payload.test.cjs; 3 files, 31 tests pass.
- Gate: that vitest run plus typecheck exit 0.

## load-gate-hold-ends-on-launch: VERIFIED
- `endHold()` zeroes heldMs, lastHeldAt and lastEscalatedAt; evaluate() never resets: loadGate.cjs:193-197, 238-244. Credit is `max(0, min(t-lastHeldAt, cap))`: :195. A non-holding tick reports heldMs 0 without clearing the clock: :231.
- Yield stays armed until endHold (yielded recomputed from heldMs each tick): :198-201.
- tickBody counts `issued`; endHold, the audit row and the toast move after the loop, only when issued > 0: scheduler.cjs:7983-8006. endHold on the paused (:7750), drain (:7758) and empty-batch (:7832) returns; not on slots-exhausted or memory-deferred. `lastDispatchAtByCwd` stamps launchBatch: :7976.
- Tests present: scheduler-load-gate-tick.test.cjs:221 (endHold on drained, paused, launch; not memory-deferred) and :275 (a yield stamps only the launched project).
- Gate: the 6-file vitest run (7 files with 2511's list; 78 tests) plus typecheck exit 0.

## load-gate-saturated-holds: VERIFIED
- `SATURATED_BUSY = 0.85` is exported; saturated is `sample !== null && busy >= min(th, 0.85)`: loadGate.cjs:48, 199, 253.
- At the limit, saturated gives gated:true, yielded:false and heldMs keeps growing; a null or unsaturated sample yields: :200-202.
- `escalated` is per tick, once per yieldAfterMs, cleared by endHold, absent from snapshot() (it is in the return, not in `last`), false on win32: :203-207, 182, 235.
- tickBody gated branch with `load.escalated` writes `load_gate_escalated` with held slugs and `topCpuConsumers(3)`, sends one toast, launches nothing and returns `load-deferred`: scheduler.cjs:7941-7957.
- `loadGateAuditFields` and `loadGateStallEvent` are used by launch_load_gated (:7936), stood_down (:7968), yielded (:7998) and escalated (:7945).
- Tests: scheduler-load-gate-tick.test.cjs:175 (saturated hold launches nothing, one audit row, one toast), plus the loadGate.test.cjs band tests; all pass.
- Gate: vitest run (7 files, 78 tests) plus typecheck exit 0.

## load-gate-docs-three-bands: VERIFIED
- The three bands, escalation every 45 minutes, iowait/cpuIowait/nice, and when a hold ends (not on slots-exhausted or memory-deferred) are in scheduler-operations.md section 3 ("The CPU load gate").
- The diagnosis row names `load_gate_escalated` and no longer says the limit always yields; the reading note says health's scheduler_queue carries lastTickReason and lastTickDetail beside raw loadRatio.
- The comment above LOAD_GATE_PER_CORE in schedulerConfig.cjs matches; the diff is comment text only.
- Gate: `npm run lint:docs` (ok, 35 files) and loadGate.test.cjs exit 0.

## Inbound criteria, end to end: HOLD
I read tickBody's whole load-gate path (scheduler.cjs:7728-8008) plus evaluate().
- Idle CPU with high loadavg does not hold: standDown at busy < 0.5, gated:false (probe below).
- Saturated CPU holds, and a long hold escalates instead of launching (probe below).
- The detail carries the measure: `formatLoadGateDetail` and the `cpuBusy` / `cpuIowait` audit fields.
- Both CPU cases are covered by tests.
- The load gate has one evaluate() call site (scheduler.cjs:7928), so a hold, a launch and its audit row are written from one place. A yield audit row exists only when issued > 0, and the hold clock ends only then. No path where a hold, a launch and an audit row disagree, apart from the Minor items below.

## Real idle probe: PASS
Machine was NOT idle at the start (loadavg 20.27 from the prior full test run), yet the sample measured the CPU under half busy over the window, so the result is conclusive. 24 `dpark` parents (vfork, children sleeping 80 s), 75 s, real `os.loadavg()` and real /proc/stat, observe every 5 s:
`{"gated":false,"ratio":1.686,"threshold":0.85,"loadavg1":23.6,"cpuBusy":0.042,"cpuIowait":0.001,"cpuWindowMs":60008,"standDown":true,"cores":14,"heldMs":0,"yielded":false}`.
gated:false, standDown:true, cpuBusy 0.042 (under 0.5), cpuIowait numeric 0.001.

## Real saturation probe: PASS
Heartbeat `runningCount` was 1 (allowed). 14 spinners at nice 19, loadavg faked [30,30,30], yieldAfterMs 15000, holdCreditCapMs 60000, evaluate every 10 s:
- 10s: gated true, cpuBusy null (no sample yet, did not yield).
- 20s: cpuBusy 0.998, gated true, yielded false, heldMs 10024.
- 30s: cpuBusy 0.999, gated true, yielded false, **escalated true**, heldMs 20049.
- 40s: cpuBusy 0.997, gated true, yielded false, heldMs 30074.
- 50s: cpuBusy 0.997, gated true, yielded false, **escalated true**, heldMs 40099.
- 60s: cpuBusy 0.997, gated true, yielded false, heldMs 50124.
- 70s: cpuBusy 0.997, gated true, yielded false, **escalated true**, heldMs 60150.
Last three results all have cpuBusy >= 0.85, gated:true and yielded:false; escalated true on 3 ticks, one per 20 s (above the 15 s window). Spinners were killed; none remain.

## Full suite and lint: PASS
`npm run test:unit` with every SM_ variable unset (0 left): 862 files passed, 8161 tests passed, 1 skipped. `npm run lint`: exit 0. `npm run typecheck`: exit 0. No failure outside this plan's files.

## Findings
### Critical
- none
### Important
- none
### Minor
- scheduler.cjs:7973-7976 and :8007. `lastRunAt` and `lastDispatchAtByCwd` are stamped before the spawn loop, and the final `recordTick` reports `count: launchBatch.length` rather than `issued`. If cancel or a stale generation breaks the loop before any spawn, the row says fired:true and stamps the project though nothing launched. The hold clock and audit rows stay correct (they key on `issued`), but the tick record and the dispatch stamp can disagree with the launch.
- loadGate.cjs:231 and :194-197. A hold clock that saw no endHold (for example, load dropped and slots stayed full) keeps its heldMs until the next launch. The 2-minute credit cap bounds the effect, but a later hold can start with a stale partial figure.
- A pure-yield tick that issues 0 (cancel) leaves the yield armed by design. The toast and audit row wait for the next tick, which is correct but not covered by a test.

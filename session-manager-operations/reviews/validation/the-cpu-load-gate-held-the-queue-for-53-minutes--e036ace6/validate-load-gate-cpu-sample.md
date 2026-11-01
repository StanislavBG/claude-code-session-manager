# Validation: CPU-sampled load gate plan

Base `1153800c`, validated at HEAD `dbaf3966`. All five PRD files found under `prds-archived/` (2493-2497). Commits per PRD: 349f8db9 (cpuSample), 28c10ebf (Home strip), 31d70822 (decision), 4d4c4426 (honest hold), dbaf3966 (docs). `/code-review` and `/security-review` were not run as separate tools; I self-reviewed the combined diff (no spawn/path/input surface added beyond `fs.readFileSync('/proc/stat')` with a fixed path).

## cpu-busy-sampler — VERIFIED
- parseProcStat: `src/main/lib/scheduler/cpuSample.cjs:35-50` (`startsWith('cpu ')`, first 8 columns, busy = total − idle, null on empty/short/NaN).
- readCpuTimes: `cpuSample.cjs:56-77` (linux /proc/stat; else busy=user+nice+sys+irq; try/catch → null; empty list → null).
- createCpuSampler + constants 60000/20000/180000/5000: `cpuSample.cjs:17-22, 83-127`; observe skips null/young, trims past max (94-102).
- sample(): closest-to-window within [min,max], clamp via `Math.min(1, …)`, null on no entry/null read/dTotal<=0/dBusy<0 (`cpuSample.cjs:104-125`).
- `scripts/lib-layout.json:25` has `"cpuSample": "scheduler"`; test file present, 16 tests pass.
- Gate: cpuSample.test.cjs 16/16 pass; `npm run typecheck` exit 0.

## home-strip-names-load-gate — VERIFIED
- `queueConstraintLabel.ts:3-29` returns the old strings for memory/slots/held/paused, `lastTick.detail ?? 'CPU load gate holding'` for load-deferred, early nulls for null/fired/pending 0.
- `Home.tsx:61` imports it, `Home.tsx:955` calls it; grep for `lastTick.reason` in Home.tsx: no hits.
- Gate: queueConstraintLabel.test.ts 6/6 pass; typecheck 0; lint:selectors OK; lint:hooks OK.

## load-gate-cpu-decision — VERIFIED
- `loadGate.cjs:38` MOSTLY_IDLE_BUSY=0.5; `:135` cpu default; `:143-145` observe skips win32; `:172-175` standDown = over && sample && busy < min(th,0.5); null sample holds.
- Result fields cpuBusy/cpuWindowMs/standDown (`:157-159`, `:210-212`), win32 null/null/false; shouldAuditStandDown rate-limited (`:199-203`); `api.d.ts:1028-1033` documents them.
- `scheduler.cjs:2480-2481` `let loadGate` + `_setLoadGateForTests` (exported 11692); `:7715` observe() first statement in tickBody; `:7939` `load_gate_stood_down` audit; `:7904-7907` `launch_load_gated` carries cpuBusy/cpuWindowMs.
- `formatLoadGateDetail` `scheduler.cjs:2540-2546` prints `CPU N% busy over Ms` / `no CPU sample yet`.
- Gate: 8-file vitest set (loadGate, cpuSample, loadGateDetailTick, scheduler-load-gate-tick, queue-starvation-dispatch-driver, scheduler-shard-quarantine + the honest-hold extras) 79/79 pass; typecheck 0.

## load-gate-honest-hold — VERIFIED
- Absence check (`gatedSince|belowSince|RELEASE_WINDOW_MS|releaseWindowMs|escalate` in loadGate.cjs): clean. `gatedSinceMs` anywhere in src/: clean.
- heldMs credit/cap/reset: `loadGate.cjs:177-184`; cap 2 min `:48`; yield at `yieldAfterMs` default JOB_OVERRUN_FLOOR_MS, clock restart, reports reached heldMs `:185-192`.
- Yield tick: `scheduler.cjs:7917` launchBatch = first row only; `:7921-7925` audit with all required fields; `:7931` one `schedule:stall` send; spawn loop and recordTick use launchBatch (`:7952,7960`).
- Detail `held ${n}m with slots and memory free` (`scheduler.cjs:2545`); `api.d.ts` heldMs + yielded.
- Gate: loadGate/loadGateDetailTick/scheduler-load-gate-tick/queue-starvation-dispatch-driver/scheduler-starve-escalation/procname-sm-processes all pass (79 tests in the combined run); typecheck 0.

## load-gate-ops-docs — VERIFIED
- `scheduler-operations.md` section "The CPU load gate" (lines ~146-168): decision, no-sample rule, iowait/nice reasoning, 45-min yield with `load_gate_yielded` + toast, heartbeat-per-reason sizing with the 2026-10-31 worked example, `loadRatio` raw note.
- Diagnosis row at line 287 covers load-deferred detail, held Nm meaning, and the three audit kinds.
- `schedulerConfig.cjs:158-166` comment describes the sampled decision; no value change (`LOAD_GATE_PER_CORE: 0.85`).
- Gate: `npm run lint:docs` ok (21 junctions, 35 files); loadGate.test.cjs passes.

## Real probe (this kernel, 14 cores, SM_* unset)
24 × dpark (vfork/sleep 80) under real `createLoadGate()`, observe() every 5 s, 75 s timer. Start loadavg1 3.01 (machine quiet). Result:
`loadavg1 18.73, ratio 1.338 (threshold 0.85), cpuBusy 0.081 over cpuWindowMs 60011, gated:false, standDown:true, shouldAuditStandDown:true`; end loadavg [18.73, 9.22, 6.73]. CPU 8.1% busy, far under 50%, so the probe is conclusive: PASS.

## Full unit suite
`npm run test:unit` with every SM_ variable unset, at HEAD dbaf3966: 859 files passed, 8126 passed | 1 skipped, 0 failures. Also green: typecheck, lint:selectors, lint:hooks, lint:docs (bare `npm run lint` not used, per notes).

## Findings
### Critical
- none
### Important
- none
### Minor
- `src/main/lib/scheduler/loadGate.cjs:22-23` header still says the module tests "the escalation", and `:67-68` (`topCpuConsumers` doc) still says "held jobs past its escalation window"; escalation was removed in 4d4c4426. Comment-only drift.
- `loadGate.cjs:139-140` `lastHeldAt`/`lastStandDownAuditAt` are closure state not in `snapshot()`; intended per PRD, noted only so readers don't expect them.

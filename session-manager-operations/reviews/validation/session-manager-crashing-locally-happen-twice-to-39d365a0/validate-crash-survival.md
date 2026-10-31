# Validation: crash-survival plan

Base: d6bbe9f6b996d48abec68986c652ec91a00ad003 (given in PRD notes). PRD files found under `prds-archived/` (2453-2465).
Run with all `SM_*` env vars unset. Per-PRD gates (vitest of each new spec, 12 files / 66 tests) and `npm run typecheck`, `npm run lint:docs` re-run: all green. CLAUDE.md = 11,994 chars (< 12,000; unchanged by plan).
Full `npm run test:unit`: 848 of 849 files pass; **1 failure** (see Findings, Important #1).
Note: the `base..HEAD` range also contains an unrelated macro_delete plan (macro* files, domain-model.md); out of scope here.

## crash-scope-oom-policy-dropin — VERIFIED
- scopeOomPolicy.cjs:30-67 writes `10-oom-policy.conf` (`[Scope]\nOOMPolicy=continue`) via atomicFs; no-op on identical content, daemon-reload only after a write; non-Linux/no systemctl/throw → `{applied:false}`.
- index.cjs:1480-1486 calls it once in whenReady before `scheduler.init`, logs result. Spec passes.

## job-memory-scope-primitive — VERIFIED
- memoryScope.cjs exports present; spec (defaults, override, disabled, argv, unsupported, failing probe) passes; gate green.

## scheduler-jobs-run-in-memory-scope — VERIFIED
- scheduler.cjs `planJobScope` (unit `sm-job-<slug>-<startedAt>`, unwrapped fallback returns input target), spawn at ~4935-4955, `scopeUnit` stored in jobSupervisorRecord.cjs:43,54, `finalizeJobScope` in onExit logs memory.peak/oom_kill then stopScope once (guarded by `finalized`); cgroup read right after spawn. Spec passes.

## chat-turns-run-in-memory-scope — REFUTED — breaks existing tests/unit/chatRunner.spec.ts
- chatRunner.cjs:761-777 wraps with unit `sm-chat-<sid>-<attempt>-<ts>`, drops argv0 only when wrapped; stopAttemptScope on close/error/spawn-throw (once-guarded). Its own spec and gate pass.
- But full suite: `tests/unit/chatRunner.spec.ts:429` expects `-p` followed by `--model`; on a systemd host the wrapped argv puts `MemoryHigh=8704M` there. The PRD did not update/isolate that spec (its Files list omitted it).

## job-oom-bias-lets-size-decide — VERIFIED
- scheduler.cjs:436-441 `OOM_SCORE_ADJ_JOB = 200`, 5-line comment with arithmetic and incident; biasJobOomScore unchanged; exported; spec passes.

## memory-gate-sees-swap-exhaustion — VERIFIED
- parseMemInfo/readMemInfo/swapLimitedBatchSize exported; getAvailableMemMb fail-open retained; clamp = max(0, 1-running) when swap free <10%; no swap → no clamp; log once per hold (`swapGateLogged`). Spec passes.

## reconcile-stops-rereading-unchanged-prds — VERIFIED
- reconcileParseCache keyed by path, validated by fresh stat mtimeMs+size; pruned to live files; single-flight with one rerun flag; setImmediate yield every 10 files. Spec passes; existing reconcile tests green in full suite.

## linux-prefers-x11-over-wayland — VERIFIED
- ozonePlatform.cjs:7-14 matches all branches; index.cjs top-level `appendSwitch('ozone-platform')` before ready, logged in whenReady. Spec passes.

## cli-records-exit-and-respawns — VERIFIED
- bin/supervise.cjs (200-line cap, 5 MB rotate, 2 s delay, 5-in-10-min guard); cli.cjs stderr piped+teed, forwards SIGTERM/SIGINT, respawn only via shouldRespawn; `bin/` in package.json files. Spec passes.

## crash-diag-names-the-real-cause — VERIFIED
- crashTelemetry.cjs classify: Wayland string → compositor-disconnect, signal → `signal:<NAME>` before existing rules; crashDiagnostics.cjs reads exit record, 16 KB stderr tail, scope Result (2 s timeout); oom-scope-stop logged even when prev.open false; meta carries enum fields only. Spec passes.

## chat-inflight-ledger-primitive — VERIFIED
- chatInflight.cjs: begin/end/list, atomicFs, serialized promise chain, corrupt → empty, `SM_CHAT_INFLIGHT_PATH`; no prompt/env stored. chatRunner begin after spawn (:799), end in settle (:544). Spec passes.

## boot-recovers-chat-turns — VERIFIED
- chatBootRecovery.cjs wired in index.cjs after `registerChatHandlers`; orphan hold/release via chatRunner `orphanSessions` (blocks run()/pump()); 24 h guard via ledger `markRecovered`. Spec passes.

## doc-crash-taxonomy — VERIFIED
- conventions.md Avoid entry + post-mortem (7 deaths: 5 OOM, 2 compositor); scheduler-operations.md rows for compositor-disconnect, oom-scope-stop, job at memory cap; both docs name electron-stderr.log and scheduler-watchdog-relaunch.log. `lint:docs` ok.

## Findings
### Critical
- none
### Important
1. `tests/unit/chatRunner.spec.ts:429` red in the combined suite — caused by chatRunner.cjs:761-777 wrapping argv in `systemd-run`. Test must stub `scopeSupported` / set `SM_JOB_MEMORY_MAX_MB=0` or locate `-p` relative to the claude command.
### Minor
1. Tests that spawn through chatRunner depend on host systemd availability (wrapping is host-dependent); worth a global test default of scopes disabled.
2. `session-manager-operations/architecture/domain-model.md` change in the range belongs to the macro plan, not this one.

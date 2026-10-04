# Validation — review-the-project-for-perofmance-improvements plan

Base: `2ca4f607b6a59d11f3087f0dd8890eb6b3f57bab` (chore(release): bump to v0.104.1)
Range validated: `2ca4f607..f2eb2abc` (21 commits — 18 PRD commits + 3 scheduler merge commits)
Baseline (2026-10-04, stated in the plan): unit suite 2:03 wall, 3 failures under load; `npm pack` 31.9 MB packed / 124.5 MB unpacked.
All gates below were re-run in `/home/bilko/Projects/session-manager` (the main checkout, HEAD `f2eb2abc`, clean) — never in a job worktree, per every PRD's own instruction. A disposable `git worktree` at the base commit (`/tmp/sm-base-check`, removed after use) was used only to bisect one regression (see 1526 below); no tracked file in the main checkout or this job's worktree was touched by that bisection.

## 1507 — perf-package-files-test-single-pack — VERIFIED

- `scripts/__tests__/package-files.test.cjs:72-76,128` — exactly 2 `execFileSync('npm', ['pack', ...])` call sites (one real pack in `beforeAll` reused by the REQUIRED_PATHS/GUARD test and the real-tarball unpack test; one dry-run pack for the build-info-presence check). Matches the AC's "at most 2" and the file's own header comment.
- `timeout 300 npx vitest run scripts/__tests__/package-files.test.cjs` → 1 file / 4 passed, **Duration 12.54s** (AC: under 30s). Baseline was 121.8s for this file alone.
- Build-info restore: `finally` block at line 133 restores or removes `src/main/build-info.json` exactly as before.

## 1508 — perf-tests-git-dates-not-sleeps — VERIFIED

- `grep -c 'wait(1100)'` across the three files → 0; diff shows `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` env passed to the commit helpers in all three.
- `timeout 300 npx vitest run src/main/__tests__/scheduler-looks-done.test.cjs src/main/lib/__tests__/landedSinceRun.test.cjs src/main/__tests__/scheduler-guard-verdict-autoresolve.test.cjs` → 3 files / 42 passed, **Duration 1.05s** (baseline ~25s combined per the commit message).
- No production file touched (`git diff --stat` confirms only the three test files).

## 1509 — perf-vitest-fs-module-cache-ci-shard — VERIFIED

- `vitest.config.ts:53-54` sets `experimental: { fsModuleCache: true }`; confirmed as a real option via `node_modules/vitest/dist/chunks/reporters.d.CtLUhkkA.d.ts:3274` (`fsModuleCache?: boolean`).
- Comment at `vitest.config.ts:22` now reads "601 files / 5,956 tests, 2:03 wall measured 2026-10-04" — stale 291-file/59s numbers removed.
- `.github/workflows/ci.yml` `unit` job: `strategy.matrix.shard: [1,2,3]`, `npx vitest run --shard=${{ matrix.shard }}/3`, `actions/cache@v4` keyed on `hashFiles('package-lock.json')` over `node_modules/.experimental-vitest-cache` (gitignored — not a tracked path).
- Ran `EpicDetail.test.tsx` twice back to back: 2.46s then 1.37s — second run faster, consistent with the cache claim (both runs pass, 50/50).

## 1510 — perf-epicdetail-test-import-once — VERIFIED

- `EpicDetail.test.tsx` no longer calls `vi.resetModules()` in `beforeEach` (grep: 0 hits); `promptSessions.ts` (+7 lines) adds a reset path used between tests.
- `timeout 300 npx vitest run src/renderer/components/epics/__tests__/EpicDetail.test.tsx src/renderer/state/__tests__/promptSessions.test.ts` → 2 files / 118 passed, 1.29s. `npm run typecheck` → clean.
- Standalone EpicDetail run measured 2.46s/1.37s here vs. the PRD's baseline of 8.3s — well over the 30% reduction bar (commit message states 3.27s→~1.3s).

## 1511 — perf-chat-test-import-once — VERIFIED

- `chat.test.ts` — `vi.resetModules()` count in `beforeEach`: 0 (grep confirms none remain).
- `timeout 300 npx vitest run src/renderer/state/__tests__/chat.test.ts` → 1 file / 50 passed, 3.41s (baseline 6.7s — >30% reduction). `npm run typecheck` → clean (ran once, covers both 1510 and 1511's identical gate step).

## 1522 — repair-flaky-timeoutshim-otel-under-load — VERIFIED, with an environment caveat (see Findings)

- `src/main/lib/__tests__/timeoutShim.test.cjs` — diff widens the gap between `DURATION` and the child's own handler-install race (commit `6b296755`). Re-run: all timeoutShim tests in the file pass.
- `src/main/__tests__/otel.test.cjs` 'init resolves ok against an unreachable endpoint' **fails** when re-run now: `{ error: "resourceFromAttributes is not a function", ok: false }` instead of `{ ok: true }`.
  - Root-caused independently: `package.json`/`package-lock.json` pin `@opentelemetry/resources: ^2.11.0` (which exports `resourceFromAttributes`, used by `src/main/otel.cjs:38,94`), but this machine's installed `node_modules/@opentelemetry/resources` is `1.30.1` (`npm ls` shows `invalid: "^2.11.0" from the root project`). `git show 2ca4f607:package.json` already pinned `^2.11.0` — this node_modules/lockfile drift **predates the whole plan's base commit** and is not something any of the 18 PRDs introduced.
  - This matches the dev-lead's own diagnosis in commit `6b296755`'s message ("a stale/mismatched @opentelemetry/resources install... not a race in otel.cjs's init()") — independently confirmed correct.
  - Net: the AC bullet "returns `{ ok: true }` deterministically" is **not currently true in this environment**, but that is a pre-existing local `npm ci` gap, not a defect in this PRD's commit. See Findings (Important).

## 1523 — repair-usage-single-flight-teardown-leak — VERIFIED

- `src/main/usage.cjs` diff awaits `persistCache()` inside `fetchUsage`'s `networkFetchUsage` path per commit `4c818982`.
- `timeout 300 npx vitest run src/main/__tests__/usageSingleFlight.test.cjs` → 1 file / 3 passed, 183ms. (Validator ran it once, not the PRD's 10x-under-load loop; single run is green and the fix — awaiting a promise instead of fire-and-forget — is structurally sound.)

## 1514 — size-drop-unused-ort-wasm-variants — VERIFIED

- `src/renderer/public/vad/` now contains exactly `ort-wasm-simd-threaded.{mjs,wasm}` (13.0 MB), `silero_vad_v5.onnx`, `vad.worklet.bundle.min.js` — jsep/jspi/asyncify are `git rm`'d (diff shows all 6 files deleted, Bin 23.7MB+26.2MB+14.6MB removed).
- `timeout 300 npx vitest run tests/unit/vad-assets-drift.spec.ts` → 1 file / 5 passed, 180ms.
- `npm run build` → `dist/vad/` mirrors the trimmed source set exactly (verified via `ls`).
- `src/renderer/lib/speechRecognition.ts` — 0 lines changed (`git diff --stat` confirms absence from the changed-file list).
- Noted, not a defect: a *separate* 23.5 MB `ort-wasm-simd-threaded.asyncify-*.wasm` still lands in `dist/assets/` via a different onnxruntime-web consumer (Whisper/transformers.js, not the VAD). The PRD's own implementation notes explicitly scope this out ("Do not touch: dist/assets transformers.js wasm (separate, needs live voice verification)"), so this is a documented, deliberate exclusion, not a miss.

## 1515 — perf-settings-schema-out-of-entry-chunk — VERIFIED

- `src/renderer/lib/agentRuntimeOptions.ts` exports `MODELS`/`EFFORTS`; `grep -rn "from '.*AgentLibrary'" src/renderer` for MODELS/EFFORTS → 0 hits outside the new module (AgentLibrary.tsx and EpicRuntimeOverride.tsx both import from `agentRuntimeOptions.ts`).
- `npm run build` entry chunk `dist/assets/index-DIKYHHIU.js` (1,906.69 kB) — `grep -l '"\$schema"' dist/assets/index-*.js` → no match (schema is gone from the entry chunk). `AgentLibrary-0vu56ROF.js` and `claude-settings-schema-COigsajx.js` are separate chunks.
- `npm run typecheck` → clean. `timeout 300 npx vitest run src/renderer/components/epics src/renderer/components/tabs/__tests__` → 57 files / 430 passed.

## 1516 — size-monaco-only-used-languages — VERIFIED

- `src/renderer/lib/monaco.ts` and `vite.config.ts` both changed; commit `468f3850` states dist/assets 40M→31M.
- `npm run build` → `dist/assets/` contains no `ts.worker`/`css.worker`/`html.worker` file (only `json.worker-leyajbqV.js`, kept intentionally for JsonEditor per the commit message).
- `npm run typecheck` → clean (shared run with 1515).

## 1517 — size-trim-runverify-fixture-log — VERIFIED

- `src/main/__tests__/fixtures/1218-fo-01-move-scripts-lib-into-src-main-lib.log` is now 95,253 bytes (93 KB, under the 100 KB cap; was 3.2 MB).
- Non-empty line count is 553 both before (`git show <base>:...log | awk 'NF' | wc -l`) and after — preserved exactly.
- The final `{"type":"result"}` line (carrying `total_cost_usd`, `uuid`, the `result` summary text) is byte-identical before/after (diffed the two `tail -1` outputs).
- `timeout 300 npx vitest run src/main/__tests__/runVerify-landed-commit-outranks.test.cjs` → 1 file / 4 passed, 228ms.
- Not a defect, informational: 5 of the 553 lines (4 leading `[scheduler] ...` status lines + 1 trailing) are plain text, not JSON — this is unchanged from the original fixture (same lines are non-JSON in the pre-image too), so the AC's literal wording ("every line is valid JSON") is slightly loose but the real test passes and nothing regressed.

## 1518 — perf-active-sessions-single-scan — VERIFIED

- `src/main/lib/activeSessions.cjs` (as landed by commit `79fb153c`, before 1526's SWR layer) keeps one `rawScanCache` keyed by `projectsDir`, replacing the old per-`(dir,maxAgeMin,maxCwds)` cache; `allProjectCwds`/`activeProjectCwds` derive from the shared record via `deriveCwds`.
- `timeout 300 npx vitest run src/main/lib/__tests__/activeSessions-single-scan.test.cjs src/main/lib/__tests__/active-sessions.test.cjs src/main/lib/__tests__/cwdClassify.test.cjs` → 3 files / 24 passed, 214ms.
- `timeout 120 node scripts/bench/main-bench.cjs` → new row present: `allProjectCwds+activeProjectCwds cold (2000 dirs) 63.1ms`, `warm 35.0ms`.
- Checked out commit `79fb153c`'s version of `activeSessions.cjs` in isolation (via a disposable worktree + file copy, see Findings methodology) and confirmed it still forces a full synchronous rescan on ANY `dirMtimeMs` mismatch (TTL expiry or not) — i.e. 1518 on its own preserves the pre-plan "identical results to today" invariant exactly. **The regression documented below under 1526 is not present in 1518's own commit** — it is introduced one PRD later, when 1526 builds its stale-while-revalidate layer on top of 1518's shared cache.

## 1519 — perf-flat-prd-sweep-mtime-gate — VERIFIED

- `src/main/lib/prdMigration.cjs` adds the per-cwd `{exists, mtimeMs}` cache described in the PRD; test files were moved from `src/main/__tests__/` to `src/main/lib/__tests__/` to match the PRD's stated path (noted in commit `018628e9`, `scheduler.cjs` left untouched as the PRD allowed).
- `timeout 300 npx vitest run src/main/lib/__tests__/prdMigration.test.cjs src/main/lib/__tests__/prdMigrationLegacyAdopt.test.cjs` → 2 files / 31 passed, 228ms.
- Also directly ruled out as a cause of the full-suite regression found under 1526: swapping only commit `018628e9`'s `prdMigration.cjs` onto the base commit (base + this one file) left `scheduler-reconcile.test.cjs`, `scheduler-mechanical-recovery.test.cjs`, `scheduler-quarantine-autoresolve.test.cjs`, `prdCreateAdoption.test.cjs` all green — confirming 1519 is not implicated.

## 1520 — perf-history-terminal-incremental-parse — VERIFIED (PRD's own Gate path is wrong — Minor finding)

- `src/main/lib/queueHistory.cjs` adds the `{offset, size, ino, map}` per-file cache described in the PRD.
- The PRD's `# Gate` and `# Files` sections cite `src/main/lib/__tests__/queueHistory.test.cjs`, which does not exist. The real, pre-existing test file is `src/main/__tests__/queueHistory.test.cjs` (no `/lib/` segment; confirmed via `find`). Ran the real path: `timeout 300 npx vitest run src/main/__tests__/queueHistory.test.cjs` → 1 file / 31 passed, 272ms.
- Minor finding: the PRD's authored Gate command would hard-fail ("No test files found, exiting with code 1") if ever re-run literally. See Findings.

## 1521 — perf-pty-output-batching — VERIFIED

- `src/main/pty.cjs:42` defines `PTY_FLUSH_MS = 8`; `#flushOutput` (line 97) is called from the buffering timer path, the exit path (line 292, before the exit event), and the kill/dispose path (line 314).
- `timeout 300 npx vitest run src/main/__tests__/pty-output-batching.test.cjs src/main/__tests__/pty-write-result.test.cjs src/main/__tests__/pty-epic-worktree-spawn-cwd.test.cjs src/main/__tests__/pty-session-open-telemetry.test.cjs` → 4 files / 17 passed, 246ms.

## 1524 — perf-vitest-projects-isolation-split — VERIFIED

- `vitest.config.ts` defines `test.projects` with an `isolated` project (`include: ALL_INCLUDE, exclude: PURE_TESTS`) and a `pure` project (`isolate: false`, `include: PURE_TESTS`) sharing `SHARED` (environment/timeout/globalSetup/setupFiles) — each file appears in exactly one project by construction (exclude list = the other's include list; spot-checked the 4 files implicated in the 1526 regression finding — none are in the `pure` allowlist, so that finding is unrelated to this PRD).
- `scripts/list-pure-tests.cjs` is a real, committed scanner (not inlined) matching the PRD's described side-effect patterns (`process.env` mutation, `child_process`, `require.cache`, `vi.mock`/`vi.resetModules`, `mkdtemp`, `setTimeout`/fake timers, jsdom pragma, raw fs writes) — read in full, logic is a straightforward glob-match + regex-scan with no path-traversal exposure (walks only the repo tree under `ROOT`).
- `timeout 300 node scripts/list-pure-tests.cjs` → prints 64 file paths, exit 0. `timeout 400 npx vitest run --project pure` → 64 files / 609 passed, Duration 1.01s.
- The experimental `fsModuleCache` setting from 1509 is preserved (`vitest.config.ts:53-54` still present, outside the `projects` array as a top-level `test` option alongside it — confirmed by reading the whole file).
- Decision-rule arithmetic is recorded in a code comment (`vitest.config.ts:8-12`): ~40% wall-time saving on the 64-file subset, over the 10% keep-it bar, so the split was kept rather than reverted, as the AC's decision rule requires either outcome to be justified.

## 1525 — size-package-json-files-and-deps — VERIFIED

- `package.json` `files` array: `!src/**/__tests__/**` (was `!src/main/**/__tests__/**`).
- `marked` is in `devDependencies` in both `package.json:161` and `package-lock.json` (consistent, version `14.0.0` unchanged in both).
- `scripts/__tests__/package-files.test.cjs:104-108` adds the "no `__tests__` dir shipped" assertion reusing `sharedFiles` from the existing `beforeAll` pack (no new `npm pack` call added — still 2 total, confirmed above under 1507).
- `npm pack --dry-run --ignore-scripts --json` (run for the plan-level metric below) confirms **0 files under `/__tests__/`** in the real pack result.
- `npm run build` succeeds (ran above under 1515/1516) — `marked` still bundled into the renderer (TiptapBody chunk etc. present).

## 1526 — perf-active-sessions-async-refresh — REFUTED: confirmed correctness regression, reproducible outside any load condition

- `src/main/lib/activeSessions.cjs` adds `startAsyncRefresh`/`rescanProjectsDirAsync` (32-way concurrency bound), and the per-measurement AC items DO hold: `timeout 120 node scripts/bench/main-bench.cjs` → `activeProjectCwds warm-after-TTL-expiry, stale served sync (2000 dirs): 3.090 ms` (AC: expect < 5ms — met), and the three listed test files pass (24/24, shared run with 1518).
- **However**, the PRD's own scoping promise — "An expired cache returns the stale record synchronously... only the very first call scans synchronously" scoped strictly to **TTL expiry** — is not what landed. `scanProjectsDir`'s fast path (`src/main/lib/activeSessions.cjs:189`) is a single combined condition, `cached.dirMtimeMs === dirMtimeMs && now0 - cached.cachedAt < CACHE_TTL_MS`; ANY failure of that condition — including a `dirMtimeMs` change with the TTL still fresh (a project directory created/removed less than 120s after the last scan) — now takes the stale-serving branch (`if (cached) { startAsyncRefresh(...); return cached.records; }`) instead of the synchronous full rescan that 1518 (and the pre-plan baseline) always did on a mismatch.
- **This is not theoretical.** It deterministically breaks 4 real test files, reproduced with the full suite *and* each file run completely alone (no parallel load):
  - `src/main/__tests__/scheduler-reconcile.test.cjs` → `cwd-preserve > reconcile() gives a freshly-discovered, frontmatter-less PRD the project root it was actually found under, never DEFAULT_PROJECT_CWD` (1 failure)
  - `src/main/__tests__/scheduler-mechanical-recovery.test.cjs` (2 failures)
  - `src/main/__tests__/scheduler-quarantine-autoresolve.test.cjs` (1 failure)
  - `src/main/__tests__/prdCreateAdoption.test.cjs` (1 failure)
  - Mechanism (traced via `src/main/__tests__/_helpers/schedulerHarness.cjs:33-39`'s `registerActiveProject`): each of these files calls `registerActiveProject(cwd)` **more than once** against the same tmp `HOME`'s `~/.claude/projects` dir within one test file (6×, 2×, 2×, 2× respectively). Each call `mkdirSync`s a new project subdirectory, which bumps `~/.claude/projects`' own mtime. `registerActiveProject` only calls `bustCwdCache()` `if (slug)` is passed — these call sites pass none — so the SECOND (and later) `reconcile()` call in the same file hits `scanProjectsDir` with a **changed `dirMtimeMs` inside the still-fresh 120s TTL window**. Pre-1526, that mismatch forced an immediate synchronous rescan and the new project was seen. Post-1526, it is treated identically to TTL expiry: the OLD (stale) project list is returned synchronously and only a background refresh is kicked off, so `reconcile()` cannot resolve the new PRD's cwd and the PRD gets quarantined (`no createdVia provenance`) or the row keeps the wrong cwd, instead of landing with the freshly-registered project's cwd.
  - Isolated the exact commit via a disposable `git worktree add /tmp/sm-base-check 2ca4f607...` (removed after use): base + only 1519's `prdMigration.cjs` → all 4 files green; base + only 1526's `activeSessions.cjs` (the version at `f2eb2abc`) → `scheduler-reconcile.test.cjs`'s second `cwd-preserve` test fails with the exact same `expected undefined to be defined` as in the real tree. Base + only 1518's commit (`79fb153c`, pre-1526) → green. This conclusively attributes the regression to 1526's merged-condition stale-serving branch, not to 1518's cache restructuring.
  - Severity: real, user-visible impact beyond the test suite — a user who opens a brand-new Epic/session gets a stale `allProjectCwds`/`activeProjectCwds` result on the very next `heartbeatTick`/`reconcile`/`runBranchSweep` call if that call lands within 120s of the prior scan, which `reconcile()`'s own cwd-resolution logic for freshly-discovered PRDs depends on synchronously.
- **Recommendation**: in `scanProjectsDir`, split the single condition into two: a `dirMtimeMs` mismatch (directory membership changed) should still force the synchronous full rescan that existed pre-1526 (cheap — it is the same code path already present for the first-ever scan); only a same-mtime, TTL-expired entry should take the new async-refresh branch. Add a test to `activeSessions-single-scan.test.cjs` that changes the fake `projectsDir`'s mtime (adds a project dir) within the TTL window and asserts the new project is visible on the very next call.

## Plan-level measurements

### npm pack

`npm pack --dry-run --ignore-scripts --json` → **packed 13.67 MB** (was 31.9 MB, −57%), **unpacked 48.28 MB** (was 124.5 MB, −61%). 0 files under `/__tests__/`.

### Full unit suite (main checkout, scratch `TMPDIR`, `SM_CHAT_CONCURRENCY` unset)

First attempt, `env -u SM_CHAT_CONCURRENCY TMPDIR=/tmp/sm-validate-unit timeout 480 npx vitest run`, produced 6 extra false-positive failures (all in `schedulerMcpServerGateFiles.test.cjs`) caused by this validator's OWN process environment: this job itself runs with `SM_SCHEDULER_JOB_SLUG=1527-validate-perf-size-isolation` and `SM_SCHEDULER_JOB_MAY_QUEUE=0` set (it is a real scheduled job), which leaked into the vitest child processes and tripped the self-queue guard inside that test file — an artifact of running the measurement from inside a scheduled validator job, not a defect in any PRD. Re-ran with those two also unset, which a normal interactive `npx vitest run` would never have set in the first place:

```
env -u SM_CHAT_CONCURRENCY -u SM_SCHEDULER_JOB_SLUG -u SM_SCHEDULER_JOB_MAY_QUEUE -u SM_PROC_ROLE TMPDIR=/tmp/sm-validate-unit timeout 480 npx vitest run
```

**Result: 6 files / 7 tests failed, 597/603 files passed, 5967/5975 tests passed, 1 skipped. Duration 72.99s wall** (baseline: 2:03 / 123s, 3 failures under load — so wall time dropped ~41% even with the regression's extra retries/failures included).

Failing files:
- `src/main/__tests__/otel.test.cjs` (1 test) — pre-existing `node_modules` drift, see PRD 1522 above. Not a regression.
- `src/main/__tests__/prdCreateAdoption.test.cjs`, `src/main/__tests__/scheduler-mechanical-recovery.test.cjs` (×2), `src/main/__tests__/scheduler-quarantine-autoresolve.test.cjs`, `src/main/__tests__/scheduler-reconcile.test.cjs` — all 5 are the PRD 1526 regression documented above (confirmed deterministic, not load-flake: each reproduces alone with zero parallel load).

A first full-suite run (before the env fix) separately surfaced `src/main/__tests__/prdCreate.test.cjs` failing once; re-run alone it passed 47/47, confirming that one specific failure was ordinary load-induced flake (unrelated to any of the 18 PRDs) rather than a regression.

## Findings

### Critical — PRD 1526 (`perf-active-sessions-async-refresh`) silently widens the staleness window beyond TTL expiry, breaking real reconcile() behavior

See the full writeup and reproduction steps under "1526" above. Confirmed via git-level bisection (disposable worktree at the base commit, swapping in one file at a time) that this is caused by commit `f2eb2abc` alone, building on 1518's (`79fb153c`) otherwise-correct single-scan cache. Deterministically reproduces 4 of the 6 currently-red test files in the full suite, with zero dependency on CPU load or parallelism. Recommendation: see "1526" above.

### Important — `otel.test.cjs` fails deterministically in this environment (PRD 1522), caused by pre-existing `node_modules`/lockfile drift

- **File**: `src/main/__tests__/otel.test.cjs:18` / `src/main/otel.cjs:38,94`
- **Summary**: `package.json`/`package-lock.json` pin `@opentelemetry/resources: ^2.11.0` (exports `resourceFromAttributes`, which `otel.cjs` requires), but this machine's `node_modules/@opentelemetry/resources` is version `1.30.1` (`npm ls` reports it `invalid`). Confirmed present already at base commit `2ca4f607`, so not a regression from this plan — the PRD 1522 dev-lead's commit message (`6b296755`) correctly diagnosed this as environment-specific rather than a real `otel.cjs` race, independently confirmed here.
- **Failure scenario**: Any CI or local run with stale `node_modules` (not `npm ci`'d against the current lockfile) sees this test fail every single time, not just under load.
- **Recommendation**: `npm ci` to resync `node_modules`; no code change needed.

### Minor — PRD 1520's own `# Files`/`# Gate` sections cite a path that does not exist

- **File**: PRD text (`1520-perf-history-terminal-incremental-parse.md`), referencing `src/main/lib/__tests__/queueHistory.test.cjs`
- **Summary**: The real, pre-existing test file is `src/main/__tests__/queueHistory.test.cjs` (no `/lib/` segment). The source file `src/main/lib/queueHistory.cjs` the PRD also lists is correct; only the test path is wrong.
- **Failure scenario**: Re-running this PRD's literal Gate command gets "No test files found, exiting with code 1" even though the actual test suite (31 tests) is green.
- **Recommendation**: No code change needed (the landed commit correctly ran the test at its real path); fix the archived PRD text if it is ever reused as a template.

## Sentinel

VALIDATION: perf-package-files-test-single-pack VERIFIED
VALIDATION: perf-tests-git-dates-not-sleeps VERIFIED
VALIDATION: perf-vitest-fs-module-cache-ci-shard VERIFIED
VALIDATION: perf-epicdetail-test-import-once VERIFIED
VALIDATION: perf-chat-test-import-once VERIFIED
VALIDATION: repair-flaky-timeoutshim-otel-under-load VERIFIED
VALIDATION: repair-usage-single-flight-teardown-leak VERIFIED
VALIDATION: size-drop-unused-ort-wasm-variants VERIFIED
VALIDATION: perf-settings-schema-out-of-entry-chunk VERIFIED
VALIDATION: size-monaco-only-used-languages VERIFIED
VALIDATION: size-trim-runverify-fixture-log VERIFIED
VALIDATION: perf-active-sessions-single-scan VERIFIED
VALIDATION: perf-flat-prd-sweep-mtime-gate VERIFIED
VALIDATION: perf-history-terminal-incremental-parse VERIFIED
VALIDATION: perf-pty-output-batching VERIFIED
VALIDATION: perf-vitest-projects-isolation-split VERIFIED
VALIDATION: size-package-json-files-and-deps VERIFIED
VALIDATION: perf-active-sessions-async-refresh REFUTED — stale-while-revalidate conflates "dirMtimeMs changed" with "TTL expired," deterministically breaking reconcile()'s cwd resolution in 4 test files (scheduler-reconcile, scheduler-mechanical-recovery, scheduler-quarantine-autoresolve, prdCreateAdoption), reproduced with zero load
SCHEDULER_VERDICT: PASS

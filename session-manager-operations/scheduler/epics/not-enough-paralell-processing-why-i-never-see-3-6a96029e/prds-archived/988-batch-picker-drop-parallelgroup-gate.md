---
title: Delete the parallelGroup wave gate — fire every dependsOn-eligible PRD, not one per tick
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 55
sourcePromptId: not-enough-paralell-processing-why-i-never-see-3-6a96029e
---
# Goal

Measured max concurrency across 25 recorded runs in history.jsonl is 1 — never 2, despite a 5-slot pool. Root cause: PRD 832 made `parallelGroup` strictly unique per PRD and moved ordering to `dependsOn` (prdCreate.cjs:173 warns an explicit group is "deprecated and ignored"), but `src/main/lib/schedulerBatch.cjs` still treats it as a wave number. `pickForProject` filters the batch to a single `lowestPendingGroup` (lines 156/171/188) — with unique numbers every group is a singleton, so the batch is ALWAYS exactly 1 job — and its running-gate (lines 141-145) additionally holds every higher group while a lower one is in flight, which with monotonically-increasing allocation means every newly-queued PRD. Delete the group logic entirely and let `dependsOn` be the sole ordering primitive: fire every dependency-eligible pending job up to the available slots.

# Acceptance criteria

- [ ] `pickForProject` in src/main/lib/schedulerBatch.cjs no longer reads `parallelGroup` for batch membership: the `lowestPendingGroup` / `activeGroups` / `lowestActive` computation and the three `.filter((j) => (j.parallelGroup ?? 99) === ...)` batch filters are gone.
- [ ] The batch is built from ALL pending jobs whose `dependsOn` are satisfied (the existing `pending[]` array produced by the `blockingDep` loop at lines 78-96), ordered by parallelGroup ascending as a PRIORITY HINT only, then `.slice(0, slots)`.
- [ ] The failed-dependency hold (`heldByFailedDep`, lines 88-96) is preserved verbatim, including its `depends-gate` reason string.
- [ ] The cross-group failure gate at lines 108-120 (`j.status === 'failed' && parallelGroup < lowestPendingGroup`) is replaced by dependsOn-scoped semantics: a failed job holds ONLY jobs that transitively depend on it, never every higher-numbered job in the project. Jobs with no dependency path to the failure remain eligible.
- [ ] `pickNextBatch`'s global slot accounting (`effectiveRunning = Math.max(running.size, queueRunningCount)`, `slots = cap - effectiveRunning`) and its per-project fan-out/sort are unchanged by this PRD.
- [ ] A new unit test in the existing schedulerBatch spec asserts: given 4 pending jobs with unique parallelGroups and empty `dependsOn`, and `slots = 5`, `pickNextBatch` returns all 4 (this fails on current main, which returns 1).
- [ ] A new unit test asserts a job whose dep is still `pending` is excluded while its independent siblings are included in the same batch.
- [ ] A new unit test asserts a `failed` job holds its transitive dependents but NOT an unrelated higher-numbered job.
- [ ] `npm run typecheck` passes.
- [ ] `npm run test:unit` passes with no pre-existing schedulerBatch test regressions; any existing test that asserted single-group wave behaviour is UPDATED to the new contract with a comment explaining the PRD 832 rationale, not deleted.

# Implementation notes

Read `src/main/lib/schedulerBatch.cjs` in full first — it is a pure module with no Electron deps, which is why it is unit-testable in isolation.

Live evidence to reproduce before changing anything (run from repo root, expect `["979-fix-transcript-paged-reads"]` — one job — on current main):
```
node -e "const{pickNextBatch}=require('./src/main/lib/schedulerBatch.cjs');const q=require('./session-manager-operations/scheduler/state/queue.json');const idle=q.jobs.map(j=>j.status==='running'?{...j,status:'pending'}:j);console.log(pickNextBatch(idle,new Set(),5).batch.map(j=>j.slug))"
```
After the change the same command must return the 4 dependency-eligible slugs (985/984/983/980 families), not 1.

The `late-arrival` branch (lines 147-163) is dead code in practice — PRD numbers are allocated monotonically upward so a pending group is never LOWER than an active one. It goes away with the rest of the group logic; do not try to preserve it.

Do NOT touch the downstream gates in `scheduler.cjs` `tickQueue` (lines ~3195-3250) — `sessionSlots.available()`, the memory gate (`memoryLimitedBatchSize`, `RESERVED_HOST_MB=3000`, `MIN_FREE_MB_PER_JOB=2500`) and the per-job `sessionSlots.acquire` at spawn time are the real safety net and stay exactly as they are. This PRD only stops the picker from artificially clamping the batch to 1 before those gates ever see it. The `concurrencyCap` is handled by a separate follow-up PRD — leave it alone here.

Keep `parallelGroup` on the job row and in frontmatter (it is the PRD number and is used for display, run-dir naming and `scheduler.cjs:3679`'s fix-slug derivation) — this PRD only removes its use as a BATCH GATE.

Read session-manager-operations/scheduler/standards.md (or the standards file the executor is pointed at) before writing code.

# Out of scope

- Changing concurrencyCap or sessionSlots (separate PRD)
- Any renderer/UI change
- Removing the parallelGroup field from job rows or PRD frontmatter
- Migrating legacy PRDs that lack dependsOn

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

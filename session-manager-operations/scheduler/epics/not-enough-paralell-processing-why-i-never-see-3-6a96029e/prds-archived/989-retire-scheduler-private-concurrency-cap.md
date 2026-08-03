---
title: Retire the scheduler's private concurrencyCap — the session slot pool is the sole limiter
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: not-enough-paralell-processing-why-i-never-see-3-6a96029e
dependsOn: [batch-picker-drop-parallelgroup-gate]
---
# Goal

`sessionSlots.cjs` was written specifically to replace per-consumer private caps — its own header says "the scheduler and chatRunner previously each enforced a private cap (3 and 2), which combined could exceed the machine's real budget". chatRunner's was retired; the scheduler's was not. `scheduler.cjs:395` still defaults `concurrencyCap: 3` and `:3195` still passes it to `pickNextBatch`, so the scheduler silently ceilings at 3 while the pool the user configured on the Home tab says 5. Delete the private cap and let the machine-wide slot pool plus the existing memory gate be the only limiters, which is exactly the arbitration model sessionSlots.cjs documents.

# Acceptance criteria

- [ ] `tickQueue` in src/main/scheduler.cjs passes `sessionSlots.available()` (not `state.config.concurrencyCap`) as the cap argument to `pickNextBatch`.
- [ ] The `concurrencyCap` field is removed from the scheduler's default config object at src/main/scheduler.cjs:395 and from `~/.claude/session-manager/scheduler-machine.json`'s schema, with a schemaVersion bump and a migration that drops the key from an existing on-disk file without erroring.
- [ ] `getEnvCap()` and its env var are removed, OR explicitly re-pointed at `SM_SESSION_SLOTS` so there is exactly one env override for concurrency machine-wide — whichever the executor chooses must be stated in a code comment.
- [ ] `CONCURRENCY_CAP_MAX` is removed from src/main/lib/schedulerConfig.cjs if it has no remaining referents after the change (grep to confirm before deleting).
- [ ] Any renderer surface that reads or edits `concurrencyCap` (grep `concurrencyCap` across src/renderer) is updated to read the slot pool via `window.api.schedule.sessionSlots()` instead — no UI is left writing a field that no longer exists.
- [ ] The downstream safety gates are untouched and still present in `tickQueue`: the `sessionSlots.available() === 0` early return, `memoryLimitedBatchSize` with `RESERVED_HOST_MB=3000` / `MIN_FREE_MB_PER_JOB=2500`, and the per-job `sessionSlots.acquire` in `spawnJob` (scheduler.cjs:2728).
- [ ] A unit test asserts that with 5 free pool slots, 4 dependency-eligible pending jobs and ample free memory, `tickQueue`'s computed batch size is 4 — not 3.
- [ ] A unit test asserts the memory gate still clamps the batch when `getAvailableMemMb()` is stubbed low, proving OOM protection survives cap removal.
- [ ] `npm run typecheck` and `npm run test:unit` both pass.
- [ ] CLAUDE.md's Avoid section entry "Running more than 3 concurrent claude -p jobs" and its "queue.json concurrencyCap is 3 — keep it there" sentence are updated to describe the real model: sessionSlots pool (default 5, user-adjustable [0,10]) plus the memory gate, with no separate scheduler cap.

# Implementation notes

Grep first: `grep -rn "concurrencyCap" src/ scripts/ session-manager-operations/` — there are referents in scheduler.cjs (395, 1509, 3195), schedulerConfig.cjs (`CONCURRENCY_CAP_MAX`), possibly ipcSchemas.cjs zod validation, and possibly a renderer config surface. All must be resolved; a dangling zod field that rejects a valid payload is a silent breakage.

The 2026-06-10 five-parallel OOM that motivated the "cap 3" rule is genuinely already covered by the memory gate, which reserves 3000 MB for the Electron host and requires 2500 MB free per additional job before it will widen a batch. That gate is dynamic and machine-aware; a hardcoded 3 is not. Do not weaken the memory gate to compensate for removing the cap — the whole point is that the memory gate becomes the binding constraint under load while the pool bounds the steady state.

`~/.claude/session-manager/scheduler-machine.json` currently reads `"concurrencyCap": 3, "schemaVersion": 1`. The migration must tolerate that file existing with the key present and simply drop it on next write — never throw on an unknown/legacy key.

Verify the end state by re-running the reproduction from PRD 988's notes with the real queue: with the pool at 5 and nothing running, the batch must be every dependency-eligible job, capped only by pool and memory.

Read the engineering standards file before writing code.

# Out of scope

- Changing the sessionSlots default of 5 or its [0,10] range
- Weakening or removing the memory gate
- Re-introducing any per-consumer concurrency cap in chatRunner

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

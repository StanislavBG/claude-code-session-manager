---
title: Show the gate that is actually holding the queue — the Home slot number is not the effective limit
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 50
sourcePromptId: not-enough-paralell-processing-why-i-never-see-3-6a96029e
dependsOn: [retire-scheduler-private-concurrency-cap]
---
# Goal

The user reasonably believed concurrency was 5 because the Home tab says 5 — it reads `schedule.sessionSlots()`, the pool. But three other gates sat downstream of it (the parallelGroup wave gate, the private concurrencyCap, and the memory gate) and the real observed concurrency was 1, with nothing on screen saying so. Even after PRDs 988/989 remove two of those, the memory gate and dependency holds remain legitimate reasons a queue runs narrower than its pool. `tickQueue` already computes a precise reason for every one of these (`held`, `slots-exhausted`, `memory-deferred`, `already-running`, `drained`, plus `pickNextBatch`'s `holdReason` text) and then throws it away into console.log. Surface it.

# Acceptance criteria

- [ ] The scheduler persists its last tick outcome — reason code, human-readable detail, deferred count, and timestamp — into the broadcast state, reusing the existing `tickQueue` return descriptors (`held` / `slots-exhausted` / `memory-deferred` / `already-running` / `drained`) and the existing `lastMemGate` snapshot rather than computing anything new.
- [ ] The Home tab's 'Active sessions' widget renders, next to the N-of-M slot count, the binding constraint when N < M and pending jobs exist — e.g. 'memory gate: 4200 MB free, need 5500' or '3 pending held behind dependencies' — sourced from the persisted tick outcome, never fabricated.
- [ ] When the queue is genuinely idle (no pending jobs) the widget shows no constraint text — an empty queue must not read as a blocked one.
- [ ] The Scheduler tab's queue view shows a per-job hold reason for each `pending` row that was dependency-blocked on the last tick, naming the specific blocking dep slug (the `depends-gate` reason string already carries `job.slug <- dep.slug` pairs).
- [ ] The IPC payload carrying this is validated by a zod schema in src/main/ipcSchemas.cjs consistent with the existing schedule IPC schemas.
- [ ] No new zustand selector returns a freshly-built value — select raw slices and derive in the component, per the CLAUDE.md Avoid rule and `npm run lint:selectors`.
- [ ] `npm run lint:selectors` passes.
- [ ] `npm run typecheck` and `npm run test:unit` pass.
- [ ] A unit test asserts the reason surfaces for each of the three non-idle cases (dependency hold, slots exhausted, memory deferred) and is absent for the drained case.

# Implementation notes

The reasons already exist and are already returned — see `tickQueue` in src/main/scheduler.cjs around lines 3195-3260 (`{ fired: false, reason: 'held', detail: holdReason }`, `'slots-exhausted'` with `holders`, `'memory-deferred'` with `availableMb`/`threshold`, `'already-running'`, `'drained'`) and the `lastMemGate` module variable it already maintains. This PRD is plumbing + rendering, not new gate logic. Do not add a second computation path for any of these values.

Surfaces to touch: `src/renderer/components/tabs/Home.tsx` (the Active-sessions widget, ~line 850-870, already calls `window.api.schedule.sessionSlots()`), `src/renderer/components/SchedulePanel.tsx` (queue rows), and `src/renderer/state/scheduleState.ts` for the store field.

Follow the existing schedule IPC broadcast pattern — this should ride the existing `schedule:state` / snapshot broadcast (note `BROADCAST_COALESCE_MS = 200` trailing-edge debounce in schedulerConfig.cjs), not a new channel.

Toast is the user-facing ERROR channel — a hold is not an error. Render this inline in the widget/rows, do not fire toasts for it.

Read the engineering standards file before writing code.

# Out of scope

- Adding a new LeftNav tab
- Changing any gate's behaviour — this PRD only reports
- Web-remote mirroring of the new field

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

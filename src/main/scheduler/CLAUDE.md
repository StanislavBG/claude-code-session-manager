# src/main/scheduler/ — scoped context

Pure, extracted pieces of `../scheduler.cjs` (the most-edited file). Scheduler-family helpers
(dispatch loop, slots, gates, supervisors, queue store) live in [`../lib/scheduler/`](../lib/CLAUDE.md).
Runtime diagnosis (stuck queue, `needs_review`, reap gate) is NOT here — see
[`scheduler-operations.md`](../../../session-manager-operations/architecture/scheduler-operations.md).

## Rules

- **Spy seam:** call module functions through the module object (`mod.fn()`), never destructure them, so `vi.spyOn` works.
- **New pure scheduler logic goes in a module here, not in `scheduler.cjs`** (which keeps state, IO and timers).

## If you are changing X, edit Y

| Changing | Edit |
| --- | --- |
| PRD file parsing, frontmatter, dir/file mtime cache | `prdParser.cjs` |
| Per-project PRD dirs, slug containment, archive-on-complete, boot migration, queue-backup sweep | `prdPaths.cjs` |
| `needs_review` / auto-fix / auto-reset eligibility, verdict sets, thresholds | `reviewLadder.cjs` |
| Git status/stash/HEAD helpers, shared-tree guard, commit-guard, finalize-drop predicates | `gitTreeGuard.cjs` |
| Starvation / blocked-chain classifiers, dispatch-idle clock | `starvation.cjs` |
| Stall / stranded-row / overrun / wall-clock budget selectors, failure backoff, `dependsOn` history lookup | `budget.cjs` |
| `spawnJob` / execution, `tickQueue`, dead-process reaper, poll loop, IPC handlers, admin routes, queue-mutating ladder rungs and watchdogs | `../scheduler.cjs` (by section banner) |

Before adding to `scheduler.cjs`, check the table: a predicate or selector belongs above, the
mutation that acts on it stays in `scheduler.cjs`.

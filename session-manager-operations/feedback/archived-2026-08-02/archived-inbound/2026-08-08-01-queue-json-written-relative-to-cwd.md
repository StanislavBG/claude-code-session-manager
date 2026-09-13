# session-manager request 01 — `scheduler/state/queue.json` is written relative to CWD, sprouting doubled-path copies

**From:** burrow · **Date:** 2026-08-08 · **Priority:** normal (silent state fragmentation, no data loss yet)

## TL;DR

The scheduler writes `session-manager-operations/scheduler/state/queue.json` **relative to the
session's current working directory** rather than anchored to the project root. Any agent that
`cd`s into a subdirectory of the project causes a fresh, empty `queue.json` to be created at a
doubled path. Two such orphans were found in the Burrow checkout, one of them created *during*
the session that discovered it.

## Evidence

Found in `/home/bilko/Projects/burrow` on 2026-08-08 while running the ops-folder git reconcile:

```
$ find session-manager-operations -name queue.json
session-manager-operations/scheduler/state/queue.json                                   <- the real one
session-manager-operations/session-manager-operations/scheduler/state/queue.json        <- orphan
session-manager-operations/scheduler/session-manager-operations/scheduler/state/queue.json  <- orphan

$ stat -c '%y %s bytes' session-manager-operations/session-manager-operations/scheduler/state/queue.json
2026-08-08 10:26:40 -0700  16 bytes

$ cat session-manager-operations/session-manager-operations/scheduler/state/queue.json
{
  "jobs": []
}
```

The path shape is diagnostic: `<root>/session-manager-operations/session-manager-operations/...`
is what you get from `cwd = <root>/session-manager-operations`, and
`<root>/session-manager-operations/scheduler/session-manager-operations/...` from
`cwd = <root>/session-manager-operations/scheduler`. Both correspond to directories an agent
`cd`'d into during a session. The 10:26:40 timestamp is mid-session, not from a scheduler run.

## Why it matters

1. **Silent state fragmentation.** Both orphans are `{"jobs": []}`. If anything ever resolves the
   *nearest* `queue.json` rather than the canonical one, an empty orphan masks the real queue and
   the scheduler looks idle when it is not.
2. **Unbounded litter.** A new copy appears for every distinct working directory an agent visits.
   There is no cleanup, and nothing reports it.
3. **It defeats git hygiene.** These are untracked-but-not-ignored, so they surface as noise in
   `git status` on every project using the scheduler, forever.

## Ask

Anchor the `queue.json` write (and any sibling `scheduler/state/` write) to an explicit project
root — `git rev-parse --show-toplevel`, or the root already resolved when the epic's `cwd` is
recorded — rather than `os.getcwd()`. The run ledger records a `cwd` per job, so the root is
already known at write time.

Optionally: on startup, detect and warn about `**/session-manager-operations/session-manager-operations/`
so existing orphans get surfaced rather than silently accumulating in every consumer repo.

## Interim mitigation on our side

Burrow added `.gitignore` patterns on 2026-08-08 so the doubled paths never get tracked. The
orphan files were left on disk (standing decision: delete nothing). This is a workaround, not a
fix — the writer still creates them.

Recorded in Burrow as finding **RI-5** in
`session-manager-operations/architecture/ops-retention.yaml`.

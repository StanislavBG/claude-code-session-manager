# src/main/lib/ — scoped context

Shared main-process helpers (CommonJS `.cjs`). Layout source of truth: `scripts/lib-layout.json`.

## What's here

- `agent-cli/` — other agent CLIs: registry, adapters, session store, turn planner, IPC.
- `app-preview/` — Epic dev-server preview processes (spawn, URL detect, stop, orphan sweep).
- `claude/` — claude CLI binary, caps, model/effort resolution.
- `demo-video-kit/` — demo-video build tools (capture, sound, frames, checks), seeded to `~/.claude/session-manager/demo-video-kit/`.
- `epic/` — Epic mint, worktrees, active index, spawn plan/cwd, transcripts.
- `feedback-remote/` — cross-project and customer feedback conduits.
- `git/` — git exec, worktrees, branch sweeps, job worktrees.
- `persona-macro/` — agent persona schema/merge, macro library, builtin macros.
- `prd/` — PRD parsing helpers, admin routes, dep-slug resolution, plan validation.
- `process/` — child processes, kill tree, env cleaning, pid liveness, instance lock.
- `project-pages/` — Project Home pages library, competitor matrix store/HTML, player bridge.
- `scheduler/` — dispatch loop, session slots, gates, supervisors, queue helpers.
- `tasks/` — Task ledger, switch, runner, admin routes and IPC (one headless claude -p run per project); store: [`tasks/README.md`](../../../session-manager-operations/tasks/README.md).
- `telemetry/` — audit/ops error logs, crash and OTLP telemetry.
- `util/` — generic pure helpers (atomic fs, kebab, home/cwd encoding, JSON extract, tail).
- top-level files — cross-cutting modules that fit no domain (`opsOwnership`, `activeSessions`, `projectRootResolve`, `cwdClassify`).
- `__tests__/` — tests for top-level modules; subfolders carry their own.

## Where a new module goes

Put it in the subfolder whose domain it serves; pure and domain-free goes in `util/`.
A new top-level `lib/` module needs a stated reason (no domain fits) in its header comment,
and a `scripts/lib-layout.json` entry. Never add a subfolder for one file.

## Reuse before writing

Each of these was found duplicated once. Grep first; extend the canonical one.

| Need | Canonical | Function |
| --- | --- | --- |
| Atomic write (tmp+rename) | `util/atomicFs.cjs` | `writeTextAtomic[Sync]`, `writeJsonAtomic[Sync]` |
| JSON read with fallback | `util/atomicFs.cjs` | `readJsonOr`, `readJsonOrSync` |
| PID liveness | `process/pidAlive.cjs` | `pidAlive` |
| Kebab / slug | `util/kebabCase.cjs` | `kebabCase` |
| Project root, read-only/total (never throws) | `activeSessions.cjs` | `projectRootOf` |
| Project root, validated; `opsInternal:'refuse'` for writers | `opsOwnership.cjs` | `resolveProjectRoot` |
| Project root + Epic from session/epic hints | `projectRootResolve.cjs` | `resolveProjectContext` |
| Ops-root path (single-writer law) | `opsOwnership.cjs` | `opsPath` |
| Run git | `git/gitExec.cjs` | `execGit` |
| Spawn `claude -p` (only machine-wide cap) | `scheduler/sessionSlots.cjs` | `acquire`, `release` |

Pin `--model` on every `claude -p` spawn.

## What must NOT be assumed

- Never `path.join` an agent cwd to build an ops path — use `opsPath`.
- No private process caps, no hand-rolled tmp+rename, no new `JSON.parse(readFileSync)` fallbacks.
- Never call `activeSessions.cjs` `allProjectCwds`/`activeProjectCwds` on an IPC, boot or timer hot path: they scan `~/.claude/projects` synchronously (7k+ dirs, 0.3-4 s; the 2026-10-25 OOM crashes).
- `ipcSchemas.cjs` `validated()` passes the zod-parsed payload, which strips unknown keys: an IPC key rename the schema misses silently drops the key (2026-11-07 persona wipe). Rename keys and schema in one PRD; prefer `.strict()`.

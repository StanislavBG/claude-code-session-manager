# RCA + follow-ups: v0.39.0 blank screen at boot (React #185, unstable zustand selector)

**Date:** 2026-07-30 (evening PDT)
**Severity:** P0 at the time — published 0.39.0 booted to a fully blank window on the author's machine.
**Status of the immediate fix:** landed on main as `4ab267b` (one-line selector fix in
`src/renderer/components/TerminalChat.tsx` + explanatory comment). The user's npx cache
(`~/.npm/_npx/5346543b21849140/.../claude-code-session-manager/dist`) was hot-patched with the
fixed renderer build (original preserved at `dist.bak-0.39.0-broken`), verified booting clean.

## Root cause

`TerminalChat.tsx` had:

```ts
const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs ?? [])
```

While `snapshot` is still `null` (before the first schedule IPC broadcast), the selector mints a
**fresh `[]` on every getSnapshot call**. zustand v5 rides React 18's `useSyncExternalStore`,
which compares snapshots by reference — a new reference every check means "store changed" every
render → infinite re-render → React error #185 (Maximum update depth) → the entire React root
unmounts → blank app.

Trigger window: a dormant tab must mount `TerminalChat` **before** the first schedule snapshot
arrives. With dormant-by-default tabs and a 612 KB `queue.json` (231 jobs) slowing the first
snapshot, the race was ~100 % lost on the real machine — while unit tests, e2e (small/empty
queue), and dev-mode React (different effect timing) never hit it. Reproduced deterministically
in a sandboxed `$HOME`; confirmed the bug is **latent, not new**: v0.38.7 crashes on the same
state. Fix verified 3/3 clean boots on previously 3/3-crashing state.

## Follow-up work to queue (per item, smallest-first)

1. **Publish v0.39.1** with `4ab267b`. Do NOT publish while a scheduler job is mid-run in this
   cwd (npm packs the working tree). After publish, delete the npx-cache hot-patch backup
   (`dist.bak-0.39.0-broken`) — the next `npx @latest` resolves 0.39.1 and re-installs anyway.
2. **Codebase sweep for the same selector class.** Grep all renderer zustand selectors for
   inline fallback/derived literals (`?? []`, `?? {}`, `.filter(`, `.map(`, `Object.values` in
   selector position) and fix with module-level stable constants or post-selector derivation.
   `TabBar.tsx`'s header comment documents the same failure class from an earlier incident —
   third occurrence now; consider a lint rule (eslint `no-unstable-zustand-selector` custom rule
   or `useShallow` adoption) instead of comments.
3. **Crash-visibility gap.** A renderer that dies at boot logs `[renderer] uncaught error` to
   console only in `--enable-logging` runs; the main-process log captured nothing about the
   blank window, and the watchdog kept reporting `alive` (heartbeat is main-process-side).
   Add: forward renderer uncaught errors/`render-process-gone` into `logs.writeLine`, and
   consider a "renderer mounted OK" beacon so a boot-loop is detectable/log-visible.
4. **`browserView.cjs:231` shutdown crash (separate bug, seen in the same logs).** The
   `webContents.once('destroyed')` cleanup handler dereferences `view.webContents.id` — but by
   the time `destroyed` fires, `view.webContents` is undefined → uncaughtException
   `Cannot read properties of undefined (reading 'id')` on every quit with an open Browser
   view. Capture `const wcId = view.webContents.id` at create-time and use it in the handler.
5. **PRD migration tilde bug (also seen in the same logs).** `prdMigration.cjs` reports
   `cwd does not exist on disk: ~/Projects/session-manager` — tilde-prefixed cwds are not
   expanded before the existence check (`lib/expandHome.cjs` exists), so 226 legacy PRDs stay
   unmigrated with a false reason.

## Note for the record

While diagnosing, a sandboxed test launch at ~23:16 PDT ran boot reconciliation against the
real queue and SIGTERM'd orphan claude pid 2122468 (PRD 660 recovery run); the scheduler
re-spawned it at 23:21 (pid 2133617). Later test launches used an isolated `$HOME`.

## RESOLUTION

Evaluated 2026-07-31 against current code. Disposition per follow-up item:

1. **Publish v0.39.1** — ✅ already done. `package.json` version and the published npm
   `claude-code-session-manager` version both read `0.39.1`.
2. **Codebase sweep for the unstable-selector class** — no live instances found in
   `src/renderer` today (grepped all `use*State((s) => ...)` selectors for
   `?? []`/`?? {}`/`.filter(`/`.map(`/`Object.values(`). No preventive guard existed
   though, so queued PRD `815-add-unstable-selector-guard` to add a lint/grep check +
   CLAUDE.md pointer so a 4th occurrence is caught automatically.
3. **Crash-visibility gap (renderer uncaught errors)** — ✅ already done.
   `src/main/crashDiagnostics.cjs` already hooks `render-process-gone` and forwards it.
4. **`browserView.cjs:231` shutdown crash** — confirmed still present (destroyed-handler
   dereferences `view.webContents.id` after webContents may be gone). Queued PRD
   `815-fix-browserview-destroyed-handler-crash`.
5. **PRD migration tilde bug** — confirmed still present in
   `src/main/lib/prdMigration.cjs` (`fs.existsSync(cwd)` called on raw, unexpanded `cwd`).
   Queued PRD `815-fix-prdmigration-tilde-expansion`.

Items 2, 4, 5 queued as PRDs `815-add-unstable-selector-guard`,
`815-fix-browserview-destroyed-handler-crash`, `815-fix-prdmigration-tilde-expansion`
(all group 815, independent/parallel-safe) — execution now owned by the scheduler.

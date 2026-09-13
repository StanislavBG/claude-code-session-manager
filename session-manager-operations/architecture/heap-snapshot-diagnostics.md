# Renderer heap snapshots (diagnostic)

Goal: answer "is there a true leak (detached DOM, retained listeners, orphaned
subscriptions) underneath the retention we already fixed?" without restarting
a live app (restarting SIGTERMs any running scheduler job) and without
opening a debugging port.

## How it works

`src/main/heapSnapshot.cjs` wraps Electron's `webContents.takeHeapSnapshot(filePath)`
— a normal main-process API call, not the DevTools remote-debugging protocol,
so nothing listens on a port. It is gated behind `SM_HEAP_SNAPSHOT=1`, read
fresh on every call:

- Unset (default): `registerIpc()` registers no IPC channel and
  `buildMenuItem()` returns `null` — the Dev menu gets no extra item. Zero
  added timers/listeners/allocations on the hot path.
- Set at launch: the `diagnostics:heap-snapshot` IPC channel is registered
  and a "Take Heap Snapshot (renderer)" item appears in the Dev menu.

Because the gate is evaluated once, at module load (before `app.whenReady()`),
**the flag must be set when the process starts** — you cannot turn this on
for an already-running instance without restarting it. That's a deliberate
consequence of AC3 (capability absent by default), not a bug.

## Taking a snapshot

1. Quit the app, relaunch with `SM_HEAP_SNAPSHOT=1 npx claude-code-session-manager@latest`
   (or `SM_HEAP_SNAPSHOT=1 npm run dev` in this repo).
2. Let it run under normal use until RSS looks worth investigating.
3. Dev menu → "Take Heap Snapshot (renderer)" (or call
   `window.api.diagnostics.takeHeapSnapshot()` from the renderer devtools
   console).
4. The file lands at `~/.claude/session-manager/heap-<ISO timestamp>.heapsnapshot`;
   the path is logged to the main process console and returned to the caller.
5. Capture is bounded by a 3-minute timeout (`heapSnapshot.DEFAULT_TIMEOUT_MS`)
   — if it fires, the promise rejects with a "timed out" error instead of
   hanging forever; Electron's own write may still be in flight on disk, so
   check the file's mtime/size before assuming nothing happened.

## What to look for

Open the `.heapsnapshot` file in Chrome/Edge DevTools → Memory panel →
"Load". Two snapshots taken far apart (e.g. right after boot vs. after
several hours) make growth visible via the "Comparison" view.

- **Detached HTMLElement retainers.** Filter the Summary view by
  "Detached" — any `Detached HTMLDivElement` (etc.) with a live retaining
  path is DOM that was removed from the document but is still referenced by
  JS (a closure, a Map, a ref that was never cleared). This is the
  strongest true-leak signal for a React app: legitimate garbage should show
  0 detached nodes once GC has run.
- **Listener counts.** Search the retainers for `EventListener` / on the
  `(system)` node "Window" — a steadily climbing listener count across
  snapshots taken hours apart (with no corresponding UI growth) points at an
  `addEventListener`/subscription without its matching cleanup.
- **Retained size by constructor.** The Summary view's "Retained Size"
  column, sorted descending, tells you which constructor's instances are
  actually pinning memory (not just shallow-allocated) — that's usually
  more actionable than shallow size, since one large retained array can hide
  behind a small shallow-size wrapper object.

For a point-in-time validation that this mechanism works end-to-end against a real V8 heap, see
[`../reviews/2026-08-07-heap-snapshot-validation.md`](../reviews/2026-08-07-heap-snapshot-validation.md).

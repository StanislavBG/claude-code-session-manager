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

## Mechanism validation (2026-08-07)

The live app's renderer (pid re-derived via `ps aux | grep electron`, was
377635 at investigation time) was **not** launched with `SM_HEAP_SNAPSHOT=1`,
and per the gate above, that can't be changed without a restart — which was
out of scope (it would SIGTERM the 3 scheduler jobs that were running at the
time; verified those PIDs and the queue were untouched before/after this
work). So no live measurement of *session-manager's own* renderer was taken
this round.

Instead, `captureSnapshot()` was exercised end-to-end against a real,
isolated, throwaway Electron renderer (separate `userData` dir, offscreen
`BrowserWindow`, own process — no relation to session-manager's app lock,
scheduler, or admin API) to prove the mechanism itself works against a real
V8 heap, not a mock:

- Total heap: **352,262 nodes, 30.2 MB self size** (`heap-2026-08-07T15-09-08-956Z.heapsnapshot`,
  51 MB on disk, captured in 4.8s).
- Top 5 by aggregate self size (type:name):
  1. `native:system / JSArrayBufferData` — 19.53 MB
  2. `array:(object elements)` — 5.23 MB
  3. `object:Uint8Array` — 1.14 MB
  4. `object:ArrayBuffer` — 0.99 MB
  5. `concatenated string:(concatenated string)` — 0.76 MB

These numbers match the harness's own synthetic allocations (20k objects
each holding a 1 KB `Uint8Array`) — i.e. the capture, timeout race, and
file-write path are confirmed correct on a real renderer. **They say nothing
about session-manager's actual 773 MB retention** — that measurement needs
one snapshot taken from a real session-manager run launched with
`SM_HEAP_SNAPSHOT=1`, ideally paired with a second snapshot hours later so
DevTools' Comparison view can show what's still growing.

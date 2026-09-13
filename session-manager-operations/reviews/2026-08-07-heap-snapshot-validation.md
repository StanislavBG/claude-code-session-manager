# Heap-snapshot mechanism validation — 2026-08-07

Point-in-time validation run for the mechanism described in
[`../architecture/heap-snapshot-diagnostics.md`](../architecture/heap-snapshot-diagnostics.md).
Not a re-runnable check — the pid/figures below are frozen to this one investigation.

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

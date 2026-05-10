# F2 mic-gate v2 — implementation critique

Reviewer pass against `F2-mic-gate.v2.md`. Files audited: `src/renderer/state/voice.ts`, `src/renderer/lib/speechRecognition.ts`, `src/renderer/lib/voiceCopy.ts`, `src/renderer/components/VoiceButton.tsx`, `src/renderer/App.tsx`.

## Verdict

Substantively correct, ships the v2 contract: predicate split, copy table, `aria-disabled` vs native `disabled`, watchdog, retry path, eager preload, permission listener. Three real defects worth fixing before merge — most importantly, the `error → load-timeout` retry path is broken (`initModel` short-circuits) and the watchdog is module-scoped (concurrent retries / HMR races). Several smaller correctness gaps and missing telemetry.

## Severe issues

1. **Retry path is dead.** `voice.ts:121-127` `resetAndRetryModel` does `set({ modelStatus: 'idle', ... })` then `get().initModel()`. But `initModel` (`voice.ts:86`) bails with `if (get().modelStatus !== 'idle') return` — fine here — *however*, if the user clicks retry while a stale watchdog is pending or while a prior `preloadModel` handler is still attached, the old `handler` (`speechRecognition.ts:64`) is never removed (`addEventListener` with no `removeEventListener` anywhere). A second `preloadModel` adds a *second* listener; both fire on every `progress`/`status`/`error`. After N retries you have N handlers. This is both a memory leak and a duplicate-set storm. The PRD says "the worker is preserved and the next `preloadModel()` re-posts `load`" but does not address the listener accumulation.

2. **`mic.gate.timeout` log fires from `voice.ts:94`, but the PRD also specifies the watchdog must trip even if the user never re-armed it after a stale `progress` from a prior session.** With `watchdogTimer` at module scope (`voice.ts:50`) and `armWatchdog` closing over `set`/`get` from the *first* `initModel` call, a retry that re-enters `initModel` defines a fresh `armWatchdog` but shares the same module timer. If the first `initModel`'s `set.../error` fired `clearWatchdog` after the user already retried, you can clear the *new* retry's timer. Race: progress(old) → fires arm → retry kicked off mid-flight → progress was actually for old worker → timer is now armed against the new load but tied to no callback discipline. Concurrent flows are not guarded. Easy fix: make `watchdogTimer` an in-closure ref keyed per-init invocation, or version-stamp it.

3. **`errorKind: 'recording'` leaks through the gate as `error`.** `selectCanRecord` (`voice.ts:207-209`) treats any non-`timeout` `errorKind` as the `error` reason. But recording errors set `modelStatus` only via `onError` in `startRecording` (`voice.ts:151-156`), which sets `errorKind: 'recording'` *without* changing `modelStatus`. So a recording failure won't even hit `selectCanRecord`'s error branch — it lands silently. Conversely, if `modelStatus` is somehow `'error'` *and* `errorKind === 'recording'`, the gate copy says "speech model error" which is wrong. Either narrow `errorKind` to `'load' | 'timeout'` for the gate, or add a `recording` reason. The PRD doesn't enumerate this, so this is unresolved spec/impl drift.

## Moderate issues

4. **App eager-init race vs. `selectCanRecord === 'idle'`.** `App.tsx:39-44` schedules `initModel()` inside a `useEffect`, so for the first render pass `modelStatus` is still `'idle'` and the predicate returns `{ reason: 'idle' }` (`voice.ts:210`). The button shows "speech model not started" copy for one paint frame. Negligible visually, but in tests with `waitFor(data-state="loading")` you'll occasionally hit `idle` first. PRD does not forbid the flicker; consider calling `useVoice.getState().initModel()` synchronously at module top of `App.tsx` (post `isRecognitionSupported` check) or pre-flipping `modelStatus` before paint.

5. **`mic.gate.unsupported` fires every effect run.** `App.tsx:40-43` logs unsupported each time the effect runs. PRD §"Telemetry" says "warn once at App mount." Under StrictMode it fires twice; under HMR every reload. Guard with a module-level `loggedUnsupportedOnce` flag.

6. **No-progress watchdog: `progress` race.** `voice.ts:114-117` arms the watchdog inside the `onProgress` callback. If a `progress` event fires *after* the terminal `status === 'ready'` callback (worker ordering is FIFO so this shouldn't happen, but the listener stays attached forever in `speechRecognition.ts:80` with no removal), `armWatchdog()` re-arms the timer post-ready. Then 90s later it sets `modelStatus: 'error'` — guarded only by `if (get().modelStatus !== 'loading') return` at `voice.ts:93`, which does correctly defuse it. So this race is benign. But the *listener-leak* root cause (item 1) makes it worse over retries.

7. **Permission listener cleanup, HMR/StrictMode.** `App.tsx:57-62` resolves `query()` async. If the effect cleanup ran before resolution, `cancelled = true` short-circuits the `setPermissionState` call (`App.tsx:58`) — good — *but* it does **not** prevent `permStatus.addEventListener('change', onChange)` from running (`App.tsx:61`), because that line is unconditional after the early return. Result: a listener is attached to the `PermissionStatus` and never cleaned up. Wrap the `addEventListener` in `if (!cancelled)`. The PRD calls out this exact case in §"Edge cases" implicitly via "Double init under StrictMode."

8. **`onChange` reads stale `permStatus.state` semantics fine, but doesn't filter `'unknown'`.** `setPermissionState` accepts `PermissionState = 'granted' | 'denied' | 'prompt' | 'unknown'` (`voice.ts:21`), and the App writes only `'granted' | 'denied' | 'prompt'`, never `'unknown'` once resolved. Initial store value is `'unknown'`. Acceptable, but the state machine never reaches `'unknown'` again after first resolve — dead state value. Cosmetic.

9. **`copyFor('ready', { isRecording })` requires the call site to thread `isRecording`.** `VoiceButton.tsx:39-43` does pass it. But the `error` branch ignores `isRecording`, which is correct; and the call site for F1 (per PRD §"F1 imports `selectCanRecord` only") will not have `isRecording` context. Currently fine since F1 doesn't render copy. Worth a JSDoc note on `copyFor` that `isRecording` is meaningful only when `reason === 'ready'`.

10. **Throttle module-scope leak under HMR.** `VoiceButton.tsx:7` `let lastRejectedLog = 0` is module-scoped and survives Vite HMR (the module is re-evaluated, resetting it — actually safe). But under tests that import the module once per file, repeat fire across tests will share state. Mark with a comment, or move into a closure inside the component if you want per-mount semantics.

## Minor / nits

11. **`data-state` is set in every state.** `VoiceButton.tsx:69` always emits `data-state={gate.reason}` which is one of the seven `GateReason` lowercase-kebab values. Consistent with PRD's e2e contract.

12. **Double-click race.** `onClick` (`VoiceButton.tsx:26-37`) reads fresh state via `getState()`. A click during in-flight `stopRecording` will see `isRecording === false` (set synchronously at `voice.ts:178`) and *try to start*. The handle-drain is async (`voice.ts:182`), so a fast double-click can call `startRecording` while the previous handle is still draining. `startRecording` short-circuits on `get().isRecording` (`voice.ts:130`) but that's already false, so it falls through and creates a new handle. Two VAD instances briefly. Add a `stopping` flag, or guard `startRecording` on `activeHandle` being non-null.

13. **`mic.gate.permission_changed` log** present (`voice.ts:191`). `mic.gate.click_rejected` present (`VoiceButton.tsx:14`). `mic.gate.retry` present (`voice.ts:122`). `mic.gate.timeout` present (`voice.ts:94`). `mic.gate.unsupported` present but fires more than once (item 5). All five PRD logs accounted for.

14. **TypeScript:** `App.tsx:46` `let permStatus: PermissionStatus | null = null` — `PermissionStatus` is in `lib.dom`, fine. `App.tsx:56` casts `'microphone' as PermissionName` — necessary, OK. `voice.ts:50` `ReturnType<typeof setTimeout>` — portable, OK. No `any` introduced. `copyFor` `switch` is exhaustive but no `default`/`never` check — TS will catch missing cases via the enum-narrowed return type, but a `default: return assertNever(reason)` would lock it.

15. **`resetModel()` does not detach the worker `message` listener.** As noted in item 1, this is the actual leak. Even without retries it's already there: each *successful* `preloadModel` leaves `handler` attached forever. Cosmetic during a single load, but stacks under retry.

16. **`copyFor` `loading` percent format.** `"loading speech model, ${pct} percent"` — PRD table row reads `"{pct} percent"`. Matches.

17. **`unsupported` early in `selectCanRecord`** (`voice.ts:203`) is computed via `isRecognitionSupported()` *every call*. Cheap but called on every store update. Memoize at module scope — value cannot change in a session.

## Concrete fixes for v2

- **`speechRecognition.ts:64-82`**: capture `handler` before `addEventListener`, and remove it in *both* the `ready` and `error` branches; add `w.removeEventListener('message', handler)` after `modelReady = true` (line 69) and after the error branch (line 77). This kills the listener leak per retry.
- **`voice.ts:50`**: move `watchdogTimer` and `clearWatchdog` into a per-`initModel` closure (or version-stamp via a counter). Same for the `armWatchdog` capture.
- **`voice.ts:207-209`**: tighten to `s.errorKind === 'load' || s.errorKind === 'timeout'` and add a fall-through, *or* exclude `errorKind === 'recording'` from the gate. Document that recording errors surface via `error` slice, not `modelStatus`.
- **`App.tsx:57-62`**: hoist a top-level `let unsupportedLogged = false` and short-circuit the `mic.gate.unsupported` warn. Move `addEventListener` inside the `if (!cancelled)` block.
- **`VoiceButton.tsx:26`**: after `if (s.isRecording) return s.stopRecording()`, the call falls through synchronously; consider an `if (activeHandle) return` guard at the store level (in `startRecording`) to defuse the double-click race.
- **Tests:** add a unit case where `errorKind === 'recording'` to lock down behavior; add an HMR-style double-mount StrictMode test for the App effect to assert listener attach/detach symmetry; fake-timer test for retry-during-watchdog-pending to lock down item 2.

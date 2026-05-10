# F1 Push-to-talk — Implementation Critique (v2 PRD)

## Verdict

Solid first cut: hold/toggle, the chord-member-keyup rule, `isAutoRepeat` discard, focus/blur unregister dance, sanitizing logger, single-instance lock, and `RecordingStatus` + title-prefix invariant are all present. Precedence (focus → unregister global) is implemented as specified. PRD-mandated guardrails missing or wrong: no JSON-schema validation in `setHotkeyConfig`, `mode:'hold' && global:true` silently accepted at write time, `armed → recording` auto-promotion explicitly TODO'd out (so the "model loading when key held" flow loses the press), the sanitizer dev-throw can mask itself, and a focus-debounce timer + stale window listeners leak on quit. Ship-blockers: 2. Moderate: 7. Nits: 5.

## Severe issues

**S1. `setHotkeyConfig` skips the PRD §Chord-schema validation.** `voiceSettings.cjs:33-39` validates only types. The accelerator regex from PRD §Technical Design (`^(CommandOrControl|Cmd|Ctrl|...)+([A-Z]|F[1-9]|...)$`) is not enforced. A user can save `accelerator: "v"` (no modifier, PRD §Edge 5 forbids it); `voiceHotkey.cjs:118 parseAccelerator` returns null and registration silently no-ops with `register-failed reason:'parse'`, but the bad config persists. The "hold-mode-global removed" rule (PRD §Changes from v1) also isn't enforced — `voice.ts:342` coerces global presses to toggle at runtime, so the persisted `mode:'hold'` lies about actual behavior. Fix: add `ACCEL_RE` and `mode==='hold' && global===true` rejection in `isValidConfig`.

**S2. `armed → recording` auto-promotion is TODO'd — PRD §Edge 3 broken.** `voice.ts:367` admits it: when a press hits during `modelStatus==='loading'`, `hotkeyState` goes `armed` and *stays there after model→ready*. PRD §State machine line 71 requires `armed ──(model→ready)─────► recording`. The user holds through a 5s load, releases, and gets silence. Banner says "Hold — model loading" — implies the press was banked, but no recorder starts. Fix: subscribe to `modelStatus` in the store; on `loading→ready` with `hotkeyState==='armed'`, call `startRecording(armedTabId)`. The "still held" bit lives in main (`voiceHotkey.cjs:27 holdActive`) and never crosses IPC — so either send the held-state on transition, or rely on `armedTabId` being set as proof of intent and trust that any subsequent up/blur cancels.

## Moderate issues

**M1. Hold+global rejected only at runtime, not write time.** `voiceHotkey.cjs:202` registers the global accelerator regardless of `cfg.mode`; renderer at `voice.ts:342` coerces to toggle. Hand-edited `voice.json` produces lies. Enforce in `isValidConfig`.

**M2. Dead `'browser-window-focus'` listener.** `voiceHotkey.cjs:264` — `BrowserWindow` emits `'focus'`/`'blur'`, not `'browser-window-focus'`. The line and its "see app.on below" comment are misleading. Remove.

**M3. Sanitizer dev-throw can mask itself.** `voice-hotkey-log.cjs:48-55` throws *before* any log line is written. If a caller wraps `voiceHotkeyLog` in try/catch (or a startup throw is swallowed by the `voiceHotkey.init(...).catch` at `index.cjs:299`), the leak leaves no on-disk record. Also `app.isPackaged` is unsafe to read before `whenReady`; the existing try/catch defaults to "dev", which is the right direction but should be commented. Fix: log a structured `leak-detected` line first, then throw.

**M4. `parseAccelerator` is more permissive than the PRD regex.** PRD requires `[A-Z]` uppercase letter; `voiceHotkey.cjs:87` accepts lowercase via the `KeyV` code fallback. Functionally fine, but the schema validator (S1) should narrow at the file level so persisted state matches the PRD grammar.

**M5. `keyMatches` Space + dead-key handling is correct only by accident.** `Cmd+Option+V` on macOS emits `input.key === '√'`; fallback at `voiceHotkey.cjs:87` catches via `input.code === 'KeyV'`. Document this and add an e2e regression — without the code-fallback, the default macOS chord would be unmatchable.

**M6. Focus-debounce + listener leak on `closed`/`will-quit`.** `voiceHotkey.cjs:263` `focusDebounce` is closed-over inside `attachWindow` and never cleared in `closed` (line 273) or `disposeOnQuit` (line 316). If `closed` fires within the 50ms window, the timeout fires against `mainWindow=null`. The `focus`/`blur` handlers on the destroyed window also aren't removed; they're rooted by Electron until the BrowserWindow is GC'd, which is fine for shutdown but leaks under HMR/reboot (`index.cjs:95` re-runs `voiceHotkey.init` on dev reboots without disposing the prior window's listeners). Track at module scope; `clearTimeout` + `removeAllListeners` on dispose.

**M7. `startRecording` failure strands `hotkeyState='recording'`.** `voice.ts:378` sets `hotkeyState='recording'` *before* `s.startRecording(tabId)`. If `handle.start()` rejects (line 273) only `log.error` runs — `hotkeyState` stays `'recording'`, banner mounts forever, title prefix sticks. Fix: in both `catch` paths reset `hotkeyState` to `'error'`→`'idle'`, or set `'recording'` only after a successful `start()` resolves.

**M8. `destroyHotkey` incomplete.** `voice.ts:410-417` only handles `recording`. `armed` and `stopping` paths leak `drainWatchdog`. PRD treats `destroyed` as terminal; fine for real shutdown, but HMR remounts re-create the store. Add `clearDrainWatchdog()` and handle non-recording states.

## Minor / nits

**N1. `RecordingStatus` `aria-live="polite"`.** Privacy invariant deserves `assertive` + `role="alert"` so screen-reader users hear "Recording" preempt whatever they were on. PRD doesn't specify; assertive is safer.

**N2. Window-title base is hardcoded.** `voiceHotkey.cjs:310` literal `'Claude Session Manager'`. If anything else mutates the title, `voice:set-recording` clobbers it. Capture once on attach, strip any existing `● REC — ` prefix, restore on stop.

**N3. `applyConfig` logs `register` twice.** Inside `registerGlobalIfWanted` (line 218) on global success, then unconditionally at line 245 with `ok:true` even if `parseAccelerator` failed and `register-failed` was already logged. Move the second log inside the parse-success branch.

**N4. `second-instance` race vs held-chord debounce.** PRD §requestSingleInstanceLock specifies the 50ms focus debounce. Implementation does it (`voiceHotkey.cjs:267`) but `app.on('second-instance')` at `index.cjs:205` calls `mainWindow.show()/focus()` which fires `'focus'` synchronously — debounced 50ms then `unregisterGlobal`. If the user was holding a *global* chord, the down already fired before show()/focus(); fine. Edge worth a test.

**N5. TS hygiene.** No `any` introduced in the new `voice` namespace; `armHotkey` payload fully typed; `RecordingStatus` clean. Pass.

## Concrete fixes for v2

1. `voiceSettings.cjs:33` — add the PRD accelerator regex and the hold+global rejection:
   ```js
   const ACCEL_RE = /^(CommandOrControl|Cmd|Ctrl|Alt|Option|Shift|Super)(\+(CommandOrControl|Cmd|Ctrl|Alt|Option|Shift|Super))*\+([A-Z]|F[1-9]|F1[0-9]|F2[0-4]|Space|Tab|Enter|Backspace|Delete|Esc|[0-9])$/;
   if (!ACCEL_RE.test(cfg.accelerator)) return false;
   if (cfg.mode === 'hold' && cfg.global === true) return false;
   ```
2. `voice.ts:367` — implement armed→recording auto-promotion. Track `armedTabId` in store, subscribe to `modelStatus`; when transition `loading→ready` and `hotkeyState==='armed'`, call `startRecording(armedTabId)` and set `hotkeyState='recording'`.
3. `voice.ts:266` — `startRecording`'s catch and `handle.start().catch` must reset `hotkeyState` to `'idle'` (or `'error'`) so a failed start doesn't strand the state machine.
4. `voiceHotkey.cjs:264` — delete the dead `browser-window-focus` listener line.
5. `voiceHotkey.cjs:263-277` — track the focus debounce timer at module scope and clear in `disposeOnQuit` and on `closed`. Remove the focus/blur listeners on `closed`.
6. `voiceHotkey.cjs:245-252` — move the unconditional `register` log inside the parse-success branch in `attachBeforeInput`.
7. `voice-hotkey-log.cjs:48` — log a structured `leak-detected` line *before* throwing, so prod swallow + dev throw both leave a trace.
8. `voiceHotkey.cjs:310` — capture `mainWindow.getTitle()` once at attach, strip any existing `● REC — ` prefix, use as base.
9. `RecordingStatus.tsx:15` — switch `aria-live="polite"` → `assertive` and add `role="alert"`.
10. `voice.ts:410` — `destroyHotkey` should `clearDrainWatchdog()` and handle `armed`/`stopping` paths, not just `recording`.
11. Add an e2e regression test exercising: model `loading` → keydown → model `ready` → assert recording starts within 200ms of ready (covers S2). And a test for `setHotkeyConfig({ mode:'hold', global:true })` returning a validation error (covers M1/S1).
12. PRD §Edge 4 says "ignore the first global callback within 500ms of registration." `voiceHotkey.cjs:200` does this. Good — but `globalRegisteredAt` is only set on success; if `register` returned `false` (collision), the suppression window still triggers off the prior value. Tighten.

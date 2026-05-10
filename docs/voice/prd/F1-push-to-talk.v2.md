# F1 — Push-to-talk + Global Hotkey (v2)

Status: Draft v2
Author: voice-feature working group
Last updated: 2026-05-02

## Changes from v1

- **macOS default `Cmd+Shift+Space` retired** — bound by macOS to "Select the previous input source" per [Apple Support 102650](https://support.apple.com/en-us/102650). Replaced with `Cmd+Option+V`.
- **Renderer-document fallback removed.** Main and renderer cannot share a DOM attribute synchronously. Two layers only: `before-input-event` and `globalShortcut`.
- **Precedence rule added.** Window focused → `globalShortcut` unregistered; on `browser-window-blur` we re-register. IPC `source` is telemetry-only.
- **Wayland is experimental.** Min Electron 32.x; 40.x blocked (issue #49806). Runtime DBus probe of `org.freedesktop.portal.GlobalShortcuts` disables the global toggle when absent.
- **`requestSingleInstanceLock` is in scope** with second-instance handler spec. Tray icon split to **F1a**; F1's privacy invariant uses banner + window-title prefix.
- **State machine resolved:** added `error`, `aborted`, `destroyed`; transitions for `armed+blur`, `armed+model→error`, `recording+destroyed`; 10 s drain watchdog.
- **First-phoneme claim corrected.** `preSpeechPadMs: 300` only helps when the mic is already feeding the VAD. Opt-in warm-mic mitigates from press 2 onward.
- **Auto-repeat API gap called out.** Main uses `input.isAutoRepeat`; DOM uses `event.repeat`. Only the main rule applies for hotkeys; DOM is for the Settings capture widget.
- **No-transcript rule is enforceable.** A `voice-hotkey` logger wrapper strips meta keys matching `/transcript|interim|final|text/i` and throws in dev when a stripped value was non-empty.
- **Hold-mode-global removed.** Global forces toggle; hold radio is disabled when `global` is true. Resolves v1's open question #4.
- **Chord schema added** as a JSON-schema snippet.

## Problem & Motivation

Voice input today requires a mouse click on `VoiceButton` (`src/renderer/components/VoiceButton.tsx`). This is a terminal-first app: hands stay on the keyboard, the active tab is usually a `node-pty`-backed xterm, and clicking steals focus so the first transcribed character can land in the wrong place. We want keyboard-first activation: hold-to-talk and toggle-to-talk, single configurable accelerator, working over xterm focus, optionally global.

## Scope

In:
- `voice.hotkey` settings: `{ accelerator, mode: 'hold' | 'toggle', global: boolean }` with a JSON-schema validator.
- Window-local capture via `before-input-event` (always on).
- `globalShortcut` registration when `voice.hotkey.global === true`, gated by Wayland portal probe on Linux. Toggle-only.
- Settings UI: capture-the-next-chord field, hold/toggle radio (disabled when global), "Capture globally" checkbox with portal hint.
- State machine with `armed`, `error`, `aborted`, `destroyed` states and a 10 s drain watchdog.
- `voice-hotkey` logger wrapper (sanitized).
- `app.requestSingleInstanceLock()` with second-instance focus handler.
- Mounted `RecordingStatus` banner + window-title `● REC — ` prefix while recording.

Out (split or deferred):
- Tray icon → **F1a**.
- Wake-word ("Hey Claude") → F4.
- Voice barge-in over TTS → F2.
- Per-tab hotkey, multi-modifier chords beyond `globalShortcut`'s grammar, "tap-tap to lock".

## UX Flow

| OS | Default | Min Electron | Rationale |
|---|---|---|---|
| macOS | `Cmd+Option+V` | 32.x | `Cmd+Shift+Space` is bound to "Select previous input source" per [Apple Support 102650](https://support.apple.com/en-us/102650); `Cmd+Option+V` unbound by default. |
| Linux | `Ctrl+Shift+Space` | 32.x | Not bound in default GNOME 45 / KDE 6. |
| Windows | `Ctrl+Shift+Space` | 32.x | `Win+H` is system dictation; `Ctrl+Shift+Space` unbound by default. |

Modes:
- **Hold-to-talk (default, window-local only):** keydown → start; keyup → stop. Minimum hold **80 ms** (was 150 ms — reliably ate first syllables). User-configurable.
- **Toggle:** first tap arms, second tap stops. 5-minute auto-stop.
- **Global mode forces toggle.** `globalShortcut` does not deliver keyup, so hold cannot be implemented faithfully. Hold radio is disabled in the UI when `global` is true.

Visual states:
1. Idle: icon dim.
2. Armed: amber pulse + "Hold — model loading 67%".
3. Recording: red pulse + "Listening…"; window title prefixed with `● REC — `.
4. Transcribing: blue pulse.
5. Cooldown: 250 ms grey check after toggle stop (debounce next press).
6. Error: red ring + toast; → Idle on dismiss.
7. Aborted: brief grey "Cancelled" then Idle.

## Technical Design

State machine (single source of truth in `useVoice`):

```
idle ──(keydown, model=ready)─────────────► recording
idle ──(keydown, model=loading)───────────► armed
armed ──(model→ready)─────────────────────► recording
armed ──(keyup before ready, hold)────────► idle (log miss-model-loading)
armed ──(window blur)─────────────────────► idle
armed ──(model→error)─────────────────────► error
recording ──(keyup, hold)─────────────────► stopping
recording ──(keydown, toggle)─────────────► stopping
recording ──(blur, hold only)─────────────► stopping
recording ──(window destroyed)────────────► destroyed (terminal)
recording ──(model→error)─────────────────► error
stopping ──(transcribe drained)───────────► idle
stopping ──(drain timeout ≥10s)───────────► aborted → idle
error ──(user dismiss)────────────────────► idle
```

Two-layer key capture (was three):

1. **`mainWindow.webContents.on('before-input-event', …)`** in `src/main/index.cjs`. Fires before xterm; `event.preventDefault()` blocks the terminal. Always on.
2. **`globalShortcut`** when `voice.hotkey.global === true` (and Linux portal probe passes). Toggle-only.

**Precedence:** when the window is focused, `globalShortcut` is *unregistered*. On `browser-window-blur` we re-register; on `browser-window-focus` we unregister. This eliminates double-fire without any cross-process flag. `source` in IPC is telemetry-only.

**Wayland portal probe (Linux):** at `app.whenReady()`, if `XDG_SESSION_TYPE === 'wayland'`, DBus-introspect `org.freedesktop.portal.Desktop` for `org.freedesktop.portal.GlobalShortcuts`. If absent or `xdg-desktop-portal < 1.17`, disable the global toggle and surface the reason. Electron 32.x minimum; 40.x blocked (#49806).

**Auto-repeat:** main discards via `input.isAutoRepeat`. DOM `event.repeat` only matters in the Settings capture widget.

**Modifier-release timing:** v1's "keyup on non-modifier only" rule fails on Wayland/XWayland when a modifier is released first. v2 treats *any* chord-member keyup as end-of-press in hold mode, with a 30 s watchdog backstop.

**First-phoneme strategy.** `preSpeechPadMs: 300` only helps when the VAD is already running. The first press takes longer than 300 ms to spin up `getUserMedia` + worker + VAD, so the first phoneme will clip. Opt-in **warm-mic** mode keeps `getUserMedia` open and VAD paused after the first press; subsequent presses unpause instantly. Off by default for privacy.

Chord schema (validated at write time and at registration time):

```jsonc
{
  "type": "object",
  "required": ["accelerator", "mode", "global"],
  "properties": {
    "accelerator": {
      "type": "string",
      "pattern": "^(CommandOrControl|Cmd|Ctrl|Alt|Option|Shift|Super)(\\+(CommandOrControl|Cmd|Ctrl|Alt|Option|Shift|Super))*\\+([A-Z]|F[1-9]|F1[0-9]|F2[0-4]|Space|Tab|Enter|Backspace|Delete|Esc|0-9)$"
    },
    "mode": { "enum": ["hold", "toggle"] },
    "global": { "type": "boolean" }
  }
}
```

The Settings capture widget validates against this schema, then runs `globalShortcut.isRegistered(accelerator)` to detect collisions before saving.

`requestSingleInstanceLock` (explicit delta):
- Call at top of `app.whenReady()`. If lock not acquired, `app.quit()`.
- On `second-instance`: `mainWindow.show(); mainWindow.focus()`. The resulting `browser-window-focus` is debounced 50 ms so the unregister/re-register dance does not race with a held chord.
- Dev mode (`SM_DEV=1`) skips the lock for two-dev-instance workflows.

IPC plumbing:
- Preload (new `voice` namespace): `voice.onHotkey(handler)` for `voice:hotkey` `{ phase, source }`; `voice.setHotkeyConfig(cfg)` → `voice:set-hotkey`.
- Main: dispatch from `before-input-event` (with `preventDefault()`) and `globalShortcut`; `app.on('will-quit', () => globalShortcut.unregisterAll())`.
- Renderer: `useVoice` adds `armHotkey()` running the state machine on top of existing `startRecording` / `stopRecording`.

Integration points: `src/main/index.cjs` (menu/accelerator block, `before-input-event`, `requestSingleInstanceLock`, portal probe); `src/preload/index.cjs` (`voice` namespace); `src/renderer/state/voice.ts` (state machine + drain watchdog); `src/renderer/components/VoiceButton.tsx` (hint copy); `src/renderer/lib/speechRecognition.ts` (warm-mic option).

## Edge Cases & Failure Modes

1. Collision — `globalShortcut.register` returns false; surface warning, fall back to window-local; re-check on focus.
2. Press/release before model loaded — `idle → armed → idle`; log `miss-model-loading`.
3. Model loading when key held — stay `armed`; transition on `ready`. First phoneme clips; warm-mic helps from press 2.
4. Key held during cold start — `globalShortcut.register` runs in `app.whenReady()`; ignore the first global callback within 500 ms of registration.
5. Text input vs terminal — schema forbids bare alphanumerics, requires ≥1 modifier.
6. Hotkey while TTS speaking — `speechSynthesis.cancel()` on `phase: down` before starting recognizer.
7. Another tab recording — first-press wins on shared `activeHandle`; subsequent presses log `busy`.
8. xterm captures keys — `before-input-event` fires first; defaults verified against `Reboot Session` (`CmdOrCtrl+Shift+S`) and the rest of the menu block.
9. Lost focus mid-hold — window-mode: `window.blur` force-stops. Global is toggle-only so the case does not arise. 30 s watchdog backstops all hold paths.
10. First-200 ms clipping — documented limitation on first press; warm-mic mitigates after.
11. Multiple windows / instances — `requestSingleInstanceLock` handles; debounced focus prevents race with held chord.
12. Auto-repeat — `input.isAutoRepeat` discarded in main.
13. Modifier release timing — any chord-member keyup ends the press in hold mode.
14. Mic permission denied — `getUserMedia` rejection → error toast → `error` state.
15. Wayland portal unavailable — global toggle disabled with explanation; window-local unaffected.
16. `armed + blur` → `idle` (cancelled silently).
17. `armed + model→error` → `error` (toast).
18. `recording + window destroyed` → `destroyed`; worker aborted; partial transcript discarded.
19. `stopping + drain timeout ≥10 s` → `aborted`; partial discarded; logged `drain-timeout`.

## Security & Privacy

- A global hotkey can start recording when the window is hidden. F1's privacy invariant is satisfied by:
  1. `RecordingStatus` banner mounted whenever `isRecording === true`.
  2. Window title prefix `● REC — ` while recording.
  3. (Tray icon split to F1a — out of scope here.)
- No transcript content in `voice-hotkey` logs. **Enforcement:** new wrapper at `src/main/lib/voice-hotkey-log.ts` calls `logs.write('voice-hotkey', ...)` after running `meta` through a sanitizer that drops keys matching `/transcript|interim|final|text/i`. In dev (`NODE_ENV !== 'production'`), if the sanitizer drops a non-empty value, throw — failing tests immediately.
- 80 ms hold floor and ≥1-modifier schema requirement reduce the chance of accidental arming on password input.
- Document in the Settings UI that "global" mode means audio capture can begin from any app focus state.
- Renderer never gets raw key events except for the configured chord.
- **Non-goal (explicit):** we never log raw key codes outside the configured chord.
- macOS Accessibility: `globalShortcut` does NOT need it for the chord set we ship. Adding `Fn` or media keys later would change that boundary.

## Telemetry & Logging

All via the new `voice-hotkey` wrapper:

- `info` `register` — `{ accelerator, global, mode, ok, sessionType }`
- `info` `down` — `{ source, modelStatus, isRecording }`
- `info` `up` — `{ source, durationMs, hadTranscript }` (`hadTranscript` is boolean, never the text)
- `warn` `collision` — `{ accelerator, platform }`
- `warn` `busy` — `{ activeTabId, requestedTabId }`
- `warn` `miss-model-loading` — `{ modelStatus }`
- `warn` `drain-timeout` — `{ durationMs }`
- `error` `register-failed` — `{ accelerator, platform, sessionType }`

The wrapper enforces the no-transcript rule via the sanitizer.

## Testing Plan

Playwright e2e (extends the WAV-fed harness in `e2e/`):
- Hold mode: keydown → 600 ms → keyup → assert `__transcripts` populated.
- Toggle mode: two keydowns; assert start then stop.
- Pre-model arming: keydown before `ready`; assert `armed`; resolve model; assert recording starts.
- Blur watchdog: simulate `window.blur` mid-hold; assert stop within 100 ms.
- Busy: hotkey while another tab recording; assert no-op + `busy` log.
- Auto-repeat: dispatch with `isAutoRepeat: true`; assert one start.
- Drain timeout: stub the worker to never drain; assert `aborted` after 10 s.
- Sanitizer: log `{ transcript: 'foo' }`; assert dev throw / prod drop.
- `XDG_SESSION_TYPE=wayland`: under xvfb-run with the env set, mock the DBus call to return no portal; assert global toggle is disabled.

Manual:
- macOS: confirm `Cmd+Option+V` is unbound on a fresh user account.
- Linux Wayland (GNOME 45+): with portal present, confirm portal prompt and binding survives restart. With portal absent, confirm disabled state with explanation.
- Windows: `Ctrl+Shift+Space` works while Notepad is focused (toggle).
- Concurrent global hotkey: bind another app to the same chord on each OS; verify our settings UI surfaces the collision warning.

## Alternatives Considered

1. **Button-only.** Lowest cost, but click-to-record is the #1 friction.
2. **Per-window only.** Skips Wayland complexity; off-window users still want global, so we gate it behind a default-off toggle.
3. **Wake-word.** Higher CPU, false-positive surface; punted to F4.
4. **OS dictation passthrough** (`Fn`, `Win+H`). Sends audio to OS vendor — rejected; the value prop is local STT.
5. **Renderer-document fallback as a third capture layer.** Rejected — cannot dedupe against `before-input-event` without an in-renderer guard that is racy under blur.

## Open Questions

1. Schema location — dedicated `voice.json` (hot-reloadable) vs. merge into `session-rules.json`? **Decision needed:** dedicated vs. merged + a schema version for migration.
2. UI placement — top-level "Voice" tab vs. nest under "Settings → Input"? **Decision needed.**
3. Warm-mic default — off (privacy) vs. on (UX)? **Decision needed;** recommend off with a Settings toggle.
4. F1a tray-icon timeline — same release as F1 or one minor behind? **Decision needed** so banner copy is accurate.
5. First-run picker — show always, or only when default chord fails `globalShortcut.isRegistered`? **Decision needed.**
6. Headless CI — additional non-Wayland Linux job, or rely on the existing xvfb harness? **Decision needed.**

## Sources

- [Mac keyboard shortcuts — Apple Support 102650](https://support.apple.com/en-us/102650) — verifies `Cmd+Shift+Space` = "Select previous input source"; `Cmd+Option+V` unbound by default.
- [globalShortcut | Electron docs](https://www.electronjs.org/docs/latest/api/global-shortcut/)
- [Keyboard Shortcuts | Electron docs](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts)
- [Global Shortcuts Broken on Wayland (electron #45607)](https://github.com/electron/electron/issues/45607)
- [feat: GlobalShortcutsPortal (electron #45171)](https://github.com/electron/electron/pull/45171)
- [globalShortcut not very global in Wayland (electron #15863)](https://github.com/electron/electron/issues/15863)
- [globalShortcuts behaviour is not actually global (electron #27240)](https://github.com/electron/electron/issues/27240)
- [Global shortcuts failing on Wayland — 40.x regression (electron #49806)](https://github.com/electron/electron/issues/49806) — basis for the 40.x block.
- [claude-code #34305 — voice mode keybinding](https://github.com/anthropics/claude-code/issues/34305)
- [Push-To-Talk vs VAD — TeamSpeak](https://support.teamspeak.com/hc/en-us/articles/360002745898)
- [Voice Input Modes 101 — Discord](https://support.discord.com/hc/en-us/articles/211376518)
- [xdg-desktop-portal GlobalShortcuts](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html) — basis for portal probe and ≥1.17 minimum.

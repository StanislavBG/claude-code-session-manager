# F1 — Push-to-talk + Global Hotkey

Status: Draft
Author: voice-feature working group
Last updated: 2026-05-02

## Problem & Motivation

Voice input today requires a mouse click on the mic icon (`VoiceButton` at `src/renderer/components/VoiceButton.tsx:36`). This is a terminal-first app: hands stay on the keyboard, the active tab is usually a `node-pty`-backed xterm, and clicking steals focus so the first transcribed character can land in the wrong place. We want keyboard-first activation:
- Hold-to-talk and toggle-to-talk modes, single configurable accelerator.
- Works while a terminal tab is focused (xterm.js would otherwise swallow the keys).
- Optionally global, so users can dictate from another app (browser, IDE) and have the transcript injected into the active session-manager tab.

## Scope

In:
- New `voice.hotkey` settings block: `{ accelerator: string, mode: 'hold' | 'toggle', global: boolean }`.
- Window-local key handling via `before-input-event` (always on).
- Optional `globalShortcut` registration when `voice.hotkey.global === true`.
- Settings UI to capture and re-bind the accelerator.
- State-machine guards so a hotkey press is a no-op until the model is ready.
- Logging via `window.api.logs.write('voice-hotkey', …)`.

Out:
- Wake-word activation ("Hey Claude") — separate feature F4.
- Per-tab hotkey customization.
- Multi-modifier chords beyond what `globalShortcut` accepts.
- Voice barge-in over running TTS — F2.

## UX Flow

Default key choice (per OS), based on the lowest collision risk we could survey:

| OS | Default | Rationale |
|---|---|---|
| macOS | `Cmd+Shift+Space` | `Fn` dictation already exists; `Cmd+Space` is Spotlight |
| Linux | `Ctrl+Shift+Space` | Avoids GNOME/KDE compose key territory |
| Windows | `Ctrl+Shift+Space` | `Win+H` is system dictation |

Modes:
- **Hold-to-talk (default):** key down -> start; key up -> stop and submit. Minimum hold of 150 ms before activation to avoid accidental taps. After release, VAD's `redemptionMs: 600` already gives a graceful tail.
- **Toggle:** first tap arms recording, second tap stops. A 5-minute auto-stop guards against forgotten sessions.

Visual states (extend `RecordingStatus` in `LeftNav.tsx:89` and `VoiceButton` ring at `VoiceButton.tsx:45`):
1. Idle: icon dim.
2. Hotkey-armed (held but model not ready): amber pulse + "Hold — model loading 67%".
3. Recording: red pulse + "Listening…" or interim text.
4. Transcribing: blue pulse + "Transcribing…".
5. Cooldown after toggle stop: 250 ms grey check.

Customizability: a "Voice" tab in Settings exposes a single capture field (records the next key chord), a hold/toggle radio, and a "Capture globally (Linux/Windows: requires desktop portal)" checkbox.

## Technical Design

State machine (single source of truth in `useVoice`):

```
idle --(keydown, model=ready)--> recording
idle --(keydown, model=loading)--> armed --(model->ready)--> recording
                                       \--(keyup before ready)--> idle (no-op)
recording --(keyup in hold mode)--> stopping
recording --(keydown in toggle mode)--> stopping
stopping --(transcribe drained)--> idle
```

Three-layer key capture:

1. **Window-local (always on)** — `mainWindow.webContents.on('before-input-event', …)` near the menu block at `src/main/index.cjs:219`. Fires before xterm; `event.preventDefault()` blocks the terminal. Only path that reliably works on Wayland today.
2. **Renderer fallback** — `document` keydown/keyup, useful in dev when DevTools steals `before-input-event`. A `data-voice-hotkey-host` flag prevents double-fire.
3. **`globalShortcut`** — registered when `voice.hotkey.global === true`. On Linux, set `app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')` so the XDG portal handles Wayland. `globalShortcut` only fires on press, not release, so it drives **toggle** but not hold; when `global && mode=hold`, degrade to press-arms-for-N-seconds (default 8 s).

IPC plumbing:

- Preload (`src/preload/index.cjs:3` — new `voice` namespace): `voice.onHotkey(handler)` for `voice:hotkey` events `{ phase: 'down'|'up', source: 'window'|'global' }`; `voice.setHotkeyConfig(cfg)` -> `voice:set-hotkey`.
- Main: dispatch `voice:hotkey` from `before-input-event` (with `preventDefault()`) and `globalShortcut`; `app.on('will-quit', () => globalShortcut.unregisterAll())`.
- Renderer: `useVoice` adds `armHotkey()` running the state machine on top of existing `startRecording(activeTabId)` / `stopRecording()` (`voice.ts:74`, `:117`).

Integration points (file:line):
- `src/main/index.cjs:219` — extend menu/accelerator block, add `before-input-event` wiring.
- `src/main/index.cjs:192` — register `globalShortcut` inside `app.whenReady()` after permission handlers.
- `src/preload/index.cjs:3` — expose `voice` namespace.
- `src/renderer/state/voice.ts:74` — entry point reused; add `armed` flag.
- `src/renderer/components/VoiceButton.tsx:18` — surface "Hold to talk" hint when hotkey config is hold-mode.
- `src/renderer/lib/speechRecognition.ts:170` — `preSpeechPadMs: 300` already absorbs ~300 ms before keydown, so the first phoneme survives even with a fast trigger.

## Edge Cases & Failure Modes

1. **Hotkey collision with another app** — `globalShortcut.register` returns `false` silently; surface a settings-page warning, fall back to window-local. Re-check on `browser-window-focus`.
2. **Rapid press/release before model loaded** — `idle -> armed -> idle`; log `miss-model-loading`, flash loading bar, no recording.
3. **Model loading when key held** — stay `armed`; transition to `recording` when `ready` fires. `preSpeechPadMs: 300` keeps the leading consonant.
4. **Key held during app launch** — listeners don't exist before `ready-to-show`; pre-init keydowns are ignored, no buffered replay.
5. **Text input vs terminal** — chord schema forbids plain alphanumerics; configured chord is intercepted in both contexts.
6. **Hotkey while TTS speaking** — cancel via `speechSynthesis.cancel()` (`src/renderer/lib/speechSynthesis.ts`) on `phase: down` before starting recognizer; otherwise mic picks up the speakers.
7. **Another tab recording** — first-press wins on shared `activeHandle` (`voice.ts:28`); subsequent presses log `busy`. No implicit tab-switch.
8. **xterm captures keys** — `before-input-event` fires before xterm; `preventDefault()` blocks `node-pty`. Defaults don't overlap with existing accelerators (`src/main/index.cjs:225-244`).
9. **Lost focus mid-hold** — keyup is missed; 30 s hard-stop watchdog plus `window.blur` -> force-stop.
10. **First-200 ms clipping** — already mitigated by `preSpeechPadMs: 300` in `speechRecognition.ts:170`; documented, do not lower.
11. **Multiple windows / instances** — `globalShortcut` is process-global; only focused window receives `voice:hotkey`. Add `app.requestSingleInstanceLock()` (not currently set in `index.cjs`).
12. **Auto-repeat double-fire** — `globalShortcut` does not auto-repeat, but `before-input-event` does; discard `event.isAutoRepeat`.
13. **Modifier release timing** — releasing `Shift` before `Space` drops the keyup; listen for `keyup` on the *non-modifier* only.
14. **Mic permission denied** — `getUserMedia` rejection at `speechRecognition.ts:188` surfaces the existing error toast.

## Security & Privacy

- A global hotkey can start recording when the window is hidden. We MUST keep the recording indicator visible: the OS tray icon turns red while `isRecording === true` (new tray work, tracked here) and the `RecordingStatus` banner stays mounted.
- Never log transcript text in hotkey logs — only event metadata.
- Sensitive input near hotkey: passwords typed in a terminal could be captured if the hotkey accidentally arms recording. Mitigation: enforce a 150 ms hold floor and require a modifier in the schema (no bare `F-keys` in default config).
- Document in the Settings UI that "global" mode means audio capture can begin from any app focus state.
- Renderer never gets raw key events from main except for the configured chord — no general key-logging surface.

## Telemetry & Logging

All via `window.api.logs.write('voice-hotkey', level, msg, meta)` (preload at `src/preload/index.cjs:60`):

- `info` `register` — `{ accelerator, global, mode, ok }`
- `info` `down` — `{ source, modelStatus, isRecording }`
- `info` `up` — `{ source, durationMs, hadTranscript }`
- `warn` `collision` — `{ accelerator, platform }`
- `warn` `busy` — `{ activeTabId, requestedTabId }`
- `error` `register-failed` — `{ accelerator, platform, sessionType }`

No transcript content is ever logged.

## Testing Plan

Playwright e2e (extends the WAV-fed harness in `e2e/`, see project memory):
- Hold mode happy path: send synthetic keydown -> wait 600 ms -> keyup -> assert `__transcripts` populated.
- Toggle mode: two synthetic keydowns; assert recording starts then stops.
- Pre-model arming: send keydown immediately at boot before model `ready`; assert `armed` state; resolve model; assert recording starts.
- Auto-stop watchdog: simulate `window.blur` mid-hold; assert recording stops within 100 ms.
- Hotkey while another tab recording: assert second press is a no-op and logs `busy`.
- Auto-repeat suppression: dispatch `KeyboardEvent` with `repeat: true`; assert only one start.

Manual:
- macOS: confirm `Cmd+Shift+Space` doesn't collide with Spotlight in user's locale.
- Linux Wayland (GNOME): with `enable-features=GlobalShortcutsPortal`, confirm portal prompt appears once and binding survives restart.
- Windows: confirm `Ctrl+Shift+Space` works while Notepad is focused (global mode).
- Concurrent global Discord PTT bound to same chord — verify our settings UI surfaces collision warning.

## Alternatives Considered

1. **Keep button-only.** Lowest cost, but click-to-record is the #1 friction in the voice feature.
2. **Per-window shortcut only.** Skips Wayland/portal complexity and the off-window recording privacy concern. Shipping as *default*; power users dictating from a browser still want global, so we gate it behind an off-by-default toggle.
3. **Wake-word ("Hey Claude").** Always-on KWS — higher CPU, harder false-positive surface; punted to F4.
4. **OS-native dictation passthrough** (`Fn`, `Win+H`). Bypasses our local Moonshine model, sends audio to OS vendor — rejected, the value prop is local STT.

## Open Questions

1. Confirm `Cmd+Shift+Space` doesn't collide with the user's Raycast/Alfred binds (survey internally).
2. Schema location — dedicated `voice.json` (hot-reloadable) vs. merge into `session-rules.json`? Leaning dedicated.
3. UI placement — top-level "Voice" tab vs. nest under "Settings -> Input"? Tabs plan has free slots.
4. Global+toggle auto-stop — fixed 8 s vs. VAD `redemptionMs`? VAD is more elegant but bypasses explicit-control mental model.
5. "Tap-tap to lock" (double-tap promotes hold -> toggle) like ChatGPT desktop — defer.
6. Tray icon — in scope for F1 or split? Recommend split.

## Sources

- [globalShortcut | Electron docs](https://www.electronjs.org/docs/latest/api/global-shortcut/)
- [Keyboard Shortcuts | Electron docs](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts)
- [Global Shortcuts Broken on Wayland (electron #45607)](https://github.com/electron/electron/issues/45607)
- [feat: support global shortcuts via GlobalShortcutsPortal (electron #45171)](https://github.com/electron/electron/pull/45171)
- [globalShortcut not very global in Wayland (electron #15863)](https://github.com/electron/electron/issues/15863)
- [globalShortcuts behaviour is not actually global (electron #27240)](https://github.com/electron/electron/issues/27240)
- [Global shortcuts failing on Wayland — regression in 40.x (electron #49806)](https://github.com/electron/electron/issues/49806)
- [Voice UI Design Guide 2026 — Fuselab Creative](https://fuselabcreative.com/voice-user-interface-design-guide-2026/)
- [Voice AI & Voice Agents: An Illustrated Primer](https://voiceaiandvoiceagents.com/)
- [Voice mode: wake-word, toggle-to-talk, configurable keybinding (claude-code #34305)](https://github.com/anthropics/claude-code/issues/34305)
- [Push-To-Talk vs Voice Activity Detection — TeamSpeak](https://support.teamspeak.com/hc/en-us/articles/360002745898)
- [Voice Input Modes 101 — Discord](https://support.discord.com/hc/en-us/articles/211376518)

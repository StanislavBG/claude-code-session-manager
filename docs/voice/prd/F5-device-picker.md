# F5 — Audio Input Device Picker + Remembered Selection

**Status:** Draft
**Owner:** voice
**Last updated:** 2026-05-02 (PDT)
**Related:** F3 (MicVAD lifecycle / stream ownership)

## Problem & Motivation

The renderer's speech path (`src/renderer/lib/speechRecognition.ts:158`) calls `MicVAD.new()` with no audio constraints. MicVAD internally invokes `getUserMedia({ audio: true })`, so the OS-default input device is always used. Users with multiple mics (built-in array, USB headset, Bluetooth, virtual cable) cannot pick one without changing their OS-wide default. On Linux/PulseAudio that default is especially fragile.

Concrete failure modes:

1. User plugs in a headset — Claude Code keeps recording from the laptop array.
2. User has a "Monitor of Output" source as default — mic captures speakers.
3. User wants a specific mic for QA and has to fight the OS chooser.

We want a first-class in-app picker that persists per-user, survives USB reseats when possible, and degrades to "Default" cleanly when the chosen device disappears.

## Scope

**In:** picker UI for `audioinput` devices; persisted selection applied across sessions; live device-change handling; fallback to OS default when the remembered device is gone; manual refresh.

**Out:** output device selection (`setSinkId`); per-tab device selection; per-device gain/AGC/noise-suppression (F6); Bluetooth profile forcing (HFP vs A2DP).

## UX Flow

**Where the dropdown lives.** A new **Voice** sub-panel under the Settings tab (`src/renderer/components/tabs/Settings.tsx`). We deliberately do not put it inline in `LeftNav.tsx`: the nav voice cluster is for in-the-moment status (record button, errors, model load progress) and is too narrow for a wide device label. A small chevron next to the VoiceButton opens a compact quick-switch menu (`Default`, listed devices, `Settings…`).

**When the list populates.** Lazily, on first paint of the Voice panel or first chevron open. We call `navigator.mediaDevices.enumerateDevices()`. Because main grants media perms at startup (`src/main/index.cjs:206-211`), labels should be populated, but we still guard the empty-label case. A Refresh button re-runs enumeration; the `devicechange` event covers automatic updates.

**The "Default" sentinel.** First row is always `Default (system)` with `deviceId === 'default'` (Chromium synthesizes this entry). Selecting it equals "no constraint" and is the initial state. Persisting `null`/absent also means Default.

**When the selected device disappears.** We do not silently change selection. We keep the saved preference (so a USB reseat restores it), surface a yellow status pill `Selected mic unavailable — using Default` in the LeftNav status row, and constrain with `deviceId: { ideal: <savedId> }` so the browser auto-falls back. The user must explicitly pick Default to clear the preference.

## Technical Design

### Enumeration & permission gating

`enumerateDevices()` returns entries with empty `label` and unstable `deviceId` strings until a media permission has been granted to the origin in this rendering context. Main already auto-grants `media`/`audioCapture`/`microphone` and triggers macOS consent (`src/main/index.cjs:215-217`), but **labels remain empty until the first successful `getUserMedia()` in the renderer.** To unlock labels without making the user record first, we run a one-shot priming call (≤50 ms, immediately stopped) on first panel open, gated by a `devicesUnlocked` flag.

### deviceId stability

Per the WebRTC spec the `deviceId` is "persisted across sessions… reset when the user clears cookies." In practice, Linux PipeWire/PulseAudio renames the underlying ALSA source when a USB device is reseated, so Chromium hashes a different string and the saved id no longer matches. (Safari/WebKit has bug 179220 making this worse, but we ship Electron/Chromium only.)

**Mitigation: label-based fallback.** We persist both `deviceId` and `label`. On startup, if no entry matches the saved `deviceId`, we look for one whose `label` matches exactly. If found, silently rebind and re-save. If not, surface the unavailable pill.

### Persistence

This is a per-machine user setting, not Claude Code config. New file: `~/.claude/session-manager/voice.json`.

```json
{ "inputDevice": { "deviceId": "abc…", "label": "Logitech USB Headset", "groupId": "xyz…" } }
```

Reasons not to reuse `~/.claude/settings.json`: (a) it's Claude Code's territory and not ours to extend; (b) the `useConfig` flow in `src/renderer/state/config.ts` is built around scoped JSON the user may also hand-edit — a hashed deviceId is not human-meaningful. Add `window.api.voice.{read,write}` IPC backed by a small main helper next to `src/main/logs.cjs`.

### Switching device live

MicVAD has no documented API to swap streams after `start()`. Use destroy + reinit, which `speechRecognition.ts:207-210` already does on stop. Two options for actually passing the deviceId:

- **(A) Pass via MicVAD options.** `@ricky0123/vad-web` accepts `additionalAudioConstraints` merged into its internal `getUserMedia`. Smallest change.
- **(B) Own the stream.** `getUserMedia({ audio: { deviceId: { exact: id } } })` ourselves, pass `stream:` to `MicVAD.new`. Required if F3 also wants to feed the stream into a level meter or recorder.

**Recommendation:** ship (A) for F5 alone. If F3 lands first, switch to (B); both paths share the persistence schema.

### Hot-swap via `devicechange`

Per MDN, `navigator.mediaDevices` emits `devicechange` whenever the system's device set changes. Attach once at app startup (alongside `installConfigChangeListener` in `App.tsx`). On fire: re-enumerate; if recording and the active id has vanished, stop recording, surface the pill, set `error: 'Mic disconnected'`; if a previously-saved-but-missing id reappears, silently rebind on the next start (do not auto-start).

### Integration points

- `src/renderer/lib/speechRecognition.ts:158` — accept `inputDeviceId?: string` and thread into MicVAD options.
- `src/renderer/state/voice.ts:45` — extend store with `inputDeviceId`, `inputDeviceLabel`, `availableInputs`, `setInputDevice()`, `refreshDevices()`.
- `src/renderer/components/tabs/Settings.tsx` — add Voice sub-panel.
- `src/renderer/components/LeftNav.tsx:74` — chevron next to `<VoiceButton />`.
- New `src/main/voice.cjs` — read/write `voice.json`; logs via `src/main/logs.cjs`.
- New preload exports `voice.readPrefs()` / `voice.writePrefs(prefs)`.

## Edge Cases & Failure Modes

1. **Permission not yet granted → empty labels.** Detect `entries.every((e) => !e.label)`, run the priming `getUserMedia` to unlock. If priming rejects, render "Microphone access denied — grant permission to choose a device" with a retry.
2. **User picks a device, then unplugs it.** Pref stays; constrain with `deviceId: { ideal: id }` so the OS falls back. Pill: "Selected mic unavailable — using Default".
3. **deviceId churn after USB reseat (Linux/PipeWire).** Label fallback rebinds and re-saves; log at info.
4. **Two devices with identical labels** (two identical USB mics, or built-in + virtual passthrough sharing a name). Disambiguate in the dropdown by appending a short `groupId` hash for duplicates only. Selection pins by `deviceId` first.
5. **`devicechange` during an active recording.** Active id still present → no-op. Vanished → stop, fall back, pill. Don't auto-restart; recording is a deliberate action.
6. **User removes default device while a non-default is selected.** No-op. The OS picks a new default; our explicit selection is unaffected.
7. **PulseAudio/PipeWire monitor sources** (`Monitor of <output>`) appear as `audioinput` and let users accidentally record speaker output. Don't filter (Chromium usually excludes them; hiding would mask legitimate loopback workflows). Tag any device whose label includes `monitor` with a small "loopback" badge.
8. **Bluetooth A2DP vs HFP profile mismatch.** A BT headset in A2DP may list an HFP mic that won't start until the OS swaps profiles. Out of scope to manage. Catch the rejection: "Selected mic refused to start — try another or check your Bluetooth profile."
9. **Permission revoked while picker is open.** Next `enumerateDevices` returns empty labels; re-render the "grant permission" state.
10. **Settings file write race.** Use the write-temp-then-rename pattern from `logs.cjs`. Last-writer-wins is acceptable for a one-key file.
11. **Wayland quirks.** Mic input on Wayland is handled transparently by Chromium; no special concern. PipeWire portal-mediated capture can produce session-rotating deviceIds — same label fallback covers it.
12. **Stale enumeration during model load.** Picker is independent of the Whisper download; do not block one on the other.

## Security & Privacy

Device labels can be PII-ish ("John's MacBook Pro Microphone"). They never reach the worker, never leave the renderer, and are **never logged**. We log only `deviceId` (already an opaque hash) and a short prefix where useful. `voice.json` lives at `~/.claude/session-manager/voice.json` with `0600` perms (matching `logs.cjs`). No network egress; this is purely local.

## Telemetry & Logging

All via `log.info('voice', …)`:

- `picker:opened`
- `picker:enumerated { count, hasLabels }`
- `picker:selected { deviceIdPrefix }` — never the label
- `picker:fallback { reason: 'unavailable' | 'rebound-by-label' }`
- `devicechange { added, removed, total }` — counts only
- `recording:device-vanished` — when hot-swap kills a live session

## Testing Plan

**Unit (Vitest):**

- `pickDeviceFromList(savedId, savedLabel, devices)` → saved id if present, else label match, else `null`. Cover empty list, identical labels, no match.
- `dedupeLabels(devices)` → groupId suffix on duplicates only.
- `isMonitorSource(label)` → regex.
- Mock `navigator.mediaDevices` to assert store transitions on `devicechange`.

**Manual E2E** (the xvfb fake-audio harness can't simulate multiple devices today):

- Built-in only → picker shows `Default` + 1.
- Plug USB while panel open → appears within ~500 ms.
- Select USB → record → unplug mid-recording → recording stops, pill appears.
- Replug USB → no auto-restart; selection rebinds; manual record uses USB.
- Bluetooth A2DP → `getUserMedia` rejection path.
- Reboot → preference persists.

## Alternatives Considered

1. **Rely on OS default only (status quo).** Zero code, doesn't solve the failure modes. Rejected.
2. **System mic indicator only — open OS sound settings on click.** Cross-platform inconsistent (gnome-control-center vs `ms-settings:sound` vs macOS), can't be embedded, doesn't fix the wrong-default case. Rejected.
3. **Per-tab device selection.** Adds a column to the Tabs schema, complicates persistence, no observed user need. Punted.
4. **`setSinkId` on a hidden `<audio>` to force input routing.** `setSinkId` is output-only. Rejected.

## Open Questions

- **Follow OS default changes automatically?** When pinned to `Default`, OS flips already work. When the user has a specific device pinned and the OS flips defaults, do we ignore (current proposal) or prompt? Lean ignore, log the event so we can revisit.
- **"Test mic" button** in the picker — a 3-second meter without invoking Whisper? Probably yes; flag as stretch.
- **Is `additionalAudioConstraints` a stable MicVAD API?** Used in the wild, undocumented. If removed, fall back to option B (own the stream) — already on F3's roadmap.
- **Priming UX.** Is a 50 ms mic-indicator flicker on first panel open acceptable, or should we defer priming until the dropdown is clicked explicitly?

## Sources

- [MDN: MediaDevices.enumerateDevices()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices)
- [MDN: MediaDeviceInfo](https://developer.mozilla.org/en-US/docs/Web/API/MediaDeviceInfo)
- [WebKit Bug 179220 — deviceIds change on page refresh](https://bugs.webkit.org/show_bug.cgi?id=179220)
- [WebRTC.org: Getting started with media devices](https://webrtc.org/getting-started/media-devices)
- [webrtc-developers.com: Managing Devices in WebRTC](https://www.webrtc-developers.com/managing-devices-in-webrtc/)
- [Electron docs: Device Access](https://www.electronjs.org/docs/latest/tutorial/devices)
- [W3C Audio Output Devices API](https://www.w3.org/TR/audio-output/)
- [WebRTC Samples: Select audio and video sources](https://webrtc.github.io/samples/src/content/devices/input-output/)

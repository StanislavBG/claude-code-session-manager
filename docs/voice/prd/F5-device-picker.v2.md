# F5 — Audio Input Device Picker + Remembered Selection (v2)

**Status:** Draft (revised)
**Owner:** voice
**Last updated:** 2026-05-02 (PDT)
**Related:** F3 (MicVAD lifecycle / stream ownership) — v2 converges on the same stream-ownership design.

## Changes from v1

The adversarial review surfaced two showstoppers and several smaller defects. v2 folds them in:

- **Stream ownership (S1).** v1's "Recommendation A" relied on `additionalAudioConstraints`, which does not exist. `node_modules/@ricky0123/vad-web/dist/real-time-vad.d.ts` exposes only `audioContext`, `getStream`, `pauseStream`, `resumeStream`. v2 owns the stream in `speechRecognition.ts` and passes both `getStream` and `resumeStream` (otherwise the device pin drops on first VAD pause/resume). Same path as F3.
- **Atomic-write reference (S2).** v1 cited `logs.cjs`, which uses `fs.appendFileSync` — intentionally non-atomic. The real temp-then-rename pattern is `sessionsStore.cjs:46-48`.
- **Persistence root.** `~/.config/session-manager/voice.json` to match `sessionsStore.cjs:20`. Not `~/.claude/`.
- **Schema trimmed.** Dropped `groupId` (no consumer). Added `schemaVersion`.
- **Label-fallback uniqueness rule.** Rebind only when the label match is unique; otherwise treat as unavailable.
- **"Pill" defined.** Replaced with `Toast` plus concrete copy/severity/dismissibility.
- **Monitor-source filtering.** Best-effort hide of "Monitor of …" sources by default with a reveal toggle.
- **`devicechange` listener.** Bound in one React effect at `App.tsx`, cleaned up on unmount; never on module init.
- **E2E.** Hot-swap tests are manual-only; xvfb fake-audio can't hot-plug.
- **Priming.** Drop the priming `getUserMedia`; verify-then-decide. Modern Chromium with main-process permission grant should populate labels without it. Keep priming only as a fallback.
- **UI placement.** Commit to inline-in-LeftNav for v1: a single dropdown next to `<VoiceButton />`. A Settings tab entry can land later.

## Problem & Motivation

`src/renderer/lib/speechRecognition.ts:158` calls `MicVAD.new()` with no audio constraints, so the library's default `getStream` calls `getUserMedia({ audio: true })` and the OS-default input device wins every time. Users with multiple mics cannot pick one without changing the OS default. On Linux/PulseAudio that default is fragile.

Concrete failures: headset plugged in but laptop array still recording; "Monitor of Output" set as default and we capture speakers; QA wants to A/B mics.

We want a first-class in-app picker that persists per-user, survives USB reseats when possible, and degrades to Default cleanly when the chosen device disappears.

## Scope

**In:** picker UI for `audioinput` devices inline in LeftNav; persisted selection applied across sessions; live device-change handling; uniqueness-checked label-fallback when `deviceId` churns; manual refresh; default-hide of monitor sources.

**Out:** output device selection (`setSinkId`); per-tab device selection; per-device gain/AGC/noise-suppression knobs (F6); Bluetooth profile forcing (HFP vs A2DP); a Settings-tab home (follow-up).

## UX Flow

**Where the dropdown lives.** Inline in `src/renderer/components/LeftNav.tsx:74`, immediately right of `<VoiceButton />`. A compact `<select>`-style dropdown with rows: `Default (system)`, the enumerated devices, `Refresh`, `Show monitor sources`. Width is constrained to the nav's available space; long labels truncate with ellipsis and a hover tooltip.

**When the list populates.** Lazily, on first dropdown open. We call `navigator.mediaDevices.enumerateDevices()`. Labels should be populated because main grants media permissions at startup (`src/main/index.cjs:206-217`). If `entries.every(e => !e.label)`, we run a one-shot priming `getUserMedia` (≤50 ms, immediately stopped) once, behind a `devicesUnlocked` flag. We measure first; if labels populate without priming on every supported platform during dogfood, we delete the priming code path before merge.

**The "Default" sentinel.** First row is always `Default (system)`. Selecting it equals "no `deviceId` constraint" and is the initial state. Persisted `null`/absent also means Default.

**When the selected device disappears.** We do not silently change the persisted selection. We surface a `Toast` (see below) and constrain with `deviceId: { ideal: <savedId> }` so Chromium auto-falls back to the OS default for the active session. The user must explicitly pick Default to clear the preference.

**Toast spec.** Reuse the existing `Toast` component. Severity `warning`, copy `Selected mic unavailable — using default`, dismissible, auto-hide 6 s. Rebind variant: severity `info`, copy `Mic re-detected as "<label>"`, auto-hide 4 s. No new component.

## Technical Design

### Stream ownership (replaces v1 §"Switching device live")

`speechRecognition.ts` owns the `MediaStream`. We allocate the `AudioContext` ourselves, call `getUserMedia` ourselves, and feed both into `MicVAD.new` via the documented hooks.

```ts
// Hot path: called on every record start. ~1 getUserMedia + 1 AudioContext.
// O(1); no loops over device-scaled data.
const audioCtx = new AudioContext({ sampleRate: 16000 });
const constraints: MediaStreamConstraints = {
  audio: {
    deviceId: configuredId ? { exact: configuredId } : undefined,
    channelCount: 1,
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: true,
  },
};
const stream = await navigator.mediaDevices.getUserMedia(constraints);

const vad = await MicVAD.new({
  audioContext: audioCtx,
  getStream: async () => stream,
  resumeStream: async () => stream, // critical: keeps device pin across pause/resume
  pauseStream: async () => {},      // we keep the stream alive; tracks paused via AudioContext suspend
  // ... existing callbacks
});
```

Tear-down order matches F3 v2: `await vad.destroy()` → stop each `MediaStreamTrack` → `await audioCtx.close()` → null-out refs. Doing destroy first lets the worklet drain; stopping tracks before destroy can race the final frame.

If `getUserMedia` rejects (`OverconstrainedError`, `NotAllowedError`, `NotFoundError`, `NotReadableError`), we surface a Toast keyed by the error name and leave the persisted preference alone unless the user explicitly clears it.

### Enumeration & permission gating

`enumerateDevices()` returns empty `label` and unstable `deviceId` strings until a media permission is granted to the rendering origin. `src/main/index.cjs:206-217` already auto-grants `media`/`audioCapture`/`microphone`. v2 starts without priming. Detection is `entries.length > 0 && entries.every(e => !e.label)` — if true on first paint, run the priming `getUserMedia` once and re-enumerate. Log which path was taken so we can decide whether to remove priming entirely after a dogfood window.

### deviceId stability & label fallback (uniqueness-checked)

WebRTC says `deviceId` is "persisted across sessions". In practice Linux PipeWire/PulseAudio renames the underlying source on USB reseat, the per-origin salt produces a new hash, and the saved id stops matching. We persist `selectedDeviceId` and `selectedLabel`.

Algorithm for `pickDeviceFromList(savedId, savedLabel, devices)`, O(n) over a tiny n:

1. If `devices` contains `deviceId === savedId` → return it.
2. Otherwise count `matches = devices.filter(d => normalize(d.label) === normalize(savedLabel))`.
3. If `matches.length === 1` → return it; rebind and re-save the new `deviceId`; emit the `info` Toast.
4. If `matches.length === 0` or `> 1` → return `null` (treat as unavailable; emit the `warning` Toast). Do not guess between duplicates.

`normalize(label)` collapses whitespace and strips a trailing parenthesized suffix (PulseAudio's `(USB-1)`, PipeWire port suffixes). Best-effort; we acknowledge labels can still drift.

### Persistence

Per-machine user setting, not Claude Code config. New file: `~/.config/session-manager/voice.json` (matching `sessionsStore.cjs:20`).

```json
{
  "selectedDeviceId": "...",
  "selectedLabel": "Logitech USB Headset",
  "schemaVersion": 1
}
```

Atomic write: copy the pattern at `sessionsStore.cjs:46-48` — `fs.writeFileSync(${p}.tmp-${pid}-${ts}, json)` followed by `fs.renameSync(tmp, p)`. Last-writer-wins is acceptable for this single-key file. New `src/main/voice.cjs` reads and writes; preload exposes `window.api.voice.{readPrefs, writePrefs}`. File mode `0600`.

### Hot-swap via `devicechange`

`navigator.mediaDevices` emits `devicechange` whenever the OS device set changes. v2 binds this in **one** React effect at `App.tsx`, alongside `installConfigChangeListener`:

```ts
useEffect(() => {
  const handler = () => useVoice.getState().refreshDevices();
  navigator.mediaDevices.addEventListener('devicechange', handler);
  return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
}, []);
```

The handler dispatches into Zustand. `voice.ts` never self-attaches on module import (StrictMode would double-mount it during HMR). On fire: re-enumerate; if recording and the active id has vanished, stop recording, set `error: 'Mic disconnected'`, surface the warning Toast; if a previously-saved-but-missing id reappears uniquely, rebind silently on next start (do not auto-start).

### Monitor-source filtering

On Linux/PipeWire, monitor sources show up as `audioinput` and let users accidentally record speaker output. Best-effort filter at enumeration time: hide entries whose label matches `/^monitor of /i`. Label is the only portable heuristic. A `Show monitor sources` toggle in the dropdown reveals them. A persisted monitor selection is never silently dropped from the list.

### Integration points

- `src/renderer/lib/speechRecognition.ts:158` — accept `inputDeviceId?: string`; own the stream and AudioContext per the snippet above.
- `src/renderer/state/voice.ts:45` — extend store with `inputDeviceId`, `inputDeviceLabel`, `availableInputs`, `showMonitorSources`, `setInputDevice()`, `refreshDevices()`.
- `src/renderer/components/LeftNav.tsx:74` — dropdown next to `<VoiceButton />`.
- `src/renderer/App.tsx` — single `useEffect` for `devicechange`.
- New `src/main/voice.cjs` — read/write `~/.config/session-manager/voice.json` with the `sessionsStore.cjs` atomic pattern.
- New preload exports `voice.readPrefs()` / `voice.writePrefs(prefs)`.

## Edge Cases & Failure Modes

1. **Permission not yet granted → empty labels.** Detect and run one-shot priming as a fallback; if priming rejects, render `Microphone access denied — grant permission to choose a device` with retry.
2. **User picks a device, then unplugs it.** Pref stays; `deviceId: { ideal: id }`; warning Toast. Pref clears only on explicit Default selection.
3. **deviceId churn after USB reseat.** Unique-label fallback rebinds and re-saves; info Toast.
4. **Two devices with identical labels.** Fallback returns `null`; user picks manually. We never silently rebind to one of N matches.
5. **`devicechange` during active recording.** Active id present → no-op. Vanished → stop, warning Toast, do not auto-restart.
6. **Default device removed while non-default is selected.** No-op; OS picks a new default; our explicit selection is unaffected.
7. **PipeWire/PulseAudio monitor sources.** Hidden by default; toggle reveals them. Users who explicitly persist one keep it.
8. **Bluetooth A2DP↔HFP profile flip.** Opening HFP forces clients off A2DP and music drops for a few seconds. We accept that transient and surface `Switching Bluetooth profile…` while `getUserMedia` is pending.
9. **Permission revoked while picker is open.** Next enumerate returns empty labels; re-render the grant-permission state.
10. **Settings file write race.** Temp-then-rename per `sessionsStore.cjs:46-48`. Last-writer-wins.
11. **Wayland / portal-mediated capture.** PipeWire portal can rotate session deviceIds; unique-label fallback covers it best-effort.
12. **Stale enumeration during model load.** Picker is independent of the Whisper download; do not block one on the other.

## Security & Privacy

Device labels are PII-ish ("John's MacBook Pro Microphone"). They never reach the worker, never leave the renderer, are **never logged**. We log only a short `deviceId` prefix — note that the deviceId is a stable per-install opaque token (salted per origin and profile), not anonymous; do not aggregate logs externally without scrubbing. `voice.json` lives at `~/.config/session-manager/voice.json` mode `0600`. No network egress.

## Telemetry & Logging

Via `log.info('voice', …)`:

- `picker:opened`
- `picker:enumerated { count, hasLabels, primingUsed }`
- `picker:selected { deviceIdPrefix }` — never the label
- `picker:fallback { reason: 'unavailable' | 'rebound-by-label' | 'duplicate-labels' }`
- `devicechange { added, removed, total }` — counts only
- `recording:device-vanished` — when hot-swap kills a live session

## Testing Plan

**Unit (Vitest):**

- `pickDeviceFromList(savedId, savedLabel, devices)` — saved id present; unique label match; zero matches; ≥2 matches (returns `null`); empty list.
- `normalizeLabel(label)` — strips parenthesized suffix, collapses whitespace.
- `isMonitorSource(label)` — regex.
- `devicechange` handling: stub `navigator.mediaDevices` with an `EventTarget`, dispatch the event, assert store transitions.
- Atomic write: round-trip `voice.cjs` against a tmpdir.

**Manual E2E (xvfb fake-audio harness can't hot-plug — explicitly manual-only):**

- Built-in only → picker shows `Default` + 1.
- Plug USB while dropdown open → appears within ~500 ms.
- Select USB → record → unplug mid-recording → recording stops; warning Toast.
- Replug USB → no auto-restart; selection rebinds; manual record uses USB.
- Bluetooth A2DP → `getUserMedia` rejection path with profile-switch Toast.
- Monitor source hidden by default; toggle reveals; persisted monitor selection retained.
- Reboot → preference persists.

## Alternatives Considered

1. **Status quo (OS default only).** Doesn't solve the failure modes. Rejected.
2. **Open OS sound settings on click.** Cross-platform inconsistent; can't fix wrong-default. Rejected.
3. **Per-tab device selection.** No observed need; complicates persistence. Punted.
4. **`setSinkId` on a hidden `<audio>`.** Output-only API. Rejected.
5. **Add `prefs` key to `tabs.json` via `sessionsStore`.** Considered; rejected because device prefs and tab state have different lifetimes (device prefs survive a tabs.json wipe). A separate `voice.json` next to `tabs.json` keeps colocation without coupling.

## Open Questions

- **Follow OS default changes automatically?** When pinned to Default, OS flips already work. When a specific device is pinned and the OS flips, do we ignore (current proposal) or prompt? Lean ignore; log so we can revisit.
- **"Test mic" button** in the dropdown — a 3-second meter without invoking Whisper? Stretch.
- **Drop priming entirely?** Decide after a dogfood window with `primingUsed` telemetry across macOS/Linux/Windows.

## Sources

- `node_modules/@ricky0123/vad-web/dist/real-time-vad.d.ts` (verified: `getStream`/`resumeStream` are the only stream hooks)
- `src/main/sessionsStore.cjs:20,46-48` (atomic write + `~/.config/session-manager/` convention)
- `src/main/index.cjs:206-217` (media permission auto-grant)
- [MDN: MediaDevices.enumerateDevices()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices)
- [MDN: MediaDeviceInfo](https://developer.mozilla.org/en-US/docs/Web/API/MediaDeviceInfo)
- [WebKit Bug 179220 — deviceIds change on page refresh](https://bugs.webkit.org/show_bug.cgi?id=179220)
- [Electron docs: Device Access](https://www.electronjs.org/docs/latest/tutorial/devices)
- [WebRTC Samples: Select audio and video sources](https://webrtc.github.io/samples/src/content/devices/input-output/)

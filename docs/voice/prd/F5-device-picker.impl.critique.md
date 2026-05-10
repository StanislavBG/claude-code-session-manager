# F5 — Audio Input Device Picker — Implementation Critique (vs v2 PRD)

## Verdict

Ship-ready for the happy path. Stream ownership, persistence file, atomic-write
pattern, label-uniqueness rule, and the App-level `devicechange` listener all
match the PRD. Several deviations are real footguns under hot-swap and dual-
writer load — none catastrophic, all fixable with small surgical changes.

## Severe issues

**S1. `writeMerged` read-then-write race.**
`src/main/voiceSettings.cjs:91-101` reads then writes. F1 hotkey and F5
device handlers both call it. `await fsp.readFile` / `await fsp.writeFile`
straddle event-loop turns, so concurrent IPC handles interleave: F1 reads,
F5 reads, F5 writes (drops F1 patch), F1 writes (drops F5 patch). The
`tmp-${pid}-${Date.now()}` suffix avoids tmp collisions but doesn't
serialize the merge. Probability low, failure silent.
**Fix:** serialize via a tail-promise queue inside `voiceSettings.cjs`. ~6 lines.

**S2. Live device-switch restart relies on a fragile poll.**
`MicDevicePicker.tsx:180-201` does `stopRecording()` + `setTimeout(tryStart, 50)`.
`stopRecording` (`voice.ts:328-339`) returns sync but `handle.stop().finally(...)`
runs async (vad.pause → drain whisper → vad.destroy → audioCtx.close →
tracks.stop). The poll gates on `s.isRecording` (line 192), not on
`activeHandle`. It works only because `startRecording`'s
`activeHandle != null` guard at `voice.ts:214-217` silently no-ops a warn —
fragile. With 20×100 ms cap (line 196), if the prior drain exceeds 2 s
(whisper still transcribing the final utterance), the restart never fires
and the user is left silent with no visible error. There is no overlapping-
streams window because the cap stops the loop, but the cap is undocumented.
**Fix:** expose `restartWithDevice(tabId, deviceId)` in `voice.ts` that chains
`stop().finally(start)` directly. No timeout, no polling.

## Moderate issues

**M1. File mode `0600` not enforced** vs PRD §Security & Privacy.
`voiceSettings.cjs:97-99` calls `fsp.writeFile(tmp, body, 'utf8')` with no
`mode`; default `0666 & ~umask` → typically `0644`. `fsp.rename` preserves
the temp file mode. Device labels are PII per the PRD.
**Fix:** `fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })`,
plus a one-shot `fsp.chmod(p, 0o600).catch(() => {})` after rename for
existing files.

**M2. PRD drift #3 — `exact` vs `ideal`.** Impl uses
`{ exact: pinId }` (`speechRecognition.ts:227`). PRD §Stream ownership
snippet (line 62) says `exact`; PRD §Edge Cases #2 says `ideal` with
warning Toast — the PRD contradicts itself. With `exact`, getUserMedia
rejects `OverconstrainedError` and the error surfaces via
`voice.ts:267-276` as raw text, **not** as a Toast and **not** as a
silent fallback. The PRD's promised "fall back to default" never happens.
**Fix:** either (a) keep `exact` and wire a Toast that explicitly retries
with no `deviceId` constraint when `OverconstrainedError`/`NotFoundError`
is raised, or (b) switch to `ideal` to get Chromium's auto-fallback for
free. (a) is closer to PRD §Stream ownership; (b) is closer to §Edge
Cases #2.

**M3. Label match is exact, not normalized.** PRD §3 specifies a
`normalize(label)` that collapses whitespace and strips a trailing
parenthesized suffix (`(USB-1)`, PipeWire port suffixes). Impl at
`MicDevicePicker.tsx:43` is `d.label === savedLabel`. Exactly the failure
mode the PRD called out: a PulseAudio rename from `Logitech USB Headset` to
`Logitech USB Headset (USB-1)` on reseat silently breaks rebind. The
0/1/≥2-matches branching at lines 38-46 is correct — only the comparator is
wrong. **Fix:** add `normalizeLabel` per PRD §3, use on both sides.

**M4. `devicechange` handler can clobber a user-initiated stop.**
`App.tsx:176-207`'s handler reads `v.isRecording` once at line 184, then
`await`s `getDevicePref`, then calls `v.stopRecording()` + sets the
`Microphone disconnected` error at lines 199-203. Between the two awaits the
user may have stopped manually. **Fix:** re-check `useVoice.getState().isRecording`
immediately before line 199.

**M5. Pinned-but-unusable device (Q7).** Bluetooth profile mismatch leaves
the device in `enumerateDevices` so the App-level vanish detector
(`App.tsx:193`) reports `stillThere` and does nothing — but
`getUserMedia({deviceId: { exact }})` will hang or reject `NotReadableError`.
The raw error surfaces via `voice.ts:269` as a recording error, no Toast.
PRD §Edge Cases #8 wanted "Switching Bluetooth profile…". v1 doesn't deliver
that copy. Document the gap.

## Minor / nits

**N1. Schema validation gaps.** `isValidDevicePref`
(`voiceSettings.cjs:147-154`) permits empty strings; `normalizeDevice`
(lines 156-162) coerces them to null. Behaviorally fine. No length bound —
a 10 MB label would be persisted. Cap at 512 chars.

**N2. Monitor-source filter is locale-fragile.** `MicDevicePicker.tsx:22`
uses `/^monitor of /i`. PipeWire honors LC_MESSAGES — French
"Moniteur de…", Russian "Монитор…". Combined with the missing
`Show monitor sources` toggle (`SHOW_MONITORS = false`, line 62), a non-
English user can't see them at all. PRD acknowledged best-effort; toggle is
listed as "v1 hides them silently" in the file's docstring (lines 11-12).

**N3. No `any` in F5-touched files.** `speechRecognition.ts:227` does
`(audioConstraints as MediaTrackConstraints & { deviceId?: ConstrainDOMString })`
— harmless cast, but cleaner to construct the full object once with
`deviceId` already typed.

**N4. F4 ducking unchanged.** `speechRecognition.ts:323-333` still calls
`vad.setOptions({ positive, negative })`; `attachVadDucking` at `voice.ts:295`
is unaffected by stream ownership. Confirmed.

**N5. No migration scaffold.** `loadDevice` (`voiceSettings.cjs:165-174`)
doesn't branch on `schemaVersion`. A v2 shape that fails `isValidDevicePref`
silently resets to defaults — pinned device lost on upgrade.
**Fix on next bump:** branch on `sub.schemaVersion` before validation.

**N6. Persistence path matches the PRD** — `~/.config/session-manager/voice.json`
at `voiceSettings.cjs:39`. Confirmed.

**N7. `devicechange` cleanup.** App-level listener attached in
`App.tsx:208-210`, removed in cleanup at `App.tsx:215-217`. Picker uses a
custom-event bridge (`MicDevicePicker.tsx:151-155`) so it never double-binds
the DOM API. PRD requirement met.

**N8. IPC round-trip per `startRecording`.** `voice.ts:311-313` invokes
`getDevicePref` every start (~1-3 ms). Cache + invalidate on `setDevicePref`
to shave it. Optional.

## Concrete fixes for v2

1. `voiceSettings.cjs`: serialize `writeMerged` via a tail-promise queue
   (~6 lines).
2. `voiceSettings.cjs:98`: pass `{ encoding: 'utf8', mode: 0o600 }`; chmod
   target after rename.
3. `MicDevicePicker.tsx`: add `normalizeLabel(s)` per PRD §3, use on both
   sides of the label equality test (line 43).
4. `voice.ts`: expose `restartWithDevice(tabId, deviceId)` chaining
   `stop().finally(start)`; replace the polling loop in
   `MicDevicePicker.tsx:188-200`.
5. `App.tsx:199`: re-check `useVoice.getState().isRecording` before
   `stopRecording()`.
6. Decide `exact` vs `ideal` (PRD self-contradicts). If keeping `exact`,
   wire a real Toast (replace `console.warn` at `MicDevicePicker.tsx:105-108`
   and the raw `voice.ts:269` error surface). If switching to `ideal`, drop
   the `OverconstrainedError` branch and rely on Chromium fallback.
7. Add the "Show monitor sources" toggle (PRD §UX Flow).
8. `voiceSettings.cjs:147-154`: cap label at 512 chars; reject whitespace-only.
9. `MicDevicePicker.tsx`: emit the telemetry keys listed in PRD §Telemetry
   (`picker:opened`, `picker:enumerated`, `picker:fallback`, etc.).
10. Document the 20×100 ms restart cap or remove it via fix #4.

Stream ownership, owned `AudioContext`, identical-stream `getStream`/
`resumeStream`, and the `pause → drain → destroy → close → stop` teardown at
`speechRecognition.ts:294-321` match PRD §Stream ownership exactly. Nothing
breaks F1/F4. Dominant residual risk is the silent S1 clobber; everything
else degrades gracefully.

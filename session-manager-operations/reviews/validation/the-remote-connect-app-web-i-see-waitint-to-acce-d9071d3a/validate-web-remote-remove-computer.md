# Validation: web-remote-forget-removed-computer-state, device-picker-remove-button

Base: e4163106 (given). Commits: 5c6e5e40 (forget), 671d8ac8 (Remove button).
Gate (both PRDs, identical): `npm --prefix web/remote-app ci && typecheck && test` -> typecheck exit 0; vitest 32 files, 213 passed / 1 skipped (pre-existing skip). Re-run by me, in foreground.
/code-review and /security-review were not run as separate commands; self-reviewed the diff (no secrets, no path handling, ids only go to localStorage keys and an encoded API path).

## web-remote-forget-removed-computer-state — VERIFIED
- AC1: devices.ts PIN_PREFIX exported; `forgetDeviceLocal` removes PIN+META keys, clears PREFERRED_KEY only if it equals the id (devices.ts diff, +8 lines); App.tsx imports PIN_PREFIX.
- AC2: store.ts `forgetDevice` filters readyDeviceIds, keyMismatchDeviceIds, drops deviceMeta[id].
- AC3: App.tsx refreshDevices captures previousIds before setDevices, calls forgetDeviceLocal + store forgetDevice for absent ids.
- AC4: refreshDevices always calls pickActiveDevice and setActiveDevice when `pick !== st.activeDeviceId` (null included); present active device kept by pickActiveDevice.
- AC5: tests exist: devices.spec.ts (2 forgetDeviceLocal cases), store.spec.ts (forgetDevice), multi-device.spec.tsx (switch to other online desktop; last removed -> null). All pass.

## device-picker-remove-button — VERIFIED
- AC1: DevicePicker.tsx — Remove button in every `<li>`, sibling of select button, `device-remove-${id}`, data-track `device-picker-remove`. data-track-unique.spec.ts passes in the suite.
- AC2: `window.confirm` with label; online text says disconnects now + paired again from Settings → Phone remote; offline says paired again later; cancel returns early.
- AC3: revokeDevice(id) then `await onRefreshDevices?.()`; buttons `disabled={removingId !== null}`; failure sets `role="alert"` error and sheet stays open; `onClose()` when current.
- AC4: Cockpit.tsx optional `onRefreshDevices` prop passed to DevicePicker; App.tsx passes `refreshDevices` to Cockpit.
- AC5: device-picker.spec.tsx `describe('Remove')` has 5 cases covering every listed behaviour; pass.

## Findings
- Critical: none.
- Important: none.
- Minor: DevicePicker.tsx `remove()` — if revokeDevice succeeds but onRefreshDevices throws, the user sees "Failed to remove" though the computer was revoked, and the sheet stays open (one try/catch covers both).
- Minor: the combined diff base..HEAD includes unrelated commits (RemoteRenderer boot watchdog/fallback, chain tests, vite.web.config.ts); out of this plan's scope and not reviewed here beyond noting they pass the suite.
- Minor: Remove is disabled for all rows during any removal, which matches the AC; no per-row spinner.

/**
 * MicDevicePicker — F5 v1: tiny <select> next to the mic button that lists
 * audioinput devices, persists the user's choice to ~/.config/session-manager/
 * voice.json (`device` subtree), and live-restarts recording on switch.
 *
 * Out of v1 scope (TODO(F5-followup)):
 *   - Settings tab dedicated entry; we ship inline-in-LeftNav per PRD v2.
 *   - Output device picker.
 *   - Permission-not-yet-granted "labels are empty" priming.
 *   - Bluetooth A2DP/HFP profile detection.
 *   - "Show monitor sources" toggle (v1 hides them silently).
 *   - Toast surfacing of fallback states (we console.warn for v1).
 */

import { useCallback, useEffect, useState } from 'react'
import { useVoice } from '../state/voice'
import { useSessions } from '../state/sessions'
import { log } from '../lib/logger'

/** Best-effort PipeWire/PulseAudio "Monitor of Output" filter. */
function isMonitorSource(label: string): boolean {
  return /^monitor of /i.test(label.trim())
}

/**
 * Pick the right device from an enumeration given a saved pref. Pure; tested
 * indirectly via the picker's render path. Complexity: O(n) over devices —
 * n is tiny (≤ ~10 inputs in practice).
 *
 * Returns `null` when the saved pref is ambiguous or absent so the caller
 * can fall back to OS default without silently rebinding.
 */
/**
 * Normalize a device label for fallback matching. PulseAudio/PipeWire
 * sometimes append a port suffix like " (USB-1)" or repeat-counter
 * "Microphone #2" after a USB reseat, breaking exact-match. We strip those
 * patterns so a user's persisted label still rebinds. Trade-off: looser
 * matches risk false positives — guarded by the uniqueness check below.
 */
function normalizeLabel(label: string): string {
  return label
    .replace(/\s*\([^)]*\)\s*$/, '')   // trailing parenthesized suffix
    .replace(/\s*#\d+\s*$/, '')         // trailing "#N"
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim()
    .toLowerCase()
}

function pickDeviceFromList(
  savedId: string | null,
  savedLabel: string | null,
  devices: MediaDeviceInfo[],
): MediaDeviceInfo | null {
  if (savedId) {
    const byId = devices.find((d) => d.deviceId === savedId)
    if (byId) return byId
  }
  if (!savedLabel) return null
  // Exact match first; if unique, use it.
  const exact = devices.filter((d) => d.label === savedLabel)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null // ambiguous; never guess
  // Normalized fallback for PulseAudio/PipeWire suffix drift.
  const target = normalizeLabel(savedLabel)
  const fuzzy = devices.filter((d) => d.label && normalizeLabel(d.label) === target)
  if (fuzzy.length === 1) return fuzzy[0]
  return null
}

/** Module-singleton cache of the last enumeration to short-circuit renders. */
type DeviceList = MediaDeviceInfo[]

async function enumerateAudioInputs(includeMonitors: boolean): Promise<DeviceList> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const all = await navigator.mediaDevices.enumerateDevices()
  return all.filter((d) => {
    if (d.kind !== 'audioinput') return false
    if (!includeMonitors && d.label && isMonitorSource(d.label)) return false
    return true
  })
}

const SHOW_MONITORS = false // v1: hide monitor sources; reveal toggle is F5-followup.

export function MicDevicePicker() {
  const isRecording = useVoice((s) => s.isRecording)
  const startRecording = useVoice((s) => s.startRecording)
  const stopRecording = useVoice((s) => s.stopRecording)

  const [devices, setDevices] = useState<DeviceList>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Track the persisted label so the rebind-by-label path can fire on
  // device-id churn (USB reseat, salt refresh).
  const [savedLabel, setSavedLabel] = useState<string | null>(null)

  // Initial load: read pref, enumerate, reconcile.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const pref = await window.api.voice.getDevicePref()
        if (cancelled) return
        const list = await enumerateAudioInputs(SHOW_MONITORS)
        if (cancelled) return
        setDevices(list)
        setSavedLabel(pref.selectedLabel)
        const resolved = pickDeviceFromList(pref.selectedDeviceId, pref.selectedLabel, list)
        if (resolved) {
          setSelectedId(resolved.deviceId)
          // If we rebinded by label (saved id !== resolved id), persist the
          // refreshed id so subsequent boots short-circuit the label path.
          if (pref.selectedDeviceId && resolved.deviceId !== pref.selectedDeviceId) {
            log.info('voice', 'device-picker rebind-by-label', {
              fromIdPrefix: pref.selectedDeviceId.slice(0, 8),
              toIdPrefix: resolved.deviceId.slice(0, 8),
            })
            await window.api.voice.setDevicePref({
              selectedDeviceId: resolved.deviceId,
              selectedLabel: resolved.label || pref.selectedLabel,
            }).catch(() => { /* */ })
          }
        } else {
          // Unavailable: fall back to default for the active session but do
          // NOT clear the persisted pref — user must explicitly pick Default.
          if (pref.selectedDeviceId || pref.selectedLabel) {
            console.warn(
              '[MicDevicePicker] previously-selected device unavailable; falling back to OS default',
              { savedLabel: pref.selectedLabel, hadId: !!pref.selectedDeviceId },
            )
            log.warn('voice', 'device-picker selected-unavailable', { hadId: !!pref.selectedDeviceId })
          }
          setSelectedId(null)
        }
      } catch (e: unknown) {
        log.warn('voice', 'device-picker init failed', { error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Re-enumerate handler (called from devicechange listener in App.tsx and
  // from the picker's onFocus to keep labels fresh).
  const refresh = useCallback(async () => {
    try {
      const list = await enumerateAudioInputs(SHOW_MONITORS)
      setDevices(list)
      // If our current selection vanished and recording is active, the
      // App-level devicechange listener stops recording. Here we just sync
      // the visible state.
      if (selectedId && !list.some((d) => d.deviceId === selectedId)) {
        // Try label rebind (uniqueness-checked) so a USB reseat doesn't
        // strand the user on Default.
        const rebound = pickDeviceFromList(null, savedLabel, list)
        if (rebound) {
          setSelectedId(rebound.deviceId)
          await window.api.voice.setDevicePref({
            selectedDeviceId: rebound.deviceId,
            selectedLabel: rebound.label || savedLabel,
          }).catch(() => { /* */ })
        } else {
          // Fall back visually; do not clear pref.
          setSelectedId(null)
        }
      }
    } catch (e: unknown) {
      log.warn('voice', 'device-picker refresh failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }, [selectedId, savedLabel])

  // Listen for the App-level devicechange ping. App.tsx dispatches a custom
  // event so the picker doesn't double-bind navigator.mediaDevices.
  useEffect(() => {
    const handler = () => { refresh() }
    window.addEventListener('mic-device-change', handler)
    return () => window.removeEventListener('mic-device-change', handler)
  }, [refresh])

  const onChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value // '' = default sentinel
    const nextId = value === '' ? null : value
    const nextLabel = nextId ? (devices.find((d) => d.deviceId === nextId)?.label ?? null) : null

    setSelectedId(nextId)
    setSavedLabel(nextLabel)

    try {
      await window.api.voice.setDevicePref({
        selectedDeviceId: nextId,
        selectedLabel: nextLabel,
      })
      log.info('voice', 'device-picker selected', {
        deviceIdPrefix: nextId ? nextId.slice(0, 8) : null,
      })
    } catch (err: unknown) {
      log.warn('voice', 'setDevicePref failed', { error: err instanceof Error ? err.message : String(err) })
    }

    // Live-restart: if recording, stop+start via the store helper so the new
    // device pin takes effect. The helper waits for the prior handle to drain
    // (no polling here) and surfaces failure via the error slice.
    if (isRecording) {
      try {
        await useVoice.getState().restartWithDevice()
      } catch (err: unknown) {
        log.warn('voice', 'device-picker restart failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // Render: compact dropdown. Width is constrained by the parent flex;
  // the <option> labels truncate with ellipsis via CSS.
  return (
    <select
      value={selectedId ?? ''}
      onChange={onChange}
      onFocus={() => { refresh() }}
      title="Microphone input device"
      data-testid="mic-device-picker"
      className="text-[10px] bg-bg border border-line text-fg-dim hover:text-fg rounded px-1.5 py-1 max-w-[8rem] truncate"
    >
      <option value="">Default</option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
        </option>
      ))}
    </select>
  )
}

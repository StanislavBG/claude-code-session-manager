import { useVoice } from '../state/voice'
import { Z } from '../lib/zLayers'

/**
 * F1 privacy invariant (PRD §Security): mounted whenever isRecording === true.
 * Single line, red dot + literal copy. Window-title prefix is the second leg
 * of the invariant; tray icon is split to F1a.
 *
 * Also covers `externalRecording` (non-terminal mic capture, e.g. the
 * Document Experience voice edit in useDocEdit.ts) — that path owns its own
 * recognition handle outside this store's activeHandle, so it can't set
 * `isRecording` without corrupting startRecording/armHotkey's assumptions
 * about who owns the handle. See the field comment in state/voice.ts.
 */
export function RecordingStatus() {
  const isRecording = useVoice((s) => s.isRecording || s.externalRecording)
  if (!isRecording) return null
  return (
    <div
      data-testid="recording-status"
      role="status"
      aria-live="polite"
      className={`fixed inset-x-0 top-0 ${Z.recording} h-7 px-3 flex items-center gap-2 bg-red-950/95 border-b border-red-800 text-red-200 text-xs shrink-0`}
    >
      <span
        className="inline-block w-2 h-2 rounded-full bg-red-400 animate-pulse"
        aria-hidden="true"
      />
      <span>Recording — speech is being captured locally</span>
    </div>
  )
}

/**
 * The press-time Voice picker (`press-voice-select`) shared by the Demo Video composer and the project
 * Video tool presses in VideosPane. Options are the voice library (`voices:list`), each `<label> · <id>`,
 * after a first `Default` option (value `''`): the persona's voice, then the kit default.
 *
 * `useVoiceOptions` reads `voices:list` once per cwd — never polled. A rejected read toasts once and
 * leaves only Default; a renderer without the voices API (older preload, tests) shows only Default.
 *
 * A picked voice reaches an agent tool (Demo Video) as a `Voice: <id>` prompt line (`voiceLine`) and a
 * job tool as the dispatch's `voiceId`.
 */
import { useEffect, useState } from 'react'
import { toast } from '../../../../state/toast'

export interface VoiceOption {
  id: string
  label: string
}

const NO_VOICES: readonly VoiceOption[] = []

/** The voice library for `cwd` as select options, library order. */
export function useVoiceOptions(cwd: string | null | undefined): readonly VoiceOption[] {
  const [state, setState] = useState<{ cwd: string; voices: readonly VoiceOption[] } | null>(null)
  useEffect(() => {
    if (!cwd) return
    const list = window.api?.voices?.list
    if (typeof list !== 'function') return
    let live = true
    let pending: ReturnType<typeof list>
    try {
      pending = list({ cwd })
    } catch (err) {
      pending = Promise.reject(err)
    }
    pending.then(
      (res) => {
        if (!live) return
        const voices = (res?.voices ?? []).map((v) => ({ id: v.id, label: v.label || v.id }))
        setState({ cwd, voices })
      },
      (err: unknown) => {
        if (!live) return
        setState({ cwd, voices: NO_VOICES })
        toast.error(`Could not list voices: ${(err instanceof Error ? err.message : String(err)) || 'Unknown error'}`)
      },
    )
    return () => {
      live = false
    }
  }, [cwd])
  return state && state.cwd === cwd ? state.voices : NO_VOICES
}

const SELECT_CLASS =
  'h-[34px] max-w-full px-2.5 border border-rule-structural rounded-lg bg-bg-hi text-[12.5px] text-fg outline-none focus:border-accent'

/**
 * The Voice select. `value` `''` = Default. A `value` not in `voices` (a tool default the library no longer
 * lists, or a list still loading) still shows as its own option so the pick is never silently lost.
 */
export function VoiceSelect({
  voices,
  value,
  onChange,
  label = 'Voice',
  macroId,
}: {
  voices: readonly VoiceOption[]
  value: string
  onChange: (voiceId: string) => void
  label?: string
  /** The tool this select belongs to (VideosPane's per-tool selects); absent in the composer. */
  macroId?: string
}) {
  const listed = value === '' || voices.some((v) => v.id === value)
  return (
    <select
      data-testid="press-voice-select"
      data-macro-id={macroId}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">Default</option>
      {!listed && <option value={value}>{value}</option>}
      {voices.map((v) => (
        <option key={v.id} value={v.id}>
          {v.label === v.id ? v.id : `${v.label} · ${v.id}`}
        </option>
      ))}
    </select>
  )
}

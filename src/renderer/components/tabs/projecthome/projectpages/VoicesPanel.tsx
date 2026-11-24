/**
 * Project Home ▸ Video ▸ Voices — the voice library (`voices:list`): built-in Kokoro voices,
 * machine voices and this project's own voices, one row each with engine, licence, scope, an
 * Approved badge, its sample text, last preview (time + wall-clock seconds) and a Play button.
 *
 * Play speaks the typed text (or the voice's sample) through `voices:preview` and plays the
 * returned WAV bytes as an `audio/wav` Blob URL, revoked once playback ends. One audio element at
 * a time: a new Play stops (and revokes) the previous one. A cache hit says `cached`.
 *
 * The voice lane (`lane` of the list result) shows as `idle` or its holder plus waiting count; the
 * list re-reads every 2 seconds only while this panel is mounted. Errors go to the toast; a
 * repeating poll error toasts once until it changes.
 *
 * Human-only controls (project and machine voices; built-ins get none): Approve pins the voice's
 * params (`voices:approve`), Unapprove drops that pin, and Delete — only on an unapproved voice —
 * asks inline (the Confirm / Cancel step ProjectLibraryList uses) before `voices:delete`. An
 * approved voice whose pin no longer matches says `changed since approved` with Re-approve. Each
 * action reloads the list; a refusal or a thrown IPC error goes to the error toast.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '../../../ui/Badge'
import { useToast } from '../../../../state/toast'
import { formatClock } from '../../../../lib/formatTime'
import type { VoiceLaneTicket, VoiceLibraryEntry, VoicesListResult } from '../../../../../preload/api'

const POLL_MS = 2000
const NO_VOICES: VoiceLibraryEntry[] = []
const NO_LANE: Record<string, VoiceLaneTicket[]> = {}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** `idle`, or per busy lane `<lane>: <holder> speaking · N waiting`. */
export function laneStatusText(lane: Record<string, VoiceLaneTicket[]>): string {
  const parts: string[] = []
  for (const name of Object.keys(lane).sort()) {
    const tickets = lane[name] ?? []
    if (tickets.length === 0) continue
    const holder = tickets.find((t) => t.position === 0)
    const waiting = tickets.filter((t) => t.position !== 0).length
    const who = holder ? (holder.label ?? holder.voiceId ?? `pid ${holder.pid}`) : 'nobody'
    parts.push(`${name}: ${who} speaking · ${waiting} waiting`)
  }
  return parts.length === 0 ? 'idle' : parts.join(' | ')
}

function lastPreviewText(v: VoiceLibraryEntry): string {
  const lp = v.lastPreview
  if (!lp || !lp.at) return 'never previewed'
  const t = Date.parse(lp.at)
  const when = Number.isFinite(t) ? formatClock(t) : lp.at
  const wall = lp.wallMs !== null ? ` · ${(lp.wallMs / 1000).toFixed(1)}s` : ''
  return `last ${when}${wall}`
}

type VoiceAction = 'approve' | 'unapprove' | 'delete'

const ACTION_LABEL: Record<VoiceAction, string> = {
  approve: 'Approve',
  unapprove: 'Unapprove',
  delete: 'Delete',
}

const PLAY_CLASS =
  'inline-flex h-7 items-center justify-center rounded-lg border border-rule-structural bg-bg-hi px-3 text-[12px] font-semibold text-fg cursor-pointer enabled:hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed'

export function VoicesPanel({ cwd }: { cwd?: string | null }) {
  const show = useToast((s) => s.show)
  const [voices, setVoices] = useState<VoiceLibraryEntry[]>(NO_VOICES)
  const [lane, setLane] = useState<Record<string, VoiceLaneTicket[]>>(NO_LANE)
  const [loaded, setLoaded] = useState(false)
  const [text, setText] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [cached, setCached] = useState<Record<string, boolean>>({})
  const [actingId, setActingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const audioRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null)
  const lastListError = useRef<string | null>(null)

  const stopAudio = useCallback(() => {
    const cur = audioRef.current
    if (!cur) return
    audioRef.current = null
    cur.audio.onended = null
    cur.audio.onerror = null
    try {
      cur.audio.pause()
    } catch {
      // nothing to stop
    }
    URL.revokeObjectURL(cur.url)
  }, [])

  const load = useCallback(async () => {
    if (!cwd) return
    try {
      const res: VoicesListResult = await window.api.voices.list({ cwd })
      setVoices(res.voices)
      setLane(res.lane ?? NO_LANE)
      lastListError.current = null
    } catch (e) {
      const msg = errMsg(e)
      if (lastListError.current !== msg) {
        lastListError.current = msg
        show('error', `Could not list voices: ${msg}`)
      }
    } finally {
      setLoaded(true)
    }
  }, [cwd, show])

  useEffect(() => {
    let alive = true
    void load()
    const timer = setInterval(() => {
      if (alive) void load()
    }, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [load])

  // Unmount stops any playing preview and frees its Blob URL.
  useEffect(() => stopAudio, [stopAudio])

  const playVoice = async (v: VoiceLibraryEntry) => {
    if (!cwd) return
    const spoken = text.trim() || v.sampleText
    stopAudio()
    setBusyId(v.id)
    try {
      const res = await window.api.voices.preview({ cwd, voiceId: v.id, text: spoken })
      if (!res.ok) {
        show('error', `Preview failed: ${res.error}`)
        return
      }
      setCached((c) => ({ ...c, [v.id]: res.cached }))
      stopAudio()
      const url = URL.createObjectURL(new Blob([new Uint8Array(res.bytes)], { type: 'audio/wav' }))
      const audio = new Audio(url)
      const entry = { audio, url }
      audioRef.current = entry
      const done = () => {
        if (audioRef.current === entry) stopAudio()
      }
      audio.onended = done
      audio.onerror = done
      await audio.play()
      void load()
    } catch (e) {
      show('error', `Preview failed: ${errMsg(e)}`)
      stopAudio()
    } finally {
      setBusyId(null)
    }
  }

  const runAction = async (v: VoiceLibraryEntry, action: VoiceAction) => {
    if (!cwd || actingId !== null) return
    setActingId(v.id)
    try {
      const payload = { cwd, voiceId: v.id }
      const res =
        action === 'approve'
          ? await window.api.voices.approve(payload)
          : action === 'unapprove'
            ? await window.api.voices.unapprove(payload)
            : await window.api.voices.delete(payload)
      if (!res.ok) show('error', `${ACTION_LABEL[action]} failed: ${res.error}`)
    } catch (e) {
      show('error', `${ACTION_LABEL[action]} failed: ${errMsg(e)}`)
    } finally {
      setActingId(null)
      setConfirmDeleteId(null)
      void load()
    }
  }

  return (
    <div data-testid="voices-panel" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-none flex-wrap items-center gap-3">
        <input
          data-testid="voice-text-input"
          type="text"
          value={text}
          maxLength={300}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type text to preview (blank = each voice's sample)"
          className="h-8 min-w-[240px] flex-1 rounded-lg border border-rule-structural bg-bg-hi px-3 text-[12.5px] text-fg"
        />
        <span data-testid="voice-lane-status" className="font-mono text-[11px] text-fg-faint">
          Voice lane: {laneStatusText(lane)}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-0.5">
        {loaded && voices.length === 0 ? (
          <p className="m-0 text-xs text-fg-faint">No voices found.</p>
        ) : (
          <ul aria-label="Voices" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {voices.map((v) => (
              <li
                key={v.id}
                data-testid={`voice-row-${v.id}`}
                className="flex flex-wrap items-center gap-3 rounded-[9px] border border-rule-structural px-3 py-2"
              >
                <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-[12.5px] font-semibold text-fg">
                    {v.label}
                    {v.approved && (
                      <span data-testid="voice-approved">
                        <Badge tone={v.pinOk ? 'good' : 'warn'} title={v.pinOk ? undefined : 'Changed since approval'}>
                          Approved
                        </Badge>
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[10.5px] text-fg-faint">
                    {v.engine} · {v.licence} · {v.scope}
                  </span>
                  <span className="truncate text-[11.5px] text-fg-dim">“{v.sampleText}”</span>
                  <span data-testid={`voice-last-preview-${v.id}`} className="font-mono text-[10.5px] text-fg-faint">
                    {lastPreviewText(v)}
                  </span>
                  {v.approved && !v.pinOk && (
                    <span data-testid={`voice-pin-mismatch-${v.id}`} className="text-[11px] font-semibold text-amber-400">
                      changed since approved
                    </span>
                  )}
                </div>
                {cached[v.id] && (
                  <span data-testid={`voice-cached-${v.id}`} className="font-mono text-[10.5px] text-fg-faint">
                    cached
                  </span>
                )}
                {v.scope !== 'builtin' && (
                  <span className="flex items-center gap-2">
                    {confirmDeleteId === v.id ? (
                      <>
                        <span className="text-[11.5px] text-fg-faint">Delete this voice?</span>
                        <button
                          type="button"
                          data-testid={`voice-delete-confirm-${v.id}`}
                          disabled={actingId !== null}
                          onClick={() => void runAction(v, 'delete')}
                          className={PLAY_CLASS}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          data-testid={`voice-delete-cancel-${v.id}`}
                          onClick={() => setConfirmDeleteId(null)}
                          className={PLAY_CLASS}
                        >
                          Cancel
                        </button>
                      </>
                    ) : v.approved ? (
                      <>
                        {!v.pinOk && (
                          <button
                            type="button"
                            data-testid={`voice-reapprove-${v.id}`}
                            disabled={!cwd || actingId !== null}
                            onClick={() => void runAction(v, 'approve')}
                            className={PLAY_CLASS}
                          >
                            Re-approve
                          </button>
                        )}
                        <button
                          type="button"
                          data-testid={`voice-unapprove-${v.id}`}
                          disabled={!cwd || actingId !== null}
                          onClick={() => void runAction(v, 'unapprove')}
                          className={PLAY_CLASS}
                        >
                          Unapprove
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          data-testid={`voice-approve-${v.id}`}
                          disabled={!cwd || actingId !== null}
                          onClick={() => void runAction(v, 'approve')}
                          className={PLAY_CLASS}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          data-testid={`voice-delete-${v.id}`}
                          disabled={!cwd || actingId !== null}
                          onClick={() => setConfirmDeleteId(v.id)}
                          className={PLAY_CLASS}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </span>
                )}
                <button
                  type="button"
                  data-testid={`voice-play-${v.id}`}
                  disabled={!cwd || busyId !== null}
                  onClick={() => void playVoice(v)}
                  className={PLAY_CLASS}
                >
                  {busyId === v.id ? 'Speaking…' : 'Play'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

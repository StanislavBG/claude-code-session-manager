import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { useSessions, type SessionTab } from '../../state/sessions'
import { useRace, readRaceHistory, type RaceParticipant } from '../../state/race'
import { toast } from '../../state/toast'

/**
 * Race modal — pick 2..N existing tabs, broadcast a prompt, watch transcript
 * digests side-by-side, declare a winner.
 *
 * MVP scope (matches the v1 brief): we require existing tabs. Spinning up
 * ephemeral preset-backed tabs is a v2 follow-up; that path needs to plumb
 * spawn → ready handshake before the prompt is safe to write.
 *
 * The store (state/race.ts) owns transcript subscriptions and grading. This
 * component is presentation + form input only.
 */
export function RaceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useRace((s) => s.status)
  const participants = useRace((s) => s.participants)
  const winnerTabId = useRace((s) => s.winnerTabId)
  const startedAt = useRace((s) => s.startedAt)
  const racePrompt = useRace((s) => s.prompt)
  const configure = useRace((s) => s.configure)
  const begin = useRace((s) => s.begin)
  const declareWinner = useRace((s) => s.declareWinner)
  const reset = useRace((s) => s.reset)

  const tabs = useSessions((s) => s.tabs)

  const [prompt, setPrompt] = useState('')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [historyOpen, setHistoryOpen] = useState(false)

  // Reset local form fields whenever the modal opens fresh (status idle).
  useEffect(() => {
    if (!open) return
    if (status === 'idle') {
      setPrompt('')
      setPicked({})
    }
  }, [open, status])

  // When the modal is closed mid-race, leave the store running so the user can
  // re-open and keep watching. A "Reset" button explicitly tears down.
  const handleClose = () => {
    onClose()
  }

  const runningTabs = useMemo(() => tabs.filter((t) => t.status === 'running'), [tabs])
  const pickedIds = Object.entries(picked).filter(([, v]) => v).map(([k]) => k)
  const pickedCount = pickedIds.length
  const canStart = prompt.trim().length > 0 && pickedCount >= 2

  const handleStart = () => {
    if (!canStart) return
    const picks = runningTabs
      .filter((t) => picked[t.id])
      .map((t) => ({ tabId: t.id, label: t.label, presetId: t.presetId }))
    if (picks.length < 2) {
      toast.warn('Race needs at least 2 running tabs.')
      return
    }
    configure(prompt.trim(), picks)
    // Send the prompt to every picked tab. '\r' is the PTY line terminator
    // (matches BroadcastBar).
    const trimmedPrompt = prompt.trim()
    for (const p of picks) {
      try {
        window.api.pty.write({ tabId: p.tabId, data: trimmedPrompt + '\r' })
      } catch (e) {
        toast.error(`Failed to send race prompt to ${p.label}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    begin()
  }

  const handleReset = () => {
    reset()
    setPrompt('')
    setPicked({})
  }

  return (
    <Modal open={open} onClose={handleClose} size="xl" fillHeight noPadding>
      <div className="flex items-center justify-between px-4 py-2 border-b border-line shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base">🏁</span>
          <h2 className="text-xs uppercase tracking-wider text-fg-dim">
            Race — same prompt, side-by-side
          </h2>
          {status === 'running' && <RaceTimer startedAt={startedAt} />}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="text-xs text-fg-dim hover:text-fg px-2 py-0.5 rounded hover:bg-bg-hi"
          >
            {historyOpen ? 'Hide history' : 'History'}
          </button>
          {(status === 'running' || status === 'finished') && (
            <Button variant="default" onClick={handleReset}>Reset</Button>
          )}
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="px-2 py-0.5 text-fg-dim hover:text-fg hover:bg-bg-hi rounded text-base leading-none"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
        {historyOpen ? (
          <HistoryView />
        ) : status === 'idle' ? (
          <IdleForm
            prompt={prompt}
            setPrompt={setPrompt}
            runningTabs={runningTabs}
            picked={picked}
            setPicked={setPicked}
            pickedCount={pickedCount}
            canStart={canStart}
            onStart={handleStart}
          />
        ) : (
          <RaceView
            participants={participants}
            winnerTabId={winnerTabId}
            status={status}
            prompt={racePrompt}
            onDeclareWinner={declareWinner}
          />
        )}
      </div>
    </Modal>
  )
}

function IdleForm({
  prompt,
  setPrompt,
  runningTabs,
  picked,
  setPicked,
  pickedCount,
  canStart,
  onStart,
}: {
  prompt: string
  setPrompt: (s: string) => void
  runningTabs: SessionTab[]
  picked: Record<string, boolean>
  setPicked: (p: Record<string, boolean>) => void
  pickedCount: number
  canStart: boolean
  onStart: () => void
}) {
  const toggle = (id: string) => setPicked({ ...picked, [id]: !picked[id] })

  return (
    <div className="space-y-4">
      <div>
        <label className="text-[10px] uppercase tracking-wider text-fg-faint mb-1 block">
          Prompt for all participants
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Implement a binary search function with tests"
          rows={4}
          className="w-full bg-bg border border-line rounded px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent resize-none font-mono"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[10px] uppercase tracking-wider text-fg-faint">
            Participants — pick 2+ existing tabs
          </label>
          <span className="text-[10px] text-fg-faint">{pickedCount} selected</span>
        </div>
        {runningTabs.length === 0 ? (
          <div className="text-xs text-fg-dim p-3 border border-line rounded bg-bg">
            No running tabs available. Open at least 2 sessions first, then return here.
          </div>
        ) : (
          <div className="max-h-64 overflow-auto border border-line rounded divide-y divide-line">
            {runningTabs.map((t) => (
              <label
                key={t.id}
                className="flex items-center gap-3 px-3 py-2 text-xs hover:bg-bg-hi cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={!!picked[t.id]}
                  onChange={() => toggle(t.id)}
                  className="accent-accent"
                />
                <span className="text-fg truncate flex-1">{t.label}</span>
                {t.presetId && (
                  <span className="text-fg-faint text-[10px] font-mono">{t.presetId}</span>
                )}
                <span className="text-fg-faint text-[10px] font-mono">{t.cwd.split('/').filter(Boolean).pop()}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="primary" onClick={onStart} disabled={!canStart}>
          Start race
        </Button>
      </div>
      <p className="text-[10px] text-fg-faint">
        MVP: race uses existing tabs. Spawning ephemeral preset-backed tabs ships in v2.
      </p>
    </div>
  )
}

function RaceView({
  participants,
  winnerTabId,
  status,
  prompt,
  onDeclareWinner,
}: {
  participants: RaceParticipant[]
  winnerTabId: string | null
  status: 'idle' | 'running' | 'finished'
  prompt: string
  onDeclareWinner: (tabId: string) => void
}) {
  // Pick a grid column count based on N. Capped at 3 for legibility.
  // 2 → 2 cols, 3 → 3 cols, 4+ → 3 cols (rows wrap).
  const cols = participants.length <= 2 ? 2 : 3

  return (
    <div className="space-y-4">
      <div className="text-xs bg-bg border border-line rounded px-3 py-2">
        <span className="text-fg-faint mr-2">Prompt:</span>
        <span className="text-fg font-mono">{prompt}</span>
      </div>

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {participants.map((p) => (
          <ParticipantPanel
            key={p.tabId}
            participant={p}
            isWinner={winnerTabId === p.tabId}
            canDeclare={status !== 'finished'}
            onDeclareWinner={onDeclareWinner}
          />
        ))}
      </div>

      {status === 'finished' && winnerTabId && (
        <div className="text-xs text-accent border border-accent/40 rounded px-3 py-2 bg-bg">
          Winner: {participants.find((p) => p.tabId === winnerTabId)?.label ?? winnerTabId}
        </div>
      )}
    </div>
  )
}

function ParticipantPanel({
  participant,
  isWinner,
  canDeclare,
  onDeclareWinner,
}: {
  participant: RaceParticipant
  isWinner: boolean
  canDeclare: boolean
  onDeclareWinner: (tabId: string) => void
}) {
  const statusBadge =
    participant.status === 'done'
      ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent">done</span>
      : participant.status === 'running'
        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hi text-fg-dim">working…</span>
        : <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hi text-fg-faint">waiting</span>

  return (
    <div
      className={`flex flex-col rounded border bg-bg ${isWinner ? 'border-accent' : 'border-line'}`}
    >
      <div className={`flex items-center justify-between px-3 py-2 border-b ${isWinner ? 'border-accent/40' : 'border-line'}`}>
        <div className="flex items-center gap-2 min-w-0">
          {isWinner && <span className="text-accent">🏆</span>}
          <span className="text-xs font-medium text-fg truncate">{participant.label}</span>
        </div>
        {statusBadge}
      </div>
      <div className="flex-1 min-h-32 p-2 font-mono text-[10px] leading-relaxed text-fg-dim overflow-auto">
        {participant.outputDigest.length === 0 ? (
          <span className="text-fg-faint">Waiting for activity…</span>
        ) : (
          participant.outputDigest.map((line, i) => (
            <div key={i} className="truncate">{line}</div>
          ))
        )}
      </div>
      <div className="px-2 py-1.5 border-t border-line flex justify-end">
        <Button
          variant={isWinner ? 'primary' : 'default'}
          onClick={() => onDeclareWinner(participant.tabId)}
          disabled={!canDeclare}
        >
          {isWinner ? 'Winner' : 'Declare winner'}
        </Button>
      </div>
    </div>
  )
}

function RaceTimer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (!startedAt) return null
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return (
    <span className="text-xs font-mono text-fg-dim ml-2">
      {m}:{String(s).padStart(2, '0')}
    </span>
  )
}

function HistoryView() {
  const entries = useMemo(() => readRaceHistory(), [])
  if (entries.length === 0) {
    return <div className="text-xs text-fg-dim">No past races yet.</div>
  }
  return (
    <div className="space-y-3">
      {entries.map((e, i) => (
        <div key={i} className="border border-line rounded p-3 bg-bg">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-fg-faint font-mono">
              {new Date(e.startedAt).toLocaleString()}
            </span>
            <span className="text-[10px] text-accent">
              Winner: {e.participants.find((p) => p.tabId === e.winnerTabId)?.label ?? '—'}
            </span>
          </div>
          <div className="text-xs text-fg mb-2 truncate font-mono">{e.prompt}</div>
          <div className="text-[10px] text-fg-dim flex flex-wrap gap-x-3 gap-y-0.5">
            {e.participants.map((p) => (
              <span key={p.tabId}>
                {p.label}
                <span className="text-fg-faint ml-1">({p.status})</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

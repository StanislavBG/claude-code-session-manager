import { Button } from '../../ui/Button'
import type { RaceParticipant } from '../../../state/race'

/**
 * Live grid for a running/finished Race dispatch — one panel per participant
 * with its transcript digest + status, and a "declare winner" control. Driven
 * by props; the store wiring lives in DispatchLive. (Extracted from the
 * retired RaceModal during the Dispatch→Subagents consolidation.)
 */
export function RaceView({
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

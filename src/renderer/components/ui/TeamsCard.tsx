import type { TeamInfo } from '../../../preload/api'
import { useTeams } from '../../state/teams'
import { prettyModel } from '../../lib/prettyModel'

/**
 * Compact roster panel rendered on Overview below the instrument cluster.
 * Reads from the singleton `useTeams` store; the underlying 30s poller is
 * owned by state/teams.ts (started once in App.tsx). Renders nothing until
 * the first list arrives.
 *
 * Aesthetic: terminal-cabinet — 1px border, 4px radius, no shadows. Aligns
 * with research-03's anti-recommendations (kept verbatim in synthesis).
 */
export function TeamsCard() {
  const teams = useTeams((s) => s.teams)
  const loaded = useTeams((s) => s.loaded)

  if (!loaded) return null
  const activeCount = teams.length

  return (
    <div className="border border-line rounded bg-bg-elev p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs text-fg-faint uppercase tracking-wider">
          Teams ON · {activeCount} active
        </div>
        <div className="text-xs text-fg-faint">~/.claude/teams</div>
      </div>
      {activeCount === 0 ? (
        <div className="text-xs text-fg-faint italic">no teams configured</div>
      ) : (
        <div className="space-y-2">
          {teams.map((t) => (
            <TeamRow key={t.name} team={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function TeamRow({ team }: { team: TeamInfo }) {
  // O(M) over members for the model histogram — M is small (typically < 10).
  const modelCounts: Record<string, number> = {}
  for (const m of team.members) {
    const k = m.model ?? 'unknown'
    modelCounts[k] = (modelCounts[k] ?? 0) + 1
  }
  const modelSummary = Object.entries(modelCounts)
    .map(([model, n]) => `${n}× ${prettyModel(model)}`)
    .join(' · ')

  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <div className="flex-1 min-w-0">
        <span className="text-fg font-mono">{team.name}</span>
        {team.leadAgentId && (
          <span className="text-fg-faint ml-2">lead: {team.leadAgentId}</span>
        )}
      </div>
      <div className="text-fg-dim">
        {team.memberCount} member{team.memberCount === 1 ? '' : 's'}
        {modelSummary && <span className="text-fg-faint"> · {modelSummary}</span>}
      </div>
      <div className={`tabular-nums w-20 text-right ${team.inboxDepth > 0 ? 'text-yellow-400' : 'text-fg-faint'}`}>
        inbox: {team.inboxDepth}
      </div>
    </div>
  )
}


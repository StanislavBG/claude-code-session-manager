import { useEffect, useState } from 'react'
import type { TeamInfo } from '../../../preload/api'

/**
 * Compact roster panel rendered on Overview below the instrument cluster.
 * Polls `window.api.teams.list()` every 30s. Renders nothing while loading;
 * shows a faint "no teams configured" if the list comes back empty.
 *
 * Aesthetic: terminal-cabinet — 1px border, 4px radius, no shadows. Aligns
 * with research-03's anti-recommendations (kept verbatim in synthesis).
 */
export function TeamsCard() {
  const [teams, setTeams] = useState<TeamInfo[] | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const tick = async () => {
      try {
        const r = await window.api.teams.list()
        if (cancelled) return
        setTeams(r.teams)
      } catch {
        if (!cancelled) setTeams([])
      }
      timer = window.setTimeout(tick, 30_000)
    }
    tick()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  if (teams === null) return null
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

function prettyModel(model: string): string {
  // Compress noisy model strings (e.g. claude-opus-4-7[1m]) to a short tag.
  if (model === 'unknown') return 'unknown'
  const m = model.match(/(opus|sonnet|haiku)[-_]?(\d+[-_.]?\d*)?/i)
  if (m) return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()}${m[2] ? ' ' + m[2].replace(/-/g, '.') : ''}`
  return model
}

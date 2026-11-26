// Pure roster for the Guild Hall world: active session-slot holders grouped by
// persona (agentType) with copy counts. No store imports.
import type { ChatSignalLite, EpicLite, ScheduleJobLite, SlotHolderLite } from './homeSessionRows'

export interface WorldRosterEntry {
  agentType: string
  count: number
  owners: string[]
}

type JobWithAgent = ScheduleJobLite & { agentType?: string | null }
type EpicWithAgent = EpicLite & { agentType?: string }

const UNKNOWN = 'unknown'

function resolveAgentType(
  owner: string,
  jobs: JobWithAgent[],
  chats: Record<string, ChatSignalLite>,
  epics: Record<string, EpicWithAgent>,
): string {
  if (owner.startsWith('scheduler:')) {
    const slug = owner.slice('scheduler:'.length)
    const job = jobs.find((j) => j.slug === slug)
    if (!job) return UNKNOWN
    return typeof job.agentType === 'string' && job.agentType ? job.agentType : 'dev-lead'
  }
  if (owner.startsWith('chat:')) {
    const epicId = owner.slice('chat:'.length)
    const epic = epics[epicId]
    if (!chats[epicId]?.running || !epic) return UNKNOWN
    return typeof epic.agentType === 'string' && epic.agentType ? epic.agentType : 'claude'
  }
  return UNKNOWN
}

export function worldRoster(
  holders: SlotHolderLite[],
  jobs: JobWithAgent[],
  chats: Record<string, ChatSignalLite>,
  epics: Record<string, EpicWithAgent>,
): WorldRosterEntry[] {
  const byType = new Map<string, WorldRosterEntry>()
  for (const holder of holders) {
    const agentType = resolveAgentType(holder.owner, jobs, chats, epics)
    let entry = byType.get(agentType)
    if (!entry) {
      entry = { agentType, count: 0, owners: [] }
      byType.set(agentType, entry)
    }
    entry.count += 1
    entry.owners.push(holder.owner)
  }
  return [...byType.values()].sort(
    (a, b) => b.count - a.count || (a.agentType < b.agentType ? -1 : a.agentType > b.agentType ? 1 : 0),
  )
}

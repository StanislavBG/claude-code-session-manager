// Pure Guild Hall rooms: one room per open project (tab order), each with a
// per-agentType roster of agents active in that project. Reads only existing
// renderer state passed in as plain shapes — no store imports, no IPC.
import type { ChatSignalLite, EpicLite, ScheduleJobLite, SlotHolderLite } from './homeSessionRows'
import { projectNameFromCwd } from './homeProjectRows'
import { resolveAgentType, type WorldRosterEntry } from './worldRoster'

export const GUILD_ACTIVE_WINDOW_MS = 30_000

export interface GuildRoom {
  cwd: string | null
  label: string
  roster: WorldRosterEntry[]
}

export interface GuildRoomsInput {
  tabs: { cwd: string }[]
  holders: SlotHolderLite[]
  jobs: (ScheduleJobLite & { agentType?: string | null })[]
  chats: Record<string, ChatSignalLite>
  epics: Record<string, EpicLite & { agentType?: string }>
  liveTabs: { tabId: string; cwd: string; sessionUuid: string; lastEventAt: number }[]
  now: number
}

const norm = (cwd: string): string => cwd.replace(/\/+$/, '') || cwd

function holderCwd(owner: string, input: GuildRoomsInput): string | null {
  if (owner.startsWith('scheduler:')) {
    const slug = owner.slice('scheduler:'.length)
    return input.jobs.find((j) => j.slug === slug)?.cwd ?? null
  }
  if (owner.startsWith('chat:')) return input.epics[owner.slice('chat:'.length)]?.cwd ?? null
  return null
}

function sortRoster(roster: WorldRosterEntry[]): WorldRosterEntry[] {
  return roster.sort(
    (a, b) => b.count - a.count || (a.agentType < b.agentType ? -1 : a.agentType > b.agentType ? 1 : 0),
  )
}

export function guildRooms(input: GuildRoomsInput): GuildRoom[] {
  const rooms = new Map<string, Map<string, WorldRosterEntry>>()
  const order: { key: string; cwd: string }[] = []
  for (const tab of input.tabs) {
    const key = norm(tab.cwd)
    if (rooms.has(key)) continue
    rooms.set(key, new Map())
    order.push({ key, cwd: tab.cwd })
  }
  const other = new Map<string, WorldRosterEntry>()

  const add = (cwd: string | null, agentType: string, owner: string): void => {
    const target = cwd != null ? rooms.get(norm(cwd)) ?? other : other
    let entry = target.get(agentType)
    if (!entry) {
      entry = { agentType, count: 0, owners: [] }
      target.set(agentType, entry)
    }
    entry.count += 1
    entry.owners.push(owner)
  }

  const chatSessionIds = new Set<string>()
  for (const holder of input.holders) {
    const agentType = resolveAgentType(holder.owner, input.jobs, input.chats, input.epics)
    const cwd = agentType === 'unknown' ? null : holderCwd(holder.owner, input)
    add(cwd, agentType, holder.owner)
    if (holder.owner.startsWith('chat:')) {
      const sid = input.epics[holder.owner.slice('chat:'.length)]?.claudeSessionId
      if (sid) chatSessionIds.add(sid)
    }
  }

  const epicBySession = new Map<string, EpicLite & { agentType?: string }>()
  for (const epic of Object.values(input.epics)) {
    if (epic.claudeSessionId) epicBySession.set(epic.claudeSessionId, epic)
  }
  for (const live of input.liveTabs) {
    if (input.now - live.lastEventAt >= GUILD_ACTIVE_WINDOW_MS) continue
    if (chatSessionIds.has(live.sessionUuid)) continue
    const epic = epicBySession.get(live.sessionUuid)
    const agentType = epic && typeof epic.agentType === 'string' && epic.agentType ? epic.agentType : 'claude'
    add(live.cwd, agentType, `live:${live.tabId}`)
  }

  const out: GuildRoom[] = order.map(({ key, cwd }) => ({
    cwd,
    label: projectNameFromCwd(key),
    roster: sortRoster([...rooms.get(key)!.values()]),
  }))
  if (other.size > 0) out.push({ cwd: null, label: 'Other projects', roster: sortRoster([...other.values()]) })
  return out
}

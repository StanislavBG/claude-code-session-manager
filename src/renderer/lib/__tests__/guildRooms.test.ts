import { describe, expect, it } from 'vitest'
import { GUILD_ACTIVE_WINDOW_MS, guildRooms, type GuildRoomsInput } from '../guildRooms'

const now = 1_000_000
const base = (over: Partial<GuildRoomsInput> = {}): GuildRoomsInput => ({
  tabs: [], holders: [], jobs: [], chats: {}, epics: {}, liveTabs: [], now, ...over,
})

describe('guildRooms', () => {
  it('8 open projects with no agents -> 8 empty rooms in tab order', () => {
    const names = ['Self', 'SM', 'Bilko', 'A', 'B', 'C', 'D', 'Hatch-Day']
    const tabs = [...names, 'SM'].map((n) => ({ cwd: `/p/${n}` }))
    const rooms = guildRooms(base({ tabs }))
    expect(rooms.map((r) => r.label)).toEqual(names)
    expect(rooms.every((r) => r.roster.length === 0)).toBe(true)
  })

  it('places job, chat and live tab in the right rooms', () => {
    const rooms = guildRooms(base({
      tabs: [{ cwd: '/p/a' }, { cwd: '/p/b' }],
      holders: [{ owner: 'scheduler:j1', at: '' }, { owner: 'chat:e1', at: '' }],
      jobs: [{ slug: 'j1', cwd: '/p/a', agentType: null }],
      chats: { e1: { running: true } },
      epics: { e1: { cwd: '/p/b', goalText: '', agentType: 'architect', claudeSessionId: 's1' },
        e2: { cwd: '/p/a', goalText: '', agentType: 'validator', claudeSessionId: 's2' } },
      liveTabs: [{ tabId: 't1', cwd: '/p/a', sessionUuid: 's2', lastEventAt: now - 1000 },
        { tabId: 't2', cwd: '/p/b', sessionUuid: 'x', lastEventAt: now - 10 }],
    }))
    expect(rooms[0].roster.map((e) => e.agentType)).toEqual(['dev-lead', 'validator'])
    expect(rooms[1].roster.map((e) => e.agentType)).toEqual(['architect', 'claude'])
    expect(rooms).toHaveLength(2)
  })

  it('ignores stale live tabs and dedupes chat/live', () => {
    const rooms = guildRooms(base({
      tabs: [{ cwd: '/p/a' }],
      holders: [{ owner: 'chat:e1', at: '' }],
      chats: { e1: { running: true } },
      epics: { e1: { cwd: '/p/a', goalText: '', claudeSessionId: 's1' } },
      liveTabs: [{ tabId: 't1', cwd: '/p/a', sessionUuid: 's1', lastEventAt: now },
        { tabId: 't2', cwd: '/p/a', sessionUuid: 'z', lastEventAt: now - GUILD_ACTIVE_WINDOW_MS }],
    }))
    expect(rooms[0].roster).toEqual([{ agentType: 'claude', count: 1, owners: ['chat:e1'] }])
  })

  it('matches cwds after stripping trailing slashes', () => {
    const rooms = guildRooms(base({
      tabs: [{ cwd: '/p/a/' }],
      liveTabs: [{ tabId: 't', cwd: '/p/a', sessionUuid: 'u', lastEventAt: now }],
    }))
    expect(rooms).toHaveLength(1)
    expect(rooms[0].label).toBe('a')
    expect(rooms[0].roster[0].count).toBe(1)
  })

  it('agents outside open projects and unresolvable holders go to Other projects', () => {
    const rooms = guildRooms(base({
      tabs: [{ cwd: '/p/a' }],
      holders: [{ owner: 'scheduler:j1', at: '' }, { owner: 'mystery', at: '' }],
      jobs: [{ slug: 'j1', cwd: '/p/zzz' }],
    }))
    expect(rooms.map((r) => r.label)).toEqual(['a', 'Other projects'])
    expect(rooms[1].cwd).toBeNull()
    expect(rooms[1].roster.map((e) => e.agentType).sort()).toEqual(['dev-lead', 'unknown'])
  })

  it('empty tabs -> [] or only Other projects', () => {
    expect(guildRooms(base())).toEqual([])
    const rooms = guildRooms(base({ holders: [{ owner: 'x', at: '' }] }))
    expect(rooms.map((r) => r.label)).toEqual(['Other projects'])
  })
})

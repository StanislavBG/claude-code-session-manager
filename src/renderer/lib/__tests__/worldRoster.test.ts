import { describe, it, expect } from 'vitest'
import { worldRoster } from '../worldRoster'

const h = (owner: string) => ({ owner, at: '2026-01-01T00:00:00Z' })
const job = (slug: string, agentType?: string) => ({ slug, cwd: '/p', agentType })

describe('worldRoster', () => {
  it('returns [] for no holders', () => {
    expect(worldRoster([], [], {}, {})).toEqual([])
  })

  it('groups 3 dev-lead jobs + 1 architect chat', () => {
    const r = worldRoster(
      [h('scheduler:a'), h('scheduler:b'), h('scheduler:c'), h('chat:e1')],
      [job('a'), job('b', 'dev-lead'), job('c')],
      { e1: { running: true } },
      { e1: { cwd: '/p', goalText: 'g', agentType: 'architect' } },
    )
    expect(r.map(({ agentType, count }) => ({ agentType, count }))).toEqual([
      { agentType: 'dev-lead', count: 3 },
      { agentType: 'architect', count: 1 },
    ])
    expect(r[1].owners).toEqual(['chat:e1'])
  })

  it('defaults chat agentType to claude', () => {
    const r = worldRoster([h('chat:e1')], [], { e1: { running: true } }, { e1: { cwd: '/p', goalText: 'g' } })
    expect(r).toEqual([{ agentType: 'claude', count: 1, owners: ['chat:e1'] }])
  })

  it('missing job -> unknown', () => {
    expect(worldRoster([h('scheduler:gone')], [], {}, {})[0].agentType).toBe('unknown')
  })

  it('unresolved owner prefix -> unknown', () => {
    expect(worldRoster([h('weird:x')], [], {}, {})[0].agentType).toBe('unknown')
  })

  it('tie-breaks by agentType ascending', () => {
    const r = worldRoster(
      [h('scheduler:a'), h('scheduler:b')],
      [job('a', 'validator'), job('b', 'architect')],
      {},
      {},
    )
    expect(r.map((e) => e.agentType)).toEqual(['architect', 'validator'])
  })
})

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../../src/main/webRemote.cjs') as {
  __test: { buildRemoteSessionList: (tabs: unknown[], readIndex: (cwd: string) => unknown) => any[] }
}
const build = __test.buildRemoteSessionList

const tab = { sessionId: 't1', cwd: '/p/alpha', label: '' }
const epic = (id: string, extra: Record<string, unknown> = {}) => ({
  id, claudeSessionId: `cs-${id}`, cwd: '/p/alpha', status: 'active', goalText: `Goal ${id}`,
  tag: 'build', agentType: 'dev-lead', ...extra,
})
const idx = (...eps: any[]) => () => ({ sessions: Object.fromEntries(eps.map((e) => [e.id, e])) })

describe('buildRemoteSessionList', () => {
  it('lists project + 2 active Epics', () => {
    const r = build([tab], idx(epic('a'), epic('b')))
    expect(r).toHaveLength(3)
    expect(r[0]).toEqual({ kind: 'project', tabId: 't1', cwd: '/p/alpha', title: '/p/alpha', project: 'alpha' })
    expect(r[1]).toEqual({
      kind: 'epic', tabId: 'cs-a', epicId: 'a', cwd: '/p/alpha', title: 'Goal a', project: 'alpha', tag: 'build', agentType: 'dev-lead',
    })
  })

  it('excludes proposed/completed and Epics without claudeSessionId', () => {
    const r = build([tab], idx(epic('a', { status: 'proposed' }), epic('b', { status: 'completed' }), epic('c', { claudeSessionId: '' }), epic('d')))
    expect(r.map((e) => e.epicId)).toEqual([undefined, 'd'])
  })

  it('prefers worktree dir over cwd', () => {
    const r = build([tab], idx(epic('a', { worktree: { dir: '/wt/a' } })))
    expect(r[1].cwd).toBe('/wt/a')
  })

  it('truncates title to first line / 80 chars, falls back to id', () => {
    const r = build([{ ...tab, label: 'Alpha' }], idx(
      epic('a', { goalText: `  First line  \nsecond` }),
      epic('b', { goalText: 'x'.repeat(200) }),
      epic('c', { goalText: '   ' }),
    ))
    expect(r[0].title).toBe('Alpha')
    expect(r[1].project).toBe('Alpha')
    expect(r[1].title).toBe('First line')
    expect(r[2].title).toHaveLength(80)
    expect(r[3].title).toBe('c')
  })

  it('yields the project entry alone when readIndex throws or is empty', () => {
    expect(build([tab], () => { throw new Error('boom') })).toHaveLength(1)
    expect(build([tab], () => ({ sessions: {} }))).toHaveLength(1)
    expect(build([tab], () => undefined)).toHaveLength(1)
  })

  it('does not duplicate Epics for tabs sharing a cwd', () => {
    const r = build([tab, { ...tab, sessionId: 't2' }], idx(epic('a')))
    expect(r.filter((e) => e.kind === 'epic')).toHaveLength(1)
    expect(r.filter((e) => e.kind === 'project')).toHaveLength(2)
  })
})

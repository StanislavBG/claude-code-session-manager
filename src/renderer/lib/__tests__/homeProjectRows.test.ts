import { describe, it, expect } from 'vitest'
import { buildHomeProjectRows } from '../homeProjectRows'
import type { ProjectAggregate } from '../knownProjectAggregate'

function project(overrides: Partial<ProjectAggregate> = {}): ProjectAggregate {
  return {
    cwd: '/home/bilko/Projects/foo',
    name: 'foo',
    encoded: '-home-bilko-Projects-foo',
    encodedIds: ['-home-bilko-Projects-foo'],
    sessionCount: 2,
    sizeBytes: 4096,
    lastSession: 1000,
    details: {},
    ...overrides,
  }
}

describe('buildHomeProjectRows', () => {
  it('maps a project aggregate to a display row with no live chats', () => {
    expect(buildHomeProjectRows([project()], {}, {})).toEqual([
      {
        encoded: '-home-bilko-Projects-foo',
        name: 'foo',
        cwd: '/home/bilko/Projects/foo',
        dotSeed: '/home/bilko/Projects/foo',
        liveCount: 0,
        lastActivityMs: 1000,
      },
    ])
  })

  it('counts running chats whose epic cwd matches the project', () => {
    const chats = {
      'epic-1': { running: true },
      'epic-2': { running: true },
      'epic-3': { running: false },
    }
    const sessions = {
      'epic-1': { cwd: '/home/bilko/Projects/foo' },
      'epic-2': { cwd: '/home/bilko/Projects/other' },
      'epic-3': { cwd: '/home/bilko/Projects/foo' },
    }
    expect(buildHomeProjectRows([project()], chats, sessions)[0].liveCount).toBe(1)
  })

  it('matches an epic cwd that differs only by a trailing slash', () => {
    const chats = { 'epic-1': { running: true } }
    const sessions = { 'epic-1': { cwd: '/home/bilko/Projects/foo/' } }
    expect(buildHomeProjectRows([project()], chats, sessions)[0].liveCount).toBe(1)
  })

  it('ignores running chats whose epic id has no matching session', () => {
    const chats = { 'epic-orphan': { running: true } }
    expect(buildHomeProjectRows([project()], chats, {})[0].liveCount).toBe(0)
  })

  it('handles zero known projects', () => {
    expect(buildHomeProjectRows([], {}, {})).toEqual([])
  })
})

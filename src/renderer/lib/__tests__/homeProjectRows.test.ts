import { describe, it, expect } from 'vitest'
import { buildHomeProjectRows } from '../homeProjectRows'
import type { ProjectRow, EnrichmentState } from '../useKnownProjects'

function row(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    encoded: '-home-bilko-Projects-foo',
    displayPath: '/home/bilko/Projects/foo',
    sessionCount: 2,
    lastSession: 1000,
    path: '/home/x/.claude/projects/-home-bilko-Projects-foo',
    sizeBytes: 4096,
    ...overrides,
  }
}

describe('buildHomeProjectRows', () => {
  it('maps a plain row to a display row with no live chats', () => {
    const rows = buildHomeProjectRows([row()], {}, {}, {})
    expect(rows).toEqual([
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

  it('prefers the enriched cwd over the displayPath fallback', () => {
    const enriched: Record<string, EnrichmentState> = {
      '-home-bilko-Projects-foo': { cwd: '/actual/path/foo' } as EnrichmentState,
    }
    const rows = buildHomeProjectRows([row()], enriched, {}, {})
    expect(rows[0].cwd).toBe('/actual/path/foo')
    expect(rows[0].name).toBe('foo')
  })

  it('counts running chats whose epic cwd matches the project', () => {
    const enriched: Record<string, EnrichmentState> = {
      '-home-bilko-Projects-foo': { cwd: '/home/bilko/Projects/foo' } as EnrichmentState,
    }
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
    const rows = buildHomeProjectRows([row()], enriched, chats, sessions)
    expect(rows[0].liveCount).toBe(1)
  })

  it('ignores running chats whose epic id has no matching session', () => {
    const chats = { 'epic-orphan': { running: true } }
    const rows = buildHomeProjectRows([row()], {}, chats, {})
    expect(rows[0].liveCount).toBe(0)
  })

  it('handles zero known projects', () => {
    expect(buildHomeProjectRows([], {}, {}, {})).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import { aggregateProjectsByCwd, normalizeCwd, projectNameFromCwd } from '../knownProjectAggregate'
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

const e = (cwd: string | null, extra: Partial<EnrichmentState> = {}): EnrichmentState =>
  ({ cwd, ...extra }) as EnrichmentState

describe('normalizeCwd', () => {
  it('strips trailing slashes and collapses repeats', () => {
    expect(normalizeCwd('/a/b/')).toBe('/a/b')
    expect(normalizeCwd('/a//b')).toBe('/a/b')
    expect(normalizeCwd('  /a/b//  ')).toBe('/a/b')
  })

  it('keeps root as /', () => {
    expect(normalizeCwd('/')).toBe('/')
  })
})

describe('projectNameFromCwd', () => {
  it('returns the last path segment', () => {
    expect(projectNameFromCwd('/home/bilko/Projects/foo')).toBe('foo')
    expect(projectNameFromCwd('/home/bilko/Projects/foo/')).toBe('foo')
  })
})

describe('aggregateProjectsByCwd', () => {
  it('emits one row per unique cwd, named after the directory', () => {
    const out = aggregateProjectsByCwd([row()], { '-home-bilko-Projects-foo': e('/home/bilko/Projects/foo') })
    expect(out).toHaveLength(1)
    expect(out[0].cwd).toBe('/home/bilko/Projects/foo')
    expect(out[0].name).toBe('foo')
    expect(out[0].encodedIds).toEqual(['-home-bilko-Projects-foo'])
  })

  it('drops rows whose cwd never resolved — no fabricated candidatePath fallback', () => {
    // The 2044-phantom-projects bug: every unresolvable transcript folder used
    // to become a "project" named after a decoded-but-nonexistent path.
    const rows = [
      row({ encoded: '-tmp-sm-doflush-test-l2mclS' }),
      row({ encoded: '-home-bilko-Projects-foo' }),
    ]
    const out = aggregateProjectsByCwd(rows, {
      '-tmp-sm-doflush-test-l2mclS': e(null),
      '-home-bilko-Projects-foo': e('/home/bilko/Projects/foo'),
    })
    expect(out.map((p) => p.cwd)).toEqual(['/home/bilko/Projects/foo'])
  })

  it('drops rows with no enrichment entry at all', () => {
    expect(aggregateProjectsByCwd([row()], {})).toEqual([])
  })

  it('drops rows whose cwd is blank', () => {
    expect(aggregateProjectsByCwd([row()], { '-home-bilko-Projects-foo': e('   ') })).toEqual([])
  })

  it('merges several transcript folders that resolve to the same cwd', () => {
    const rows = [
      row({ encoded: 'old', sessionCount: 3, sizeBytes: 100, lastSession: 500 }),
      row({ encoded: 'new', sessionCount: 4, sizeBytes: 250, lastSession: 900 }),
    ]
    const out = aggregateProjectsByCwd(rows, {
      old: e('/home/bilko/Projects/foo'),
      new: e('/home/bilko/Projects/foo/', { lastBranch: 'main' }),
    })
    expect(out).toHaveLength(1)
    expect(out[0].sessionCount).toBe(7)
    expect(out[0].sizeBytes).toBe(350)
    expect(out[0].lastSession).toBe(900)
    expect(out[0].encodedIds.sort()).toEqual(['new', 'old'])
    // Representative = the most recently active folder.
    expect(out[0].encoded).toBe('new')
    expect(out[0].details.lastBranch).toBe('main')
  })

  it('treats trailing-slash and doubled-slash variants as one project', () => {
    const out = aggregateProjectsByCwd(
      [row({ encoded: 'a' }), row({ encoded: 'b' }), row({ encoded: 'c' })],
      { a: e('/p/foo'), b: e('/p/foo/'), c: e('/p//foo') },
    )
    expect(out).toHaveLength(1)
    expect(out[0].cwd).toBe('/p/foo')
  })

  it('sorts most-recently-active first', () => {
    const rows = [
      row({ encoded: 'a', lastSession: 10 }),
      row({ encoded: 'b', lastSession: 90 }),
      row({ encoded: 'c', lastSession: 50 }),
    ]
    const out = aggregateProjectsByCwd(rows, { a: e('/p/a'), b: e('/p/b'), c: e('/p/c') })
    expect(out.map((p) => p.cwd)).toEqual(['/p/b', '/p/c', '/p/a'])
  })

  it('never leaks the cwd field into details', () => {
    const out = aggregateProjectsByCwd([row()], {
      '-home-bilko-Projects-foo': e('/p/foo', { name: 'pkg-name', gitRemote: 'github.com/x/y' }),
    })
    expect(out[0].details).toEqual({ name: 'pkg-name', gitRemote: 'github.com/x/y' })
    expect('cwd' in out[0].details).toBe(false)
  })

  it('handles zero rows', () => {
    expect(aggregateProjectsByCwd([], {})).toEqual([])
  })
})

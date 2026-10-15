import { describe, it, expect } from 'vitest'
import {
  aggregateProjectsByCwd,
  countUnresolvedWorktreeFolders,
  normalizeCwd,
  ownerCandidateCwds,
  parseManagedWorktreeCwd,
  projectNameFromCwd,
} from '../knownProjectAggregate'
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

const H = 'a1b2c3d4e5f60718'
const JOB = `/tmp/session-manager-job-worktrees/${H}/4169-fix-event-pricing`
const EPIC = `/home/bilko/.local-state/session-manager/session-manager-epic-worktrees/${H}/abc123`
const OWNER = '/home/bilko/Projects/foo'

describe('parseManagedWorktreeCwd', () => {
  it('recognises job and epic worktrees on both bases, incl. subdirectories', () => {
    expect(parseManagedWorktreeCwd(JOB)).toEqual({ kind: 'job', hash: H })
    expect(parseManagedWorktreeCwd(EPIC)).toEqual({ kind: 'epic', hash: H })
    expect(parseManagedWorktreeCwd(`${JOB}/src/renderer`)).toEqual({ kind: 'job', hash: H })
  })

  it('returns null for ordinary paths and malformed hashes', () => {
    expect(parseManagedWorktreeCwd(OWNER)).toBeNull()
    expect(parseManagedWorktreeCwd('/tmp/session-manager-job-worktrees/short/key')).toBeNull()
    expect(parseManagedWorktreeCwd(`/tmp/session-manager-job-worktrees/${H}0/key`)).toBeNull()
    expect(parseManagedWorktreeCwd(`/tmp/session-manager-job-worktrees/${H.toUpperCase()}/key`)).toBeNull()
    expect(parseManagedWorktreeCwd(`/tmp/session-manager-job-worktrees/${H}`)).toBeNull()
  })
})

describe('worktree folding', () => {
  const owners = new Map([[H, OWNER]])

  it('folds a worktree row into the owner project, keeping the main folder as representative', () => {
    const rows = [
      row({ encoded: 'main', sessionCount: 2, sizeBytes: 10, lastSession: 100 }),
      row({ encoded: 'wt', sessionCount: 5, sizeBytes: 90, lastSession: 900 }),
    ]
    const out = aggregateProjectsByCwd(rows, { main: e(OWNER, { lastBranch: 'main' }), wt: e(JOB, { lastBranch: 'sm-job/x' }) }, owners)
    expect(out).toHaveLength(1)
    expect(out[0].cwd).toBe(OWNER)
    expect(out[0].sessionCount).toBe(7)
    expect(out[0].sizeBytes).toBe(100)
    expect(out[0].lastSession).toBe(900)
    expect(out[0].encodedIds.sort()).toEqual(['main', 'wt'])
    expect(out[0].encoded).toBe('main')
    expect(out[0].details.lastBranch).toBe('main')
  })

  it('keeps the main folder representative regardless of row order', () => {
    const rows = [
      row({ encoded: 'wt', lastSession: 900 }),
      row({ encoded: 'main', lastSession: 100 }),
    ]
    const out = aggregateProjectsByCwd(rows, { main: e(OWNER), wt: e(EPIC) }, owners)
    expect(out).toHaveLength(1)
    expect(out[0].encoded).toBe('main')
    expect(out[0].lastSession).toBe(900)
  })

  it('creates the owner row from worktree rows alone, named after the owner cwd', () => {
    const out = aggregateProjectsByCwd([row({ encoded: 'wt' })], { wt: e(JOB) }, owners)
    expect(out).toHaveLength(1)
    expect(out[0].cwd).toBe(OWNER)
    expect(out[0].name).toBe('foo')
    expect(out[0].encoded).not.toBe('wt')
    expect(out[0].details).toEqual({})
  })

  it('drops an unresolved worktree (or any worktree without a map) and counts it', () => {
    const rows = [row({ encoded: 'wt' }), row({ encoded: 'main' })]
    const en = { wt: e(JOB), main: e(OWNER) }
    expect(aggregateProjectsByCwd(rows, en).map((p) => p.cwd)).toEqual([OWNER])
    expect(aggregateProjectsByCwd(rows, en, new Map()).map((p) => p.cwd)).toEqual([OWNER])
    expect(countUnresolvedWorktreeFolders(rows, en)).toBe(1)
    expect(countUnresolvedWorktreeFolders(rows, en, new Map())).toBe(1)
    expect(countUnresolvedWorktreeFolders(rows, en, owners)).toBe(0)
  })
})

describe('ownerCandidateCwds', () => {
  it('lists unique normalized non-worktree cwds only', () => {
    const rows = [row({ encoded: 'a' }), row({ encoded: 'b' }), row({ encoded: 'w' }), row({ encoded: 'n' })]
    const out = ownerCandidateCwds(rows, { a: e(OWNER), b: e(`${OWNER}/`), w: e(JOB), n: e(null) })
    expect(out).toEqual([OWNER])
  })
})

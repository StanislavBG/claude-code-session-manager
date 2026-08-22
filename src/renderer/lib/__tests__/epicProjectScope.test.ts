import { describe, it, expect } from 'vitest'
import { resolveEpicProject, epicProjectCwds } from '../epicProjectScope'

const KNOWN = ['/home/bilko/Projects/alpha', '/home/bilko/Projects/beta']

describe('resolveEpicProject', () => {
  it('uses the active tab cwd even when it is not a known project yet', () => {
    // The reported bug: a brand-new project has no ~/.claude/projects/ folder,
    // so it is missing from knownCwds and the card fell through to alpha.
    expect(resolveEpicProject({ activeTabCwd: '/home/bilko/Projects/brand-new', knownCwds: KNOWN }))
      .toEqual({ cwd: '/home/bilko/Projects/brand-new', showSelector: false })
  })

  it('hides the selector, and ignores a stale pick, whenever a tab is active', () => {
    expect(resolveEpicProject({
      picked: '/home/bilko/Projects/beta',
      activeTabCwd: '/home/bilko/Projects/alpha',
      knownCwds: KNOWN,
    })).toEqual({ cwd: '/home/bilko/Projects/alpha', showSelector: false })
  })

  it('normalizes the tab cwd', () => {
    expect(resolveEpicProject({ activeTabCwd: '/home/bilko/Projects/alpha/', knownCwds: KNOWN }).cwd)
      .toBe('/home/bilko/Projects/alpha')
  })

  it('falls back to a picker only when there is no active tab', () => {
    expect(resolveEpicProject({ activeTabCwd: null, knownCwds: KNOWN }))
      .toEqual({ cwd: KNOWN[0], showSelector: true })
    expect(resolveEpicProject({ picked: KNOWN[1], activeTabCwd: '', knownCwds: KNOWN }))
      .toEqual({ cwd: KNOWN[1], showSelector: true })
    expect(resolveEpicProject({ activeTabCwd: null, knownCwds: [] }))
      .toEqual({ cwd: '', showSelector: true })
  })
})

describe('epicProjectCwds', () => {
  it('appends the on-screen cwd when it is not yet a known project', () => {
    expect(epicProjectCwds(KNOWN, '/home/bilko/Projects/brand-new'))
      .toEqual([...KNOWN, '/home/bilko/Projects/brand-new'])
  })
  it('does not duplicate an already-known cwd', () => {
    expect(epicProjectCwds(KNOWN, '/home/bilko/Projects/alpha/')).toEqual(KNOWN)
  })
  it('is a no-op without an active cwd', () => {
    expect(epicProjectCwds(KNOWN, null)).toEqual(KNOWN)
  })
})

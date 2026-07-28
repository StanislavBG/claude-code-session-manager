import { describe, it, expect } from 'vitest'
import { resolveProjectCwd, findBackgroundSession } from '../findBackgroundSession'
import type { SessionTab } from '../../../../state/sessions'

function makeTab(overrides: Partial<SessionTab>): SessionTab {
  return {
    id: overrides.id ?? 't1',
    sessionId: overrides.sessionId ?? 'session-1',
    label: overrides.label ?? 'tab',
    cwd: overrides.cwd ?? '/home/user/project',
    pid: overrides.pid ?? null,
    status: overrides.status ?? 'dormant',
    exitCode: overrides.exitCode ?? null,
    startupCommand: overrides.startupCommand ?? null,
    presetId: overrides.presetId ?? null,
    generation: overrides.generation ?? 0,
  }
}

describe('resolveProjectCwd', () => {
  it('picks the longest matching tab cwd prefix', () => {
    const tabs = [
      makeTab({ id: 'a', cwd: '/home/user' }),
      makeTab({ id: 'b', cwd: '/home/user/project' }),
    ]
    expect(resolveProjectCwd('/home/user/project/src/file.md', tabs)).toBe('/home/user/project')
  })

  it('returns null when no tab cwd prefixes the path', () => {
    const tabs = [makeTab({ cwd: '/home/other/project' })]
    expect(resolveProjectCwd('/home/user/project/file.md', tabs)).toBeNull()
  })
})

describe('findBackgroundSession', () => {
  it('returns null when no tab matches the cwd', () => {
    const tabs = [makeTab({ id: 'a', cwd: '/other', status: 'dormant' })]
    expect(findBackgroundSession('/home/user/project', tabs, {})).toBeNull()
  })

  it('returns the single dormant match', () => {
    const tabs = [makeTab({ id: 'a', cwd: '/home/user/project', status: 'dormant' })]
    const result = findBackgroundSession('/home/user/project', tabs, { a: { lastEventAt: 100 } })
    expect(result?.id).toBe('a')
  })

  it('picks the more recently active of two dormant matches', () => {
    const tabs = [
      makeTab({ id: 'a', cwd: '/home/user/project', status: 'dormant' }),
      makeTab({ id: 'b', cwd: '/home/user/project', status: 'dormant' }),
    ]
    const live = { a: { lastEventAt: 100 }, b: { lastEventAt: 200 } }
    expect(findBackgroundSession('/home/user/project', tabs, live)?.id).toBe('b')
  })

  it('never picks a running/spawning/exited tab even with a higher lastEventAt', () => {
    const tabs = [
      makeTab({ id: 'a', cwd: '/home/user/project', status: 'running' }),
      makeTab({ id: 'b', cwd: '/home/user/project', status: 'dormant' }),
    ]
    const live = { a: { lastEventAt: 999 }, b: { lastEventAt: 1 } }
    expect(findBackgroundSession('/home/user/project', tabs, live)?.id).toBe('b')
  })
})

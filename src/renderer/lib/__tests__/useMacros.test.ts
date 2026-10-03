import { describe, it, expect } from 'vitest'
import { macrosForProject } from '../useMacros'
import type { Macro } from '../../../preload/api'

const m = (label: string, projects: string[], surface?: 'sessions' | 'project-home'): Macro => ({
  id: label, label, agentName: 'a', tag: 'feature', prompt: 'p', projects,
  surface: surface ?? 'sessions', createdAt: '', updatedAt: '',
})

describe('macrosForProject', () => {
  it('returns [] without a cwd', () => {
    expect(macrosForProject([m('x', ['*'])], null)).toEqual([])
  })
  it('matches cwd (normalized) and wildcard, drops others', () => {
    const r = macrosForProject([m('a', ['/p/one/']), m('b', ['/p/two']), m('c', ['*'])], '/p//one')
    expect(r.map((x) => x.label)).toEqual(['a', 'c'])
  })
  it('sorts case-insensitively', () => {
    const r = macrosForProject([m('beta', ['*']), m('Alpha', ['*']), m('charlie', ['*'])], '/x')
    expect(r.map((x) => x.label)).toEqual(['Alpha', 'beta', 'charlie'])
  })
  it('default surface excludes project-home macros', () => {
    const r = macrosForProject([m('a', ['*'], 'sessions'), m('b', ['*'], 'project-home')], '/x')
    expect(r.map((x) => x.label)).toEqual(['a'])
  })
  it("surface 'project-home' returns only project-home macros", () => {
    const r = macrosForProject(
      [m('a', ['*'], 'sessions'), m('b', ['*'], 'project-home')],
      '/x',
      'project-home',
    )
    expect(r.map((x) => x.label)).toEqual(['b'])
  })
  it('a macro without surface counts as sessions', () => {
    const noSurface = { ...m('a', ['*']) } as Partial<Macro>
    delete noSurface.surface
    const r = macrosForProject([noSurface as Macro], '/x')
    expect(r.map((x) => x.label)).toEqual(['a'])
  })
})

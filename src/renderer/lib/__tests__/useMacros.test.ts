// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { macrosForProject, useMacros, __resetMacrosCacheForTests } from '../useMacros'
import { toast } from '../../state/toast'
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

describe('useMacros last-known cache', () => {
  let container: HTMLDivElement
  let root: Root
  let seen: { macros: Macro[]; loaded: boolean }
  const list = vi.fn()
  function Probe() {
    seen = useMacros()
    return null
  }
  const probe = () => createElement(Probe)
  const mount = async () => {
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => { root.render(probe()) })
  }
  const unmount = () => { act(() => root.unmount()) }

  beforeEach(() => {
    __resetMacrosCacheForTests()
    list.mockReset()
    ;(globalThis as any).window.api = { macros: { list, onChanged: vi.fn(() => () => {}) } }
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('a first mount with a pending list reports loaded false', async () => {
    list.mockReturnValue(new Promise(() => {}))
    await mount()
    expect(seen.loaded).toBe(false)
    expect(seen.macros).toEqual([])
    unmount()
  })

  it('a remount whose list never resolves still renders the old macros', async () => {
    list.mockResolvedValueOnce([m('Keep', ['*'])])
    await mount()
    expect(seen.macros.map((x) => x.label)).toEqual(['Keep'])
    unmount()
    list.mockReturnValue(new Promise(() => {}))
    await mount()
    expect(seen.loaded).toBe(true)
    expect(seen.macros.map((x) => x.label)).toEqual(['Keep'])
    unmount()
  })

  it('a rejected list after a success keeps the macros and toasts once', async () => {
    const err = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never)
    list.mockResolvedValueOnce([m('Keep', ['*'])])
    await mount()
    unmount()
    list.mockRejectedValue(new Error('boom'))
    await mount()
    expect(seen.macros.map((x) => x.label)).toEqual(['Keep'])
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0][0])).toContain('boom')
    unmount()
  })
})

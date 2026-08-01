import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, getNavItemsForFace } from '../navGroups'
import type { NavFace } from '../navFace'

const VALID_FACES: NavFace[] = ['home', 'project']

describe('navGroups Home swap', () => {
  it('first Workspace item is project-home labeled Home', () => {
    const workspace = NAV_ITEMS.filter((item) => item.group === 'Workspace')
    expect(workspace[0]?.key).toBe('project-home')
    expect(workspace[0]?.label).toBe('Home')
  })

  it('no NAV_ITEMS entry has key overview', () => {
    expect(NAV_ITEMS.some((item) => item.key === 'overview')).toBe(false)
  })
})

describe('getNavItemsForFace', () => {
  const HOME_ONLY = ['browser', 'plugins', 'keybindings', 'remote', 'sm-config', 'voice']
  const PROJECT_ONLY = ['project-home', 'projects', 'repoviz', 'search', 'memory']
  const BOTH = [
    'terminal', 'scheduler', 'history', 'system-prompt', 'skills', 'mcp', 'hooks',
    'permissions', 'settings',
  ]

  it('home face returns home-only + both keys', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(new Set(keys)).toEqual(new Set([...HOME_ONLY, ...BOTH]))
  })

  it('project face returns project-only + both keys', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(new Set(keys)).toEqual(new Set([...PROJECT_ONLY, ...BOTH]))
  })

  it('preserves NAV_ITEMS group order (Workspace, Configure, Tools)', () => {
    const homeKeys = getNavItemsForFace('home').map((item) => item.key)
    const allKeysInOrder = NAV_ITEMS.map((item) => item.key)
    const expected = allKeysInOrder.filter((k) => homeKeys.includes(k))
    expect(homeKeys).toEqual(expected)
  })
})

describe('project-home is project-only', () => {
  it('NAV_ITEMS tags project-home with faces: [project]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'project-home')
    expect(item?.faces).toEqual(['project'])
  })

  it('home face excludes project-home', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).not.toContain('project-home')
  })

  it('project face includes project-home', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).toContain('project-home')
  })
})

describe('browser is home-only', () => {
  it('NAV_ITEMS tags browser with faces: [home]', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'browser')
    expect(item?.faces).toEqual(['home'])
  })

  it('project face excludes browser', () => {
    const keys = getNavItemsForFace('project').map((item) => item.key)
    expect(keys).not.toContain('browser')
  })

  it('home face includes browser', () => {
    const keys = getNavItemsForFace('home').map((item) => item.key)
    expect(keys).toContain('browser')
  })
})

describe('NAV_ITEMS face-coverage invariant', () => {
  it('every NAV_ITEMS entry has a non-empty faces array', () => {
    for (const item of NAV_ITEMS) {
      expect(item.faces.length).toBeGreaterThan(0)
    }
  })

  it('every face value is a valid NavFace', () => {
    for (const item of NAV_ITEMS) {
      for (const face of item.faces) {
        expect(VALID_FACES).toContain(face)
      }
    }
  })

  it('home + project faces together cover every NAV_ITEMS key', () => {
    const homeKeys = getNavItemsForFace('home').map((item) => item.key)
    const projectKeys = getNavItemsForFace('project').map((item) => item.key)
    const covered = new Set([...homeKeys, ...projectKeys])
    const allKeys = NAV_ITEMS.map((item) => item.key)
    expect(covered).toEqual(new Set(allKeys))
  })
})

import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, getNavItemsForFace } from '../navGroups'

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

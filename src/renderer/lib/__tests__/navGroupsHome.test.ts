import { describe, expect, it } from 'vitest'
import { NAV_ITEMS } from '../navGroups'

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

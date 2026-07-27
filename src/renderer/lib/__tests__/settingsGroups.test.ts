import { describe, it, expect } from 'vitest'
import { SETTINGS_GROUPS, planGroupRail } from '../settingsGroups'

describe('planGroupRail', () => {
  it('returns one rail entry per SETTINGS_GROUPS group with keys present in allKeys', () => {
    const allKeys = new Set(SETTINGS_GROUPS.flatMap((g) => g.keys))
    const presentKeys = new Set<string>()
    const rail = planGroupRail(allKeys, presentKeys)
    expect(rail.map((r) => r.id)).toEqual(SETTINGS_GROUPS.map((g) => g.id))
  })

  it('computes a correct set-count out of the group total', () => {
    const essentials = SETTINGS_GROUPS.find((g) => g.id === 'essentials')!
    const allKeys = new Set(essentials.keys)
    const presentKeys = new Set([essentials.keys[0], essentials.keys[1]])
    const rail = planGroupRail(allKeys, presentKeys)
    const entry = rail.find((r) => r.id === 'essentials')!
    expect(entry.total).toBe(essentials.keys.length)
    expect(entry.setCount).toBe(2)
  })

  it('omits a group entirely when none of its keys are known', () => {
    const rail = planGroupRail(new Set(['model']), new Set(['model']))
    expect(rail.some((r) => r.id === 'git')).toBe(false)
    const essentials = rail.find((r) => r.id === 'essentials')!
    expect(essentials.total).toBe(1)
    expect(essentials.setCount).toBe(1)
  })

  it('adds an "other" entry for keys outside every declared group', () => {
    const rail = planGroupRail(new Set(['model', 'someUnknownKey']), new Set(['someUnknownKey']))
    const other = rail.find((r) => r.id === 'other')!
    expect(other.total).toBe(1)
    expect(other.setCount).toBe(1)
  })
})

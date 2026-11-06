import { describe, expect, it } from 'vitest'
import { NO_MISSION, TAG_GROUP_ORDER, TAG_LIBRARY, missionLabel, tagLibraryEntry } from '../tagLibrary'

describe('tagLibrary', () => {
  it('flags requiresDevelopLoop per tag', () => {
    const on = TAG_LIBRARY.filter((e) => e.requiresDevelopLoop).map((e) => e.tag).sort()
    expect(on).toEqual(['art', 'bug', 'feature'])
    for (const t of ['discussion', 'build', 'project-home-builder', 'portfolio'] as const) {
      expect(tagLibraryEntry(t).requiresDevelopLoop).toBe(false)
    }
  })
  it('exports NO_MISSION', () => {
    expect(NO_MISSION.label).toBe('None')
    expect(NO_MISSION.description).toBe('No mission — your goal is sent as written, with no task framing.')
  })
  it('missionLabel handles tag, null and undefined', () => {
    expect(missionLabel('bug')).toBe(tagLibraryEntry('bug').label)
    expect(missionLabel(null)).toBe('None')
    expect(missionLabel(undefined)).toBe('None')
  })
  it('keeps 7 tags', () => {
    expect(TAG_GROUP_ORDER).toHaveLength(7)
  })
})

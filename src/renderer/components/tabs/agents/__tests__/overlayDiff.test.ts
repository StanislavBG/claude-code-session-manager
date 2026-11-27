import { describe, it, expect } from 'vitest'
import { overlayDiff, BLANK_DRAFT } from '../AgentDetail'

describe('overlayDiff', () => {
  it('lists an empty overlay list against an unset global as changed', () => {
    const d = overlayDiff(BLANK_DRAFT, { mcpServers: [] }, 'Self')
    expect(d).toHaveLength(1)
    expect(d[0].lines[0]).toBe('mcpServers: none in Self')
  })
  it('lists an empty overlay against a non-empty global as changed with removals', () => {
    const d = overlayDiff({ ...BLANK_DRAFT, mcpServers: ['blender'] }, { mcpServers: [] }, 'Self')
    expect(d[0].lines).toEqual(['mcpServers: none in Self', '− blender'])
  })
  it('keeps same-as-global when both are explicitly empty', () => {
    expect(overlayDiff({ ...BLANK_DRAFT, mcpServers: [] }, { mcpServers: [] })[0].lines).toEqual(['same as global'])
  })
})

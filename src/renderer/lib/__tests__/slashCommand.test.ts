import { describe, it, expect } from 'vitest'
import { matchSlashNav } from '../slashCommand'

describe('matchSlashNav', () => {
  it('matches a known command', () => {
    expect(matchSlashNav('/mcp')).toBe('mcp')
  })

  it('matches case-insensitively', () => {
    expect(matchSlashNav('/MCP')).toBe('mcp')
  })

  it('ignores trailing args', () => {
    expect(matchSlashNav('/agents foo bar')).toBe('subagents')
  })

  it('returns null for plain text with no leading slash', () => {
    expect(matchSlashNav('mcp')).toBeNull()
  })

  it('returns null for an unknown command', () => {
    expect(matchSlashNav('/nonexistent')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(matchSlashNav('')).toBeNull()
  })

  it('returns null for a bare slash with nothing after it', () => {
    expect(matchSlashNav('/')).toBeNull()
  })
})

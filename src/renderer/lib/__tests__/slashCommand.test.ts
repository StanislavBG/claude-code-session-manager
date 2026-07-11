import { describe, it, expect } from 'vitest'
import { matchSlashNav, isUnroutedSlashCommand } from '../slashCommand'

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

describe('isUnroutedSlashCommand', () => {
  it('is true for a slash command with no nav route — forwarded to headless claude -p', () => {
    expect(isUnroutedSlashCommand('/design consent')).toBe(true)
  })

  it('is false for a slash command that matches a nav route (handled locally, never sent)', () => {
    expect(isUnroutedSlashCommand('/mcp')).toBe(false)
  })

  it('is false for plain text with no leading slash', () => {
    expect(isUnroutedSlashCommand('hello there')).toBe(false)
  })

  it('is false for a bare slash with nothing after it', () => {
    expect(isUnroutedSlashCommand('/')).toBe(false)
  })
})

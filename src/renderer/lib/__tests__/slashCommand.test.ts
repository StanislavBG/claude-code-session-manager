import { describe, it, expect } from 'vitest'
import { matchSlashNav, isUnroutedSlashCommand, decideSubmitAction } from '../slashCommand'

describe('matchSlashNav', () => {
  it('matches a known command', () => {
    expect(matchSlashNav('/mcp')).toBe('mcp')
  })

  it('matches case-insensitively', () => {
    expect(matchSlashNav('/MCP')).toBe('mcp')
  })

  it('ignores trailing args', () => {
    expect(matchSlashNav('/mcp foo bar')).toBe('mcp')
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

  it('matches the remaining LeftNav destinations with natural slash names', () => {
    expect(matchSlashNav('/remote')).toBe('remote')
    expect(matchSlashNav('/projects')).toBe('projects')
    expect(matchSlashNav('/voice')).toBe('voice')
    expect(matchSlashNav('/repoviz')).toBe('repoviz')
    expect(matchSlashNav('/repo')).toBe('repoviz')
    expect(matchSlashNav('/search')).toBe('search')
    expect(matchSlashNav('/system')).toBe('system-prompt')
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

// decideSubmitAction is what TerminalChat's submit() actually branches on —
// asserting against it (rather than re-deriving the branch in a test double)
// proves the real submit path treats a matched command as navigation and
// never reaches the send()-to-runner call.
describe('decideSubmitAction', () => {
  it('is nav for a matched slash command — submit() must not call send()', () => {
    expect(decideSubmitAction('/mcp')).toEqual({ type: 'nav', key: 'mcp' })
  })

  it('is warn-unrouted for a slash command with no nav route — still forwarded to send()', () => {
    expect(decideSubmitAction('/design consent')).toEqual({ type: 'warn-unrouted' })
  })

  it('is send for plain text', () => {
    expect(decideSubmitAction('hello there')).toEqual({ type: 'send' })
  })
})

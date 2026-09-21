import { describe, it, expect } from 'vitest'
import { findPlaceholders, distinctPlaceholders, fillPlaceholders } from '../mcpPlaceholders'

describe('findPlaceholders', () => {
  it('returns [] for a config with none', () => {
    expect(findPlaceholders({ command: 'npx', args: ['-y', 'pkg'], env: { A: 'b' } })).toEqual([])
  })

  it('labels a flag value with its flag', () => {
    expect(findPlaceholders({ command: 'uvx', args: ['mcp-server-sqlite', '--db-path', '<path>'] })).toEqual([
      { token: '<path>', label: '--db-path <path>' },
    ])
  })

  it('scans command, env values and url', () => {
    const found = findPlaceholders({ command: '<bin>', env: { KEY: 'x-<secret>' }, url: 'https://<host>/mcp' })
    expect(found.map((p) => p.token)).toEqual(['<bin>', '<secret>', '<host>'])
    expect(found[1].label).toBe('env KEY')
  })

  it('reports repeated tokens per occurrence but distinct once', () => {
    const cfg = { args: ['<p>', '--x', '<p>'] }
    expect(findPlaceholders(cfg)).toHaveLength(2)
    expect(distinctPlaceholders(cfg)).toHaveLength(1)
  })

  it('finds a token inside a longer arg', () => {
    expect(findPlaceholders({ args: ['--dsn=postgres://<connection-string>/db'] })[0].token).toBe('<connection-string>')
  })
})

describe('fillPlaceholders', () => {
  it('returns a new config with tokens replaced everywhere, leaving the input untouched', () => {
    const cfg = { command: 'x', args: ['--db-path', '<path>', '--copy=<path>.bak'], env: { K: '<path>' }, url: 'u/<path>' }
    const out = fillPlaceholders(cfg, { '<path>': '/tmp/x.db' })
    expect(out).toEqual({ command: 'x', args: ['--db-path', '/tmp/x.db', '--copy=/tmp/x.db.bak'], env: { K: '/tmp/x.db' }, url: 'u//tmp/x.db' })
    expect(cfg.args[1]).toBe('<path>')
    expect(out).not.toBe(cfg)
  })

  it('leaves unknown tokens and placeholder-free configs unchanged', () => {
    expect(fillPlaceholders({ args: ['<a>', 'b'] }, { '<z>': 'q' })).toEqual({ args: ['<a>', 'b'] })
  })

  it('does not interpret $ patterns in values', () => {
    expect(fillPlaceholders({ args: ['<a>'] }, { '<a>': "$&$1" }).args).toEqual(['$&$1'])
  })
})

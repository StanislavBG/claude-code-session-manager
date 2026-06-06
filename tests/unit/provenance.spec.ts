/**
 * Provenance classifier characterization tests.
 *
 * classifyProvenance is a best-effort heuristic over the bundled catalog +
 * package/host signatures. These cases pin the behaviour that's easy to break
 * with a regex tweak or a catalog edit:
 *   - the curated catalog `official` flag is authoritative (a third-party server
 *     shipped under an @-scoped package stays Community);
 *   - generic command names do NOT false-positive as Anthropic;
 *   - self-hosted/local items fall through to Local.
 *
 * Source: src/renderer/lib/provenance.ts.
 */
import { describe, it, expect } from 'vitest'
import { classifyProvenance, provenanceKey } from '../../src/renderer/lib/provenance'

const prov = (input: Parameters<typeof classifyProvenance>[0]) => classifyProvenance(input).provenance

describe('classifyProvenance — catalog is authoritative', () => {
  it('official MCP server → anthropic', () => {
    expect(prov({ type: 'mcp', name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] })).toBe('anthropic')
  })

  it('official:false MCP shipped under @modelcontextprotocol stays community (catalog wins over the @-scope)', () => {
    // gitlab is catalog official:false but launches @modelcontextprotocol/server-gitlab.
    expect(prov({ type: 'mcp', name: 'gitlab', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'] })).toBe('community')
  })

  it('community catalog MCP (github via docker) → community', () => {
    expect(prov({ type: 'mcp', name: 'github', command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'] })).toBe('community')
  })

  it('official catalog skill → anthropic; official:false catalog skill → community', () => {
    expect(prov({ type: 'skill', name: 'pdf' })).toBe('anthropic')
    expect(prov({ type: 'skill', name: 'playwright-e2e' })).toBe('community')
  })
})

describe('classifyProvenance — heuristics', () => {
  it('@anthropic-ai package → anthropic', () => {
    expect(prov({ type: 'mcp', name: 'whatever', command: 'npx', args: ['@anthropic-ai/some-server'] })).toBe('anthropic')
  })

  it('anthropics-org repo on a plugin → anthropic', () => {
    expect(prov({ type: 'plugin', name: 'unlisted-plugin', repository: 'https://github.com/anthropics/foo' })).toBe('anthropic')
  })

  it('distinctive built-in command name → anthropic', () => {
    expect(prov({ type: 'command', name: 'security-review' })).toBe('anthropic')
  })

  it('generic command names do NOT false-positive as anthropic', () => {
    for (const name of ['memory', 'config', 'review', 'status', 'context', 'cost']) {
      expect(prov({ type: 'command', name })).toBe('local')
    }
  })

  it('self-hosted local MCP (node ./server.js) → local', () => {
    expect(prov({ type: 'mcp', name: 'my-server', command: 'node', args: ['./server.js'] })).toBe('local')
  })

  it('registry launcher with no anthropic/catalog signal → community', () => {
    expect(prov({ type: 'mcp', name: 'random', command: 'npx', args: ['-y', 'some-random-mcp'] })).toBe('community')
  })

  it('plugin with a homepage but no anthropic signal → community', () => {
    expect(prov({ type: 'plugin', name: 'rando', homepage: 'https://example.com' })).toBe('community')
  })

  it('bare user skill/subagent with no metadata → local', () => {
    expect(prov({ type: 'skill', name: 'my-custom-skill' })).toBe('local')
    expect(prov({ type: 'subagent', name: 'my-helper' })).toBe('local')
  })

  it('catalog subagent → anthropic', () => {
    expect(prov({ type: 'subagent', name: 'code-reviewer' })).toBe('anthropic')
  })
})

describe('provenanceKey', () => {
  it('disambiguates by type so skill and command with the same name+scope do not collide', () => {
    expect(provenanceKey('skill', 'user', 'foo')).not.toBe(provenanceKey('command', 'user', 'foo'))
  })
  it('null scope renders as a stable placeholder', () => {
    expect(provenanceKey('plugin', null, 'x')).toBe('plugin:-:x')
  })
})

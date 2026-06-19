/**
 * Enterprise-auth detection for the scheduler's usage gate.
 *
 * The consumer 5-hour usage meter (/api/oauth/usage) only exists for
 * OAuth/subscription auth against api.anthropic.com. On Bedrock/Vertex/API-key/
 * corporate-gateway machines it 404s/times-out, and the old scheduler would
 * pause on 'network' and never run jobs. usageMeterApplicable() is the gate
 * that lets the scheduler skip the meter and fire on pending+memory instead.
 *
 * Source: src/main/usage.cjs.
 */
import { describe, it, expect } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { usageMeterApplicable } = require('../../src/main/usage.cjs')

describe('usageMeterApplicable', () => {
  it('true for plain consumer OAuth (no special env)', () => {
    expect(usageMeterApplicable({})).toBe(true)
  })

  it('true when base URL is the real Anthropic API', () => {
    expect(usageMeterApplicable({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(true)
  })

  it('false on Amazon Bedrock', () => {
    expect(usageMeterApplicable({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(false)
  })

  it('false on Google Vertex', () => {
    expect(usageMeterApplicable({ CLAUDE_CODE_USE_VERTEX: 'true' })).toBe(false)
  })

  it('false with a raw API key', () => {
    expect(usageMeterApplicable({ ANTHROPIC_API_KEY: 'sk-ant-...' })).toBe(false)
  })

  it('false with a custom auth token', () => {
    expect(usageMeterApplicable({ ANTHROPIC_AUTH_TOKEN: 'tok' })).toBe(false)
  })

  it('false behind a non-Anthropic gateway base URL', () => {
    expect(usageMeterApplicable({ ANTHROPIC_BASE_URL: 'https://llm-proxy.blackrock.com/v1' })).toBe(false)
  })

  it('false for a deceptive host that only contains anthropic.com', () => {
    expect(usageMeterApplicable({ ANTHROPIC_BASE_URL: 'https://anthropic.com.attacker.example/v1' })).toBe(false)
  })

  it('true for a legitimate anthropic.com subdomain', () => {
    expect(usageMeterApplicable({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' })).toBe(true)
  })

  it('false for an unparseable base URL', () => {
    expect(usageMeterApplicable({ ANTHROPIC_BASE_URL: 'not a url' })).toBe(false)
  })

  it('treats falsey env strings as not-enabled (still consumer)', () => {
    expect(usageMeterApplicable({ CLAUDE_CODE_USE_BEDROCK: '0' })).toBe(true)
    expect(usageMeterApplicable({ CLAUDE_CODE_USE_VERTEX: 'false' })).toBe(true)
  })
})

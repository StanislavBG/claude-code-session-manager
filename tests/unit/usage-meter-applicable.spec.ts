/**
 * Enterprise-auth detection for the scheduler's usage gate.
 *
 * The consumer 5-hour usage meter (/api/oauth/usage) only exists for
 * OAuth/subscription auth against api.anthropic.com. On Bedrock/Vertex/API-key/
 * corporate-gateway machines it 404s/times-out (or 401s with no credentials
 * file), and the scheduler would pause on 'auth'/'network' and never run jobs.
 * usageMeterApplicable() is the gate that lets the scheduler skip the meter and
 * fire on pending+memory instead.
 *
 * Signals come from BOTH process.env and Claude Code's settings files (the
 * `env` block + `apiKeyHelper`) — the latter is how corporate gateways are
 * usually configured, and on macOS a GUI app doesn't inherit shell env, so the
 * settings path is the one that actually fires for those users.
 *
 * Source: src/main/usage.cjs.
 */
import { describe, it, expect } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { usageMeterApplicable } = require('../../src/main/usage.cjs')

// Explicit empty settings keeps these hermetic — without it the default reads
// the real ~/.claude/settings.json on the test machine.
const NO_SETTINGS = { env: {}, apiKeyHelper: false }
const meter = (env: Record<string, string>, settings = NO_SETTINGS) =>
  usageMeterApplicable(env, settings)

describe('usageMeterApplicable — env signals', () => {
  it('true for plain consumer OAuth (no special env)', () => {
    expect(meter({})).toBe(true)
  })

  it('true when base URL is the real Anthropic API', () => {
    expect(meter({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(true)
  })

  it('false on Amazon Bedrock', () => {
    expect(meter({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(false)
  })

  it('false on Google Vertex', () => {
    expect(meter({ CLAUDE_CODE_USE_VERTEX: 'true' })).toBe(false)
  })

  it('false with a raw API key', () => {
    expect(meter({ ANTHROPIC_API_KEY: 'sk-ant-...' })).toBe(false)
  })

  it('false with a custom auth token', () => {
    expect(meter({ ANTHROPIC_AUTH_TOKEN: 'tok' })).toBe(false)
  })

  it('false behind a non-Anthropic gateway base URL', () => {
    expect(meter({ ANTHROPIC_BASE_URL: 'https://llm-proxy.blackrock.com/v1' })).toBe(false)
  })

  it('false for a deceptive host that only contains anthropic.com', () => {
    expect(meter({ ANTHROPIC_BASE_URL: 'https://anthropic.com.attacker.example/v1' })).toBe(false)
  })

  it('true for a legitimate anthropic.com subdomain', () => {
    expect(meter({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' })).toBe(true)
  })

  it('false for an unparseable base URL', () => {
    expect(meter({ ANTHROPIC_BASE_URL: 'not a url' })).toBe(false)
  })

  it('treats falsey env strings as not-enabled (still consumer)', () => {
    expect(meter({ CLAUDE_CODE_USE_BEDROCK: '0' })).toBe(true)
    expect(meter({ CLAUDE_CODE_USE_VERTEX: 'false' })).toBe(true)
  })
})

describe('usageMeterApplicable — settings.json signals (gateway not in process.env)', () => {
  it('false when settings.json env declares a gateway base URL', () => {
    expect(
      meter({}, { env: { ANTHROPIC_BASE_URL: 'https://gw.corp.example/v1' }, apiKeyHelper: false }),
    ).toBe(false)
  })

  it('false when settings.json env sets an API key', () => {
    expect(meter({}, { env: { ANTHROPIC_API_KEY: 'sk-...' }, apiKeyHelper: false })).toBe(false)
  })

  it('false when settings.json declares an apiKeyHelper', () => {
    expect(meter({}, { env: {}, apiKeyHelper: true })).toBe(false)
  })

  it('false when settings.json enables Bedrock', () => {
    expect(meter({}, { env: { CLAUDE_CODE_USE_BEDROCK: '1' }, apiKeyHelper: false })).toBe(false)
  })

  it('still true when settings.json env is innocuous', () => {
    expect(meter({}, { env: { SOME_OTHER: 'x' }, apiKeyHelper: false })).toBe(true)
  })

  it('process.env overrides settings for the same key (real anthropic wins)', () => {
    // settings says gateway, but the live process explicitly points at anthropic.
    expect(
      meter(
        { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
        { env: { ANTHROPIC_BASE_URL: 'https://gw.corp.example/v1' }, apiKeyHelper: false },
      ),
    ).toBe(true)
  })
})

/**
 * Cross-platform credential resolution.
 *
 * macOS has no ~/.claude/.credentials.json — Claude Code keeps the OAuth blob
 * in the login Keychain. Before this, readCredentials() only read the file, so
 * on a Mac every usage poll failed ("credentials file not found"), wedging the
 * scheduler (observed: 4045 consecutive failures). These specs lock in the
 * blob-parsing contract shared by the file and Keychain code paths.
 *
 * Source: src/main/lib/credentials.cjs.
 */
import { describe, it, expect } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const creds = require('../../src/main/lib/credentials.cjs')

const VALID = JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-abc', refreshToken: 'rt-xyz', expiresAt: Date.now() + 3_600_000 },
})

describe('parseCredsRaw — shared by file + Keychain paths', () => {
  it('accepts a valid blob and tags its source', () => {
    const r = creds.parseCredsRaw(VALID, 'keychain')
    expect(r.kind).toBe('ok')
    expect(r.creds.accessToken).toBe('sk-abc')
    expect(r.source).toBe('keychain')
  })

  it('file source is tagged distinctly (drives write-back routing)', () => {
    expect(creds.parseCredsRaw(VALID, 'file').source).toBe('file')
  })

  it('rejects malformed JSON with the source named in the message', () => {
    const r = creds.parseCredsRaw('{not json', 'keychain')
    expect(r.kind).toBe('config')
    expect(r.message).toMatch(/keychain/)
  })

  it('rejects a blob missing accessToken', () => {
    const r = creds.parseCredsRaw(JSON.stringify({ claudeAiOauth: {} }), 'file')
    expect(r.kind).toBe('config')
    expect(r.message).toMatch(/accessToken/)
  })

  it('exposes the macOS Keychain service name used by `security`', () => {
    expect(creds.KEYCHAIN_SERVICE).toBe('Claude Code-credentials')
  })
})

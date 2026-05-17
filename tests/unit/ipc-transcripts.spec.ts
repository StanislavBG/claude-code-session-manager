import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
}

// SESSION_UUID_RE = /^[a-zA-Z0-9-]{1,64}$/

// ──────────────────────────────────────────── transcripts:subscribe
describe('transcriptSubscribe schema', () => {
  it('accepts valid subscribe payload', () => {
    expect(schemas.transcriptSubscribe.safeParse({
      tabId: 'tab-abc', cwd: '/home/user/project', sessionUuid: 'abc-123-DEF',
    }).success).toBe(true)
  })

  it('rejects sessionUuid with special chars', () => {
    expect(schemas.transcriptSubscribe.safeParse({
      tabId: 'tab-1', cwd: '/home/user', sessionUuid: 'uuid with spaces',
    }).success).toBe(false)
  })

  it('rejects sessionUuid exceeding 64 chars', () => {
    expect(schemas.transcriptSubscribe.safeParse({
      tabId: 'tab-1', cwd: '/home/user', sessionUuid: 'a'.repeat(65),
    }).success).toBe(false)
  })

  it('rejects empty sessionUuid', () => {
    expect(schemas.transcriptSubscribe.safeParse({
      tabId: 'tab-1', cwd: '/home/user', sessionUuid: '',
    }).success).toBe(false)
  })

  it('rejects missing sessionUuid', () => {
    expect(schemas.transcriptSubscribe.safeParse({ tabId: 'tab-1', cwd: '/home/user' }).success).toBe(false)
  })

  it('rejects empty tabId', () => {
    expect(schemas.transcriptSubscribe.safeParse({
      tabId: '', cwd: '/home/user', sessionUuid: 'abc',
    }).success).toBe(false)
  })

  it('rejects tabId exceeding 128 chars', () => {
    expect(schemas.transcriptSubscribe.safeParse({
      tabId: 'a'.repeat(129), cwd: '/home/user', sessionUuid: 'abc',
    }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── transcripts:unsubscribe / transcripts:buffer
describe('transcriptTabId schema', () => {
  it('accepts valid tabId', () => {
    expect(schemas.transcriptTabId.safeParse({ tabId: 'my-tab-123' }).success).toBe(true)
  })

  it('rejects empty tabId', () => {
    expect(schemas.transcriptTabId.safeParse({ tabId: '' }).success).toBe(false)
  })

  it('rejects tabId exceeding 128 chars', () => {
    expect(schemas.transcriptTabId.safeParse({ tabId: 'a'.repeat(129) }).success).toBe(false)
  })

  it('rejects missing tabId', () => {
    expect(schemas.transcriptTabId.safeParse({}).success).toBe(false)
  })
})

// ──────────────────────────────────────────── transcripts:path-for
describe('transcriptPath schema', () => {
  it('accepts valid cwd + sessionUuid', () => {
    expect(schemas.transcriptPath.safeParse({
      cwd: '/home/user/project', sessionUuid: 'abc-123',
    }).success).toBe(true)
  })

  it('rejects sessionUuid with slash', () => {
    expect(schemas.transcriptPath.safeParse({
      cwd: '/home/user', sessionUuid: 'abc/123',
    }).success).toBe(false)
  })

  it('rejects cwd exceeding 4096 chars', () => {
    expect(schemas.transcriptPath.safeParse({
      cwd: '/' + 'a'.repeat(4096), sessionUuid: 'abc',
    }).success).toBe(false)
  })

  it('rejects missing cwd', () => {
    expect(schemas.transcriptPath.safeParse({ sessionUuid: 'abc' }).success).toBe(false)
  })

  it('rejects missing sessionUuid', () => {
    expect(schemas.transcriptPath.safeParse({ cwd: '/home/user' }).success).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
}

// ──────────────────────────────────────────── sessions:save
// sessionsPayload: { tabs: PersistedTab[], activeTabId: string | null }

describe('sessionsPayload schema', () => {
  it('accepts empty tabs with null activeTabId', () => {
    expect(schemas.sessionsPayload.safeParse({ tabs: [], activeTabId: null }).success).toBe(true)
  })

  it('accepts a single valid tab', () => {
    expect(schemas.sessionsPayload.safeParse({
      tabs: [{
        id: 'tab-1',
        sessionId: 'session-abc',
        cwd: '/home/user/project',
        label: 'My Tab',
        presetId: null,
      }],
      activeTabId: 'tab-1',
    }).success).toBe(true)
  })

  it('accepts multiple tabs', () => {
    const tabs = [
      { id: 'tab-1', sessionId: 'sess-1', cwd: '/home/user/a', label: 'A', presetId: null },
      { id: 'tab-2', sessionId: 'sess-2', cwd: '/home/user/b', label: 'B', presetId: 'preset-x' },
    ]
    expect(schemas.sessionsPayload.safeParse({ tabs, activeTabId: 'tab-1' }).success).toBe(true)
  })

  it('accepts tab with non-null presetId', () => {
    expect(schemas.sessionsPayload.safeParse({
      tabs: [{ id: 'tab-1', sessionId: 'sess-1', cwd: '/home/user', label: 'A', presetId: 'my-preset' }],
      activeTabId: null,
    }).success).toBe(true)
  })

  it('rejects tab with id exceeding 128 chars', () => {
    expect(schemas.sessionsPayload.safeParse({
      tabs: [{ id: 'a'.repeat(129), sessionId: 'sess-1', cwd: '/home/user', label: 'A', presetId: null }],
      activeTabId: null,
    }).success).toBe(false)
  })

  it('rejects tab with empty id', () => {
    expect(schemas.sessionsPayload.safeParse({
      tabs: [{ id: '', sessionId: 'sess-1', cwd: '/home/user', label: 'A', presetId: null }],
      activeTabId: null,
    }).success).toBe(false)
  })

  it('rejects tab with label exceeding 256 chars', () => {
    expect(schemas.sessionsPayload.safeParse({
      tabs: [{ id: 'tab-1', sessionId: 'sess-1', cwd: '/home/user', label: 'x'.repeat(257), presetId: null }],
      activeTabId: null,
    }).success).toBe(false)
  })

  it('rejects tab with cwd exceeding 4096 chars', () => {
    expect(schemas.sessionsPayload.safeParse({
      tabs: [{ id: 'tab-1', sessionId: 'sess-1', cwd: '/home/' + 'a'.repeat(4091), label: 'A', presetId: null }],
      activeTabId: null,
    }).success).toBe(false)
  })

  it('rejects missing tabs field', () => {
    expect(schemas.sessionsPayload.safeParse({ activeTabId: null }).success).toBe(false)
  })

  it('rejects missing activeTabId field', () => {
    expect(schemas.sessionsPayload.safeParse({ tabs: [] }).success).toBe(false)
  })

  it('rejects non-null non-string activeTabId', () => {
    expect(schemas.sessionsPayload.safeParse({ tabs: [], activeTabId: 42 }).success).toBe(false)
  })
})

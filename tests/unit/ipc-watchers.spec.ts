import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)
const { schemas } = requireCjs('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
}

// ──────────────────────────────────────────── watchers:add
// Runs `spawn(command, { shell: true })` per CLAUDE.md. The command string is
// the injection surface — anything past the 8 KiB cap or with NUL bytes (zod
// already rejects multi-byte invalid utf-8) is refused before reaching spawn.

describe('watchersAdd schema', () => {
  it('accepts minimal valid payload', () => {
    expect(schemas.watchersAdd.safeParse({
      tabId: 'tab-1',
      command: 'ls -la',
    }).success).toBe(true)
  })

  it('accepts full payload with label + cwd', () => {
    expect(schemas.watchersAdd.safeParse({
      tabId: 'tab-1',
      label: 'list files',
      command: 'ls -la',
      cwd: '/home/user/project',
    }).success).toBe(true)
  })

  it('accepts null cwd (optional + nullable)', () => {
    expect(schemas.watchersAdd.safeParse({
      tabId: 'tab-1',
      command: 'ls',
      cwd: null,
    }).success).toBe(true)
  })

  it('accepts command at max length (8 KiB)', () => {
    expect(schemas.watchersAdd.safeParse({
      tabId: 'tab-1',
      command: 'x'.repeat(8192),
    }).success).toBe(true)
  })

  it('rejects command exceeding 8 KiB (above injection-surface cap)', () => {
    expect(schemas.watchersAdd.safeParse({
      tabId: 'tab-1',
      command: 'x'.repeat(8193),
    }).success).toBe(false)
  })

  it('rejects empty command (avoids spawn-empty crash)', () => {
    expect(schemas.watchersAdd.safeParse({
      tabId: 'tab-1',
      command: '',
    }).success).toBe(false)
  })

  it('rejects empty tabId', () => {
    expect(schemas.watchersAdd.safeParse({
      tabId: '',
      command: 'ls',
    }).success).toBe(false)
  })

  it('rejects missing tabId', () => {
    expect(schemas.watchersAdd.safeParse({ command: 'ls' }).success).toBe(false)
  })

  it('rejects missing command', () => {
    expect(schemas.watchersAdd.safeParse({ tabId: 'tab-1' }).success).toBe(false)
  })

  it('rejects label exceeding 256 chars', () => {
    expect(schemas.watchersAdd.safeParse({
      tabId: 'tab-1',
      label: 'x'.repeat(257),
      command: 'ls',
    }).success).toBe(false)
  })

  it('rejects cwd exceeding 4096 chars', () => {
    expect(schemas.watchersAdd.safeParse({
      tabId: 'tab-1',
      command: 'ls',
      cwd: '/'.repeat(4097),
    }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── watchers:list
describe('watchersList schema', () => {
  it('accepts valid tabId', () => {
    expect(schemas.watchersList.safeParse({ tabId: 'tab-1' }).success).toBe(true)
  })

  it('rejects empty tabId', () => {
    expect(schemas.watchersList.safeParse({ tabId: '' }).success).toBe(false)
  })

  it('rejects missing tabId', () => {
    expect(schemas.watchersList.safeParse({}).success).toBe(false)
  })
})

// ──────────────────────────────────────────── watchers:remove
describe('watchersRemove schema', () => {
  it('accepts valid watcherId', () => {
    expect(schemas.watchersRemove.safeParse({ watcherId: 'w-abc-123' }).success).toBe(true)
  })

  it('rejects empty watcherId', () => {
    expect(schemas.watchersRemove.safeParse({ watcherId: '' }).success).toBe(false)
  })

  it('rejects watcherId exceeding 128 chars', () => {
    expect(schemas.watchersRemove.safeParse({ watcherId: 'x'.repeat(129) }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── watchers:kill-tab
describe('watchersKillTab schema', () => {
  it('accepts valid tabId', () => {
    expect(schemas.watchersKillTab.safeParse({ tabId: 'tab-1' }).success).toBe(true)
  })

  it('rejects empty tabId', () => {
    expect(schemas.watchersKillTab.safeParse({ tabId: '' }).success).toBe(false)
  })
})

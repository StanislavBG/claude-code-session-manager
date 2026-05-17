import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
}

// ──────────────────────────────────────────── pty:spawn
describe('ptySpawn schema', () => {
  it('accepts minimal valid payload', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab-1', cwd: '/home/user' }).success).toBe(true)
  })

  it('accepts with cols and rows', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab-1', cwd: '/home/user', cols: 80, rows: 24 }).success).toBe(true)
  })

  it('accepts with startupCommand', () => {
    expect(schemas.ptySpawn.safeParse({
      tabId: 'tab-1', cwd: '/home/user', startupCommand: 'claude --session-id abc',
    }).success).toBe(true)
  })

  it('rejects cols below 10', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab-1', cwd: '/home/user', cols: 9 }).success).toBe(false)
  })

  it('rejects cols above 1000', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab-1', cwd: '/home/user', cols: 1001 }).success).toBe(false)
  })

  it('rejects rows below 3', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab-1', cwd: '/home/user', rows: 2 }).success).toBe(false)
  })

  it('rejects rows above 1000', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab-1', cwd: '/home/user', rows: 1001 }).success).toBe(false)
  })

  it('rejects tabId exceeding 128 chars', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'a'.repeat(129), cwd: '/home/user' }).success).toBe(false)
  })

  it('rejects empty tabId', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: '', cwd: '/home/user' }).success).toBe(false)
  })

  it('rejects cwd exceeding 4096 chars', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab-1', cwd: '/' + 'a'.repeat(4096) }).success).toBe(false)
  })

  it('rejects missing tabId', () => {
    expect(schemas.ptySpawn.safeParse({ cwd: '/home/user' }).success).toBe(false)
  })

  it('rejects missing cwd', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab-1' }).success).toBe(false)
  })

  it('rejects startupCommand exceeding 8192 chars', () => {
    expect(schemas.ptySpawn.safeParse({
      tabId: 'tab-1', cwd: '/home/user', startupCommand: 'x'.repeat(8193),
    }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── pty:write
// 64 KiB cap guards against renderer bugs or attacks sending megabytes per call.
describe('ptyWrite schema', () => {
  it('accepts valid tabId + data', () => {
    expect(schemas.ptyWrite.safeParse({ tabId: 'tab-1', data: 'ls\n' }).success).toBe(true)
  })

  it('accepts empty data (valid — terminal may handle noop)', () => {
    expect(schemas.ptyWrite.safeParse({ tabId: 'tab-1', data: '' }).success).toBe(true)
  })

  it('accepts data at exactly 64 KiB', () => {
    const data = 'x'.repeat(64 * 1024)
    expect(schemas.ptyWrite.safeParse({ tabId: 'tab-1', data }).success).toBe(true)
  })

  it('rejects data exceeding 64 KiB', () => {
    const data = 'x'.repeat(64 * 1024 + 1)
    expect(schemas.ptyWrite.safeParse({ tabId: 'tab-1', data }).success).toBe(false)
  })

  it('rejects missing tabId', () => {
    expect(schemas.ptyWrite.safeParse({ data: 'hi' }).success).toBe(false)
  })

  it('rejects missing data', () => {
    expect(schemas.ptyWrite.safeParse({ tabId: 'tab-1' }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── pty:resize
describe('ptyResize schema', () => {
  it('accepts valid resize payload', () => {
    expect(schemas.ptyResize.safeParse({ tabId: 'tab-1', cols: 120, rows: 40 }).success).toBe(true)
  })

  it('rejects cols below 10', () => {
    expect(schemas.ptyResize.safeParse({ tabId: 'tab-1', cols: 9, rows: 24 }).success).toBe(false)
  })

  it('rejects cols above 1000', () => {
    expect(schemas.ptyResize.safeParse({ tabId: 'tab-1', cols: 1001, rows: 24 }).success).toBe(false)
  })

  it('rejects rows below 3', () => {
    expect(schemas.ptyResize.safeParse({ tabId: 'tab-1', cols: 80, rows: 2 }).success).toBe(false)
  })

  it('rejects non-integer cols', () => {
    expect(schemas.ptyResize.safeParse({ tabId: 'tab-1', cols: 80.5, rows: 24 }).success).toBe(false)
  })

  it('rejects missing cols', () => {
    expect(schemas.ptyResize.safeParse({ tabId: 'tab-1', rows: 24 }).success).toBe(false)
  })

  it('rejects missing rows', () => {
    expect(schemas.ptyResize.safeParse({ tabId: 'tab-1', cols: 80 }).success).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
}

// ──────────────────────────────────────────── config:write-json
describe('configWriteJson schema', () => {
  it('accepts valid path + any object data', () => {
    expect(schemas.configWriteJson.safeParse({ path: '/home/user/foo.json', data: { key: 'val' } }).success).toBe(true)
  })

  it('accepts null as data (z.unknown() allows it)', () => {
    expect(schemas.configWriteJson.safeParse({ path: '/home/user/foo.json', data: null }).success).toBe(true)
  })

  it('accepts array as data', () => {
    expect(schemas.configWriteJson.safeParse({ path: '/home/user/foo.json', data: [1, 2, 3] }).success).toBe(true)
  })

  it('accepts string as data', () => {
    expect(schemas.configWriteJson.safeParse({ path: '/home/user/foo.json', data: 'hello' }).success).toBe(true)
  })

  it('accepts path at max length (4096)', () => {
    const p = '/home/' + 'a'.repeat(4090)
    expect(schemas.configWriteJson.safeParse({ path: p, data: {} }).success).toBe(true)
  })

  it('rejects path exceeding 4096 chars', () => {
    const p = '/home/' + 'a'.repeat(4091)
    expect(schemas.configWriteJson.safeParse({ path: p, data: {} }).success).toBe(false)
  })

  it('rejects empty path', () => {
    expect(schemas.configWriteJson.safeParse({ path: '', data: {} }).success).toBe(false)
  })

  it('rejects missing path', () => {
    expect(schemas.configWriteJson.safeParse({ data: {} }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── config:write-text
describe('configWriteText schema', () => {
  it('accepts valid path + text', () => {
    expect(schemas.configWriteText.safeParse({ path: '/home/user/foo.txt', text: 'hello' }).success).toBe(true)
  })

  it('accepts empty text (valid empty write)', () => {
    expect(schemas.configWriteText.safeParse({ path: '/home/user/foo.txt', text: '' }).success).toBe(true)
  })

  it('accepts text with newlines and unicode', () => {
    expect(schemas.configWriteText.safeParse({ path: '/home/user/foo.txt', text: 'line1\nline2\n🚀' }).success).toBe(true)
  })

  it('rejects empty path', () => {
    expect(schemas.configWriteText.safeParse({ path: '', text: 'hi' }).success).toBe(false)
  })

  it('rejects path exceeding 4096 chars', () => {
    const p = '/' + 'a'.repeat(4096)
    expect(schemas.configWriteText.safeParse({ path: p, text: 'hi' }).success).toBe(false)
  })

  it('rejects missing text field', () => {
    expect(schemas.configWriteText.safeParse({ path: '/home/user/foo.txt' }).success).toBe(false)
  })

  it('rejects missing path field', () => {
    expect(schemas.configWriteText.safeParse({ text: 'hi' }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── config:list-dir
describe('configListDir schema', () => {
  it('accepts path only (no opts)', () => {
    expect(schemas.configListDir.safeParse({ path: '/home/user' }).success).toBe(true)
  })

  it('accepts path with filesOnly opt', () => {
    expect(schemas.configListDir.safeParse({ path: '/home/user', opts: { filesOnly: true } }).success).toBe(true)
  })

  it('accepts path with dirsOnly opt', () => {
    expect(schemas.configListDir.safeParse({ path: '/home/user', opts: { dirsOnly: true } }).success).toBe(true)
  })

  it('accepts path with includeHidden opt', () => {
    expect(schemas.configListDir.safeParse({ path: '/home/user', opts: { includeHidden: true } }).success).toBe(true)
  })

  it('accepts all opts together', () => {
    expect(schemas.configListDir.safeParse({ path: '/home/user', opts: { filesOnly: true, includeHidden: true } }).success).toBe(true)
  })

  it('rejects empty path', () => {
    expect(schemas.configListDir.safeParse({ path: '' }).success).toBe(false)
  })

  it('rejects path exceeding 4096 chars', () => {
    const p = '/' + 'a'.repeat(4096)
    expect(schemas.configListDir.safeParse({ path: p }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── config:read-json / config:read-text / config:exists
describe('configPath schema (read-json / read-text / exists)', () => {
  it('accepts valid absolute path', () => {
    expect(schemas.configPath.safeParse({ path: '/home/user/.claude/settings.json' }).success).toBe(true)
  })

  it('accepts path at max length', () => {
    const p = '/home/' + 'a'.repeat(4090)
    expect(schemas.configPath.safeParse({ path: p }).success).toBe(true)
  })

  it('rejects empty path', () => {
    expect(schemas.configPath.safeParse({ path: '' }).success).toBe(false)
  })

  it('rejects path exceeding 4096 chars', () => {
    const p = '/home/' + 'a'.repeat(4091)
    expect(schemas.configPath.safeParse({ path: p }).success).toBe(false)
  })

  it('rejects missing path field', () => {
    expect(schemas.configPath.safeParse({}).success).toBe(false)
  })
})

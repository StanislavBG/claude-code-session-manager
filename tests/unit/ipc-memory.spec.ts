import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } }>
}

// ──────────────────────────────────────────── memory:list
describe('memoryList schema', () => {
  it('accepts empty object (default workspace)', () => {
    expect(schemas.memoryList.safeParse({}).success).toBe(true)
  })

  it('accepts valid alphanumeric workspace', () => {
    expect(schemas.memoryList.safeParse({ workspace: 'myproject' }).success).toBe(true)
  })

  it('accepts workspace with hyphens and underscores', () => {
    expect(schemas.memoryList.safeParse({ workspace: 'my-project_2' }).success).toBe(true)
  })

  it('accepts workspace at max length (256 chars)', () => {
    const ws = 'a'.repeat(256)
    expect(schemas.memoryList.safeParse({ workspace: ws }).success).toBe(true)
  })

  it('rejects workspace exceeding 256 chars', () => {
    const ws = 'a'.repeat(257)
    expect(schemas.memoryList.safeParse({ workspace: ws }).success).toBe(false)
  })

  it('rejects workspace with path-traversal dots', () => {
    expect(schemas.memoryList.safeParse({ workspace: '../etc' }).success).toBe(false)
  })

  it('rejects workspace with slash (could escape directory)', () => {
    expect(schemas.memoryList.safeParse({ workspace: 'foo/bar' }).success).toBe(false)
  })

  it('rejects workspace with NUL character', () => {
    expect(schemas.memoryList.safeParse({ workspace: 'foo\0bar' }).success).toBe(false)
  })

  it('rejects extra keys (strict schema)', () => {
    expect(schemas.memoryList.safeParse({ workspace: 'ok', extra: 'x' }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── memory:read
describe('memoryRead schema', () => {
  it('accepts valid name.md with no workspace', () => {
    expect(schemas.memoryRead.safeParse({ name: 'foo.md' }).success).toBe(true)
  })

  it('accepts valid name.md with workspace', () => {
    expect(schemas.memoryRead.safeParse({ name: 'my-memory.md', workspace: 'proj' }).success).toBe(true)
  })

  it('accepts slugs with numbers and underscores', () => {
    expect(schemas.memoryRead.safeParse({ name: 'user_role_01.md' }).success).toBe(true)
  })

  it('rejects name without .md extension', () => {
    expect(schemas.memoryRead.safeParse({ name: 'foo.txt' }).success).toBe(false)
  })

  it('rejects path-traversal slug', () => {
    expect(schemas.memoryRead.safeParse({ name: '../etc/passwd.md' }).success).toBe(false)
  })

  it('rejects absolute path slug', () => {
    expect(schemas.memoryRead.safeParse({ name: '/etc/passwd.md' }).success).toBe(false)
  })

  it('rejects uppercase in slug', () => {
    // MEMORY_SLUG_RE = /^[a-z0-9-_]+\.md$/ — uppercase not allowed
    expect(schemas.memoryRead.safeParse({ name: 'MyMemory.md' }).success).toBe(false)
  })

  it('rejects empty name', () => {
    expect(schemas.memoryRead.safeParse({ name: '' }).success).toBe(false)
  })

  it('rejects name with NUL', () => {
    expect(schemas.memoryRead.safeParse({ name: 'foo\0.md' }).success).toBe(false)
  })

  it('rejects extra keys (strict schema)', () => {
    expect(schemas.memoryRead.safeParse({ name: 'foo.md', extra: true }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── memory:write
describe('memoryWrite schema', () => {
  it('accepts valid name + content', () => {
    expect(schemas.memoryWrite.safeParse({ name: 'note.md', content: '# hello' }).success).toBe(true)
  })

  it('accepts content at exactly 1 MiB', () => {
    const content = 'x'.repeat(1024 * 1024)
    expect(schemas.memoryWrite.safeParse({ name: 'big.md', content }).success).toBe(true)
  })

  it('rejects content exceeding 1 MiB', () => {
    // max is string.max(MEMORY_MAX_BYTES) = 1048576 chars
    const content = 'x'.repeat(1024 * 1024 + 1)
    expect(schemas.memoryWrite.safeParse({ name: 'big.md', content }).success).toBe(false)
  })

  it('accepts empty content (valid empty write)', () => {
    expect(schemas.memoryWrite.safeParse({ name: 'empty.md', content: '' }).success).toBe(true)
  })

  it('rejects path-traversal slug', () => {
    expect(schemas.memoryWrite.safeParse({ name: '../../etc/passwd.md', content: 'x' }).success).toBe(false)
  })

  it('accepts optional workspace', () => {
    expect(schemas.memoryWrite.safeParse({ name: 'note.md', content: 'hi', workspace: 'ws1' }).success).toBe(true)
  })

  it('rejects extra keys (strict schema)', () => {
    expect(schemas.memoryWrite.safeParse({ name: 'note.md', content: 'hi', bogus: 1 }).success).toBe(false)
  })

  it('rejects missing content field', () => {
    expect(schemas.memoryWrite.safeParse({ name: 'note.md' }).success).toBe(false)
  })

  it('rejects missing name field', () => {
    expect(schemas.memoryWrite.safeParse({ content: 'hi' }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── memory:delete
describe('memoryDelete schema', () => {
  it('accepts valid slug', () => {
    expect(schemas.memoryDelete.safeParse({ name: 'to-delete.md' }).success).toBe(true)
  })

  it('accepts with optional workspace', () => {
    expect(schemas.memoryDelete.safeParse({ name: 'entry.md', workspace: 'ws' }).success).toBe(true)
  })

  it('rejects path-traversal in name', () => {
    expect(schemas.memoryDelete.safeParse({ name: '../secret.md' }).success).toBe(false)
  })

  it('rejects non-.md extension', () => {
    expect(schemas.memoryDelete.safeParse({ name: 'entry.json' }).success).toBe(false)
  })

  it('rejects extra keys (strict schema)', () => {
    expect(schemas.memoryDelete.safeParse({ name: 'ok.md', extra: true }).success).toBe(false)
  })

  it('rejects empty name', () => {
    expect(schemas.memoryDelete.safeParse({ name: '' }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── memory:create
describe('memoryCreate schema', () => {
  it('accepts name only', () => {
    expect(schemas.memoryCreate.safeParse({ name: 'new-entry.md' }).success).toBe(true)
  })

  it('accepts name + description', () => {
    expect(schemas.memoryCreate.safeParse({ name: 'new.md', description: 'A short description' }).success).toBe(true)
  })

  it('accepts name + description + workspace', () => {
    expect(schemas.memoryCreate.safeParse({ name: 'new.md', description: 'desc', workspace: 'ws' }).success).toBe(true)
  })

  it('rejects description exceeding 2048 chars', () => {
    const description = 'x'.repeat(2049)
    expect(schemas.memoryCreate.safeParse({ name: 'new.md', description }).success).toBe(false)
  })

  it('accepts description at exactly 2048 chars', () => {
    const description = 'x'.repeat(2048)
    expect(schemas.memoryCreate.safeParse({ name: 'new.md', description }).success).toBe(true)
  })

  it('rejects path-traversal in name', () => {
    expect(schemas.memoryCreate.safeParse({ name: '../../evil.md' }).success).toBe(false)
  })

  it('rejects non-.md extension', () => {
    expect(schemas.memoryCreate.safeParse({ name: 'new.yaml' }).success).toBe(false)
  })

  it('rejects extra keys (strict schema)', () => {
    expect(schemas.memoryCreate.safeParse({ name: 'new.md', extra: 1 }).success).toBe(false)
  })

  it('rejects missing name', () => {
    expect(schemas.memoryCreate.safeParse({ description: 'desc' }).success).toBe(false)
  })
})

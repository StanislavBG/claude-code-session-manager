import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
}

// ──────────────────────────────────────────── plugins:install
// SLUG_RE = /^[a-z0-9\-/]+$/, max 128 chars.
// Shell injection is blocked by passing argv array (no shell:true) — the schema
// also rejects anything outside [a-z0-9\-/], giving defense in depth.

describe('pluginsInstall schema', () => {
  it('accepts a simple slug', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: 'my-plugin' }).success).toBe(true)
  })

  it('accepts owner/name format (slash allowed)', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: 'anthropic/claude-plugin' }).success).toBe(true)
  })

  it('accepts slug with numbers', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: 'plugin-v2' }).success).toBe(true)
  })

  it('accepts slug at max length (128 chars)', () => {
    const slug = 'a'.repeat(128)
    expect(schemas.pluginsInstall.safeParse({ slug }).success).toBe(true)
  })

  it('rejects slug exceeding 128 chars', () => {
    const slug = 'a'.repeat(129)
    expect(schemas.pluginsInstall.safeParse({ slug }).success).toBe(false)
  })

  it('rejects uppercase letters (would bypass SLUG_RE)', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: 'MyPlugin' }).success).toBe(false)
  })

  it('rejects shell-injection attempt with semicolon', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: 'plugin; rm -rf /' }).success).toBe(false)
  })

  it('rejects shell-injection attempt with backtick', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: 'plugin`whoami`' }).success).toBe(false)
  })

  it('rejects slug with spaces', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: 'my plugin' }).success).toBe(false)
  })

  it('rejects slug with double-dot path traversal', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: '../evil' }).success).toBe(false)
  })

  it('rejects empty slug', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: '' }).success).toBe(false)
  })

  it('rejects missing slug field', () => {
    expect(schemas.pluginsInstall.safeParse({}).success).toBe(false)
  })

  it('rejects slug with dollar sign (env var expansion attempt)', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: '$HOME' }).success).toBe(false)
  })

  it('rejects slug with null byte', () => {
    expect(schemas.pluginsInstall.safeParse({ slug: 'plugin\0evil' }).success).toBe(false)
  })
})

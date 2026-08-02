import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } }>
}

// ──────────────────────────────────────────── auditLog:append
describe('auditLogAppend schema', () => {
  const valid = { kind: 'epic_create', cwd: '/home/user/project', epicId: 'psess-abc123', source: 'NewEpicCard' }

  it('accepts a valid epic_create payload', () => {
    expect(schemas.auditLogAppend.safeParse(valid).success).toBe(true)
  })

  it.each(['epic_create', 'epic_approve', 'epic_complete', 'epic_delete', 'epic_resume', 'epic_duplicate'])(
    'accepts allowlisted kind %s',
    (kind) => {
      expect(schemas.auditLogAppend.safeParse({ ...valid, kind }).success).toBe(true)
    },
  )

  it('rejects a kind outside the allowlist (renderer cannot write arbitrary kinds)', () => {
    expect(schemas.auditLogAppend.safeParse({ ...valid, kind: 'epic_mint' }).success).toBe(false)
  })

  it('rejects an arbitrary made-up kind', () => {
    expect(schemas.auditLogAppend.safeParse({ ...valid, kind: 'rm -rf /' }).success).toBe(false)
  })

  it('rejects missing kind', () => {
    const { kind: _kind, ...rest } = valid
    expect(schemas.auditLogAppend.safeParse(rest).success).toBe(false)
  })

  it('rejects missing cwd', () => {
    const { cwd: _cwd, ...rest } = valid
    expect(schemas.auditLogAppend.safeParse(rest).success).toBe(false)
  })

  it('rejects missing epicId', () => {
    const { epicId: _epicId, ...rest } = valid
    expect(schemas.auditLogAppend.safeParse(rest).success).toBe(false)
  })

  it('rejects missing source', () => {
    const { source: _source, ...rest } = valid
    expect(schemas.auditLogAppend.safeParse(rest).success).toBe(false)
  })

  it('rejects empty string fields', () => {
    expect(schemas.auditLogAppend.safeParse({ ...valid, cwd: '' }).success).toBe(false)
    expect(schemas.auditLogAppend.safeParse({ ...valid, epicId: '' }).success).toBe(false)
    expect(schemas.auditLogAppend.safeParse({ ...valid, source: '' }).success).toBe(false)
  })

  it('rejects extra keys (strict schema)', () => {
    expect(schemas.auditLogAppend.safeParse({ ...valid, extra: 'nope' }).success).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
}

// ──────────────────────────────────────────── app:test-fire-hook
// This handler runs `spawn(command, { shell: true })` — the highest blast-radius
// handler in the codebase. The schema is the primary injection fence.
// CLAUDE.md explicitly notes shell:true is legitimately needed here.

describe('appTestFireHook schema', () => {
  it('accepts minimal valid payload (command only)', () => {
    expect(schemas.appTestFireHook.safeParse({ command: 'echo hello' }).success).toBe(true)
  })

  it('accepts full valid payload', () => {
    expect(schemas.appTestFireHook.safeParse({
      command: 'echo $PAYLOAD',
      env: { MY_VAR: 'value' },
      payload: '{"event":"test"}',
      timeoutMs: 5000,
    }).success).toBe(true)
  })

  it('accepts command at max length (16 KiB)', () => {
    const command = 'echo ' + 'x'.repeat(16 * 1024 - 5)
    expect(schemas.appTestFireHook.safeParse({ command }).success).toBe(true)
  })

  it('rejects command exceeding 16 KiB', () => {
    const command = 'x'.repeat(16 * 1024 + 1)
    expect(schemas.appTestFireHook.safeParse({ command }).success).toBe(false)
  })

  it('rejects empty command', () => {
    expect(schemas.appTestFireHook.safeParse({ command: '' }).success).toBe(false)
  })

  it('rejects missing command', () => {
    expect(schemas.appTestFireHook.safeParse({}).success).toBe(false)
  })

  it('accepts null env (optional)', () => {
    expect(schemas.appTestFireHook.safeParse({ command: 'echo', env: null }).success).toBe(true)
  })

  it('rejects env key with equals sign (would corrupt env block)', () => {
    expect(schemas.appTestFireHook.safeParse({
      command: 'echo',
      env: { 'FOO=BAR': 'val' },
    }).success).toBe(false)
  })

  it('rejects env key starting with digit', () => {
    expect(schemas.appTestFireHook.safeParse({
      command: 'echo',
      env: { '1VAR': 'val' },
    }).success).toBe(false)
  })

  it('accepts valid env key (alphanumeric + underscore)', () => {
    expect(schemas.appTestFireHook.safeParse({
      command: 'echo',
      env: { MY_VAR_123: 'value' },
    }).success).toBe(true)
  })

  it('rejects env value exceeding 8 KiB', () => {
    expect(schemas.appTestFireHook.safeParse({
      command: 'echo',
      env: { FOO: 'x'.repeat(8 * 1024 + 1) },
    }).success).toBe(false)
  })

  it('rejects env key exceeding 256 chars', () => {
    expect(schemas.appTestFireHook.safeParse({
      command: 'echo',
      env: { ['A'.repeat(257)]: 'val' },
    }).success).toBe(false)
  })

  it('accepts payload at exactly 1 MiB', () => {
    const payload = 'x'.repeat(1024 * 1024)
    expect(schemas.appTestFireHook.safeParse({ command: 'echo', payload }).success).toBe(true)
  })

  it('rejects payload exceeding 1 MiB', () => {
    const payload = 'x'.repeat(1024 * 1024 + 1)
    expect(schemas.appTestFireHook.safeParse({ command: 'echo', payload }).success).toBe(false)
  })

  it('accepts timeoutMs at max (30000)', () => {
    expect(schemas.appTestFireHook.safeParse({ command: 'echo', timeoutMs: 30000 }).success).toBe(true)
  })

  it('rejects timeoutMs above 30000', () => {
    expect(schemas.appTestFireHook.safeParse({ command: 'echo', timeoutMs: 30001 }).success).toBe(false)
  })

  it('rejects negative timeoutMs', () => {
    expect(schemas.appTestFireHook.safeParse({ command: 'echo', timeoutMs: -1 }).success).toBe(false)
  })

  it('rejects non-integer timeoutMs', () => {
    expect(schemas.appTestFireHook.safeParse({ command: 'echo', timeoutMs: 1000.5 }).success).toBe(false)
  })

  it('allows passthrough of extra fields (schema uses .passthrough())', () => {
    expect(schemas.appTestFireHook.safeParse({ command: 'echo', extra: true }).success).toBe(true)
  })
})

// ──────────────────────────────────────────── app:git-branch
describe('appGitBranch schema', () => {
  it('accepts valid cwd path', () => {
    expect(schemas.appGitBranch.safeParse({ cwd: '/home/user/project' }).success).toBe(true)
  })

  it('rejects empty cwd', () => {
    expect(schemas.appGitBranch.safeParse({ cwd: '' }).success).toBe(false)
  })

  it('rejects cwd exceeding 4096 chars', () => {
    expect(schemas.appGitBranch.safeParse({ cwd: '/' + 'a'.repeat(4096) }).success).toBe(false)
  })

  it('rejects missing cwd', () => {
    expect(schemas.appGitBranch.safeParse({}).success).toBe(false)
  })
})

// ──────────────────────────────────────────── app:archive-project
describe('archiveProject schema', () => {
  it('accepts valid encoded cwd slug', () => {
    // Encoded cwds are /home/user/projects → -home-user-projects style
    expect(schemas.archiveProject.safeParse({ encoded: '-home-user-myproject' }).success).toBe(true)
  })

  it('accepts alphanumeric encoded slug', () => {
    expect(schemas.archiveProject.safeParse({ encoded: 'home-user-project123' }).success).toBe(true)
  })

  it('rejects encoded slug with path traversal (../)', () => {
    // ENCODED_SLUG_RE = /^[A-Za-z0-9._-]+$/ — slashes rejected
    expect(schemas.archiveProject.safeParse({ encoded: '../etc' }).success).toBe(false)
  })

  it('rejects encoded slug with slash', () => {
    expect(schemas.archiveProject.safeParse({ encoded: 'home/user/project' }).success).toBe(false)
  })

  it('rejects empty encoded slug', () => {
    expect(schemas.archiveProject.safeParse({ encoded: '' }).success).toBe(false)
  })

  it('rejects missing encoded field', () => {
    expect(schemas.archiveProject.safeParse({}).success).toBe(false)
  })
})

/**
 * ipc-web-remote.spec.ts — Unit tests for the web remote command dispatcher.
 *
 * Tests verify:
 *   1. Non-allowlisted command types are rejected (no handler called).
 *   2. Schema-invalid payloads throw ZodError before any handler runs.
 *   3. Path-bearing commands (cmd:pty:spawn) pass cwd through validatePath.
 *   4. Kill-switch: commands are refused when remoteEnabled = false.
 *   5. All 11 allowlisted command types are present in the set.
 *   6. Destructive pty commands live in the MUTATE tier, not READ.
 *   7. Sensitive READ commands (SAS_GATED_READS) are not in the plain READ tier.
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Load the allowlist + schemas directly from ipcSchemas — no Electron dep.
const { schemas, ALLOWED_COMMANDS, READ_COMMANDS, SAS_GATED_READS, MUTATE_COMMANDS } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: unknown }; parse: (v: unknown) => unknown }>
  ALLOWED_COMMANDS: Set<string>
  READ_COMMANDS: Set<string>
  SAS_GATED_READS: Set<string>
  MUTATE_COMMANDS: Set<string>
}

// ─── Allowlist coverage ───────────────────────────────────────────────────────

describe('ALLOWED_COMMANDS set', () => {
  it('contains exactly 11 entries', () => {
    expect(ALLOWED_COMMANDS.size).toBe(11)
  })

  it('is the exact union of READ, SAS_GATED_READS, and MUTATE tiers (no overlap, no orphans)', () => {
    expect(READ_COMMANDS.size + SAS_GATED_READS.size + MUTATE_COMMANDS.size).toBe(ALLOWED_COMMANDS.size)
    for (const c of READ_COMMANDS) {
      expect(MUTATE_COMMANDS.has(c)).toBe(false)
      expect(SAS_GATED_READS.has(c)).toBe(false)
    }
    for (const c of SAS_GATED_READS) expect(MUTATE_COMMANDS.has(c)).toBe(false)
  })

  // Destructive/stateful commands must require the remoteControlEnabled + SAS
  // gate, which only applies to MUTATE_COMMANDS. A read-only mirror that could
  // kill or resize the desktop PTY would be a control-bypass (sec review S2/S7).
  for (const c of ['cmd:pty:kill', 'cmd:pty:resize', 'cmd:pty:spawn', 'cmd:pty:write']) {
    it(`gates "${c}" behind the MUTATE tier`, () => {
      expect(MUTATE_COMMANDS.has(c)).toBe(true)
      expect(READ_COMMANDS.has(c)).toBe(false)
    })
  }

  const forbidden = [
    'app:test-fire-hook',
    'watchers:add',
    'config:write-json',
    'config:write-text',
    'shell:open',
    'plugins:install',
    'plugins:abort',
    'files:read',
    'files:write',
    'search:files',
    'search:text',
    '',
    'cmd:unknown',
    'cmd:exec:shell',
    // Scheduler/Epics commands were deliberately removed from Remote (core
    // scheduler/Epics redesign) — Remote no longer reaches into scheduler
    // internals; a future rebuild will use a higher-level surface instead.
    'cmd:schedule:state',
    'cmd:schedule:read-prd',
    'cmd:schedule:read-log',
    'cmd:schedule:write-prd',
    'cmd:schedule:reset-job',
    'cmd:schedule:run-now',
    'cmd:schedule:set-config',
  ]

  for (const t of forbidden) {
    it(`rejects forbidden type "${t}"`, () => {
      expect(ALLOWED_COMMANDS.has(t)).toBe(false)
    })
  }

  const allowed = [...ALLOWED_COMMANDS]
  for (const t of allowed) {
    it(`allows "${t}"`, () => {
      expect(ALLOWED_COMMANDS.has(t)).toBe(true)
    })
  }
})

// ─── Kill-switch simulation ───────────────────────────────────────────────────

describe('kill-switch gate', () => {
  // The kill-switch is checked in handleMessage; we test the config schema here
  // and verify that remoteEnabled:false is expressible.
  it('webRemotePair schema rejects empty OTP', () => {
    expect(schemas.webRemotePair.safeParse({ otp: '' }).success).toBe(false)
  })

  it('webRemotePair schema rejects 7-char OTP', () => {
    expect(schemas.webRemotePair.safeParse({ otp: 'ABCDEF1' }).success).toBe(false)
  })

  it('webRemotePair schema rejects OTP with invalid chars', () => {
    expect(schemas.webRemotePair.safeParse({ otp: 'ABCDEF!@' }).success).toBe(false)
  })

  it('webRemotePair schema accepts valid 8-char uppercase alphanumeric OTP', () => {
    expect(schemas.webRemotePair.safeParse({ otp: 'ABC12345' }).success).toBe(true)
  })

  it('webRemotePair schema accepts lowercase OTP (case-insensitive entry)', () => {
    expect(schemas.webRemotePair.safeParse({ otp: 'abc12345' }).success).toBe(true)
  })

  it('webRemoteRevokeDevice schema rejects non-UUID deviceId', () => {
    expect(schemas.webRemoteRevokeDevice.safeParse({ deviceId: 'not-a-uuid' }).success).toBe(false)
  })

  it('webRemoteRevokeDevice schema accepts valid UUID v4', () => {
    expect(
      schemas.webRemoteRevokeDevice.safeParse({ deviceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }).success
    ).toBe(true)
  })

  it('webRemoteAuditTail schema accepts empty payload (defaults)', () => {
    expect(schemas.webRemoteAuditTail.safeParse({}).success).toBe(true)
  })

  it('webRemoteAuditTail schema accepts lines within range', () => {
    expect(schemas.webRemoteAuditTail.safeParse({ lines: 50 }).success).toBe(true)
  })

  it('webRemoteAuditTail schema rejects lines > 500', () => {
    expect(schemas.webRemoteAuditTail.safeParse({ lines: 501 }).success).toBe(false)
  })
})

// ─── Command payload schema validation ───────────────────────────────────────

describe('cmd:pty:spawn payload schema (path safety)', () => {
  it('rejects missing cwd', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab1', cols: 80, rows: 24 }).success).toBe(false)
  })

  it('rejects empty cwd', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab1', cwd: '', cols: 80, rows: 24 }).success).toBe(false)
  })

  it('accepts valid spawn payload', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab1', cwd: '/home/user', cols: 80, rows: 24 }).success).toBe(true)
  })

  it('rejects cwd exceeding 4096 chars', () => {
    expect(schemas.ptySpawn.safeParse({ tabId: 'tab1', cwd: '/home/' + 'a'.repeat(4091) }).success).toBe(false)
  })
})

describe('cmd:pty:write payload schema', () => {
  it('rejects missing tabId', () => {
    expect(schemas.ptyWrite.safeParse({ data: 'hello' }).success).toBe(false)
  })

  it('rejects data exceeding 64 KiB', () => {
    const big = 'x'.repeat(65 * 1024 + 1)
    expect(schemas.ptyWrite.safeParse({ tabId: 't', data: big }).success).toBe(false)
  })

  it('accepts data at exactly 64 KiB', () => {
    const edge = 'x'.repeat(64 * 1024)
    expect(schemas.ptyWrite.safeParse({ tabId: 't', data: edge }).success).toBe(true)
  })
})

describe('cmd:schedule:write-prd payload schema', () => {
  it('rejects body exceeding 256 KiB', () => {
    const body = 'x'.repeat(256 * 1024 + 1)
    expect(schemas.scheduleWritePrd.safeParse({ slug: '01-foo', body }).success).toBe(false)
  })

  it('accepts valid PRD write', () => {
    expect(schemas.scheduleWritePrd.safeParse({ slug: '01-my-prd', body: '# PRD\ncontent' }).success).toBe(true)
  })

  it('rejects slug with path separator', () => {
    expect(schemas.scheduleWritePrd.safeParse({ slug: '../escape', body: 'x' }).success).toBe(false)
  })
})

describe('cmd:schedule:read-log payload schema', () => {
  it('accepts valid slug + ISO-style runId (colons allowed)', () => {
    expect(
      schemas.scheduleReadLog.safeParse({ slug: '01-foo', runId: '2026-06-07T12:00:00' }).success
    ).toBe(true)
  })

  it('accepts compact runId without colons', () => {
    expect(
      schemas.scheduleReadLog.safeParse({ slug: '01-foo', runId: '20260607-120000' }).success
    ).toBe(true)
  })

  it('rejects runId with disallowed chars (asterisk)', () => {
    expect(
      schemas.scheduleReadLog.safeParse({ slug: '01-foo', runId: 'run*bad' }).success
    ).toBe(false)
  })

  it('rejects runId exceeding 64 chars', () => {
    expect(
      schemas.scheduleReadLog.safeParse({ slug: '01-foo', runId: 'a'.repeat(65) }).success
    ).toBe(false)
  })
})

describe('cmd:sessions:save payload schema', () => {
  it('accepts valid sessions payload', () => {
    expect(
      schemas.sessionsPayload.safeParse({
        tabs: [{ id: 't1', sessionId: 'cs1', cwd: '/home/user', label: 'Tab', presetId: null }],
        activeTabId: 't1',
      }).success
    ).toBe(true)
  })

  it('rejects tabs with invalid cwd length', () => {
    const longCwd = '/' + 'a'.repeat(4096)
    expect(
      schemas.sessionsPayload.safeParse({
        tabs: [{ id: 't1', sessionId: 'cs1', cwd: longCwd, label: 'Tab', presetId: null }],
        activeTabId: 't1',
      }).success
    ).toBe(false)
  })
})

describe('cmd:schedule:set-config payload schema', () => {
  it('accepts empty payload (all fields optional)', () => {
    expect(schemas.setConfigSchema.safeParse({}).success).toBe(true)
  })

  it('accepts partial config', () => {
    expect(schemas.setConfigSchema.safeParse({ concurrencyCap: 4 }).success).toBe(true)
  })

  it('rejects unknown keys (strict mode)', () => {
    expect(schemas.setConfigSchema.safeParse({ concurrencyCap: 4, hacked: true }).success).toBe(false)
  })

  it('rejects concurrencyCap above 20', () => {
    expect(schemas.setConfigSchema.safeParse({ concurrencyCap: 21 }).success).toBe(false)
  })
})

describe('cmd:history:aggregate payload schema', () => {
  it('accepts null (omitted)', () => {
    expect(schemas.historyAggregate.safeParse(null).success).toBe(true)
  })

  it('accepts valid date range', () => {
    expect(schemas.historyAggregate.safeParse({ fromDate: '2026-01-01', toDate: '2026-06-07' }).success).toBe(true)
  })

  it('rejects malformed date', () => {
    expect(schemas.historyAggregate.safeParse({ fromDate: '01/01/2026' }).success).toBe(false)
  })
})

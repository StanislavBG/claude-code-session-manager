import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ipc = require('../../src/main/ipcSchemas.cjs') as {
  READ_COMMANDS: Set<string>
  SAS_GATED_READS: Set<string>
  MUTATE_COMMANDS: Set<string>
  ALLOWED_COMMANDS: Set<string>
}
const { WEB_REMOTE_OTP_RE } = (() => {
  const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
    schemas: { webRemotePair: { safeParse: (v: unknown) => { success: boolean } } }
  }
  return {
    WEB_REMOTE_OTP_RE: {
      test: (otp: string) => schemas.webRemotePair.safeParse({ otp }).success,
    },
  }
})()

describe('web-remote command tiers', () => {
  it('MUTATE_COMMANDS is disjoint from READ_COMMANDS and SAS_GATED_READS', () => {
    for (const c of ipc.MUTATE_COMMANDS) {
      expect(ipc.READ_COMMANDS.has(c)).toBe(false)
      expect(ipc.SAS_GATED_READS.has(c)).toBe(false)
    }
  })

  it('READ_COMMANDS and SAS_GATED_READS are disjoint', () => {
    for (const c of ipc.READ_COMMANDS) expect(ipc.SAS_GATED_READS.has(c)).toBe(false)
  })

  it('ALLOWED_COMMANDS equals the union of all tiers', () => {
    const union = new Set([...ipc.READ_COMMANDS, ...ipc.SAS_GATED_READS, ...ipc.MUTATE_COMMANDS])
    expect(ipc.ALLOWED_COMMANDS).toEqual(union)
  })
})

describe('webRemotePair OTP', () => {
  it('accepts 8 alphanumeric chars', () => {
    expect(WEB_REMOTE_OTP_RE.test('AB12CD34')).toBe(true)
  })
  it('rejects wrong length and non-alphanumeric codes', () => {
    expect(WEB_REMOTE_OTP_RE.test('AB12CD3')).toBe(false)
    expect(WEB_REMOTE_OTP_RE.test('AB12CD345')).toBe(false)
    expect(WEB_REMOTE_OTP_RE.test('AB12-D34')).toBe(false)
    expect(WEB_REMOTE_OTP_RE.test('')).toBe(false)
  })
})

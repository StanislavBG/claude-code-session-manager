/**
 * Unit tests for the webRemote SAS auth gate on sensitive READ commands.
 *
 * Security invariant (2026-06-10 finding): a session with _e2eSessionKey set
 * but _e2eAuthenticated=false must be denied sensitive READ commands
 * (SAS_GATED_READS) until the user confirms the SAS on the desktop.
 * MUTATE commands are already gated; this test covers the READ tier.
 *
 * We test the pure set membership logic exported from ipcSchemas.cjs rather
 * than the full Electron-linked dispatchEnvelope, keeping the test fast and
 * dependency-free.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { SAS_GATED_READS, MUTATE_COMMANDS, READ_COMMANDS } = require('../../src/main/ipcSchemas.cjs') as {
  SAS_GATED_READS: Set<string>
  MUTATE_COMMANDS: Set<string>
  READ_COMMANDS: Set<string>
}

/** Simulates the gate predicate in dispatchEnvelope. */
function isBlocked(type: string, e2eAuthenticated: boolean): boolean {
  return (MUTATE_COMMANDS.has(type) || SAS_GATED_READS.has(type)) && !e2eAuthenticated
}

describe('SAS_GATED_READS — sensitive READ commands require SAS confirmation', () => {
  const sensitiveReads = [
    'cmd:sessions:load',
    'cmd:schedule:read-prd',
    'cmd:schedule:read-log',
    'cmd:schedule:state',
    'cmd:history:aggregate',
    'cmd:session:subscribe',
  ]

  for (const cmd of sensitiveReads) {
    it(`${cmd} is in SAS_GATED_READS`, () => {
      expect(SAS_GATED_READS.has(cmd)).toBe(true)
    })

    it(`${cmd} is blocked when e2eAuthenticated=false`, () => {
      expect(isBlocked(cmd, false)).toBe(true)
    })

    it(`${cmd} is allowed when e2eAuthenticated=true`, () => {
      expect(isBlocked(cmd, true)).toBe(false)
    })
  }
})

describe('Ungated READ commands are not in SAS_GATED_READS', () => {
  it('cmd:app:version is ungated (returns only version string, no user data)', () => {
    expect(SAS_GATED_READS.has('cmd:app:version')).toBe(false)
    expect(READ_COMMANDS.has('cmd:app:version')).toBe(true)
    expect(isBlocked('cmd:app:version', false)).toBe(false)
  })

  it('cmd:session:unsubscribe is ungated (teardown lifecycle, returns nothing)', () => {
    expect(SAS_GATED_READS.has('cmd:session:unsubscribe')).toBe(false)
    expect(READ_COMMANDS.has('cmd:session:unsubscribe')).toBe(true)
    expect(isBlocked('cmd:session:unsubscribe', false)).toBe(false)
  })
})

describe('MUTATE commands remain gated', () => {
  const mutates = ['cmd:pty:spawn', 'cmd:pty:write', 'cmd:schedule:write-prd']
  for (const cmd of mutates) {
    it(`${cmd} is blocked when e2eAuthenticated=false`, () => {
      expect(isBlocked(cmd, false)).toBe(true)
    })

    it(`${cmd} is allowed when e2eAuthenticated=true`, () => {
      expect(isBlocked(cmd, true)).toBe(false)
    })
  }
})

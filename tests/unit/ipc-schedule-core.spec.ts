import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { schemas } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
}

const home = os.homedir()

// ──────────────────────────────────────────── schedule:set-config
describe('setConfigSchema', () => {
  it('accepts empty partial (all optional)', () => {
    expect(schemas.setConfigSchema.safeParse({}).success).toBe(true)
  })

  it('accepts valid firePolicy', () => {
    expect(schemas.setConfigSchema.safeParse({ firePolicy: 'when-available' }).success).toBe(true)
    expect(schemas.setConfigSchema.safeParse({ firePolicy: 'on-reset' }).success).toBe(true)
    expect(schemas.setConfigSchema.safeParse({ firePolicy: 'manual' }).success).toBe(true)
  })

  it('rejects invalid firePolicy', () => {
    expect(schemas.setConfigSchema.safeParse({ firePolicy: 'always' }).success).toBe(false)
  })

  it('accepts valid concurrencyCap (1–20)', () => {
    expect(schemas.setConfigSchema.safeParse({ concurrencyCap: 1 }).success).toBe(true)
    expect(schemas.setConfigSchema.safeParse({ concurrencyCap: 20 }).success).toBe(true)
  })

  it('rejects concurrencyCap above 20', () => {
    expect(schemas.setConfigSchema.safeParse({ concurrencyCap: 21 }).success).toBe(false)
  })

  it('rejects concurrencyCap below 1', () => {
    expect(schemas.setConfigSchema.safeParse({ concurrencyCap: 0 }).success).toBe(false)
  })

  it('accepts defaultCwd inside home directory', () => {
    const cwd = path.join(home, 'projects', 'my-project')
    expect(schemas.setConfigSchema.safeParse({ defaultCwd: cwd }).success).toBe(true)
  })

  it('accepts defaultCwd equal to home directory', () => {
    expect(schemas.setConfigSchema.safeParse({ defaultCwd: home }).success).toBe(true)
  })

  it('rejects defaultCwd outside home directory', () => {
    expect(schemas.setConfigSchema.safeParse({ defaultCwd: '/etc' }).success).toBe(false)
  })

  it('rejects defaultCwd with path traversal escaping home', () => {
    // /home/bilko/../../../etc would resolve out of home
    const evil = path.join(home, '..', '..', 'etc')
    expect(schemas.setConfigSchema.safeParse({ defaultCwd: evil }).success).toBe(false)
  })

  it('rejects utilizationThreshold above 200', () => {
    expect(schemas.setConfigSchema.safeParse({ utilizationThreshold: 201 }).success).toBe(false)
  })

  it('accepts valid utilizationThreshold', () => {
    expect(schemas.setConfigSchema.safeParse({ utilizationThreshold: 90 }).success).toBe(true)
  })

  it('accepts valid offsetMinutes (0–180)', () => {
    expect(schemas.setConfigSchema.safeParse({ offsetMinutes: 0 }).success).toBe(true)
    expect(schemas.setConfigSchema.safeParse({ offsetMinutes: 180 }).success).toBe(true)
  })

  it('rejects offsetMinutes above 180', () => {
    expect(schemas.setConfigSchema.safeParse({ offsetMinutes: 181 }).success).toBe(false)
  })

  it('accepts valid supervisor config', () => {
    expect(schemas.setConfigSchema.safeParse({
      supervisor: { enabled: true, intervalMinutes: 15, maxConcurrentProbes: 3 },
    }).success).toBe(true)
  })

  it('rejects supervisor intervalMinutes below 5', () => {
    expect(schemas.setConfigSchema.safeParse({ supervisor: { intervalMinutes: 4 } }).success).toBe(false)
  })

  it('rejects supervisor maxConcurrentProbes above 5', () => {
    expect(schemas.setConfigSchema.safeParse({ supervisor: { maxConcurrentProbes: 6 } }).success).toBe(false)
  })

  it('rejects unknown keys (strict schema)', () => {
    expect(schemas.setConfigSchema.safeParse({ unknownKey: true }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── schedule:reset-job / schedule:read-prd
describe('scheduleSlug schema', () => {
  it('accepts valid slug', () => {
    expect(schemas.scheduleSlug.safeParse({ slug: '01-my-prd.md' }).success).toBe(true)
  })

  it('accepts slug with uppercase letters', () => {
    // SCHEDULE_SLUG_RE allows [A-Za-z0-9._-]
    expect(schemas.scheduleSlug.safeParse({ slug: 'MyPRD.md' }).success).toBe(true)
  })

  it('rejects slug with slash', () => {
    expect(schemas.scheduleSlug.safeParse({ slug: 'prds/evil.md' }).success).toBe(false)
  })

  it('rejects slug with path traversal', () => {
    expect(schemas.scheduleSlug.safeParse({ slug: '../etc/passwd' }).success).toBe(false)
  })

  it('rejects empty slug', () => {
    expect(schemas.scheduleSlug.safeParse({ slug: '' }).success).toBe(false)
  })

  it('rejects slug exceeding 128 chars', () => {
    expect(schemas.scheduleSlug.safeParse({ slug: 'a'.repeat(129) }).success).toBe(false)
  })

  it('rejects missing slug', () => {
    expect(schemas.scheduleSlug.safeParse({}).success).toBe(false)
  })
})

// ──────────────────────────────────────────── schedule:read-log
describe('scheduleReadLog schema', () => {
  it('accepts valid slug + runId', () => {
    expect(schemas.scheduleReadLog.safeParse({
      slug: '01-prd.md', runId: '2024-01-15T10:30:00.123Z',
    }).success).toBe(true)
  })

  it('rejects runId with special chars outside SCHEDULE_RUN_ID_RE', () => {
    // SCHEDULE_RUN_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/
    expect(schemas.scheduleReadLog.safeParse({
      slug: '01-prd.md', runId: '../../../etc/passwd',
    }).success).toBe(false)
  })

  it('rejects runId exceeding 64 chars', () => {
    expect(schemas.scheduleReadLog.safeParse({
      slug: '01-prd.md', runId: 'a'.repeat(65),
    }).success).toBe(false)
  })

  it('rejects missing runId', () => {
    expect(schemas.scheduleReadLog.safeParse({ slug: '01-prd.md' }).success).toBe(false)
  })

  it('rejects missing slug', () => {
    expect(schemas.scheduleReadLog.safeParse({ runId: 'abc' }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── schedule:write-prd
describe('scheduleWritePrd schema', () => {
  it('accepts valid slug + body', () => {
    expect(schemas.scheduleWritePrd.safeParse({
      slug: '01-prd.md', body: '# My PRD\n\nDo the thing.',
    }).success).toBe(true)
  })

  it('accepts empty body', () => {
    expect(schemas.scheduleWritePrd.safeParse({ slug: '01-prd.md', body: '' }).success).toBe(true)
  })

  it('accepts body at exactly 256 KiB', () => {
    const body = 'x'.repeat(256 * 1024)
    expect(schemas.scheduleWritePrd.safeParse({ slug: '01-prd.md', body }).success).toBe(true)
  })

  it('rejects body exceeding 256 KiB', () => {
    const body = 'x'.repeat(256 * 1024 + 1)
    expect(schemas.scheduleWritePrd.safeParse({ slug: '01-prd.md', body }).success).toBe(false)
  })

  it('rejects slug with path traversal', () => {
    expect(schemas.scheduleWritePrd.safeParse({ slug: '../evil.md', body: 'x' }).success).toBe(false)
  })

  it('rejects missing body', () => {
    expect(schemas.scheduleWritePrd.safeParse({ slug: '01-prd.md' }).success).toBe(false)
  })
})

// ──────────────────────────────────────────── historyAggregate
describe('historyAggregate schema', () => {
  it('accepts null (no filter)', () => {
    expect(schemas.historyAggregate.safeParse(null).success).toBe(true)
  })

  it('accepts undefined (no filter)', () => {
    expect(schemas.historyAggregate.safeParse(undefined).success).toBe(true)
  })

  it('accepts empty object', () => {
    expect(schemas.historyAggregate.safeParse({}).success).toBe(true)
  })

  it('accepts valid fromDate + toDate', () => {
    expect(schemas.historyAggregate.safeParse({ fromDate: '2024-01-01', toDate: '2024-01-31' }).success).toBe(true)
  })

  it('rejects fromDate in wrong format', () => {
    expect(schemas.historyAggregate.safeParse({ fromDate: '01/01/2024' }).success).toBe(false)
  })

  it('rejects toDate that is not YYYY-MM-DD', () => {
    expect(schemas.historyAggregate.safeParse({ toDate: '2024-1-1' }).success).toBe(false)
  })
})

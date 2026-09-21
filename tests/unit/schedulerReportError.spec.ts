/**
 * reportSchedulerError: the scheduler-scoped error sink used by spawnJob's
 * outer catch, the dispatch `.catch`, the finalize guard and the reverify
 * interval guard (PRD 1358). Source: src/main/scheduler.cjs.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('node:fs')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const logs = require('../../src/main/logs.cjs')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { reportSchedulerError } = require('../../src/main/scheduler.cjs')

afterEach(() => vi.restoreAllMocks())

describe('reportSchedulerError', () => {
  it('logs scope=scheduler level=error with slug + stack and appends an audit event', () => {
    const write = vi.spyOn(logs, 'writeLine').mockImplementation(() => {})
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {})
    const err = new Error('boom')
    reportSchedulerError('spawnJob error', 'my-slug', err)
    const line = write.mock.calls[0][0] as { meta: Record<string, string> }
    expect(line).toMatchObject({ scope: 'scheduler', level: 'error', message: 'spawnJob error' })
    expect(line.meta).toMatchObject({ slug: 'my-slug', error: 'boom' })
    expect(line.meta.stack).toContain('boom')
    expect(append).toHaveBeenCalledTimes(1)
    expect(String(append.mock.calls[0][1])).toContain('"slug":"my-slug"')
  })

  it('never throws even when the logger throws or the error is not an Error', () => {
    vi.spyOn(logs, 'writeLine').mockImplementation(() => { throw new Error('log down') })
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('disk') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => reportSchedulerError('x', null, 'plain string')).not.toThrow()
  })
})

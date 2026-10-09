import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.fn()
vi.mock('../../state/toast', () => ({ toast: { error: (m: string) => toastError(m) } }))

import { runSchedulerNow } from '../schedulerActions'

describe('runSchedulerNow', () => {
  beforeEach(() => {
    toastError.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves true on success with no toast, calling the IPC once', async () => {
    const runNow = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { schedule: { runNow } } })
    await expect(runSchedulerNow()).resolves.toBe(true)
    expect(runNow).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('resolves false and toasts once with the error message on rejection', async () => {
    const runNow = vi.fn().mockRejectedValue(new Error('boom'))
    vi.stubGlobal('window', { api: { schedule: { runNow } } })
    await expect(runSchedulerNow()).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith('Run now failed: boom')
  })

  it('stringifies non-Error rejections', async () => {
    const runNow = vi.fn().mockRejectedValue('nope')
    vi.stubGlobal('window', { api: { schedule: { runNow } } })
    await expect(runSchedulerNow()).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledWith('Run now failed: nope')
  })

  it('resolves false and toasts when window.api.schedule is missing', async () => {
    vi.stubGlobal('window', { api: {} })
    await expect(runSchedulerNow()).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0][0]).toMatch(/^Run now failed: /)
  })
})

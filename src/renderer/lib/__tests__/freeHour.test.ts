// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FREE_HOUR_URL, openFreeHour } from '../freeHour'
import { toast } from '../../state/toast'

type W = { api?: unknown; open?: unknown }
const w = window as unknown as W

describe('freeHour', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete w.api
  })

  it('exports the exact URL with utm params', () => {
    expect(FREE_HOUR_URL).toBe('https://bilko.run/book?utm_source=session-manager&utm_medium=app')
    const u = new URL(FREE_HOUR_URL)
    expect(u.searchParams.get('utm_source')).toBe('session-manager')
    expect(u.searchParams.get('utm_medium')).toBe('app')
  })

  it('desktop ok: opens externally, no toast', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true })
    w.api = { shell: { open } }
    openFreeHour()
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(open).toHaveBeenCalledWith({ as: 'external', url: FREE_HOUR_URL })
    await Promise.resolve()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('desktop rejected: toasts', async () => {
    const open = vi.fn().mockRejectedValue(new Error('x'))
    w.api = { shell: { open } }
    openFreeHour()
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1))
    expect(String(errorSpy.mock.calls[0][0])).toContain(FREE_HOUR_URL)
  })

  it('desktop { ok: false }: toasts', async () => {
    const open = vi.fn().mockResolvedValue({ ok: false })
    w.api = { shell: { open } }
    openFreeHour()
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1))
    expect(String(errorSpy.mock.calls[0][0])).toContain(FREE_HOUR_URL)
  })

  it('web: opens a tab, nulls opener, never calls shell.open', () => {
    const open = vi.fn()
    const win = { opener: {} as unknown }
    const winOpen = vi.fn().mockReturnValue(win)
    w.api = { __remote: true, shell: { open } }
    w.open = winOpen
    openFreeHour()
    expect(winOpen).toHaveBeenCalledWith(FREE_HOUR_URL, '_blank')
    expect(win.opener).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('web: popup blocked toasts', () => {
    const open = vi.fn()
    w.api = { __remote: true, shell: { open } }
    w.open = vi.fn().mockReturnValue(null)
    openFreeHour()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain(FREE_HOUR_URL)
    expect(open).not.toHaveBeenCalled()
  })
})

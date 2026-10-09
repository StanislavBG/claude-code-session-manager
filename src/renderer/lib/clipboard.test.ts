import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

describe('copyText', () => {
  const writeText = vi.fn()
  beforeEach(() => {
    writeText.mockReset()
    ;(globalThis as unknown as { window: unknown }).window = { api: { clipboard: { writeText } } }
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('resolves true and passes the exact text when the IPC returns ok:true', async () => {
    writeText.mockResolvedValue({ ok: true })
    await expect(copyText('héllo\nworld')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('héllo\nworld')
  })

  it('resolves false when the IPC returns ok:false', async () => {
    writeText.mockResolvedValue({ ok: false, error: 'nope' })
    await expect(copyText('x')).resolves.toBe(false)
  })

  it('resolves false (no throw) when the IPC rejects', async () => {
    writeText.mockRejectedValue(new Error('boom'))
    await expect(copyText('x')).resolves.toBe(false)
  })
})

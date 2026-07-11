import { describe, it, expect, vi } from 'vitest'
import { resolveChatPaste, spliceAtSelection } from '../../src/renderer/lib/pasteImageIntoChat'

describe('resolveChatPaste', () => {
  it('inserts the temp image path + space at the cursor and returns a toast on ok:true', async () => {
    const pasteImage = vi.fn().mockResolvedValue({ ok: true, path: '/tmp/foo.png', bytes: 12 })
    const readText = vi.fn().mockResolvedValue('SHOULD NOT BE CALLED')
    const r = await resolveChatPaste({ pasteImage, readText }, 'hi ', 3, 3)
    expect(r.value).toBe('hi /tmp/foo.png ')
    expect(r.caret).toBe('hi /tmp/foo.png '.length)
    expect(r.toast).toBe('Pasted image: foo.png')
    expect(readText).not.toHaveBeenCalled()
  })

  it('falls through to navigator text paste (readText) on ok:false, no toast', async () => {
    const pasteImage = vi.fn().mockResolvedValue({ ok: false, empty: true })
    const readText = vi.fn().mockResolvedValue('pasted text')
    const r = await resolveChatPaste({ pasteImage, readText }, 'ab', 1, 1)
    expect(readText).toHaveBeenCalledTimes(1)
    expect(r.value).toBe('apasted textb')
    expect(r.toast).toBeNull()
  })

  it('falls through to text paste when pasteImage throws/rejects', async () => {
    const pasteImage = vi.fn().mockRejectedValue(new Error('clipboard read failed'))
    const readText = vi.fn().mockResolvedValue('recovered text')
    const r = await resolveChatPaste({ pasteImage, readText }, 'ab', 1, 1)
    expect(readText).toHaveBeenCalledTimes(1)
    expect(r.value).toBe('arecovered textb')
    expect(r.toast).toBeNull()
  })

  it('spliceAtSelection replaces a selection range', () => {
    expect(spliceAtSelection('hello', 1, 4, 'X')).toEqual({ value: 'hXo', caret: 2 })
  })
})

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

  // Regression guard for the native-clipboard IPC wiring (window.api.clipboard.pasteText)
  // that replaced navigator.clipboard.readText(), which always rejected under Electron's
  // permission gate (only 'media'/'audioCapture'/'microphone' are allowed) and made text
  // paste a silent no-op. The IPC-backed readText never rejects for a normal read — it
  // resolves { ok: true, text } — so resolveChatPaste's unguarded `await deps.readText()`
  // now reliably returns real clipboard text instead of throwing into the caller's catch.
  it('resolves real clipboard text via an IPC-style readText that never rejects', async () => {
    const pasteImage = vi.fn().mockResolvedValue({ ok: false, empty: true })
    const pasteTextIpc = vi
      .fn<() => Promise<{ ok: true; text: string } | { ok: false; error?: string }>>()
      .mockResolvedValue({ ok: true, text: 'sample text' })
    const readText = () => pasteTextIpc().then((r) => (r.ok ? r.text : ''))
    const r = await resolveChatPaste({ pasteImage, readText }, '', 0, 0)
    expect(r.value).toBe('sample text')
    expect(r.toast).toBeNull()
  })

  // Only a genuine last-resort failure (the IPC handler itself reporting ok:false) should
  // degrade to a no-op — not the common case, and not a rejection like the old API produced.
  it('degrades to a no-op only when the IPC handler reports ok:false, not by rejecting', async () => {
    const pasteImage = vi.fn().mockResolvedValue({ ok: false, empty: true })
    const pasteTextIpc = vi
      .fn<() => Promise<{ ok: true; text: string } | { ok: false; error?: string }>>()
      .mockResolvedValue({ ok: false, error: 'clipboard unavailable' })
    const readText = () => pasteTextIpc().then((r) => (r.ok ? r.text : ''))
    const r = await resolveChatPaste({ pasteImage, readText }, 'ab', 1, 1)
    expect(r.value).toBe('ab')
    expect(r.toast).toBeNull()
  })
})

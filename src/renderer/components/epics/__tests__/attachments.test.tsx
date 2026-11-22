// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { AttachButton, AttachTray, useAttachments, attachPastedFiles, pngSize } from '../attachments'
import { toast } from '../../../state/toast'

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function Harness() {
  const att = useAttachments()
  const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
  return createElement('div', null, [
    createElement('button', { key: 'add', type: 'button', onClick: () => att.add([file]) }, 'add'),
    createElement(AttachButton, { key: 'btn', att, testId: 'attach-btn' }),
    createElement(AttachTray, { key: 'tray', att, testId: 'attach-tray' }),
  ])
}

describe('AttachTray', () => {
  it('renders no emoji — attach and file glyphs come from AlmanacIcon svgs', () => {
    const el = mount(createElement(Harness))

    const addBtn = el.querySelector('button') as HTMLButtonElement
    act(() => addBtn.click())

    expect(el.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(el.textContent ?? '')).toBe(false)
  })

  // The tray used to render a full-width dashed "Paste a screenshot (⌘V) or
  // drop files here · Attach" row even with nothing attached. That row cost a
  // permanent slab of vertical space to advertise affordances the prompt
  // already has, and its Attach button duplicated AttachButton.
  it('renders nothing at all while there is nothing attached', () => {
    const el = mount(createElement(Harness))
    expect(el.querySelector('[data-testid="attach-tray"]')).toBeNull()
    expect(el.textContent).not.toContain('Paste a screenshot')
    expect(el.textContent).not.toContain('drop files here')
  })

  it('appears only once something is attached', () => {
    const el = mount(createElement(Harness))
    act(() => (el.querySelector('button') as HTMLButtonElement).click())
    expect(el.querySelector('[data-testid="attach-tray"]')).not.toBeNull()
    expect(el.textContent).toContain('notes.txt')
  })
})

describe('AttachButton', () => {
  it('is the single attach control — an icon button plus its own hidden input', () => {
    const el = mount(createElement(Harness))
    const btn = el.querySelector('[data-testid="attach-btn"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    // No "Attach" text button anywhere — the icon IS the control.
    expect(btn.textContent).toBe('')
    expect(btn.getAttribute('aria-label')).toContain('paste a screenshot')
    const input = el.querySelector('[data-testid="attach-btn-input"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.type).toBe('file')
    expect(input.multiple).toBe(true)
  })

  it('adds the files the picker returns', () => {
    const el = mount(createElement(Harness))
    const input = el.querySelector('[data-testid="attach-btn-input"]') as HTMLInputElement
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(el.textContent).toContain('shot.png')
  })
})

// ── PRD 865: paste must work from the composer textarea, not just the tray ──
describe('attachPastedFiles', () => {
  function clipboardEvent(files: File[]) {
    let prevented = false
    return {
      clipboardData: { files },
      preventDefault: () => { prevented = true },
      get prevented() { return prevented },
    } as unknown as React.ClipboardEvent & { prevented: boolean }
  }

  it('consumes pasted files and suppresses the default text paste', () => {
    const added: File[] = []
    const att = { items: [], add: (f: FileList | File[]) => added.push(...Array.from(f)), remove: () => {}, clear: () => {} }
    const file = new File(['x'], 'screenshot.png', { type: 'image/png' })
    const e = clipboardEvent([file])

    expect(attachPastedFiles(e, att)).toBe(true)
    expect(added).toHaveLength(1)
    expect((e as unknown as { prevented: boolean }).prevented).toBe(true)
  })

  it('ignores a plain-text paste so typing is unaffected', () => {
    const added: File[] = []
    const att = { items: [], add: (f: FileList | File[]) => added.push(...Array.from(f)), remove: () => {}, clear: () => {} }
    const e = clipboardEvent([])

    expect(attachPastedFiles(e, att)).toBe(false)
    expect(added).toHaveLength(0)
    expect((e as unknown as { prevented: boolean }).prevented).toBe(false)
  })
})

// ── PRD 3647: a degenerate (≤2×2 px) pasted PNG is dropped with a warning ──
describe('pasted degenerate PNG guard', () => {
  const ONE_PX_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP5/e3NfwAJvgPhiIAxewAAAABJRU5ErkJggg=='
  const onePx = () => Uint8Array.from(atob(ONE_PX_B64), (c) => c.charCodeAt(0))
  function pngHeader(w: number, h: number): Uint8Array<ArrayBuffer> {
    const b = new Uint8Array(24)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
    const dv = new DataView(b.buffer)
    dv.setUint32(16, w)
    dv.setUint32(20, h)
    return b
  }

  let latest: ReturnType<typeof useAttachments> | null = null
  function Probe() {
    latest = useAttachments()
    return createElement(AttachTray, { att: latest, testId: 'attach-tray' })
  }
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

  afterEach(() => {
    vi.restoreAllMocks()
    latest = null
  })

  it('pngSize reads IHDR width/height, and returns null for non-PNG bytes', () => {
    expect(pngSize(onePx())).toEqual({ width: 1, height: 1 })
    expect(pngSize(pngHeader(640, 480))).toEqual({ width: 640, height: 480 })
    expect(pngSize(new TextEncoder().encode('hello world, this is not a png'))).toBeNull()
    expect(pngSize(pngHeader(1, 1).slice(0, 20))).toBeNull()
  })

  it('drops a pasted 1×1 PNG and warns once', async () => {
    const warn = vi.spyOn(toast, 'warn').mockImplementation(() => '')
    const el = mount(createElement(Probe))
    const file = new File([onePx()], 'image.png', { type: 'image/png' })
    act(() => latest!.add([file]))
    await flush()
    expect(latest!.items).toHaveLength(0)
    expect(el.querySelector('[data-testid="attach-tray"]')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('1×1 px')
    expect(warn.mock.calls[0][0]).toContain('Copy it again and paste')
  })

  it('keeps a pasted 640×480 PNG with no toast', async () => {
    const warn = vi.spyOn(toast, 'warn').mockImplementation(() => '')
    const el = mount(createElement(Probe))
    const file = new File([pngHeader(640, 480)], 'image.png', { type: 'image/png' })
    act(() => latest!.add([file]))
    await flush()
    expect(latest!.items).toHaveLength(1)
    expect(el.textContent).toContain('image.png')
    expect(warn).not.toHaveBeenCalled()
  })

  it('never probes a File carrying a real path', async () => {
    const warn = vi.spyOn(toast, 'warn').mockImplementation(() => '')
    mount(createElement(Probe))
    const file = new File([onePx()], 'tiny.png', { type: 'image/png' })
    Object.defineProperty(file, 'path', { value: '/home/u/tiny.png' })
    const slice = vi.spyOn(file, 'slice')
    act(() => latest!.add([file]))
    await flush()
    expect(slice).not.toHaveBeenCalled()
    expect(latest!.items).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })
})

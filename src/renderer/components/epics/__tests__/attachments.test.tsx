// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach } from 'vitest'
import { AttachButton, AttachTray, useAttachments, attachPastedFiles } from '../attachments'

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

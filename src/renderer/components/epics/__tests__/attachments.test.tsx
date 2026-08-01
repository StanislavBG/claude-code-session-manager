// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach } from 'vitest'
import { AttachTray, useAttachments, attachPastedFiles } from '../attachments'

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

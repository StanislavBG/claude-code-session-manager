// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach } from 'vitest'
import { AttachTray, useAttachments } from '../attachments'

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

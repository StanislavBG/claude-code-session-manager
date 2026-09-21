// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { useAttachments, type AttachmentsState } from '../attachments'

let container: HTMLDivElement | null = null
let root: Root | null = null
let att: AttachmentsState
let n = 0
const create = vi.fn()
const revoke = vi.fn()

function Harness({ tick }: { tick: number }) {
  att = useAttachments()
  return createElement('div', { 'data-tick': tick }, att.items.map((i) => i.url ?? '').join(','))
}

const img = (name: string) => new File(['x'], name, { type: 'image/png' })

function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(Harness, { tick: 0 })))
}

beforeEach(() => {
  n = 0
  create.mockReset().mockImplementation(() => `blob:mock-${n++}`)
  revoke.mockReset()
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('useAttachments blob URL lifecycle', () => {
  it('revokes on remove, clear, and unmount', () => {
    mount()
    act(() => att.add([img('a.png'), img('b.png'), img('c.png')]))
    expect(create).toHaveBeenCalledTimes(3)
    const first = att.items[0]
    act(() => att.remove(first.id))
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith(first.url)
    act(() => att.clear())
    expect(revoke).toHaveBeenCalledTimes(3)
    act(() => att.add([img('d.png'), img('e.png')]))
    act(() => root!.unmount())
    root = null
    expect(revoke).toHaveBeenCalledTimes(5)
  })

  it('never revokes a displayed url across an unrelated re-render', () => {
    mount()
    act(() => att.add([img('a.png')]))
    const url = att.items[0].url
    act(() => root!.render(createElement(Harness, { tick: 1 })))
    expect(att.items[0].url).toBe(url)
    expect(container!.textContent).toBe(url)
    expect(revoke).not.toHaveBeenCalled()
  })

  it('non-image files never create or revoke', () => {
    mount()
    act(() => att.add([new File(['t'], 'n.txt', { type: 'text/plain' })]))
    act(() => att.clear())
    act(() => root!.unmount())
    root = null
    expect(create).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MemoryStoreView } from '../memory/MemoryStoreView'
import type { MemoryTarget } from '../../../../preload/api'

vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: (p: { value: string; onChange: (v: string) => void }) =>
    createElement('textarea', {
      'data-testid': 'editor',
      value: p.value,
      onChange: (e: { target: { value: string } }) => p.onChange(e.target.value),
    }),
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

const entry = { name: 'a.md', path: '/mem/a.md', bytes: 10, mtimeMs: 1 }
const memory = {
  list: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
  create: vi.fn(),
  stale: vi.fn(),
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function mount(target: MemoryTarget) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(MemoryStoreView, { target, cwd: target.cwd ?? null }))
  })
  await flush()
  return container
}

function click(el: Element | null | undefined) {
  return act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function byText(root: HTMLElement, text: string) {
  return Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)
}

beforeEach(() => {
  memory.list.mockResolvedValue({ entries: [entry], dir: '/mem' })
  memory.read.mockResolvedValue({ content: 'hello' })
  memory.write.mockResolvedValue({ ok: true })
  memory.create.mockResolvedValue({ ok: true })
  memory.delete.mockResolvedValue({ ok: true })
  memory.stale.mockResolvedValue({ entries: [], index: undefined })
  ;(window as unknown as { api: unknown }).api = {
    memory,
    config: { watch: vi.fn(), unwatch: vi.fn(), onChanged: vi.fn(() => () => {}) },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.clearAllMocks()
})

const wsTarget: MemoryTarget = { workspace: 'ws', cwd: '/p' }

describe('MemoryStoreView', () => {
  it('lists entries and loads the selected body', async () => {
    const el = await mount(wsTarget)
    expect(el.textContent).toContain('a')
    expect(memory.list).toHaveBeenCalledWith(wsTarget)
    expect(memory.read).toHaveBeenCalledWith('a.md', wsTarget)
    expect((el.querySelector('[data-testid="editor"]') as HTMLTextAreaElement).value).toBe('hello')
  })

  it('Save calls write with the target', async () => {
    const el = await mount(wsTarget)
    const ta = el.querySelector('[data-testid="editor"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(ta, 'changed')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(byText(el, 'Save'))
    await flush()
    expect(memory.write).toHaveBeenCalledWith('a.md', 'changed', wsTarget)
  })

  it('+ New memory calls create with the target', async () => {
    const el = await mount(wsTarget)
    await click(byText(el, '+ New memory'))
    const input = el.querySelector('input[placeholder="my-notes"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'fresh')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(byText(el, 'Create'))
    await flush()
    expect(memory.create).toHaveBeenCalledWith('fresh.md', undefined, wsTarget)
  })

  it('passes an agent target through unchanged', async () => {
    const agentTarget: MemoryTarget = { cwd: '/p', agent: { name: 'x', scope: 'project' } }
    await mount(agentTarget)
    expect(memory.list).toHaveBeenCalledWith(agentTarget)
    expect(memory.stale).toHaveBeenCalledWith(agentTarget)
    expect(memory.read).toHaveBeenCalledWith('a.md', agentTarget)
  })
})

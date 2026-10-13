// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SubagentMemoryView } from '../memory/SubagentMemoryView'

vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: () => createElement('div', { 'data-testid': 'editor' }),
}))
vi.mock('../../../lib/useActiveTab', () => ({
  useActiveTab: () => ({ cwd: '/p' }),
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

const memory = {
  list: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
  create: vi.fn(),
  stale: vi.fn(),
  agents: vi.fn(),
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(SubagentMemoryView))
  })
  await flush()
  return container
}

beforeEach(() => {
  memory.list.mockResolvedValue({ entries: [], dir: '/mem' })
  memory.read.mockResolvedValue({ content: '' })
  memory.stale.mockResolvedValue({ entries: [], index: undefined })
  memory.agents.mockResolvedValue({
    agents: [
      { name: 'alpha', origin: 'project', memoryScope: 'project', agentFile: '/p/.claude/agents/alpha.md' },
      { name: 'beta', origin: 'user', memoryScope: null, agentFile: '/h/.claude/agents/beta.md' },
    ],
  })
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

describe('SubagentMemoryView', () => {
  it('lists agents from memory.agents(cwd)', async () => {
    const el = await mount()
    expect(memory.agents).toHaveBeenCalledWith('/p')
    const opts = Array.from(el.querySelectorAll('option')).map((o) => o.textContent)
    expect(opts.join('|')).toContain('alpha')
    expect(opts.join('|')).toContain('beta')
  })

  it('memory-enabled agent passes the agent target to memory.list', async () => {
    const el = await mount()
    expect(memory.list).toHaveBeenCalledWith({ cwd: '/p', agent: { name: 'alpha', scope: 'project' } })
    expect(el.textContent).toContain('project — shared via git')
  })

  it('memory-less agent shows the enable hint and no write controls', async () => {
    const el = await mount()
    const select = el.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    memory.list.mockClear()
    await act(async () => {
      setter.call(select, 'beta')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(el.textContent).toContain('memory: project')
    expect(el.textContent).toContain('Agent Library')
    expect(el.textContent).not.toContain('+ New memory')
    expect(memory.list).not.toHaveBeenCalled()
  })

  it('shows an empty state when there are no agents', async () => {
    memory.agents.mockResolvedValue({ agents: [] })
    const el = await mount()
    expect(el.textContent).toContain('no agents found')
  })
})

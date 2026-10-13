// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useMemoryExplorer, type MemoryExplorer } from '../memory/explorer/useMemoryExplorer'
import type { ExplorerScope } from '../memory/explorer/model'

const toastError = vi.fn()
vi.mock('../../../state/toast', () => ({
  toast: { error: (m: string) => toastError(m), show: vi.fn(), success: vi.fn() },
}))

let container: HTMLDivElement | null = null
let root: Root | null = null
let latest: MemoryExplorer

const memory = {
  list: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
  create: vi.fn(),
  stale: vi.fn(),
  aggregate: vi.fn(),
  agents: vi.fn(),
  verify: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  listArchived: vi.fn(),
  ask: vi.fn(),
  proposeFix: vi.fn(),
}

function Probe({ scope, cwd }: { scope: ExplorerScope; cwd: string | null }) {
  latest = useMemoryExplorer(scope, cwd)
  return null
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function mount(scope: ExplorerScope = { kind: 'workspace' }) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(Probe, { scope, cwd: '/p' }))
  })
  await flush()
}

const CONTENT = '---\nname: a\ndescription: about a\n---\n\nbody text\n'

beforeEach(() => {
  memory.list.mockResolvedValue({
    entries: [{ name: 'a.md', path: '/mem/a.md', bytes: 10, mtimeMs: Date.now() }],
    dir: '/mem', autoMemoryEnabled: true, error: null, workspace: 'ws',
  })
  memory.read.mockResolvedValue({ content: CONTENT, error: null })
  memory.write.mockResolvedValue({ ok: true, error: null })
  memory.create.mockResolvedValue({ ok: true, error: null })
  memory.delete.mockResolvedValue({ ok: true, error: null })
  memory.stale.mockResolvedValue({ entries: [], workspace: 'ws', error: null })
  memory.aggregate.mockResolvedValue({ workspace: 'ws', generatedAt: 5, clusters: [], orphans: [], cached: true })
  memory.agents.mockResolvedValue({ agents: [] })
  memory.listArchived.mockResolvedValue({ names: [], error: null })
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

describe('useMemoryExplorer', () => {
  it('builds rows on initial load and never pays for aggregate on mount', async () => {
    await mount()
    expect(latest.loading).toBe(false)
    expect(latest.rows.map((r) => r.slug)).toEqual(['a'])
    expect(latest.dir).toBe('/mem')
    expect(memory.aggregate).toHaveBeenCalledTimes(1)
    expect(memory.aggregate.mock.calls[0][1]).toBe(false)
    expect(latest.clustersMeta).toEqual({ generatedAt: 5, running: false })
  })

  it('regenerateClusters passes refresh:true', async () => {
    await mount()
    await act(async () => { await latest.actions.regenerateClusters() })
    expect(memory.aggregate).toHaveBeenLastCalledWith(expect.any(String), true, '/p')
    expect(latest.clustersMeta.running).toBe(false)
  })

  it('remove returns an undo that re-creates with the original content', async () => {
    await mount()
    let undo: (() => Promise<void>) | null = null
    await act(async () => { undo = await latest.actions.remove('a.md') })
    expect(memory.delete).toHaveBeenCalledWith('a.md', expect.anything())
    expect(undo).toBeTypeOf('function')
    await act(async () => { await undo!() })
    expect(memory.create).toHaveBeenCalledWith('a.md', 'about a', expect.anything())
    expect(memory.write).toHaveBeenCalledWith('a.md', CONTENT, expect.anything())
  })

  it('create slugs the title and writes frontmatter + body', async () => {
    await mount()
    let name: string | null = null
    await act(async () => { name = await latest.actions.create('Deploy Freeze', '\nno deploys\nmore') })
    expect(name).toBe('deploy_freeze')
    const written = memory.write.mock.calls.at(-1)![1] as string
    expect(written).toContain('name: deploy_freeze')
    expect(written).toContain('description: no deploys')
    expect(written).toContain('more')
  })

  it('an agent without memory loads nothing', async () => {
    await mount({ kind: 'agent', agent: { name: 'x', origin: 'user', memoryScope: null, agentFile: '/x.md' } })
    expect(latest.rows).toEqual([])
    expect(latest.target).toBeNull()
    expect(memory.aggregate).not.toHaveBeenCalled()
    const listCalls = memory.list.mock.calls.filter((c) => !c[0]?.agent || c[0].agent.name === 'x')
    expect(listCalls).toEqual([])
  })

  it('a failed IPC result toasts and resolves falsy', async () => {
    await mount()
    memory.delete.mockResolvedValue({ ok: false, error: 'EPERM' })
    let undo: unknown = 'unset'
    await act(async () => { undo = await latest.actions.remove('a.md') })
    expect(undo).toBeNull()
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('EPERM'))
  })
})

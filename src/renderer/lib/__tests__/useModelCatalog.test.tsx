// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useModelCatalog, __resetModelCatalogForTests } from '../useModelCatalog'

const CATALOG = {
  aliases: ['haiku', 'sonnet'], models: [], effortLevels: ['low', 'high'], settingsEffortLevels: ['low'],
  availableModels: null, claudeVersion: '1.0.0', probedAt: null,
  sources: { aliases: 'probe', models: 'floor', effortLevels: 'probe' }, degraded: false,
}

type Result = ReturnType<typeof useModelCatalog>
let latest: Record<string, Result> = {}

function Consumer({ id, cwd }: { id: string; cwd: string | null }) {
  latest[id] = useModelCatalog(cwd)
  return null
}

function install(impl: ReturnType<typeof vi.fn>) {
  ;(window as unknown as { api: unknown }).api = { models: { catalog: impl } }
}

let container: HTMLDivElement
let root: Root

async function mount(...ids: string[]) {
  container = document.createElement('div')
  root = createRoot(container)
  await act(async () => {
    root.render(createElement('div', null, ids.map((id) => createElement(Consumer, { key: id, id, cwd: '/p' }))))
  })
}

beforeEach(() => { __resetModelCatalogForTests(); latest = {} })
afterEach(() => { act(() => root.unmount()) })

describe('useModelCatalog', () => {
  it('populates catalog on first mount', async () => {
    const invoke = vi.fn().mockResolvedValue(CATALOG)
    install(invoke)
    await mount('a')
    expect(latest.a.catalog).toEqual(CATALOG)
    expect(latest.a.loading).toBe(false)
    expect(invoke).toHaveBeenCalledWith({ cwd: '/p' })
  })

  it('degrades to null on a rejected IPC without throwing', async () => {
    install(vi.fn().mockRejectedValue(new Error('boom')))
    await mount('a')
    expect(latest.a.catalog).toBeNull()
    expect(latest.a.loading).toBe(false)
    expect(latest.a.degraded).toBe(true)
  })

  it('two mounts for the same cwd issue one invoke', async () => {
    const invoke = vi.fn().mockResolvedValue(CATALOG)
    install(invoke)
    await mount('a', 'b')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(latest.b.catalog).toEqual(CATALOG)
  })

  it('refresh() issues a force:true invoke', async () => {
    const invoke = vi.fn().mockResolvedValue(CATALOG)
    install(invoke)
    await mount('a')
    await act(async () => { await latest.a.refresh() })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith({ cwd: '/p', force: true })
  })
})

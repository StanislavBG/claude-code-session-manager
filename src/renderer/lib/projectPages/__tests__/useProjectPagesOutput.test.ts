// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { useProjectPagesOutput } from '../useProjectPagesOutput'

type Out = ReturnType<typeof useProjectPagesOutput>
let root: Root | null = null
let latest: Out
const get = vi.fn()
const res = (knowledge: unknown[] = []) => ({ ok: true, html: null, mtimeMs: null, demoVideo: null, knowledge, videos: [] })

function Probe({ cwd }: { cwd: string | null }) {
  latest = useProjectPagesOutput(cwd)
  return null
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const render = (cwd: string | null) => act(() => root!.render(createElement(Probe, { cwd })))

beforeEach(() => {
  get.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    projectPages: { get, watch: vi.fn(), unwatch: vi.fn(), onChanged: () => () => {} },
  }
  root = createRoot(document.createElement('div'))
})
afterEach(() => act(() => root?.unmount()))

describe('useProjectPagesOutput', () => {
  it('resolve sets loaded with the lists', async () => {
    get.mockResolvedValue(res([{ id: 'a' }]))
    render('/p')
    expect(latest.loaded).toBe(false)
    await flush()
    expect(latest.loaded).toBe(true)
    expect(latest.error).toBeNull()
    expect(latest.knowledge).toHaveLength(1)
  })

  it('reject sets error and loaded; reload refetches and clears error', async () => {
    get.mockRejectedValueOnce(new Error('slow')).mockResolvedValueOnce(res())
    render('/p')
    await flush()
    expect(latest.error).toBe('slow')
    expect(latest.loaded).toBe(true)
    act(() => latest.reload())
    expect(latest.error).toBeNull()
    expect(latest.loaded).toBe(false)
    await flush()
    expect(get).toHaveBeenCalledTimes(2)
    expect(latest.loaded).toBe(true)
    expect(latest.error).toBeNull()
  })

  it('a cwd change sets loaded false until the new get resolves; stale response ignored', async () => {
    let resolveOld!: (v: unknown) => void
    get.mockImplementationOnce(() => new Promise((r) => { resolveOld = r }))
    render('/a')
    get.mockResolvedValueOnce(res([{ id: 'new' }]))
    render('/b')
    expect(latest.loaded).toBe(false)
    await flush()
    expect(latest.knowledge).toEqual([{ id: 'new' }])
    resolveOld(res([{ id: 'old' }]))
    await flush()
    expect(latest.knowledge).toEqual([{ id: 'new' }])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppPreviewState } from '../../../preload/api'

const toastError = vi.fn()
const toastInfo = vi.fn()
vi.mock('../toast', () => ({ toast: { error: toastError, info: toastInfo } }))

function preview(over: Partial<AppPreviewState> = {}): AppPreviewState {
  return {
    epicId: 'e1',
    cwd: '/p',
    dir: '/p/wt',
    script: 'dev',
    command: 'vite',
    port: 5173,
    url: 'http://localhost:5173',
    status: 'starting',
    error: null,
    pid: 42,
    startedAt: '2026-11-12T10:00:00.000Z',
    ...over,
  }
}

type Handler = (s: AppPreviewState) => void

function stubApi(listImpl: () => Promise<AppPreviewState[]>) {
  const handlers: Handler[] = []
  const api = {
    list: vi.fn(listImpl),
    onChanged: vi.fn((h: Handler) => {
      handlers.push(h)
      return () => {}
    }),
  }
  vi.stubGlobal('window', { api: { appPreview: api } })
  return { api, emit: (s: AppPreviewState) => handlers.forEach((h) => h(s)) }
}

async function load() {
  return import('../appPreview')
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.resetModules()
  toastError.mockReset()
  toastInfo.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('appPreview store', () => {
  it('subscribes and hydrates at most once', async () => {
    const { api } = stubApi(async () => [])
    const mod = await load()
    mod.ensureAppPreviewSubscription()
    mod.ensureAppPreviewSubscription()
    await flush()
    expect(api.onChanged).toHaveBeenCalledTimes(1)
    expect(api.list).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when window.api.appPreview is missing', async () => {
    vi.stubGlobal('window', { api: {} })
    const mod = await load()
    expect(() => mod.ensureAppPreviewSubscription()).not.toThrow()
    expect(mod.useAppPreview.getState().byEpic).toEqual({})
    vi.stubGlobal('window', undefined)
    expect(() => mod.ensureAppPreviewSubscription()).not.toThrow()
  })

  it('hydrates byEpic from list() keyed by epicId', async () => {
    const a = preview({ epicId: 'a' })
    const b = preview({ epicId: 'b', status: 'starting' })
    stubApi(async () => [a, b])
    const mod = await load()
    mod.ensureAppPreviewSubscription()
    await flush()
    expect(mod.useAppPreview.getState().byEpic).toEqual({ a, b })
  })

  it('toasts a rejected list()', async () => {
    stubApi(async () => {
      throw new Error('boom')
    })
    const mod = await load()
    mod.ensureAppPreviewSubscription()
    await flush()
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(String(toastError.mock.calls[0][0])).toContain('boom')
  })

  it('upserts every onChanged state by epicId', async () => {
    const { emit } = stubApi(async () => [])
    const mod = await load()
    mod.ensureAppPreviewSubscription()
    await flush()
    emit(preview({ epicId: 'x' }))
    emit(preview({ epicId: 'y' }))
    const running = preview({ epicId: 'x', status: 'running' })
    emit(running)
    const byEpic = mod.useAppPreview.getState().byEpic
    expect(Object.keys(byEpic).sort()).toEqual(['x', 'y'])
    expect(byEpic.x).toEqual(running)
  })

  it("toasts 'Preview failed: ' + error on a failed state", async () => {
    const mod = await load()
    mod.useAppPreview.getState().upsert(preview({ status: 'failed', error: 'port in use' }))
    expect(toastError).toHaveBeenCalledWith('Preview failed: port in use')
  })

  it('toasts the error of a stopped state with an error, not a clean stop', async () => {
    const mod = await load()
    mod.useAppPreview.getState().upsert(preview({ status: 'stopped', error: null }))
    expect(toastError).not.toHaveBeenCalled()
    mod.useAppPreview.getState().upsert(preview({ status: 'stopped', error: 'exited with code 1', startedAt: 't2' }))
    expect(toastError).toHaveBeenCalledWith('exited with code 1')
  })

  it("toasts 'Preview running at ' + url on the first running state", async () => {
    const mod = await load()
    mod.useAppPreview.getState().upsert(preview({ status: 'starting' }))
    expect(toastInfo).not.toHaveBeenCalled()
    mod.useAppPreview.getState().upsert(preview({ status: 'running' }))
    expect(toastInfo).toHaveBeenCalledWith('Preview running at http://localhost:5173')
  })

  it('de-duplicates the same epicId + startedAt + status', async () => {
    const mod = await load()
    const { upsert } = mod.useAppPreview.getState()
    upsert(preview({ status: 'running' }))
    upsert(preview({ status: 'running' }))
    upsert(preview({ status: 'failed', error: 'x' }))
    upsert(preview({ status: 'failed', error: 'x' }))
    expect(toastInfo).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledTimes(1)
    // A new start (new startedAt) toasts again.
    upsert(preview({ status: 'running', startedAt: '2026-11-12T11:00:00.000Z' }))
    expect(toastInfo).toHaveBeenCalledTimes(2)
  })
})

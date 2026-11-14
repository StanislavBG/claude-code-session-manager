// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { AgentCliDetectRow } from '../../../preload/api'

type Mod = typeof import('../useAgentCliDetect')
type ToastMod = typeof import('../../state/toast')
type Result = ReturnType<Mod['useAgentCliDetect']>

const row = (id: AgentCliDetectRow['id'], installed: boolean): AgentCliDetectRow => ({
  id, label: id, installed, path: installed ? `/usr/bin/${id}` : null, version: installed ? '1.0.0' : null,
  install: installed ? null : `npm i -g ${id}`, docs: `https://example.com/${id}`, login: null,
})
const ROWS = [row('codex', true), row('gemini', false)]

let mod: Mod
let toastMod: ToastMod
let latest: Record<string, Result> = {}
let container: HTMLDivElement
let root: Root | null = null

function Consumer({ id, enabled }: { id: string; enabled: boolean }) {
  latest[id] = mod.useAgentCliDetect(enabled)
  return null
}

function install(detect: unknown) {
  ;(window as unknown as { api: unknown }).api = { agentCli: { detect } }
}

async function render(consumers: Array<{ id: string; enabled?: boolean }>) {
  if (!root) {
    container = document.createElement('div')
    root = createRoot(container)
  }
  await act(async () => {
    root!.render(createElement('div', null, consumers.map(({ id, enabled = true }) => createElement(Consumer, { key: id, id, enabled }))))
  })
}

beforeEach(async () => {
  vi.resetModules()
  mod = await import('../useAgentCliDetect')
  toastMod = await import('../../state/toast')
  latest = {}
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

const errorToasts = () => toastMod.useToast.getState().toasts.filter((t) => t.kind === 'error')

describe('useAgentCliDetect', () => {
  it('two concurrent consumers share one detect call and the same rows', async () => {
    const detect = vi.fn().mockResolvedValue(ROWS)
    install(detect)
    await render([{ id: 'a' }, { id: 'b' }])
    expect(detect).toHaveBeenCalledTimes(1)
    expect(detect).toHaveBeenCalledWith({})
    expect(latest.a.rows).toEqual(ROWS)
    expect(latest.b.rows).toEqual(ROWS)
    expect(latest.a.checking).toBe(false)
  })

  it('enabled false makes no call until it turns true', async () => {
    const detect = vi.fn().mockResolvedValue(ROWS)
    install(detect)
    await render([{ id: 'a', enabled: false }])
    expect(detect).not.toHaveBeenCalled()
    expect(latest.a.rows).toBeNull()
    await render([{ id: 'a', enabled: true }])
    expect(detect).toHaveBeenCalledTimes(1)
    expect(latest.a.rows).toEqual(ROWS)
  })

  it('recheck calls detect with refresh:true and updates every consumer', async () => {
    const detect = vi.fn().mockResolvedValue(ROWS)
    install(detect)
    await render([{ id: 'a' }, { id: 'b' }])
    const next = [row('codex', true), row('gemini', true)]
    detect.mockResolvedValue(next)
    await act(async () => { await latest.a.recheck() })
    expect(detect).toHaveBeenLastCalledWith({ refresh: true })
    expect(latest.a.rows).toEqual(next)
    expect(latest.b.rows).toEqual(next)
  })

  it('a rejected call sets rows to [] and shows exactly one error toast', async () => {
    install(vi.fn().mockRejectedValue(new Error('boom')))
    await render([{ id: 'a' }, { id: 'b' }])
    expect(latest.a.rows).toEqual([])
    expect(latest.b.rows).toEqual([])
    expect(errorToasts().map((t) => t.message)).toEqual(['Could not detect agent CLIs: boom'])
  })

  it('a missing detect function sets rows to [] and toasts once', async () => {
    install(undefined)
    await render([{ id: 'a' }])
    expect(latest.a.rows).toEqual([])
    expect(errorToasts()).toHaveLength(1)
    expect(errorToasts()[0].message).toMatch(/^Could not detect agent CLIs: /)
  })
})

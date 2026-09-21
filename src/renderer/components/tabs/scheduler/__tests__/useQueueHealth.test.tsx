// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const gate = vi.hoisted(() => ({ focused: true, visible: true }))
vi.mock('../../../../lib/panelFocus', () => ({ usePanelFocus: () => gate.focused }))
vi.mock('../../../../lib/useDocumentVisible', () => ({ useDocumentVisible: () => gate.visible }))

import { useQueueHealth } from '../SchedulerTopBands'
import { useToast } from '../../../../state/toast'

const queueHealth = vi.fn()
let container: HTMLDivElement
let root: Root

function Probe() {
  useQueueHealth('/p')
  return null
}
const render = () => act(async () => { root.render(createElement(Probe)) })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.useFakeTimers()
  gate.focused = true
  gate.visible = true
  queueHealth.mockReset()
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  ;(window as unknown as { api: unknown }).api = { schedule: { queueHealth } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const errorToasts = () => useToast.getState().history.filter((t) => t.kind === 'error')

describe('useQueueHealth', () => {
  it('makes 0 IPC calls over 60s while hidden', async () => {
    gate.focused = false
    queueHealth.mockResolvedValue({})
    await render()
    await advance(60_000)
    expect(queueHealth).not.toHaveBeenCalled()
  })

  it('polls at cadence while visible and loads immediately on regaining focus', async () => {
    queueHealth.mockResolvedValue({})
    gate.focused = false
    await render()
    gate.focused = true
    await render()
    expect(queueHealth).toHaveBeenCalledTimes(1)
    await advance(45_000)
    expect(queueHealth).toHaveBeenCalledTimes(4)
  })

  it('skips ticks while the previous call is still in flight', async () => {
    let resolve!: (v: unknown) => void
    queueHealth.mockImplementation(() => new Promise((r) => { resolve = r }))
    await render()
    await advance(60_000)
    expect(queueHealth).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({}) })
    await advance(15_000)
    expect(queueHealth).toHaveBeenCalledTimes(2)
  })

  it('toasts once per failure streak and resets on success', async () => {
    queueHealth.mockRejectedValue(new Error('boom'))
    await render()
    await advance(60_000)
    expect(errorToasts()).toHaveLength(1)
    queueHealth.mockResolvedValueOnce({})
    await advance(15_000)
    queueHealth.mockRejectedValue(new Error('boom2'))
    await advance(15_000)
    expect(errorToasts()).toHaveLength(2)
  })
})

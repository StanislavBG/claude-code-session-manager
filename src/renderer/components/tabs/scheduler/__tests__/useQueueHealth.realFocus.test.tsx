// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { useQueueHealth } from '../SchedulerTopBands'
import { PanelFocusProvider } from '../../../../lib/panelFocus'
import { useLayout } from '../../../../state/layout'

const queueHealth = vi.fn()
let container: HTMLDivElement
let root: Root

function Probe() {
  useQueueHealth('/p')
  return null
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.useFakeTimers()
  queueHealth.mockReset().mockResolvedValue({})
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

describe('useQueueHealth under a real PanelFocusProvider', () => {
  it('makes 0 calls over 60s unfocused, then polls at the 15s cadence once focused', async () => {
    useLayout.setState({ focusedPanelId: 'terminal' })
    await act(async () => {
      root.render(createElement(PanelFocusProvider, { panelId: 'scheduler', children: createElement(Probe) }))
    })
    await advance(60_000)
    expect(queueHealth).not.toHaveBeenCalled()
    await act(async () => { useLayout.setState({ focusedPanelId: 'scheduler' }) })
    expect(queueHealth).toHaveBeenCalledTimes(1)
    await advance(45_000)
    expect(queueHealth).toHaveBeenCalledTimes(4)
  })
})

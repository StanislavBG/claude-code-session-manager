// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useSessionSlots, setSessionSlots, __resetSessionSlotsForTests } from '../useSessionSlots'
import { PanelFocusProvider } from '../panelFocus'
import { useLayout } from '../../state/layout'

/**
 * Coverage for the shared session-slots poller (performance PRD): before
 * this, Home's Hero + ActiveSessionsCard and SessionManagerConfig each ran
 * their own independent 5s `sessionSlots()` poll — three IPC calls a tick
 * for one machine-wide pool snapshot, kept alive forever since dockview
 * never unmounts a screen it has opened. This asserts the collapsed
 * singleton issues exactly one call per interval no matter how many
 * consumers are mounted, and that it stops entirely (and catches up
 * immediately) as focus comes and goes.
 */

const PANEL_A = 'panel-a'
const PANEL_B = 'panel-b'

function Consumer({ panelId }: { panelId?: string }) {
  useSessionSlots(panelId)
  return null
}

function installMock() {
  const sessionSlots = vi.fn().mockResolvedValue({
    total: 5, inUse: 1, holders: [], min: 0, max: 10, default: 5, envOverride: false,
  })
  ;(window as unknown as { api: { schedule: { sessionSlots: typeof sessionSlots } } }).api = {
    schedule: { sessionSlots },
  }
  return sessionSlots
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  __resetSessionSlotsForTests()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
  __resetSessionSlotsForTests()
  vi.useRealTimers()
})

describe('useSessionSlots — shared poller', () => {
  it('issues exactly one IPC call per interval with two focused consumers mounted', async () => {
    const sessionSlots = installMock()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(
        createElement('div', null, createElement(Consumer), createElement(Consumer)),
      )
      await Promise.resolve()
    })
    expect(sessionSlots).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
    })
    expect(sessionSlots).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
    })
    expect(sessionSlots).toHaveBeenCalledTimes(3)
  })

  it('stops polling once the last focused consumer unfocuses, and resumes on refocus', async () => {
    const sessionSlots = installMock()
    useLayout.setState({ focusedPanelId: PANEL_A })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(
        createElement(PanelFocusProvider, { panelId: PANEL_A, children: createElement(Consumer) }),
      )
      await Promise.resolve()
    })
    expect(sessionSlots).toHaveBeenCalledTimes(1)
    sessionSlots.mockClear()

    await act(async () => {
      useLayout.setState({ focusedPanelId: PANEL_B })
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(20_000)
      await Promise.resolve()
    })
    expect(sessionSlots).not.toHaveBeenCalled()

    await act(async () => {
      useLayout.setState({ focusedPanelId: PANEL_A })
      await Promise.resolve()
    })
    expect(sessionSlots).toHaveBeenCalledTimes(1)
  })
})

describe('setSessionSlots — single write path', () => {
  function installWriteMock(setImpl: () => Promise<unknown> = () => Promise.resolve()) {
    const sessionSlots = vi.fn().mockResolvedValue({
      total: 5, inUse: 1, holders: [], min: 0, max: 10, default: 5, envOverride: false,
    })
    const setSlots = vi.fn(setImpl)
    ;(window as unknown as { api: unknown }).api = {
      schedule: { sessionSlots, setSessionSlots: setSlots },
    }
    return { sessionSlots, setSlots }
  }

  async function mountConsumer() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(Consumer))
      await Promise.resolve()
    })
  }

  it('clamps a value above max to the snapshot max', async () => {
    const { setSlots } = installWriteMock()
    await mountConsumer()
    await act(async () => { await setSessionSlots(99) })
    expect(setSlots).toHaveBeenCalledTimes(1)
    expect(setSlots).toHaveBeenCalledWith(10)
  })

  it('applies no clamp when no snapshot is cached yet', async () => {
    const { setSlots } = installWriteMock()
    await setSessionSlots(99)
    expect(setSlots).toHaveBeenCalledWith(99)
  })

  it('re-polls sessionSlots() after a successful set', async () => {
    const { sessionSlots } = installWriteMock()
    await mountConsumer()
    sessionSlots.mockClear()
    await act(async () => { await setSessionSlots(3) })
    expect(sessionSlots).toHaveBeenCalledTimes(1)
  })

  it('rejects the returned promise when the write fails', async () => {
    const { sessionSlots } = installWriteMock(() => Promise.reject(new Error('boom')))
    await mountConsumer()
    sessionSlots.mockClear()
    await expect(setSessionSlots(3)).rejects.toThrow('boom')
    expect(sessionSlots).not.toHaveBeenCalled()
  })
})

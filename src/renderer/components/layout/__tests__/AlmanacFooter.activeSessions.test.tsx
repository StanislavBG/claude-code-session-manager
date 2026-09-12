// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AlmanacFooter } from '../AlmanacFooter'
import { useBilling } from '../../../state/billing'
import { __resetSessionSlotsForTests } from '../../../lib/useSessionSlots'

/**
 * The footer's active-sessions dot row must mirror the machine-wide
 * claude -p slot pool exactly and route to Home's ActiveSessionsCard, so it
 * can never drift from the Session pool card in SessionManagerConfig.tsx.
 */

let container: HTMLDivElement
let root: Root

function setSlots(sessionSlots: ReturnType<typeof vi.fn> | null) {
  ;(window as unknown as { api: unknown }).api = {
    app: { gitBranch: vi.fn().mockResolvedValue(null) },
    schedule: sessionSlots ? { sessionSlots } : undefined,
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'
  setSlots(null)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useBilling.setState({ data: null, refreshing: false })
  __resetSessionSlotsForTests()
})

function render(onNavigate?: (k: string) => void) {
  act(() => {
    root.render(createElement(AlmanacFooter, { onNavigate: onNavigate as never }))
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const btn = () => container.querySelector<HTMLButtonElement>('[data-testid="footer-active-sessions"]')
const dots = () => Array.from(container.querySelectorAll<HTMLSpanElement>('[data-testid="slot-dot"]'))

describe('AlmanacFooter active sessions indicator', () => {
  it('renders 5 empty dots when the snapshot is still null', async () => {
    render()
    await flush()
    const d = dots()
    expect(d.length).toBe(5)
    expect(d.every((el) => el.getAttribute('data-filled') === 'false')).toBe(true)
    expect(btn()?.title).toBe('— / 5 Claude sessions running')
  })

  it('fills exactly inUse dots for a resolved snapshot', async () => {
    setSlots(vi.fn().mockResolvedValue({
      total: 5,
      inUse: 2,
      holders: [{ owner: 'scheduler:foo', at: new Date().toISOString() }],
      min: 0,
      max: 10,
      default: 5,
      envOverride: false,
    }))
    render()
    await flush()
    const d = dots()
    expect(d.length).toBe(5)
    expect(d.filter((el) => el.getAttribute('data-filled') === 'true').length).toBe(2)
  })

  it('renders "pool paused" and no dots when total is 0', async () => {
    setSlots(vi.fn().mockResolvedValue({
      total: 0,
      inUse: 0,
      holders: [],
      min: 0,
      max: 10,
      default: 5,
      envOverride: false,
    }))
    render()
    await flush()
    expect(dots().length).toBe(0)
    expect(btn()?.textContent).toContain('pool paused')
  })

  it('clamps filled dots to total when inUse exceeds it', async () => {
    setSlots(vi.fn().mockResolvedValue({
      total: 3,
      inUse: 7,
      holders: [],
      min: 0,
      max: 10,
      default: 5,
      envOverride: false,
    }))
    render()
    await flush()
    const d = dots()
    expect(d.length).toBe(3)
    expect(d.every((el) => el.getAttribute('data-filled') === 'true')).toBe(true)
  })

  it('routes to Home on click', async () => {
    const onNavigate = vi.fn()
    render(onNavigate)
    await flush()
    act(() => { btn()!.click() })
    expect(onNavigate).toHaveBeenCalledWith('overview')
  })

  it('places the active-sessions button before the version text in DOM order', async () => {
    render()
    await flush()
    const statusbar = container.querySelector('[data-testid="tour-statusbar"]')!
    const children = Array.from(statusbar.children)
    const btnIndex = children.indexOf(btn()!)
    const versionIndex = children.findIndex((c) => c.textContent?.includes('0.0.0-test'))
    expect(btnIndex).toBeGreaterThan(-1)
    expect(versionIndex).toBeGreaterThan(-1)
    expect(btnIndex).toBeLessThan(versionIndex)
  })
})

// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AlmanacFooter } from '../AlmanacFooter'
import { useBilling } from '../../../state/billing'

/**
 * The bottom information bar must state BOTH billing windows the Home usage
 * meters show — session (5h) and weekly (7d) — and each must be a live route
 * into Home, where the full meters live. A weekly pill that renders but does
 * nothing on click is the regression this guards.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'
  ;(window as unknown as { api: unknown }).api = {
    app: { gitBranch: vi.fn().mockResolvedValue(null) },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useBilling.setState({ data: null, refreshing: false })
})

function setUsage(fiveHour: number | null, sevenDay: number | null) {
  act(() => {
    useBilling.setState({
      data: {
        kind: 'ok',
        data: {
          usage: {
            five_hour: fiveHour == null ? null : { utilization: fiveHour, resets_at: null },
            seven_day: sevenDay == null ? null : { utilization: sevenDay, resets_at: null },
            seven_day_sonnet: null,
            seven_day_opus: null,
            seven_day_oauth_apps: null,
            extra_usage: null,
          },
          subscriptionType: null,
          rateLimitTier: null,
          credentialsExpiresAt: null,
          fetchedAt: Date.now(),
        },
      },
      refreshing: false,
    } as never)
  })
}

function render(onNavigate?: (k: string) => void) {
  act(() => {
    root.render(createElement(AlmanacFooter, { onNavigate: onNavigate as never }))
  })
}

const pill = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)

describe('AlmanacFooter usage pills', () => {
  it('shows both the session and the weekly percentage', () => {
    render()
    setUsage(42.4, 78.6)
    expect(pill('footer-usage-session')?.textContent).toContain('42%')
    expect(pill('footer-usage-weekly')?.textContent).toContain('79%')
  })

  it('routes both pills to Home', () => {
    const onNavigate = vi.fn()
    render(onNavigate)
    setUsage(10, 20)
    act(() => { pill('footer-usage-session')!.click() })
    act(() => { pill('footer-usage-weekly')!.click() })
    expect(onNavigate.mock.calls.map((c) => c[0])).toEqual(['overview', 'overview'])
  })

  it('renders an em-dash rather than disappearing when a window is unavailable', () => {
    render()
    setUsage(null, null)
    expect(pill('footer-usage-session')?.textContent).toContain('—')
    expect(pill('footer-usage-weekly')?.textContent).toContain('—')
  })

  it('carries a tooltip naming the window it reports', () => {
    render()
    setUsage(5, 6)
    expect(pill('footer-usage-session')?.title).toContain('Session (5h window)')
    expect(pill('footer-usage-weekly')?.title).toContain('Weekly window (all models)')
  })
})

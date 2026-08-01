// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { Browser } from '../Browser'
import { useBrowserState } from '../../../state/browser'

/**
 * Browser.tsx's onOpenTabRequest wiring — main process denies non-identity-
 * provider window.open() popups and forwards the URL via
 * `browser:open-tab-request` (browserView.cjs); this asserts the renderer
 * actually turns that broadcast into a new sub-tab via the same openTab()
 * path SubTabStrip's "+" button uses, rather than dropping it silently.
 */

vi.mock('../browser/SubTabStrip', () => ({ SubTabStrip: () => null }))
vi.mock('../browser/AddressBar', () => ({ AddressBar: () => null }))
vi.mock('../browser/ActionBar', () => ({ ActionBar: () => null }))
vi.mock('../browser/CapturePanel', () => ({ CapturePanel: () => null }))
vi.mock('../browser/RecorderPanel', () => ({ RecorderPanel: () => null }))
vi.mock('../browser/ObservePanel', () => ({ ObservePanel: () => null }))
vi.mock('../browser/FindBar', () => ({ FindBar: () => null }))

class FakeResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

function installWindowApiMock() {
  let openTabRequestHandler: ((payload: { url: string }) => void) | null = null
  const api = {
    browser: {
      onOpenTabRequest: vi.fn((handler: (payload: { url: string }) => void) => {
        openTabRequestHandler = handler
        return () => {
          openTabRequestHandler = null
        }
      }),
      create: vi.fn().mockResolvedValue({ ok: true }),
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      show: vi.fn().mockResolvedValue({ ok: true }),
      hide: vi.fn().mockResolvedValue({ ok: true }),
      setBounds: vi.fn().mockResolvedValue({ ok: true }),
      onNavState: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, fireOpenTabRequest: (url: string) => openTabRequestHandler?.({ url }) }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  useBrowserState.setState({ tabs: [], activeTabId: null })
  delete (window as unknown as { api?: unknown }).api
})

describe('Browser — browser:open-tab-request wiring', () => {
  it('opens a denied popup URL as a new sub-tab and focuses it', () => {
    const { fireOpenTabRequest } = installWindowApiMock()
    mount(createElement(Browser))

    const before = useBrowserState.getState().tabs.length
    act(() => {
      fireOpenTabRequest('https://example.com/share')
    })

    const { tabs, activeTabId } = useBrowserState.getState()
    expect(tabs.length).toBe(before + 1)
    const newTab = tabs.find((t) => t.id === activeTabId)
    expect(newTab).toBeDefined()
    expect(newTab!.url).toBe('https://example.com/share')
  })

  it('registers exactly one onOpenTabRequest listener per mount', () => {
    const { api } = installWindowApiMock()
    mount(createElement(Browser))
    expect(api.browser.onOpenTabRequest).toHaveBeenCalledTimes(1)
  })
})

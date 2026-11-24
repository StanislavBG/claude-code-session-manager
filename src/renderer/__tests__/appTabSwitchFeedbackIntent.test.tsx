// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useTabSwitchTerminalRouting } from '../App'
import { useSessions, type SessionTab } from '../state/sessions'
import { useLayout } from '../state/layout'
import { useCustomerFeedback, FEEDBACK_TAB_INTENT_TTL_MS } from '../state/customerFeedback'
import { ProjectHome } from '../components/tabs/projecthome/ProjectHome'

// Drives App's real tab-switch effect (the hook App mounts) against the real stores.
function Harness({ home = false }: { home?: boolean }) {
  useTabSwitchTerminalRouting()
  return home ? <ProjectHome /> : null
}

// Every window.api namespace answers: listeners return an unsubscribe, everything else resolves empty.
function stubApi() {
  const ns = () =>
    new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) =>
        (t[k] ??= vi.fn((..._a: unknown[]) => (k.startsWith('on') ? () => {} : Promise.resolve(k === 'get' ? null : [])))),
    })
  const api: Record<string, unknown> = {}
  ;(window as unknown as { api: unknown }).api = new Proxy(api, { get: (t, k: string) => (t[k] ??= ns()) })
}

const tab = (id: string, cwd: string) => ({ id, cwd, label: id }) as unknown as SessionTab

let container: HTMLDivElement | null = null
let root: Root | null = null
let openProjectPanel: ReturnType<typeof vi.fn>

function mount(home = false) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Harness home={home} />))
}

const feedbackKey = () =>
  container!.querySelector('[data-testid="project-home-key"][data-tab="feedback"]') as HTMLButtonElement | null

const switchTo = (id: string) => act(() => useSessions.setState({ activeTabId: id }))

beforeEach(() => {
  useSessions.setState({
    tabs: [tab('a', '/owner'), tab('b', '/other'), tab('c', '')],
    activeTabId: 'a',
  })
  useCustomerFeedback.setState({ feedbackTabIntent: null })
  openProjectPanel = vi.fn()
  useLayout.setState({ openProjectPanel } as never)
  stubApi()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('App tab-switch routing vs. the Feedback-tab intent', () => {
  it('a switch to a tab with no cwd cancels a pending intent, so a later plain switch routes to the terminal', () => {
    mount()
    useCustomerFeedback.getState().requestFeedbackTab('/other')
    switchTo('c')
    expect(useCustomerFeedback.getState().feedbackTabIntent).toBeNull()
    expect(openProjectPanel).toHaveBeenCalledTimes(1)
    openProjectPanel.mockClear()
    // The stale intent no longer suppresses routing on a plain switch into its project.
    switchTo('b')
    expect(openProjectPanel).toHaveBeenCalledWith('terminal')
  })

  it('an expired intent does not suppress terminal routing on a plain switch', () => {
    mount()
    useCustomerFeedback.setState({
      feedbackTabIntent: { cwd: '/other', requestedAt: Date.now() - FEEDBACK_TAB_INTENT_TTL_MS - 1 },
    })
    switchTo('b')
    expect(openProjectPanel).toHaveBeenCalledWith('terminal')
  })

  it('a fresh matching intent keeps the navigation and Project Home opens on Feedback once', async () => {
    mount(true)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(feedbackKey()?.getAttribute('aria-pressed')).toBe('false')
    await act(async () => {
      useCustomerFeedback.getState().requestFeedbackTab('/other')
      useSessions.setState({ activeTabId: 'b' })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(openProjectPanel).not.toHaveBeenCalled()
    expect(feedbackKey()?.getAttribute('aria-pressed')).toBe('true')
    // Consumed: the one-shot intent is gone, so it can't reopen Feedback or suppress routing again.
    expect(useCustomerFeedback.getState().feedbackTabIntent).toBeNull()
    switchTo('a')
    switchTo('b')
    expect(openProjectPanel).toHaveBeenCalledTimes(2)
    expect(openProjectPanel).toHaveBeenLastCalledWith('terminal')
  })
})

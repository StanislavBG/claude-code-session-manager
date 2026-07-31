// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectsLanding } from '../ProjectsLanding'
import { usePromptSessions } from '../../state/promptSessions'

const createPromptSessionSpy = vi.fn(usePromptSessions.getState().createPromptSession)

vi.mock('../../lib/useKnownProjects', () => ({
  useKnownProjects: () => ({
    rows: [
      { encoded: '-home-bilko-Projects-alpha', displayPath: '', sessionCount: 0, lastSession: 0, path: '', sizeBytes: 0 },
      { encoded: '-home-bilko-Projects-beta', displayPath: '', sessionCount: 0, lastSession: 0, path: '', sizeBytes: 0 },
    ],
    enriched: {
      '-home-bilko-Projects-alpha': { cwd: '/home/bilko/Projects/alpha' },
      '-home-bilko-Projects-beta': { cwd: '/home/bilko/Projects/beta' },
    },
    loading: false,
  }),
  candidatePath: (encoded: string) => encoded.replace(/-/g, '/'),
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

beforeEach(() => {
  usePromptSessions.setState({ sessions: {}, events: {} })
  usePromptSessions.setState({ createPromptSession: createPromptSessionSpy })
  createPromptSessionSpy.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('ProjectsLanding', () => {
  it('renders sessions grouped by cwd', () => {
    act(() => {
      usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'ship the widget')
      usePromptSessions.getState().createPromptSession('/home/bilko/Projects/beta', 'fix the flaky test')
    })

    const el = mount(<ProjectsLanding />)
    const groups = el.querySelectorAll('[data-testid="prompt-session-group"]')
    expect(groups).toHaveLength(2)
    expect(el.textContent).toContain('ship the widget')
    expect(el.textContent).toContain('fix the flaky test')
  })

  it('visually distinguishes active vs completed sessions', () => {
    act(() => {
      usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'active goal')
    })
    const activeId = Object.values(usePromptSessions.getState().sessions)[0].id
    act(() => {
      usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'completed goal')
    })
    const completedId = Object.values(usePromptSessions.getState().sessions).find((s) => s.goalText === 'completed goal')!.id
    act(() => {
      usePromptSessions.setState((s) => ({
        sessions: {
          ...s.sessions,
          [completedId]: { ...s.sessions[completedId], status: 'completed', completedAt: new Date().toISOString() },
        },
      }))
    })

    const el = mount(<ProjectsLanding />)
    const rows = el.querySelectorAll('[data-testid="prompt-session-row"]')
    expect(rows).toHaveLength(2)
    const activeRow = Array.from(rows).find((r) => (r as HTMLElement).dataset.status === 'active')!
    const completedRow = Array.from(rows).find((r) => (r as HTMLElement).dataset.status === 'completed')!
    expect(activeRow.querySelector('[data-testid="prompt-session-status-badge"]')?.textContent).toBe('Active')
    expect(completedRow.querySelector('[data-testid="prompt-session-status-badge"]')?.textContent).toBe('Completed')
    expect(activeRow.className).not.toBe(completedRow.className)
    void activeId
  })

  it('"New starting prompt" calls createPromptSession with the chosen cwd and goal text', () => {
    const el = mount(<ProjectsLanding />)
    const select = el.querySelector('[data-testid="new-prompt-cwd"]') as HTMLSelectElement
    const input = el.querySelector('[data-testid="new-prompt-goal"]') as HTMLInputElement
    const button = el.querySelector('[data-testid="new-prompt-submit"]') as HTMLButtonElement

    // React tracks each controlled element's last-known value via a patched
    // value setter; a plain `el.value = x` assignment updates that tracker
    // too, so a follow-up dispatchEvent sees "no change" and never calls
    // onChange. Go through the native prototype setter (same trick React
    // Testing Library's fireEvent uses) to bypass the tracker.
    const setNativeValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
      const proto = el instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
      setter.call(el, value)
    }

    act(() => {
      setNativeValue(select, '/home/bilko/Projects/beta')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => {
      setNativeValue(input, 'a brand new goal')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(createPromptSessionSpy).toHaveBeenCalledWith('/home/bilko/Projects/beta', 'a brand new goal')
  })
})

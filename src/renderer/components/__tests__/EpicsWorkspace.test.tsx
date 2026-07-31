// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EpicsWorkspace } from '../epics/EpicsWorkspace'
import { usePromptSessions } from '../../state/promptSessions'
import { useEpicsPrefs } from '../../state/epicsPrefs'
import { useChat } from '../../state/chat'
import { useScheduleState } from '../../state/scheduleState'

/**
 * EpicsWorkspace (PRD 829) — the two-pane Epics workspace that replaced
 * ProjectsLanding + PromptSessionConversation. Covers the same behaviors
 * those retired components' tests covered: queue row rendering, mark
 * completed, resume, cwd selection on the New Epic card, and deep-link
 * selection — now exercised through the composed workspace rather than the
 * standalone screens.
 */

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

function installWindowApiMock() {
  const api = {
    pty: { kill: vi.fn() },
    chat: {
      cancel: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(undefined),
      onQueued: vi.fn(() => () => {}),
      onRunStarted: vi.fn(() => () => {}),
      onOutput: vi.fn(() => () => {}),
      onToolUse: vi.fn(() => () => {}),
      onComplete: vi.fn(() => () => {}),
      onNeedsInput: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      onNotice: vi.fn(() => () => {}),
      onExternalSend: vi.fn(() => () => {}),
    },
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
    config: {
      readText: vi.fn().mockResolvedValue({ exists: true, text: 'transcript content', mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }),
    },
    schedule: { listPrds: vi.fn().mockResolvedValue([]) },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
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

beforeEach(() => {
  usePromptSessions.setState({ sessions: {}, events: {} })
  usePromptSessions.setState({ createPromptSession: createPromptSessionSpy })
  createPromptSessionSpy.mockClear()
  useEpicsPrefs.setState({ pins: {}, group: 'status', sort: 'recent', compact: false, hydrated: true })
  useChat.setState({ chats: {}, hydratedTabs: {} })
  useScheduleState.setState({ snapshot: null })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('EpicsWorkspace', () => {
  it('renders queue rows for known epics and opens the detail pane on select', () => {
    installWindowApiMock()
    act(() => {
      usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'ship the widget')
      usePromptSessions.getState().createPromptSession('/home/bilko/Projects/beta', 'fix the flaky test')
    })

    const el = mount(<EpicsWorkspace />)
    const rows = el.querySelectorAll('[data-testid="epic-queue-row"]')
    expect(rows).toHaveLength(2)
    expect(el.textContent).toContain('ship the widget')
    expect(el.textContent).toContain('fix the flaky test')

    expect(el.querySelector('[data-testid="epic-detail"]')).toBeNull()
    act(() => {
      ;(rows[0] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(el.querySelector('[data-testid="epic-detail"]')).not.toBeNull()
  })

  it('"New Epic" swaps in the creation card; picking a project + goal creates and selects the new Epic', () => {
    installWindowApiMock()
    const el = mount(<EpicsWorkspace />)

    const newEpicBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('New Epic')) as HTMLButtonElement
    act(() => {
      newEpicBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(el.querySelector('[data-testid="new-epic-card"]')).not.toBeNull()

    const select = el.querySelector('[data-testid="new-prompt-cwd"]') as HTMLSelectElement
    const setNativeValue = (elm: HTMLSelectElement | HTMLTextAreaElement, value: string) => {
      const proto = elm instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLTextAreaElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
      setter.call(elm, value)
    }
    act(() => {
      setNativeValue(select, '/home/bilko/Projects/beta')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const goal = el.querySelector('[data-testid="new-epic-goal"]') as HTMLTextAreaElement
    act(() => {
      setNativeValue(goal, 'a brand new goal')
      goal.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const create = el.querySelector('[data-testid="new-epic-create"]') as HTMLButtonElement
    act(() => {
      create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(createPromptSessionSpy).toHaveBeenCalledWith('/home/bilko/Projects/beta', 'a brand new goal', 'feature')
    expect(el.querySelector('[data-testid="new-epic-card"]')).toBeNull()
    expect(el.querySelector('[data-testid="epic-detail"]')).not.toBeNull()
  })

  it('"Mark completed" kills the underlying process and flips the Epic to completed', async () => {
    const api = installWindowApiMock()
    let session: ReturnType<typeof usePromptSessions.getState>['sessions'][string]
    act(() => {
      session = usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'ship the widget')
    })

    const el = mount(<EpicsWorkspace />)
    const row = el.querySelector('[data-testid="epic-queue-row"]') as HTMLButtonElement
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const markBtn = el.querySelector('[data-testid="epic-mark-completed"]') as HTMLButtonElement
    await act(async () => {
      markBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await vi.waitFor(() => expect(api.config.writeJson).toHaveBeenCalled())

    expect(api.chat.cancel).toHaveBeenCalledWith(session!.id)
    expect(api.pty.kill).toHaveBeenCalledWith(session!.claudeSessionId)
    expect(usePromptSessions.getState().sessions[session!.id].status).toBe('completed')
  })

  it('a completed Epic opens its detail read-only, with no composer, and "Resume" mints a new active Epic', async () => {
    const api = installWindowApiMock()
    let session: ReturnType<typeof usePromptSessions.getState>['sessions'][string]
    act(() => {
      session = usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'ship the widget')
    })
    await act(async () => {
      await usePromptSessions.getState().markCompleted(session!.id)
    })
    void api

    // The default "Open" queue filter excludes completed Epics — select it
    // the same way a deep link (Scheduler job row, dispatched-ticket chip)
    // would, rather than a queue row click.
    const el = mount(<EpicsWorkspace />)
    act(() => {
      window.dispatchEvent(new CustomEvent('sm:select-prompt-session', { detail: session!.id }))
    })

    expect(el.querySelector('[data-testid="epic-detail"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="epic-composer"]')).toBeNull()

    const resumeBtn = el.querySelector('[data-testid="epic-resume"]') as HTMLButtonElement
    act(() => {
      resumeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const allSessions = Object.values(usePromptSessions.getState().sessions)
    expect(allSessions).toHaveLength(2)
    const resumed = allSessions.find((s) => s.id !== session!.id)!
    expect(resumed.status).toBe('active')
    expect(resumed.resumedFromId).toBe(session!.id)
  })

  it('selecting via the sm:select-prompt-session deep link opens that Epic\'s detail, including a completed one', () => {
    installWindowApiMock()
    let session: ReturnType<typeof usePromptSessions.getState>['sessions'][string]
    act(() => {
      session = usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'ship the widget')
    })

    const el = mount(<EpicsWorkspace />)
    act(() => {
      window.dispatchEvent(new CustomEvent('sm:select-prompt-session', { detail: session!.id }))
    })

    const detail = el.querySelector('[data-testid="epic-detail"]')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('ship the widget')
  })

  it('PRD 833 I4: a deep link to a not-yet-hydrated Epic is held and selected once hydration delivers it', () => {
    installWindowApiMock()
    const el = mount(<EpicsWorkspace />)

    // Deep link fires BEFORE the target exists in the store (boot race).
    act(() => {
      window.dispatchEvent(new CustomEvent('sm:select-prompt-session', { detail: 'late-epic' }))
    })
    expect(el.querySelector('[data-testid="epic-detail"]')).toBeNull()

    // Hydration lands the Epic afterwards — the held deep link resolves.
    act(() => {
      const session = usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'late arriving epic')
      usePromptSessions.setState((s) => {
        const { [session.id]: created, ...rest } = s.sessions
        return { sessions: { ...rest, 'late-epic': { ...created, id: 'late-epic' } } }
      })
    })

    const detail = el.querySelector('[data-testid="epic-detail"]')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('late arriving epic')
  })

  it('PRD 833 C1: a surviving pty for an active Epic is re-adopted into Terminal mode with attachment re-recorded', async () => {
    const api = installWindowApiMock()
    let session: ReturnType<typeof usePromptSessions.getState>['sessions'][string]
    act(() => {
      session = usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'epic with surviving pty')
    })
    ;(api.pty as Record<string, unknown>).alive = vi
      .fn()
      .mockImplementation((ids: string[]) => Promise.resolve(ids.filter((id) => id === session!.claudeSessionId)))

    mount(<EpicsWorkspace />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const { useEpicTerminal } = await import('../../state/epicTerminal')
    expect(useEpicTerminal.getState().modes[session!.id]).toBe('terminal')
    expect(useEpicTerminal.getState().isAttached(session!.id)).toBe(true)
  })
})

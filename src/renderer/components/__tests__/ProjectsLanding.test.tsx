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

function installWindowApiMock() {
  const api = {
    pty: { kill: vi.fn() },
    chat: { cancel: vi.fn().mockResolvedValue(undefined), run: vi.fn().mockResolvedValue({ ok: true }) },
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
    config: {
      readText: vi.fn().mockResolvedValue({ exists: true, text: 'transcript content', mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }),
    },
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
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
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

  it('removes a completed session from the active list and shows it in History instead', () => {
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
    const activeRows = el.querySelectorAll('[data-testid="prompt-session-row"]')
    const historyRows = el.querySelectorAll('[data-testid="prompt-session-history-row"]')
    expect(activeRows).toHaveLength(1)
    expect((activeRows[0] as HTMLElement).dataset.status).toBe('active')
    expect(historyRows).toHaveLength(1)
    expect((historyRows[0] as HTMLElement).dataset.status).toBe('completed')
    expect(activeRows[0].querySelector('[data-testid="prompt-session-status-badge"]')?.textContent).toBe('Active')
    expect(historyRows[0].querySelector('[data-testid="prompt-session-status-badge"]')?.textContent).toBe('Completed')
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

  it('"Mark completed" kills the underlying process, persists an archive, and moves the row into History', async () => {
    const api = installWindowApiMock()
    let session: ReturnType<typeof usePromptSessions.getState>['sessions'][string]
    act(() => {
      session = usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'ship the widget')
    })

    const el = mount(<ProjectsLanding />)
    const markBtn = el.querySelector('[data-testid="prompt-session-row-mark-completed"]') as HTMLButtonElement
    await act(async () => {
      markBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await vi.waitFor(() => expect(api.config.writeJson).toHaveBeenCalled())

    // Real kill path for a chatRunner-driven PromptSession.
    expect(api.chat.cancel).toHaveBeenCalledWith(session!.id)
    // Named reuse path from the AC, also hit defensively.
    expect(api.pty.kill).toHaveBeenCalledWith(session!.claudeSessionId)

    const [archivePath, archiveData] = api.config.writeJson.mock.calls[0]
    expect(archivePath).toBe(`/home/bilko/Projects/alpha/session-manager-operations/prompt-sessions/${session!.id}.json`)
    expect(archiveData.session.status).toBe('completed')
    expect(archiveData.session.completedAt).toBeTruthy()
    expect(archiveData.events.some((e: { kind: string }) => e.kind === 'closed')).toBe(true)
    expect(archiveData.transcript).toBe('transcript content')

    expect(usePromptSessions.getState().sessions[session!.id].status).toBe('completed')
    expect(el.querySelectorAll('[data-testid="prompt-session-row"]')).toHaveLength(0)
    expect(el.querySelectorAll('[data-testid="prompt-session-history-row"]')).toHaveLength(1)
  })

  it('opening a completed session from History reads the archive and never spawns a new pty/chatRunner job', async () => {
    const api = installWindowApiMock()
    let session: ReturnType<typeof usePromptSessions.getState>['sessions'][string]
    act(() => {
      session = usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'ship the widget')
    })
    await act(async () => {
      await usePromptSessions.getState().markCompleted(session!.id)
    })
    api.config.readJson.mockResolvedValue({
      exists: true,
      raw: '',
      data: {
        session: usePromptSessions.getState().sessions[session!.id],
        events: usePromptSessions.getState().events[session!.id],
        transcript: 'archived transcript',
        archivedAt: new Date().toISOString(),
      },
      parseError: null,
      mtimeMs: 0,
      error: null,
    })
    api.chat.cancel.mockClear()
    api.chat.run.mockClear()
    api.pty.kill.mockClear()

    const el = mount(<ProjectsLanding />)
    const openBtn = el.querySelector('[data-testid="prompt-session-history-open"]') as HTMLButtonElement
    await act(async () => {
      openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await vi.waitFor(() =>
      expect(el.querySelector('[data-testid="prompt-session-archive-view"]')).not.toBeNull(),
    )

    expect(el.textContent).toContain('archived transcript')
    expect(api.chat.run).not.toHaveBeenCalled()
    expect(api.chat.cancel).not.toHaveBeenCalled()
    expect(api.pty.kill).not.toHaveBeenCalled()
  })

  it('"Resume" mints a new independent PromptSession linked back to the archived one', async () => {
    installWindowApiMock()
    let session: ReturnType<typeof usePromptSessions.getState>['sessions'][string]
    act(() => {
      session = usePromptSessions.getState().createPromptSession('/home/bilko/Projects/alpha', 'ship the widget')
    })
    await act(async () => {
      await usePromptSessions.getState().markCompleted(session!.id)
    })

    const el = mount(<ProjectsLanding />)
    const resumeBtn = el.querySelector('[data-testid="prompt-session-history-resume"]') as HTMLButtonElement
    act(() => {
      resumeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const allSessions = Object.values(usePromptSessions.getState().sessions)
    expect(allSessions).toHaveLength(2)
    const resumed = allSessions.find((s) => s.id !== session!.id)!
    expect(resumed.status).toBe('active')
    expect(resumed.id).not.toBe(session!.id)
    expect(resumed.claudeSessionId).not.toBe(session!.claudeSessionId)
    expect(resumed.resumedFromId).toBe(session!.id)
    expect(el.querySelector('[data-testid="prompt-session-conversation"]')).not.toBeNull()
  })
})

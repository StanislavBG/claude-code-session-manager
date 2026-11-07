// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EpicsWorkspace } from '../EpicsWorkspace'
import { usePromptSessions, type PromptSession } from '../../../state/promptSessions'
import { useEpicsPrefs } from '../../../state/epicsPrefs'
import { useChat } from '../../../state/chat'
import { useScheduleState } from '../../../state/scheduleState'
import { useEpicUsage } from '../../../state/epicUsage'
import { useSessions, type SessionTab } from '../../../state/sessions'
import { flushAsync } from '../../../testUtils/domFlush'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'
import { composeEpicIntake } from '../../../lib/epicIntake'

const CWD = '/home/bilko/Projects/alpha'
const TAB: SessionTab = {
  id: 'tab-alpha', sessionId: 'tab-alpha', label: 'alpha', cwd: CWD, pid: null,
  status: 'dormant', exitCode: null, startupCommand: null, presetId: null, generation: 0,
}

vi.mock('../../../lib/useKnownProjects', () => ({
  useKnownProjects: () => ({
    projects: [{ cwd: CWD, name: 'alpha', encoded: '-home-bilko-Projects-alpha', encodedIds: ['-home-bilko-Projects-alpha'], sessionCount: 0, sizeBytes: 0, lastSession: 0, details: {} }],
    rows: [], enriched: {}, loading: false, resolving: false,
  }),
}))

function installApi() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
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
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/t.jsonl'), usageFor: vi.fn().mockResolvedValue({}) },
    epicDelegationStats: { get: vi.fn().mockResolvedValue({ prdsQueued: 0, inlineEdits: 0 }) },
    config: {
      readText: vi.fn().mockResolvedValue({ exists: true, text: '', mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }),
      watch: vi.fn(),
      unwatch: vi.fn(),
    },
    schedule: { listPrds: vi.fn().mockResolvedValue([]) },
    promptSessions: {
      create: fakePromptSessionsCreate(),
      onEventAppended: vi.fn(),
      writeArchive: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
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

function epic(id: string, extra: Partial<PromptSession> = {}): PromptSession {
  const intake = composeEpicIntake({
    title: `Title ${id}`,
    goal: `Goal ${id}`,
    referencePaths: [],
    tag: undefined,
    agentName: undefined,
    contextInjections: {} as never,
  } as never)
  return {
    id, cwd: CWD, goalText: intake.goalText, claudeSessionId: `claude-${id}`, status: 'proposed',
    createdAt: new Date().toISOString(), completedAt: null, openingPrompt: intake.openingPrompt,
    sections: intake.sections, source: 'NewEpicCard', ...extra,
  } as never
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

beforeEach(() => {
  usePromptSessions.setState({ sessions: {}, events: {} })
  useEpicsPrefs.setState({ pins: {}, group: 'status', sort: 'recent', compact: false, hydrated: true, pinsCwd: null })
  useChat.setState({ chats: {}, hydratedTabs: {} })
  useScheduleState.setState({ snapshot: null })
  useEpicUsage.setState({ usage: {} })
  useSessions.setState({ tabs: [TAB], activeTabId: TAB.id })
  installApi()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

function selectRow(el: HTMLElement, text: string) {
  const row = Array.from(el.querySelectorAll('[data-testid="epic-queue-row"]')).find((r) => r.textContent?.includes(text))
  expect(row).toBeTruthy()
  act(() => row!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('EpicsWorkspace drafts', () => {
  it('selecting a human draft shows the New Session card prefilled', () => {
    usePromptSessions.setState({ sessions: { d1: epic('d1') } })
    const el = mount(<EpicsWorkspace />)
    selectRow(el, 'Title d1')
    expect(q(el, 'new-epic-card')).not.toBeNull()
    expect((q(el, 'new-epic-title') as HTMLInputElement).value).toBe('Title d1')
    expect(q(el, 'epic-approval-bar')).toBeNull()
  })

  it('selecting a cross-project proposal keeps EpicDetail + approval bar', () => {
    usePromptSessions.setState({
      sessions: {
        x1: epic('x1', { source: { producer: 'cross-project-feedback', fromCwd: '/home/u/Projects/sender' } as never }),
      },
    })
    const el = mount(<EpicsWorkspace />)
    selectRow(el, 'Title x1')
    expect(q(el, 'epic-approval-bar')).not.toBeNull()
    expect(q(el, 'new-epic-card')).toBeNull()
  })

  it('Save draft from New Session leaves the card bound to the new draft', async () => {
    const el = mount(<EpicsWorkspace />)
    const newBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('New Session')) as HTMLButtonElement
    act(() => newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const title = q(el, 'new-epic-title') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, 'Fresh draft')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      q(el, 'new-epic-save-draft')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushAsync()
    })
    const drafts = Object.values(usePromptSessions.getState().sessions)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].status).toBe('proposed')
    expect(q(el, 'new-epic-card')).not.toBeNull()
    // Bound to the draft: edit mode exposes the discard control.
    expect(q(el, 'new-epic-discard-draft')).not.toBeNull()
    expect((q(el, 'new-epic-title') as HTMLInputElement).value).toBe('Fresh draft')
  })
})

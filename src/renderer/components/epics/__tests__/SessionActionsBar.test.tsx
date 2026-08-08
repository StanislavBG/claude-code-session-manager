// @vitest-environment jsdom
/**
 * SessionActionsBar — the project-dynamic Action buttons in the Sessions
 * toolbar. Covers the two things that make an Action an Action: it is scoped
 * per project, and pressing it opens a REAL session through the same
 * mint -> approve -> send path the New Session card uses.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SessionActionsBar } from '../SessionActionsBar'
import { usePromptSessions } from '../../../state/promptSessions'
import { useSessions } from '../../../state/sessions'
import { useChat } from '../../../state/chat'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'
import type { AgentPersona } from '../../../../preload/api'

const CWD = '/home/bilko/Projects/alpha'

function persona(over: Partial<AgentPersona> = {}): AgentPersona {
  return {
    name: 'scout',
    description: 'Looks around.',
    tools: [],
    model: null,
    color: null,
    tags: [],
    projects: [],
    action: null,
    actionLabel: null,
    path: '',
    body: '',
    overridingProjects: [],
    ...over,
  }
}

const listPersonas = vi.fn(async (): Promise<AgentPersona[]> => [])
const createPromptSessionSpy = vi.fn(usePromptSessions.getState().createPromptSession)
const approveProposedSpy = vi.fn()
const sendSpy = vi.fn()

;(globalThis as any).window.api = {
  agents: { listPersonas, onChanged: vi.fn(() => () => {}) },
  promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
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

function actionButtons(el: HTMLElement) {
  return Array.from(el.querySelectorAll('[data-testid="session-action"]')) as HTMLButtonElement[]
}

beforeEach(() => {
  usePromptSessions.setState({ sessions: {}, events: {} })
  usePromptSessions.setState({ createPromptSession: createPromptSessionSpy, approveProposed: approveProposedSpy })
  createPromptSessionSpy.mockClear()
  approveProposedSpy.mockClear()
  useChat.setState({ send: sendSpy })
  sendSpy.mockClear()
  useSessions.setState({ tabs: [{ id: 'tab-1', cwd: CWD } as any], activeTabId: 'tab-1' })
  listPersonas.mockReset()
  listPersonas.mockResolvedValue([])
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('SessionActionsBar', () => {
  it('renders no Action buttons when no persona is scoped to this project', async () => {
    listPersonas.mockResolvedValue([persona({ action: 'x' })])
    const el = mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    await act(async () => {})
    expect(actionButtons(el)).toHaveLength(0)
  })

  it('renders one button per scoped persona, labelled by actionLabel', async () => {
    listPersonas.mockResolvedValue([
      persona({ name: 'scout', projects: [CWD], action: 'Sweep it.', actionLabel: 'Sweep' }),
      persona({ name: 'elsewhere', projects: ['/home/bilko/Projects/beta'], action: 'nope' }),
    ])
    const el = mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    await act(async () => {})
    expect(actionButtons(el).map((b) => b.textContent)).toEqual(['Sweep'])
  })

  it('never renders a second button for `builder` — Run Build already is its Action', async () => {
    listPersonas.mockResolvedValue([persona({ name: 'builder', projects: [CWD], action: '/builder' })])
    const el = mount(<SessionActionsBar onNew={vi.fn()} onSelect={vi.fn()} />)
    await act(async () => {})
    expect(actionButtons(el)).toHaveLength(0)
  })

  it('pressing an Action mints + approves + sends a session carrying the persona as Actor and its tag as Mission', async () => {
    listPersonas.mockResolvedValue([persona({ name: 'scout', projects: [CWD], action: 'Sweep it.', tags: ['bug'] })])
    const onSelect = vi.fn()
    const el = mount(<SessionActionsBar onNew={vi.fn()} onSelect={onSelect} />)
    await act(async () => {})

    act(() => actionButtons(el)[0].click())
    await act(async () => {})

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const [cwd, , tag, , agentType, openingPrompt] = createPromptSessionSpy.mock.calls[0]
    expect(cwd).toBe(CWD)
    expect(tag).toBe('bug')
    expect(agentType).toBe('scout')
    // AIM: Actor line first, then the tag's mission template, then the goal.
    expect(openingPrompt).toContain('You are acting as the "scout" agent')
    expect(openingPrompt).toContain('Sweep it.')

    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(approveProposedSpy).toHaveBeenCalledWith(created.id, 'SessionActionsBar scout')
    expect(sendSpy).toHaveBeenCalledWith({
      tabId: created.id,
      sessionId: created.claudeSessionId,
      cwd: CWD,
      prompt: expect.stringContaining('Sweep it.'),
    })
    expect(onSelect).toHaveBeenCalledWith(created.id)
  })

  it('+ New Session is always present and calls onNew', async () => {
    const onNew = vi.fn()
    const el = mount(<SessionActionsBar onNew={onNew} onSelect={vi.fn()} />)
    await act(async () => {})
    const btn = el.querySelector('[data-testid="epic-queue-new"]') as HTMLButtonElement
    expect(btn.textContent).toBe('+ New Session')
    act(() => btn.click())
    expect(onNew).toHaveBeenCalledTimes(1)
  })
})

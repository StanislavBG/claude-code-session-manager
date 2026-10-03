// @vitest-environment jsdom
/**
 * useMacroLaunch — shared mint -> approve -> send path for pressing a Macro.
 * Default behaviour must stay byte-for-byte what SessionActionsBar always
 * did; `resumeActive`/`requireReadiness` are opt-in additions ported from
 * the old Project Home "Generate" action (useBuilderEpic.ts).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useMacroLaunch } from '../useMacroLaunch'
import { usePromptSessions } from '../../state/promptSessions'
import { useSessions } from '../../state/sessions'
import { useChat } from '../../state/chat'
import { useToast } from '../../state/toast'
import { fakePromptSessionsCreate } from '../../testUtils/fakePromptSessionsCreate'
import type { AgentPersona, Macro } from '../../../preload/api'

const CWD = '/home/bilko/Projects/alpha'

function persona(over: Partial<AgentPersona> = {}): AgentPersona {
  return {
    name: 'scout', description: 'Looks around.', tools: [], model: null, effort: null, color: null,
    tags: [], projects: [], action: null, actionLabel: null, path: '', body: '', overridingProjects: [], ...over,
  }
}
function macro(over: Partial<Macro> = {}): Macro {
  return {
    id: 'm1', label: 'Sweep', agentName: 'scout', tag: 'bug', prompt: 'Sweep it.\nSecond line', projects: [CWD],
    surface: 'sessions', createdAt: '', updatedAt: '', ...over,
  }
}

const createPromptSessionSpy = vi.fn(usePromptSessions.getState().createPromptSession)
const approveProposedSpy = vi.fn()
const sendSpy = vi.fn()
const READY = { ok: true, checks: [] }

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(el) })
  return container
}

function Harness({ personas, opts, onSelect }: {
  personas: AgentPersona[]
  opts?: { resumeActive?: boolean; requireReadiness?: boolean }
  onSelect: (id: string) => void
}) {
  const { launch, launching } = useMacroLaunch(onSelect, personas, opts)
  return (
    <button type="button" disabled={launching !== null} onClick={() => void launch(macro())}>
      Launch
    </button>
  )
}

beforeEach(() => {
  usePromptSessions.setState({ sessions: {}, events: {} })
  usePromptSessions.setState({ createPromptSession: createPromptSessionSpy, approveProposed: approveProposedSpy })
  createPromptSessionSpy.mockClear()
  approveProposedSpy.mockClear()
  sendSpy.mockClear()
  useChat.setState({ send: sendSpy })
  useSessions.setState({ tabs: [{ id: 'tab-1', cwd: CWD } as any], activeTabId: 'tab-1' })
  ;(globalThis as any).window.api = {
    promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
    app: { delegationReadiness: vi.fn().mockResolvedValue(READY) },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

describe('useMacroLaunch', () => {
  it('default path: mints, approves, sends and selects', async () => {
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const [cwd, , tag, , agentType, openingPrompt] = createPromptSessionSpy.mock.calls[0]
    expect(cwd).toBe(CWD)
    expect(tag).toBe('bug')
    expect(agentType).toBe('scout')
    expect(openingPrompt).toContain('Sweep it.')
    const created = Object.values(usePromptSessions.getState().sessions)[0]
    expect(approveProposedSpy).toHaveBeenCalledWith(created.id, 'SessionActionsBar scout')
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ tabId: created.id, cwd: CWD }))
    expect(onSelect).toHaveBeenCalledWith(created.id)
  })

  it('resumeActive: an active Epic for the same (cwd, agentName, tag) is resumed, nothing minted', async () => {
    usePromptSessions.setState({
      sessions: {
        existing: {
          id: 'existing',
          cwd: CWD,
          goalText: 'Sweep',
          claudeSessionId: 'sess-1',
          status: 'active',
          createdAt: '2026-08-02T00:00:00.000Z',
          completedAt: null,
          tag: 'bug',
          agentType: 'scout',
        } as any,
      },
    })
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} opts={{ resumeActive: true }} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith('existing')
  })

  it('resumeActive: a completed Epic for the same (cwd, agentName, tag) still mints a new one', async () => {
    usePromptSessions.setState({
      sessions: {
        done: {
          id: 'done',
          cwd: CWD,
          goalText: 'Sweep',
          claudeSessionId: 'sess-1',
          status: 'completed',
          createdAt: '2026-08-02T00:00:00.000Z',
          completedAt: '2026-08-03T00:00:00.000Z',
          tag: 'bug',
          agentType: 'scout',
        } as any,
      },
    })
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} opts={{ resumeActive: true }} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    const created = Object.values(usePromptSessions.getState().sessions).find((s) => s.id !== 'done')!
    expect(onSelect).toHaveBeenCalledWith(created.id)
  })

  it('requireReadiness: delegationReadiness ok:false blocks the mint and toasts the failing checks', async () => {
    ;(globalThis as any).window.api.app.delegationReadiness = vi.fn().mockResolvedValue({
      ok: false,
      checks: [{ id: 'x', label: 'Scheduler MCP server answers tools/list', ok: false, detail: 'timeout', fix: null }],
    })
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} opts={{ requireReadiness: true }} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(
      useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('Scheduler MCP server answers tools/list')),
    ).toBe(true)
  })

  it('requireReadiness: delegationReadiness throwing blocks the mint and toasts', async () => {
    ;(globalThis as any).window.api.app.delegationReadiness = vi.fn().mockRejectedValue(new Error('timeout'))
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} opts={{ requireReadiness: true }} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('timeout'))).toBe(true)
  })

  it('requireReadiness: a missing persona blocks even while the personas list is still empty', async () => {
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[]} opts={{ requireReadiness: true }} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
    expect(
      useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('scout')),
    ).toBe(true)
  })

  it('default behaviour: a missing persona in an empty (still-loading) list does NOT block', async () => {
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[]} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalled()
  })
})

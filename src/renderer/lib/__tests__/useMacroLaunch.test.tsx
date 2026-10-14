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

function Harness({ personas, opts, onSelect, extraInstructions, macroOver, inputValues }: {
  personas: AgentPersona[]
  opts?: { resumeActive?: boolean; requireReadiness?: boolean }
  onSelect: (id: string) => void
  extraInstructions?: string
  macroOver?: Partial<Macro>
  inputValues?: Record<string, string>
}) {
  const { launch, launching } = useMacroLaunch(onSelect, personas, opts)
  return (
    <button
      type="button"
      disabled={launching !== null}
      onClick={() => void launch(macro(macroOver), extraInstructions, inputValues)}
    >
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

  it('extraInstructions omitted or blank: goal is unchanged', async () => {
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[persona()]} onSelect={onSelect} extraInstructions="   " />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    const [, goalText] = createPromptSessionSpy.mock.calls[0]
    expect(goalText).toBe('Sweep\n\nSweep it.\nSecond line')
  })

  it('extraInstructions provided: appended as an Additional instructions paragraph', async () => {
    const onSelect = vi.fn()
    const el = await mount(
      <Harness personas={[persona()]} onSelect={onSelect} extraInstructions="  focus on the auth flow  " />,
    )
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    const [, goalText, , , , openingPrompt] = createPromptSessionSpy.mock.calls[0]
    expect(goalText).toBe('Sweep\n\nSweep it.\nSecond line\n\nAdditional instructions: focus on the auth flow')
    expect(openingPrompt).toContain('Additional instructions: focus on the auth flow')
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

  describe('macro inputs', () => {
    const withInputs = {
      prompt: 'run stream={{stream}}',
      inputs: [{ name: 'stream', label: 'Stream', default: 'education-veggies' }],
    } as Partial<Macro>

    it('no values passed: placeholders render with the input defaults', async () => {
      const el = await mount(<Harness personas={[persona()]} onSelect={vi.fn()} macroOver={withInputs} />)
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      const [, goalText] = createPromptSessionSpy.mock.calls[0]
      expect(goalText).toBe('Sweep\n\nrun stream=education-veggies')
    })

    it('values passed: the override replaces the default', async () => {
      const el = await mount(
        <Harness personas={[persona()]} onSelect={vi.fn()} macroOver={withInputs} inputValues={{ stream: 'math' }} />,
      )
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      const [, goalText] = createPromptSessionSpy.mock.calls[0]
      expect(goalText).toBe('Sweep\n\nrun stream=math')
    })

    it('a required input left empty toasts and mints nothing', async () => {
      const onSelect = vi.fn()
      const el = await mount(
        <Harness
          personas={[persona()]}
          onSelect={onSelect}
          macroOver={{
            prompt: 'run stream={{stream}}',
            inputs: [{ name: 'stream', label: 'Stream', required: true }],
          } as Partial<Macro>}
          inputValues={{ stream: '' }}
        />,
      )
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      expect(createPromptSessionSpy).not.toHaveBeenCalled()
      expect(sendSpy).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
      expect(
        useToast.getState().toasts.some(
          (t) => t.kind === 'error' && t.message === 'Cannot start "Sweep" — "Stream" is required',
        ),
      ).toBe(true)
    })

    it('a macro without inputs sends a goal identical to its prompt', async () => {
      const el = await mount(
        <Harness personas={[persona()]} onSelect={vi.fn()} macroOver={{ prompt: 'keep {{this}} literal' }} />,
      )
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      const [, goalText] = createPromptSessionSpy.mock.calls[0]
      expect(goalText).toBe('Sweep\n\nkeep {{this}} literal')
    })
  })

  describe('cost confirmation', () => {
    let confirmSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      confirmSpy = vi.spyOn(window, 'confirm')
    })
    afterEach(() => {
      confirmSpy.mockRestore()
    })

    it('max effort + confirm declined: nothing is minted or readiness-checked', async () => {
      confirmSpy.mockReturnValue(false)
      const onSelect = vi.fn()
      const el = await mount(
        <Harness personas={[persona({ effort: 'max' })]} opts={{ requireReadiness: true }} onSelect={onSelect} />,
      )
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      expect(confirmSpy).toHaveBeenCalledTimes(1)
      expect(createPromptSessionSpy).not.toHaveBeenCalled()
      expect(sendSpy).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
      expect((globalThis as any).window.api.app.delegationReadiness).not.toHaveBeenCalled()
    })

    it('max effort + confirm accepted: launches exactly once', async () => {
      confirmSpy.mockReturnValue(true)
      const onSelect = vi.fn()
      const el = await mount(<Harness personas={[persona({ effort: 'max' })]} onSelect={onSelect} />)
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      expect(confirmSpy).toHaveBeenCalledTimes(1)
      expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledTimes(1)
    })

    it('medium effort: no confirm, launches', async () => {
      const onSelect = vi.fn()
      const el = await mount(<Harness personas={[persona({ effort: 'medium' })]} onSelect={onSelect} />)
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      expect(confirmSpy).not.toHaveBeenCalled()
      expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    })

    it('resumeActive with an existing active Epic + max effort: never prompts', async () => {
      usePromptSessions.setState({
        sessions: {
          existing: {
            id: 'existing', cwd: CWD, goalText: 'Sweep', claudeSessionId: 'sess-1', status: 'active',
            createdAt: '2026-08-02T00:00:00.000Z', completedAt: null, tag: 'bug', agentType: 'scout',
          } as any,
        },
      })
      const onSelect = vi.fn()
      const el = await mount(
        <Harness personas={[persona({ effort: 'max' })]} opts={{ resumeActive: true }} onSelect={onSelect} />,
      )
      await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

      expect(confirmSpy).not.toHaveBeenCalled()
      expect(onSelect).toHaveBeenCalledWith('existing')
    })
  })

  it('default behaviour: a missing persona in an empty (still-loading) list does NOT block', async () => {
    const onSelect = vi.fn()
    const el = await mount(<Harness personas={[]} onSelect={onSelect} />)
    await act(async () => { (el.querySelector('button') as HTMLButtonElement).click() })

    expect(createPromptSessionSpy).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalled()
  })
})
